//! 익명 건의함. 운영자 개념 없이 모든 멤버가 동등하다.
//!
//! 위협 모델 (팀원 참고: 이 파일을 고칠 때 반드시 지킨다)
//! 운영자는 DB, 서버 설정(.env), 컨테이너를 모두 볼 수 있다고 가정한다. 그래서 "서버만 아는 비밀 키로
//! 사용자 id 를 해시" 하는 방식은 익명이 아니다 (운영자가 키와 user_id 를 알면 바로 대조할 수 있다).
//! 대신 서버 쪽 어디에도 "사용자 ↔ 건의/공감" 을 이어 줄 값이 생기지 않게 한다.
//!
//! - 멤버 증명: 로그인한 사용자에게 블라인드 서명 토큰(RFC 9474, RSABSSA-SHA384-PSSZERO-Deterministic)을
//!   발급한다. 서버는 블라인드된 값에 서명하므로 실제 토큰 메시지를 보지 못하고, 나중에 쓰인 토큰이
//!   누구에게 발급된 것인지 서버 키를 갖고 있어도 계산할 수 없다 (블라인드 서명의 무조건적 비연결성).
//! - 작성·삭제·공감·공감 취소 요청은 세션 쿠키 없이 받는다. 이 요청들을 처리하는 함수는 사용자 정보를
//!   인자로 받지 않는다.
//! - 작성 토큰: 월별 키. 사람당 하루 N개 발급, 이번 달·지난달 키로 서명된 것만 받는다(유효기간 제한).
//!   쓴 토큰은 SHA-256 만 남겨 재사용을 막는다.
//! - 공감 토큰: 건의마다 다른 키. 사람당 건의 하나에 블라인드 값 하나만 서명해 1인 1공감을 지킨다.
//! - "내 건의"·"내 공감" 판별에 쓰는 비밀 키는 브라우저에만 있다. 서버는 그 키로 만든 값의 해시만 본다.
//! - 작성자 id, 닉네임, IP, 정확한 작성 시각을 DB 에도 로그에도 남기지 않는다.
//!   이 모듈에서는 tracing 으로 사용자 관련 값이나 건의 내용을 출력하지 않는다.

use std::{collections::HashMap, sync::Arc};

use blind_rsa_signatures::{
    DefaultRng, Deterministic, KeyPair, PSSZero, PublicKey, SecretKey, Sha384, Signature,
};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, QueryBuilder};
use time::{Date, OffsetDateTime};
use tokio::sync::Mutex;

use super::to_hex;
use crate::{
    error::AppError,
    models::{
        suggestion::{
            CreateSuggestionRequest, DeleteSuggestionRequest, PostTokenRequest, PostTokenResponse,
            SignedToken, SuggestionDto, SuggestionKeysDto, SuggestionListQuery, SuggestionRow,
            UnvoteRequest, VoteResult, VoteTokenRequest, VoteTokenResponse, VoteTokenSigned,
        },
        user::UserRow,
    },
};

type BrsaPublicKey = PublicKey<Sha384, PSSZero, Deterministic>;
type BrsaSecretKey = SecretKey<Sha384, PSSZero, Deterministic>;
type BrsaKeyPair = KeyPair<Sha384, PSSZero, Deterministic>;

const RSA_BITS: usize = 2048;
/// RSA-2048 서명·블라인드 메시지 길이 (바이트)
const RSA_BYTES: usize = RSA_BITS / 8;
/// 토큰 메시지·작성자 토큰 길이 (바이트)
const TOKEN_BYTES: usize = 32;
/// author_ref 길이 (바이트)
const AUTHOR_REF_BYTES: usize = 16;
/// 공감 nullifier 중 목록에 내보내는 앞부분 길이 (hex 글자 수)
const VOTE_TAG_LEN: usize = 16;

const TITLE_MAX: usize = 100;
const CONTENT_MAX: usize = 3000;
/// 전체 목록 최대 개수
const LIST_LIMIT: i64 = 200;
/// 사람당 하루에 받을 수 있는 작성 토큰 수
pub const POST_TOKENS_PER_DAY: i64 = 3;
/// 공감 토큰 한 번에 요청할 수 있는 최대 개수
const VOTE_TOKEN_BATCH_MAX: usize = LIST_LIMIT as usize;

