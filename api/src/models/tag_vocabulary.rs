use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use time::OffsetDateTime;

/// 태그 추천용 목록의 항목 (태그 + 동의어). GET /api/admin/tag-vocabulary 응답 항목
#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct TagVocabulary {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub aliases: Vec<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

/// POST /api/admin/tag-vocabulary
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTagVocabularyRequest {
    pub name: String,
    pub description: Option<String>,
    pub aliases: Option<Vec<String>>,
}

/// PATCH /api/admin/tag-vocabulary/{id}. 보낸 필드만 바뀌고, `aliases` 는 전체 교체
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTagVocabularyRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub aliases: Option<Vec<String>>,
}
