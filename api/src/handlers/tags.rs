use axum::{Json, extract::State};

use crate::{
    error::AppError,
    extract::CurrentUser,
    models::tag::{SuggestTagsRequest, TagCount, TagSuggestionResponse},
    services,
    state::AppState,
};

/// GET /api/tags — 사용 중인 태그 목록 (게시물 수 내림차순)
pub async fn list(State(state): State<AppState>) -> Result<Json<Vec<TagCount>>, AppError> {
    Ok(Json(services::tags::list(&state.pool).await?))
}

/// POST /api/tags/suggestions — 제목·본문으로 태그 추천 (로그인 필요)
pub async fn suggest(
    State(state): State<AppState>,
    CurrentUser(_user): CurrentUser,
    Json(req): Json<SuggestTagsRequest>,
) -> Result<Json<TagSuggestionResponse>, AppError> {
    Ok(Json(
        services::tag_suggest::suggest(&state.pool, req).await?,
    ))
}
