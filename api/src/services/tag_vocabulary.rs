//! 태그 추천용 태그 목록(태그 + 동의어) 관리. 관리자/최고 관리자만 변경할 수 있다.
//! 게시물의 실제 태그(`tags`)와는 별개이며, 추천 기능이 이 목록 안에서만 태그를 고른다.

use std::collections::HashSet;

use sqlx::{PgPool, Postgres, Transaction};

use super::tags::{TAG_MAX_LEN, normalize_tag};
use crate::{
    error::AppError,
    models::{
        tag_vocabulary::{CreateTagVocabularyRequest, TagVocabulary, UpdateTagVocabularyRequest},
        user::UserRow,
    },
};

const DESCRIPTION_MAX: usize = 200;
const ALIAS_MAX_COUNT: usize = 30;

const SELECT_VOCABULARY: &str = "SELECT v.id, v.name::text AS name, v.description::text AS description, \
            COALESCE(array_agg(a.alias::text ORDER BY a.alias) FILTER (WHERE a.alias IS NOT NULL), \
                     ARRAY[]::text[]) AS aliases, \
            v.created_at, v.updated_at \
     FROM tag_vocabulary v LEFT JOIN tag_aliases a ON a.vocabulary_id = v.id";

/// 전체 목록 (이름순)
pub async fn list(pool: &PgPool, actor: &UserRow) -> Result<Vec<TagVocabulary>, AppError> {
    ensure_admin(actor)?;
    let rows = sqlx::query_as::<_, TagVocabulary>(&format!(
        "{SELECT_VOCABULARY} GROUP BY v.id ORDER BY v.name"
    ))
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn create(
    pool: &PgPool,
    actor: &UserRow,
    req: CreateTagVocabularyRequest,
) -> Result<TagVocabulary, AppError> {
    ensure_admin(actor)?;
    let name = validate_name(&req.name)?;
    let description = validate_description(req.description.as_deref().unwrap_or(""))?;
    let aliases = normalize_aliases(req.aliases.unwrap_or_default(), &name)?;

    let mut tx = pool.begin().await?;
    let inserted: Option<(i64,)> = sqlx::query_as(
        "INSERT INTO tag_vocabulary (name, description) VALUES ($1, $2) \
         ON CONFLICT (name) DO NOTHING RETURNING id",
    )
    .bind(&name)
    .bind(&description)
    .fetch_optional(&mut *tx)
    .await?;
    let (id,) = inserted.ok_or_else(|| AppError::conflict("이미 목록에 있는 태그입니다"))?;
    replace_aliases(&mut tx, id, &aliases).await?;
    tx.commit().await?;

    get(pool, id).await
}

/// 보낸 필드만 수정한다. `aliases` 를 보내면 전체 교체.
pub async fn update(
    pool: &PgPool,
    actor: &UserRow,
    id: i64,
    req: UpdateTagVocabularyRequest,
) -> Result<TagVocabulary, AppError> {
    ensure_admin(actor)?;
    let new_name = req.name.as_deref().map(validate_name).transpose()?;
    let description = req
        .description
        .as_deref()
        .map(validate_description)
        .transpose()?;

    let mut tx = pool.begin().await?;
    let current: Option<(String,)> =
        sqlx::query_as("SELECT name::text FROM tag_vocabulary WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let (current_name,) = current.ok_or_else(not_found)?;
    let name = new_name.unwrap_or(current_name);

    let (duplicate,): (bool,) =
        sqlx::query_as("SELECT EXISTS (SELECT 1 FROM tag_vocabulary WHERE name = $1 AND id <> $2)")
            .bind(&name)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if duplicate {
        return Err(AppError::conflict("이미 목록에 있는 태그입니다"));
    }

    sqlx::query(
        "UPDATE tag_vocabulary SET name = $2, description = COALESCE($3, description), \
                updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(&name)
    .bind(description)
    .execute(&mut *tx)
    .await?;

    match req.aliases {
        Some(aliases) => {
            let aliases = normalize_aliases(aliases, &name)?;
            replace_aliases(&mut tx, id, &aliases).await?;
        },
        // 이름만 바뀐 경우, 새 이름과 같은 동의어는 의미가 없으므로 지운다
        None => {
            sqlx::query("DELETE FROM tag_aliases WHERE vocabulary_id = $1 AND alias = $2")
                .bind(id)
                .bind(&name)
                .execute(&mut *tx)
                .await?;
        },
    }
    tx.commit().await?;

    get(pool, id).await
}

pub async fn delete(pool: &PgPool, actor: &UserRow, id: i64) -> Result<(), AppError> {
    ensure_admin(actor)?;
    let result = sqlx::query("DELETE FROM tag_vocabulary WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(not_found());
    }
    Ok(())
}

/// 추천용: 모든 태그의 (이름, 동의어) 목록. 로그인한 누구나 추천을 받을 수 있으므로 권한 검사 없음
pub(crate) async fn all_terms(pool: &PgPool) -> Result<Vec<(String, Vec<String>)>, AppError> {
    let rows = sqlx::query_as::<_, (String, Vec<String>)>(
        "SELECT v.name::text, \
                COALESCE(array_agg(a.alias::text) FILTER (WHERE a.alias IS NOT NULL), ARRAY[]::text[]) \
         FROM tag_vocabulary v LEFT JOIN tag_aliases a ON a.vocabulary_id = v.id \
         GROUP BY v.id",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

async fn get(pool: &PgPool, id: i64) -> Result<TagVocabulary, AppError> {
    sqlx::query_as::<_, TagVocabulary>(&format!(
        "{SELECT_VOCABULARY} WHERE v.id = $1 GROUP BY v.id"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(not_found)
}

async fn replace_aliases(
    tx: &mut Transaction<'_, Postgres>,
    id: i64,
    aliases: &[String],
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM tag_aliases WHERE vocabulary_id = $1")
        .bind(id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO tag_aliases (vocabulary_id, alias) SELECT $1, unnest($2::text[])")
        .bind(id)
        .bind(aliases)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

fn ensure_admin(actor: &UserRow) -> Result<(), AppError> {
    if actor.is_admin() {
        Ok(())
    } else {
        Err(AppError::Forbidden)
    }
}

fn not_found() -> AppError {
    AppError::not_found("목록에 없는 태그입니다")
}

fn validate_name(raw: &str) -> Result<String, AppError> {
    let name = normalize_tag(raw);
    if name.is_empty() {
        return Err(AppError::bad_request("태그 이름을 입력해 주세요"));
    }
    if name.chars().count() > TAG_MAX_LEN {
        return Err(AppError::bad_request(format!(
            "태그는 {TAG_MAX_LEN}자 이하여야 합니다"
        )));
    }
    Ok(name)
}

fn validate_description(raw: &str) -> Result<String, AppError> {
    let description = raw.trim().to_string();
    if description.chars().count() > DESCRIPTION_MAX {
        return Err(AppError::bad_request(format!(
            "설명은 {DESCRIPTION_MAX}자 이하여야 합니다"
        )));
    }
    Ok(description)
}

/// 동의어 정규화: 태그와 같은 규칙으로 소문자화, 빈 값·중복·태그 이름과 같은 값 제거, 개수/길이 제한
fn normalize_aliases(raw: Vec<String>, name: &str) -> Result<Vec<String>, AppError> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in raw {
        let alias = normalize_tag(&item);
        if alias.is_empty() || alias == name {
            continue;
        }
        if alias.chars().count() > TAG_MAX_LEN {
            return Err(AppError::bad_request(format!(
                "동의어는 {TAG_MAX_LEN}자 이하여야 합니다"
            )));
        }
        if seen.insert(alias.clone()) {
            out.push(alias);
        }
    }
    if out.len() > ALIAS_MAX_COUNT {
        return Err(AppError::bad_request(format!(
            "동의어는 최대 {ALIAS_MAX_COUNT}개까지 가능합니다"
        )));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aliases_are_normalized_and_deduplicated() {
        let raw = vec![
            " JSX ".into(),
            "#useState".into(),
            "jsx".into(),
            "".into(),
            "React".into(),
            "리액트".into(),
        ];
        let out = normalize_aliases(raw, "react").unwrap();
        assert_eq!(out, vec!["jsx", "usestate", "리액트"]);
    }

    #[test]
    fn too_many_aliases_are_rejected() {
        let raw = (0..=ALIAS_MAX_COUNT).map(|i| format!("a{i}")).collect();
        assert!(normalize_aliases(raw, "x").is_err());
    }

    #[test]
    fn name_is_normalized_and_validated() {
        assert_eq!(validate_name("  #Rust ").unwrap(), "rust");
        assert!(validate_name(" # ").is_err());
        assert!(validate_name(&"a".repeat(TAG_MAX_LEN + 1)).is_err());
    }
}
