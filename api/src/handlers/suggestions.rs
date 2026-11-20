//! 익명 건의함 핸들러. 운영자 전용 기능은 없다.
//! 팀원 참고: 사용자 정보는 서비스에서 건의별 HMAC 계산에만 쓰이고, 저장·로그 출력하지 않는다.

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};

use crate::{
    error::AppError,
    extract::CurrentUser,
    models::suggestion::{CreateSuggestionRequest, SuggestionDto, SuggestionListQuery, VoteResult},
    services,
    state::AppState,
};

/// GET /api/suggestions?sort=votes|latest&mine=true
pub async fn list(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Query(query): Query<SuggestionListQuery>,
) -> Result<Json<Vec<SuggestionDto>>, AppError> {
    let secret = &state.config.suggestion_secret;
    Ok(Json(
        services::suggestions::list(&state.pool, secret, &user, &query).await?,
    ))
}

/// POST /api/suggestions
pub async fn create(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Json(req): Json<CreateSuggestionRequest>,
) -> Result<(StatusCode, Json<SuggestionDto>), AppError> {
    let secret = &state.config.suggestion_secret;
    let created = services::suggestions::create(&state.pool, secret, &user, &req).await?;
    Ok((StatusCode::CREATED, Json(created)))
}

/// DELETE /api/suggestions/{id} — 작성자 본인만
pub async fn delete(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let secret = &state.config.suggestion_secret;
    services::suggestions::delete(&state.pool, secret, &user, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// PUT /api/suggestions/{id}/vote
pub async fn vote(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<i64>,
) -> Result<Json<VoteResult>, AppError> {
    let secret = &state.config.suggestion_secret;
    Ok(Json(
        services::suggestions::vote(&state.pool, secret, &user, id).await?,
    ))
}

/// DELETE /api/suggestions/{id}/vote
pub async fn unvote(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<i64>,
) -> Result<Json<VoteResult>, AppError> {
    let secret = &state.config.suggestion_secret;
    Ok(Json(
        services::suggestions::unvote(&state.pool, secret, &user, id).await?,
    ))
}