/// 월별 작성 키 이름 앞부분 (`post:YYYY-MM`)
const POST_KEY_PREFIX: &str = "post:";

const SUGGESTION_SELECT: &str = "SELECT s.id, s.title, s.content, s.author_ref, s.author_digest, \
            s.vote_pk_der, s.created_on FROM suggestions s";

// ---------------------------------------------------------------------------
// 공통 도우미
// ---------------------------------------------------------------------------

fn sha256_hex(bytes: &[u8]) -> String {
    to_hex(&Sha256::digest(bytes))
}

/// 고정 길이 hex 문자열을 바이트로. 형식이 틀리면 400
fn decode_hex(value: &str, len: usize, label: &str) -> Result<Vec<u8>, AppError> {
    let invalid = || AppError::bad_request(format!("{label} 형식이 올바르지 않습니다"));
    if value.len() != len * 2 {
        return Err(invalid());
    }
    (0..len)
        .map(|i| u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).map_err(|_| invalid()))
        .collect()
}

/// 소문자 hex 인지 검사 (DB 에 그대로 저장하는 값)
fn validate_hex(value: &str, len: usize, label: &str) -> Result<String, AppError> {
    decode_hex(value, len, label)?;
    Ok(value.to_ascii_lowercase())
}

/// 응답 시간 차이로 값을 추측하지 못하도록 끝까지 비교한다
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

fn modulus_hex(pk: &BrsaPublicKey) -> String {
    to_hex(&pk.components().n())
}

fn crypto_error(_: blind_rsa_signatures::Error) -> AppError {
    AppError::Internal("blind signature error".into())
}

/// RSA-2048 키 생성 (CPU 작업이라 blocking 스레드에서). (공개키 DER, 개인키 DER)
async fn generate_key() -> Result<(Vec<u8>, Vec<u8>), AppError> {
    tokio::task::spawn_blocking(|| {
        let kp = BrsaKeyPair::generate(&mut DefaultRng, RSA_BITS).map_err(crypto_error)?;
        Ok((
            kp.pk.to_der().map_err(crypto_error)?,
            kp.sk.to_der().map_err(crypto_error)?,
        ))
    })
    .await?
}

fn parse_pk(der: &[u8]) -> Result<BrsaPublicKey, AppError> {
    BrsaPublicKey::from_der(der).map_err(crypto_error)
}

fn parse_sk(der: &[u8]) -> Result<BrsaSecretKey, AppError> {
    BrsaSecretKey::from_der(der).map_err(crypto_error)
}

/// 블라인드 메시지에 서명 (blocking 스레드에서 여러 개를 한 번에)
async fn blind_sign_all(
    sk: BrsaSecretKey,
    blinded: Vec<Vec<u8>>,
) -> Result<Vec<Vec<u8>>, AppError> {
    tokio::task::spawn_blocking(move || {
        blinded
            .iter()
            .map(|msg| {
                sk.blind_sign(msg)
                    .map(|sig| sig.0)
                    .map_err(|_| AppError::bad_request("서명할 수 없는 값입니다"))
            })
            .collect()
    })
    .await?
}

/// (메시지, 서명) 쌍을 검증하고 메시지 바이트를 돌려준다
fn verify_token(pk: &BrsaPublicKey, token: &SignedToken) -> Result<Vec<u8>, AppError> {
    let message = decode_hex(&token.message, TOKEN_BYTES, "토큰")?;
    let signature = decode_hex(&token.signature, RSA_BYTES, "토큰 서명")?;
    pk.verify(&Signature(signature), None, &message)
        .map_err(|_| AppError::bad_request("유효하지 않은 토큰입니다"))?;
    Ok(message)
}

// ---------------------------------------------------------------------------
// 작성 토큰 키 (전역)
// ---------------------------------------------------------------------------

struct PostKey {
    pk: BrsaPublicKey,
    sk: BrsaSecretKey,
    modulus: String,
}

