use serde::Serialize;
use sqlx::FromRow;

/// GET /api/tags 항목
#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub name: String,
    pub post_count: i64,
}

/// POST /api/tags/suggestions 요청
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestTagsRequest {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub content: String,
    /// 이미 입력한 태그. 추천에서 뺀다
    #[serde(default)]
    pub exclude: Vec<String>,
}

/// 추천 태그 한 개. `score` 는 0~1 (높을수록 관련성 높음)
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TagSuggestion {
    pub name: String,
    pub score: f64,
}

/// POST /api/tags/suggestions 응답. `source` 는 추천 방식 (`keyword` / 이후 `jev`)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSuggestionResponse {
    pub tags: Vec<TagSuggestion>,
    pub source: &'static str,
}
