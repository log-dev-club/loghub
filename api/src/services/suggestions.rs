//! 익명 건의함. 운영자 개념 없이 모든 멤버가 동등하다.
//!
//! 익명성 원칙 (팀원 참고: 이 파일을 고칠 때 반드시 지킨다)
//! - 작성자의 user_id, 닉네임, IP, 정확한 작성 시각을 DB 에도 로그에도 남기지 않는다.
//! - 작성자·공감자는 HMAC(서버 키, "용도:사용자id:건의id") 로만 기록한다.
//!   건의마다 값이 달라 같은 사람의 기록끼리 묶을 수 없고, 서버 키 없이 DB 만으로는 사람을 알 수 없다.
//!   서버 키(`SUGGESTION_SECRET`)는 DB 와 다른 곳(.env)에만 둔다.
//! - 본인 확인이 필요한 곳(내 건의 표시·삭제)은 요청한 사용자로 HMAC 을 다시 계산해 비교한다.
//! - 이 모듈에서는 tracing 으로 사용자 관련 값이나 건의 내용을 출력하지 않는다.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use sqlx::{PgPool, Postgres, QueryBuilder};

use super::to_hex;
use crate::{
    error::AppError,
    models::{
        suggestion::{
            CreateSuggestionRequest, SuggestionDto, SuggestionListQuery, SuggestionRow, VoteResult,
        },
        user::UserRow,
    },
};

const TITLE_MAX: usize = 100;
const CONTENT_MAX: usize = 3000;
/// 전체 목록 최대 개수 ("내 건의" 보기는 제한 없이 전부 확인한다)
const LIST_LIMIT: i64 = 200;

const SUGGESTION_SELECT: &str = "SELECT s.id, s.title, s.content, s.author_hash, s.created_on, \
            (SELECT count(*) FROM suggestion_votes v WHERE v.suggestion_id = s.id) AS vote_count \
     FROM suggestions s";

/// 용도(`author`/`vote`)와 건의마다 완전히 다른 값이 나오는 HMAC
fn keyed_hash(secret: &[u8], purpose: &str, user_id: i64, suggestion_id: i64) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret).expect("HMAC 은 모든 길이의 키를 허용한다");
    mac.update(format!("{purpose}:{user_id}:{suggestion_id}").as_bytes());
    to_hex(&mac.finalize().into_bytes())
}

fn author_hash(secret: &[u8], user_id: i64, suggestion_id: i64) -> String {
    keyed_hash(secret, "author", user_id, suggestion_id)
}

fn voter_hash(secret: &[u8], user_id: i64, suggestion_id: i64) -> String {
    keyed_hash(secret, "vote", user_id, suggestion_id)
}

/// 응답 시간 차이로 해시를 추측하지 못하도록 (같은 길이의) 해시를 끝까지 비교한다
fn hash_eq(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

fn required_text(value: &str, max: usize, label: &str) -> Result<String, AppError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(AppError::bad_request(format!("{label}을 입력해주세요")));
    }
    if value.chars().count() > max {
        return Err(AppError::bad_request(format!(
            "{label}은 {max}자 이하여야 합니다"
        )));
    }
    Ok(value.to_string())
}

async fn has_voted(pool: &PgPool, suggestion_id: i64, hash: &str) -> Result<bool, AppError> {
    let (exists,): (bool,) = sqlx::query_as(
        "SELECT EXISTS (SELECT 1 FROM suggestion_votes WHERE suggestion_id = $1 AND voter_hash = $2)",
    )
    .bind(suggestion_id)
    .bind(hash)
    .fetch_one(pool)
    .await?;
    Ok(exists)
}

async fn get_row(pool: &PgPool, id: i64) -> Result<SuggestionRow, AppError> {
    sqlx::query_as::<_, SuggestionRow>(&format!("{SUGGESTION_SELECT} WHERE s.id = $1"))
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::not_found("건의를 찾을 수 없습니다"))
}

fn is_mine(secret: &[u8], viewer: &UserRow, row: &SuggestionRow) -> bool {
    hash_eq(&author_hash(secret, viewer.id, row.id), &row.author_hash)
}

/// GET /api/suggestions — 로그인한 멤버 누구나. `mine=true` 면 내가 쓴 건의만
pub async fn list(
    pool: &PgPool,
    secret: &[u8],
    viewer: &UserRow,
    query: &SuggestionListQuery,
) -> Result<Vec<SuggestionDto>, AppError> {
    let only_mine = query.mine.unwrap_or(false);

    let mut qb = QueryBuilder::<Postgres>::new(SUGGESTION_SELECT);
    match query.sort.as_deref() {
        Some("latest") => qb.push(" ORDER BY s.created_on DESC, s.id DESC"),
        _ => qb.push(" ORDER BY vote_count DESC, s.created_on DESC, s.id DESC"),
    };
    // 작성자 해시는 사용자마다 서버에서 다시 계산해야 하므로 "내 건의" 는 SQL 로 거를 수 없다
    if !only_mine {
        qb.push(" LIMIT ").push_bind(LIST_LIMIT);
    }

    let rows: Vec<SuggestionRow> = qb.build_query_as().fetch_all(pool).await?;
    let mut items = Vec::new();
    for row in rows {
        let mine = is_mine(secret, viewer, &row);
        if only_mine && !mine {
            continue;
        }
        let voted = has_voted(pool, row.id, &voter_hash(secret, viewer.id, row.id)).await?;
        items.push(SuggestionDto::from_row(row, voted, mine));
    }
    Ok(items)
}