/// 월별 작성 키 캐시 (purpose → 키)
static POST_KEYS: Mutex<Option<HashMap<String, Arc<PostKey>>>> = Mutex::const_new(None);

/// 작성 키 이름. 월마다 키를 바꿔 토큰 유효기간을 제한한다 (서버 시계 UTC 기준)
fn post_key_purpose(date: Date) -> String {
    format!(
        "{POST_KEY_PREFIX}{:04}-{:02}",
        date.year(),
        u8::from(date.month())
    )
}

fn previous_month(date: Date) -> Date {
    date.replace_day(1)
        .ok()
        .and_then(|first| first.previous_day())
        .unwrap_or(date)
}

/// 이번 달·지난달 작성 키 이름
fn post_key_purposes() -> (String, String) {
    let today = OffsetDateTime::now_utc().date();
    (
        post_key_purpose(today),
        post_key_purpose(previous_month(today)),
    )
}

/// 작성 토큰 서명 키. `create` 가 true 면 DB 에 없을 때 만들어 저장한다.
/// 팀원 참고: 이 키는 DB 에 있어도 익명성에 영향이 없다 (블라인드 서명은 키를 알아도 연결할 수 없음).
/// 키가 새어 나가면 토큰 위조(도배)만 가능해진다. 키를 월마다 바꾸므로 탈퇴한 멤버나 유출된 토큰도
/// 길어야 다음 달까지만 쓸 수 있다 (서버는 토큰 주인을 모르므로 사람별 무효화는 불가능).
async fn post_key(
    pool: &PgPool,
    purpose: &str,
    create: bool,
) -> Result<Option<Arc<PostKey>>, AppError> {
    let mut cache = POST_KEYS.lock().await;
    let cache = cache.get_or_insert_with(HashMap::new);
    if let Some(key) = cache.get(purpose) {
        return Ok(Some(key.clone()));
    }

    let select = "SELECT pk_der, sk_der FROM suggestion_signing_keys WHERE purpose = $1";
    let mut stored: Option<(Vec<u8>, Vec<u8>)> = sqlx::query_as(select)
        .bind(purpose)
        .fetch_optional(pool)
        .await?;
    if stored.is_none() && create {
        let (pk_der, sk_der) = generate_key().await?;
        sqlx::query(
            "INSERT INTO suggestion_signing_keys (purpose, pk_der, sk_der) \
             VALUES ($1, $2, $3) ON CONFLICT (purpose) DO NOTHING",
        )
        .bind(purpose)
        .bind(&pk_der)
        .bind(&sk_der)
        .execute(pool)
        .await?;
        // 다른 서버 프로세스가 먼저 저장했을 수 있으므로 저장된 값을 다시 읽는다
        stored = sqlx::query_as(select)
            .bind(purpose)
            .fetch_optional(pool)
            .await?;
        // 지난달보다 오래된 키는 더 이상 쓰지 않으므로 지운다
        sqlx::query(
            "DELETE FROM suggestion_signing_keys WHERE purpose LIKE 'post:%' AND purpose < $1",
        )
        .bind(post_key_purpose(previous_month(
            OffsetDateTime::now_utc().date(),
        )))
        .execute(pool)
        .await?;
    }
    let Some((pk_der, sk_der)) = stored else {
        return Ok(None);
    };
    let pk = parse_pk(&pk_der)?;
    let key = Arc::new(PostKey {
        modulus: modulus_hex(&pk),
        pk,
        sk: parse_sk(&sk_der)?,
    });
    // 지난 달 키가 캐시에 쌓이지 않도록 이번 달·지난달 것만 남긴다
    let (current, previous) = post_key_purposes();
    cache.retain(|k, _| *k == current || *k == previous);
    cache.insert(purpose.to_string(), key.clone());
    Ok(Some(key))
}

/// 이번 달 작성 키 (없으면 만든다)
async fn current_post_key(pool: &PgPool) -> Result<Arc<PostKey>, AppError> {
    let (current, _) = post_key_purposes();
    post_key(pool, &current, true)
        .await?
        .ok_or_else(|| AppError::Internal("post key missing".into()))
}

