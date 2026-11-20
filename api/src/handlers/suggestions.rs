//! 익명 건의함 핸들러. 운영자 전용 기능은 없다.
//! 팀원 참고: 작성·삭제·공감·공감 취소 핸들러에는 `CurrentUser`/`MaybeUser` 를 절대 넣지 않는다.
//! 이 요청들은 세션 쿠키 없이 오며, 멤버 증명은 블라인드 서명 토큰으로만 한다 (services/suggestions.rs 참고).

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};

use crate::{
    error::AppError,
    extract::CurrentUser,
    models::suggestion::{
        CreateSuggestionRequest, DeleteSuggestionRequest, PostTokenRequest, PostTokenResponse,
        SignedToken, SuggestionDto, SuggestionKeysDto, SuggestionListQuery, UnvoteRequest,
        VoteResult, VoteTokenRequest, VoteTokenResponse,
    },
    services,
    state::AppState,
};

/// GET /api/suggestions?sort=votes|latest (로그인 필요)
pub async fn list(
    State(state): State<AppState>,
    CurrentUser(_user): CurrentUser,
    Query(query): Query<SuggestionListQuery>,
) -> Result<Json<Vec<SuggestionDto>>, AppError> {
    Ok(Json(
        services::suggestions::list(&state.pool, &query).await?,
    ))
}

/// GET /api/suggestions/keys (로그인 필요)
pub async fn keys(
    State(state): State<AppState>,
    CurrentUser(_user): CurrentUser,
) -> Result<Json<SuggestionKeysDto>, AppError> {
    Ok(Json(services::suggestions::keys(&state.pool).await?))
}

/// POST /api/suggestions/post-tokens (로그인 필요)
pub async fn post_tokens(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Json(req): Json<PostTokenRequest>,
) -> Result<Json<PostTokenResponse>, AppError> {
    Ok(Json(
        services::suggestions::issue_post_tokens(&state.pool, &user, &req).await?,
    ))
}

/// POST /api/suggestions/vote-tokens (로그인 필요)
pub async fn vote_tokens(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Json(req): Json<VoteTokenRequest>,
) -> Result<Json<VoteTokenResponse>, AppError> {
    Ok(Json(
        services::suggestions::issue_vote_tokens(&state.pool, &user, &req).await?,
    ))
}

/// POST /api/suggestions (익명)
pub async fn create(
    State(state): State<AppState>,
    Json(req): Json<CreateSuggestionRequest>,
) -> Result<(StatusCode, Json<SuggestionDto>), AppError> {
    let created = services::suggestions::create(&state.pool, &req).await?;
    Ok((StatusCode::CREATED, Json(created)))
}

/// DELETE /api/suggestions/{id} (익명, 작성자 토큰 필요)
pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<DeleteSuggestionRequest>,
) -> Result<StatusCode, AppError> {
    services::suggestions::delete(&state.pool, id, &req).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// PUT /api/suggestions/{id}/vote (익명, 공감 토큰 필요)
pub async fn vote(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(token): Json<SignedToken>,
) -> Result<Json<VoteResult>, AppError> {
    Ok(Json(
        services::suggestions::vote(&state.pool, id, &token).await?,
    ))
}

/// DELETE /api/suggestions/{id}/vote (익명, 공감 메시지 필요)
pub async fn unvote(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<UnvoteRequest>,
) -> Result<Json<VoteResult>, AppError> {
    Ok(Json(
        services::suggestions::unvote(&state.pool, id, &req).await?,
    ))
}