/// POST /api/suggestions — 작성자는 건의별 HMAC 으로만 남는다
pub async fn create(
    pool: &PgPool,
    secret: &[u8],
    author: &UserRow,
    req: &CreateSuggestionRequest,
) -> Result<SuggestionDto, AppError> {
    let title = required_text(&req.title, TITLE_MAX, "제목")?;
    let content = required_text(&req.content, CONTENT_MAX, "내용")?;

    // 해시에 건의 id 가 들어가므로 id 를 먼저 받아 둔다
    let (id,): (i64,) = sqlx::query_as("SELECT nextval('suggestions_id_seq')")
        .fetch_one(pool)
        .await?;
    sqlx::query(
        "INSERT INTO suggestions (id, title, content, author_hash) VALUES ($1, $2, $3, $4)",
    )
    .bind(id)
    .bind(title)
    .bind(content)
    .bind(author_hash(secret, author.id, id))
    .execute(pool)
    .await?;

    Ok(SuggestionDto::from_row(
        get_row(pool, id).await?,
        false,
        true,
    ))
}

/// DELETE /api/suggestions/{id} — 작성자 본인만 (관리자도 예외 없음)
pub async fn delete(
    pool: &PgPool,
    secret: &[u8],
    actor: &UserRow,
    id: i64,
) -> Result<(), AppError> {
    let row = get_row(pool, id).await?;
    if !is_mine(secret, actor, &row) {
        return Err(AppError::Forbidden);
    }
    sqlx::query("DELETE FROM suggestions WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

async fn vote_count(pool: &PgPool, id: i64) -> Result<i64, AppError> {
    let (count,): (i64,) =
        sqlx::query_as("SELECT count(*) FROM suggestion_votes WHERE suggestion_id = $1")
            .bind(id)
            .fetch_one(pool)
            .await?;
    Ok(count)
}

/// PUT /api/suggestions/{id}/vote
pub async fn vote(
    pool: &PgPool,
    secret: &[u8],
    voter: &UserRow,
    id: i64,
) -> Result<VoteResult, AppError> {
    get_row(pool, id).await?;
    sqlx::query(
        "INSERT INTO suggestion_votes (suggestion_id, voter_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(id)
    .bind(voter_hash(secret, voter.id, id))
    .execute(pool)
    .await?;
    Ok(VoteResult {
        voted: true,
        vote_count: vote_count(pool, id).await?,
    })
}

/// DELETE /api/suggestions/{id}/vote
pub async fn unvote(
    pool: &PgPool,
    secret: &[u8],
    voter: &UserRow,
    id: i64,
) -> Result<VoteResult, AppError> {
    get_row(pool, id).await?;
    sqlx::query("DELETE FROM suggestion_votes WHERE suggestion_id = $1 AND voter_hash = $2")
        .bind(id)
        .bind(voter_hash(secret, voter.id, id))
        .execute(pool)
        .await?;
    Ok(VoteResult {
        voted: false,
        vote_count: vote_count(pool, id).await?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &[u8] = b"test-key";

    #[test]
    fn hashes_differ_per_suggestion() {
        // 같은 사람이라도 건의가 다르면 값이 달라 서로 연결할 수 없어야 한다
        assert_ne!(author_hash(KEY, 1, 10), author_hash(KEY, 1, 11));
        assert_ne!(voter_hash(KEY, 1, 10), voter_hash(KEY, 1, 11));
        // 같은 사람·같은 건의는 항상 같은 값 (본인 확인, 중복 공감 방지)
        assert_eq!(author_hash(KEY, 1, 10), author_hash(KEY, 1, 10));
    }

    #[test]
    fn author_and_vote_hashes_are_separated() {
        // 내가 쓴 건의에 내가 공감해도 두 기록을 서로 대조할 수 없어야 한다
        assert_ne!(author_hash(KEY, 1, 10), voter_hash(KEY, 1, 10));
    }

    #[test]
    fn hashes_depend_on_secret() {
        // 키가 다르면 값이 달라 DB 만으로는 역산할 수 없다
        assert_ne!(author_hash(KEY, 1, 10), author_hash(b"other", 1, 10));
    }

    #[test]
    fn hash_eq_compares_exactly() {
        assert!(hash_eq("abc", "abc"));
        assert!(!hash_eq("abc", "abd"));
        assert!(!hash_eq("abc", "abcd"));
    }
}