/// 만료·위조·이미 쓴 작성 토큰. 브라우저는 409 를 받으면 그 토큰을 버리고 다음 토큰으로 다시 시도한다
fn unusable_post_token() -> AppError {
    AppError::conflict("작성 토큰이 만료되었거나 이미 사용되었습니다")
}

/// GET /api/suggestions/keys
pub async fn keys(pool: &PgPool) -> Result<SuggestionKeysDto, AppError> {
    let current = current_post_key(pool).await?;
    let (_, previous) = post_key_purposes();
    let previous = post_key(pool, &previous, false).await?;
    Ok(SuggestionKeysDto {
        post_key: current.modulus.clone(),
        previous_post_key: previous.map(|k| k.modulus.clone()),
        post_tokens_per_day: POST_TOKENS_PER_DAY,
    })
}

// ---------------------------------------------------------------------------
// 토큰 발급 (로그인 필요. 블라인드된 값만 보므로 무엇에 쓰일지 서버는 모른다)
// ---------------------------------------------------------------------------

/// POST /api/suggestions/post-tokens — 오늘 남은 개수만큼만 서명한다
pub async fn issue_post_tokens(
    pool: &PgPool,
    user: &UserRow,
    req: &PostTokenRequest,
) -> Result<PostTokenResponse, AppError> {
    if req.blinded_messages.len() > POST_TOKENS_PER_DAY as usize {
        return Err(AppError::bad_request("요청한 토큰이 너무 많습니다"));
    }
    let blinded = req
        .blinded_messages
        .iter()
        .map(|m| decode_hex(m, RSA_BYTES, "블라인드 메시지"))
        .collect::<Result<Vec<_>, _>>()?;
    let key = current_post_key(pool).await?;
    // 브라우저가 /keys 를 받은 뒤 달이 바뀌었으면 다른 키로 블라인드한 것이므로 서명하지 않는다
    // (발급 개수도 차감하지 않음. 브라우저는 409 를 받으면 키를 다시 받아 재시도한다)
    if !hash_eq(&req.post_key, &key.modulus) {
        return Err(AppError::conflict(
            "작성 키가 바뀌었습니다. 다시 시도해주세요",
        ));
    }

    let mut tx = pool.begin().await?;
    // 지난 날짜 발급 기록은 쿼터 계산에 필요 없으므로 남기지 않는다
    sqlx::query("DELETE FROM suggestion_post_token_issuance WHERE issued_on < CURRENT_DATE")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO suggestion_post_token_issuance (user_id, issued) VALUES ($1, 0) \
         ON CONFLICT (user_id, issued_on) DO NOTHING",
    )
    .bind(user.id)
    .execute(&mut *tx)
    .await?;
    let (issued,): (i32,) = sqlx::query_as(
        "SELECT issued FROM suggestion_post_token_issuance \
         WHERE user_id = $1 AND issued_on = CURRENT_DATE FOR UPDATE",
    )
    .bind(user.id)
    .fetch_one(&mut *tx)
    .await?;
    let allowed = (POST_TOKENS_PER_DAY - i64::from(issued)).max(0) as usize;
    let blinded: Vec<Vec<u8>> = blinded.into_iter().take(allowed).collect();
    if !blinded.is_empty() {
        sqlx::query(
            "UPDATE suggestion_post_token_issuance SET issued = issued + $2 \
             WHERE user_id = $1 AND issued_on = CURRENT_DATE",
        )
        .bind(user.id)
        .bind(blinded.len() as i32)
        .execute(&mut *tx)
        .await?;
    }
    let signatures = blind_sign_all(key.sk.clone(), blinded).await?;
    tx.commit().await?;

    Ok(PostTokenResponse {
        blind_signatures: signatures.iter().map(|s| to_hex(s)).collect(),
    })
}

/// POST /api/suggestions/vote-tokens — 사람당 건의 하나에 블라인드 값 하나만 서명한다.
/// 같은 블라인드 값을 다시 보내면(같은 복구 코드를 쓰는 다른 기기) 다시 서명해 준다.
pub async fn issue_vote_tokens(
    pool: &PgPool,
    user: &UserRow,
    req: &VoteTokenRequest,
) -> Result<VoteTokenResponse, AppError> {
    if req.items.len() > VOTE_TOKEN_BATCH_MAX {
        return Err(AppError::bad_request("요청한 토큰이 너무 많습니다"));
    }
    let mut items = Vec::with_capacity(req.items.len());
    for item in &req.items {
        let blinded = decode_hex(&item.blinded_message, RSA_BYTES, "블라인드 메시지")?;
        let digest = sha256_hex(&blinded);

        let key: Option<(Vec<u8>,)> =
            sqlx::query_as("SELECT vote_sk_der FROM suggestions WHERE id = $1")
                .bind(item.suggestion_id)
                .fetch_optional(pool)
                .await?;
        // 그 사이 삭제된 건의는 건너뛴다
        let Some((sk_der,)) = key else { continue };

        sqlx::query(
            "INSERT INTO suggestion_vote_token_issuance (suggestion_id, user_id, blinded_digest) \
             VALUES ($1, $2, $3) ON CONFLICT (suggestion_id, user_id) DO NOTHING",
        )
        .bind(item.suggestion_id)
        .bind(user.id)
        .bind(&digest)
        .execute(pool)
        .await?;
        let (stored,): (String,) = sqlx::query_as(
            "SELECT blinded_digest FROM suggestion_vote_token_issuance \
             WHERE suggestion_id = $1 AND user_id = $2",
        )
        .bind(item.suggestion_id)
        .bind(user.id)
        .fetch_one(pool)
        .await?;
        // 처음 받은 것과 다른 값이면 한 사람이 두 번 공감하려는 것이므로 서명하지 않는다
        if !hash_eq(&stored, &digest) {
            continue;
        }

        let sk = tokio::task::spawn_blocking(move || parse_sk(&sk_der)).await??;
        let signature = blind_sign_all(sk, vec![blinded]).await?.remove(0);
        items.push(VoteTokenSigned {
            suggestion_id: item.suggestion_id,
            blind_signature: to_hex(&signature),
        });
    }
    Ok(VoteTokenResponse { items })
}

// ---------------------------------------------------------------------------
// 조회 (로그인 필요. 읽기는 누가 했는지 알려져도 건의·공감과 연결되지 않는다)
// ---------------------------------------------------------------------------

/// GET /api/suggestions
pub async fn list(
    pool: &PgPool,
    query: &SuggestionListQuery,
) -> Result<Vec<SuggestionDto>, AppError> {
    let mut qb = QueryBuilder::<Postgres>::new(SUGGESTION_SELECT);
    match query.sort.as_deref() {
        Some("latest") => qb.push(" ORDER BY s.created_on DESC, s.id DESC"),
        _ => qb.push(
            " ORDER BY (SELECT count(*) FROM suggestion_votes v WHERE v.suggestion_id = s.id) DESC, \
             s.created_on DESC, s.id DESC",
        ),
    };
    qb.push(" LIMIT ").push_bind(LIST_LIMIT);
    let rows: Vec<SuggestionRow> = qb.build_query_as().fetch_all(pool).await?;

    let ids: Vec<i64> = rows.iter().map(|r| r.id).collect();
    let votes: Vec<(i64, String)> = sqlx::query_as(
        "SELECT suggestion_id, nullifier FROM suggestion_votes WHERE suggestion_id = ANY($1)",
    )
    .bind(&ids)
    .fetch_all(pool)
    .await?;
    let mut tags: HashMap<i64, Vec<String>> = HashMap::new();
    for (id, nullifier) in votes {
        tags.entry(id)
            .or_default()
            .push(nullifier[..VOTE_TAG_LEN].to_string());
    }

    rows.into_iter()
        .map(|row| {
            let vote_tags = tags.remove(&row.id).unwrap_or_default();
            to_dto(row, vote_tags)
        })
        .collect()
}

fn to_dto(row: SuggestionRow, vote_tags: Vec<String>) -> Result<SuggestionDto, AppError> {
    Ok(SuggestionDto {
        id: row.id,
        title: row.title,
        content: row.content,
        created_on: row.created_on.to_string(),
        vote_count: vote_tags.len() as i64,
        author_ref: row.author_ref,
        author_digest: row.author_digest,
        vote_key: modulus_hex(&parse_pk(&row.vote_pk_der)?),
        vote_tags,
    })
}

// ---------------------------------------------------------------------------
// 익명 요청 (세션 없음. 이 아래 함수들은 사용자 정보를 받지 않는다)
// ---------------------------------------------------------------------------

/// 작성 토큰을 이번 달 → 지난달 키 순서로 검증한다. 둘 다 아니면(만료·위조) 409
async fn verify_post_token(pool: &PgPool, token: &SignedToken) -> Result<Vec<u8>, AppError> {
    // 형식 오류는 400 으로 먼저 걸러낸다
    decode_hex(&token.message, TOKEN_BYTES, "토큰")?;
    decode_hex(&token.signature, RSA_BYTES, "토큰 서명")?;
    let (current, previous) = post_key_purposes();
    for purpose in [current, previous] {
        if let Some(key) = post_key(pool, &purpose, false).await?
            && let Ok(message) = verify_token(&key.pk, token)
        {
            return Ok(message);
        }
    }
    Err(unusable_post_token())
}

/// POST /api/suggestions — 작성 토큰으로 멤버임을 증명한다
pub async fn create(
    pool: &PgPool,
    req: &CreateSuggestionRequest,
) -> Result<SuggestionDto, AppError> {
    let title = required_text(&req.title, TITLE_MAX, "제목")?;
    let content = required_text(&req.content, CONTENT_MAX, "내용")?;
    let author_ref = validate_hex(&req.author_ref, AUTHOR_REF_BYTES, "작성자 값")?;
    let author_digest = validate_hex(&req.author_digest, 32, "작성자 값")?;
    let message = verify_post_token(pool, &req.token).await?;
    let token_digest = sha256_hex(&message);

    // 이미 쓴 토큰은 RSA 키 생성(비싼 작업) 전에 거른다. 같은 토큰을 반복해 보내 CPU 를 쓰게 하는 것을 막는다
    let (already_spent,): (bool,) = sqlx::query_as(
        "SELECT EXISTS (SELECT 1 FROM suggestion_spent_tokens WHERE token_digest = $1)",
    )
    .bind(&token_digest)
    .fetch_one(pool)
    .await?;
    if already_spent {
        return Err(unusable_post_token());
    }

    let (vote_pk_der, vote_sk_der) = generate_key().await?;

    let mut tx = pool.begin().await?;
    // 위 확인과 이 사이에 같은 토큰이 동시에 들어온 경우는 여기서 한 번 더 막는다
    let spent = sqlx::query(
        "INSERT INTO suggestion_spent_tokens (token_digest) VALUES ($1) ON CONFLICT DO NOTHING",
    )
    .bind(&token_digest)
    .execute(&mut *tx)
    .await?;
    if spent.rows_affected() == 0 {
        return Err(unusable_post_token());
    }
    let (id,): (i64,) = sqlx::query_as(
        "INSERT INTO suggestions (title, content, author_ref, author_digest, vote_pk_der, vote_sk_der) \
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    )
    .bind(title)
    .bind(content)
    .bind(author_ref)
    .bind(author_digest)
    .bind(vote_pk_der)
    .bind(vote_sk_der)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    let row = sqlx::query_as::<_, SuggestionRow>(&format!("{SUGGESTION_SELECT} WHERE s.id = $1"))
        .bind(id)
        .fetch_one(pool)
        .await?;
    to_dto(row, Vec::new())
}

/// DELETE /api/suggestions/{id} — 작성자 토큰을 아는 사람(작성자 본인)만. 관리자도 예외 없음
pub async fn delete(pool: &PgPool, id: i64, req: &DeleteSuggestionRequest) -> Result<(), AppError> {
    let token = decode_hex(&req.author_token, TOKEN_BYTES, "작성자 토큰")?;
    let stored: Option<(String,)> =
        sqlx::query_as("SELECT author_digest FROM suggestions WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    let Some((digest,)) = stored else {
        return Err(AppError::not_found("건의를 찾을 수 없습니다"));
    };
    if !hash_eq(&sha256_hex(&token), &digest) {
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

/// PUT /api/suggestions/{id}/vote — 이 건의 키로 서명된 공감 토큰이 필요하다
pub async fn vote(pool: &PgPool, id: i64, token: &SignedToken) -> Result<VoteResult, AppError> {
    let stored: Option<(Vec<u8>,)> =
        sqlx::query_as("SELECT vote_pk_der FROM suggestions WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    let Some((pk_der,)) = stored else {
        return Err(AppError::not_found("건의를 찾을 수 없습니다"));
    };
    let message = verify_token(&parse_pk(&pk_der)?, token)?;
    sqlx::query(
        "INSERT INTO suggestion_votes (suggestion_id, nullifier) VALUES ($1, $2) \
         ON CONFLICT DO NOTHING",
    )
    .bind(id)
    .bind(sha256_hex(&message))
    .execute(pool)
    .await?;
    Ok(VoteResult {
        voted: true,
        vote_count: vote_count(pool, id).await?,
    })
}

/// DELETE /api/suggestions/{id}/vote — 공감 메시지(브라우저 키로만 만들 수 있음)를 아는 사람만
pub async fn unvote(pool: &PgPool, id: i64, req: &UnvoteRequest) -> Result<VoteResult, AppError> {
    let message = decode_hex(&req.message, TOKEN_BYTES, "토큰")?;
    sqlx::query("DELETE FROM suggestion_votes WHERE suggestion_id = $1 AND nullifier = $2")
        .bind(id)
        .bind(sha256_hex(&message))
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

    #[test]
    fn decode_hex_checks_length_and_chars() {
        assert_eq!(decode_hex("00ff", 2, "x").unwrap(), vec![0, 255]);
        assert!(decode_hex("00f", 2, "x").is_err());
        assert!(decode_hex("zzzz", 2, "x").is_err());
    }

    #[test]
    fn post_key_purpose_rotates_monthly() {
        use time::Month;
        let jan = Date::from_calendar_date(2027, Month::January, 15).unwrap();
        assert_eq!(post_key_purpose(jan), "post:2027-01");
        assert_eq!(post_key_purpose(previous_month(jan)), "post:2026-12");
        let mar1 = Date::from_calendar_date(2026, Month::March, 1).unwrap();
        assert_eq!(post_key_purpose(previous_month(mar1)), "post:2026-02");
    }

    #[test]
    fn hash_eq_compares_exactly() {
        assert!(hash_eq("abc", "abc"));
        assert!(!hash_eq("abc", "abd"));
        assert!(!hash_eq("abc", "abcd"));
    }

    /// 브라우저와 같은 흐름: 블라인드 → 서버 서명 → 언블라인드 → 서버 검증
    #[test]
    fn blind_token_round_trip() {
        let kp = BrsaKeyPair::generate(&mut DefaultRng, RSA_BITS).unwrap();
        let msg = [7u8; TOKEN_BYTES];
        let blinding = kp.pk.blind(&mut DefaultRng, msg).unwrap();
        let blind_sig = kp.sk.blind_sign(&blinding.blind_message).unwrap();
        let sig = kp.pk.finalize(&blind_sig, &blinding, msg).unwrap();

        let token = SignedToken {
            message: to_hex(&msg),
            signature: to_hex(&sig.0),
        };
        assert_eq!(verify_token(&kp.pk, &token).unwrap(), msg.to_vec());

        // 다른 키(다른 건의)로는 검증되지 않아야 한다
        let other = BrsaKeyPair::generate(&mut DefaultRng, RSA_BITS).unwrap();
        assert!(verify_token(&other.pk, &token).is_err());

        // 메시지를 바꾸면 검증되지 않아야 한다
        let forged = SignedToken {
            message: to_hex(&[8u8; TOKEN_BYTES]),
            signature: token.signature.clone(),
        };
        assert!(verify_token(&kp.pk, &forged).is_err());
    }
}
