use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};

use crate::{
    error::AppError,
    extract::CurrentUser,
    models::tag_vocabulary::{
        CreateTagVocabularyRequest, TagVocabulary, UpdateTagVocabularyRequest,
    },
    services,
    state::AppState,
};

/// GET /api/admin/tag-vocabulary — 관리자/최고 관리자만
pub async fn list(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
) -> Result<Json<Vec<TagVocabulary>>, AppError> {
    Ok(Json(
        services::tag_vocabulary::list(&state.pool, &user).await?,
    ))
}

/// POST /api/admin/tag-vocabulary
pub async fn create(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Json(req): Json<CreateTagVocabularyRequest>,
) -> Result<(StatusCode, Json<TagVocabulary>), AppError> {
    let item = services::tag_vocabulary::create(&state.pool, &user, req).await?;
    Ok((StatusCode::CREATED, Json(item)))
}

/// PATCH /api/admin/tag-vocabulary/{id}
pub async fn update(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<i64>,
    Json(req): Json<UpdateTagVocabularyRequest>,
) -> Result<Json<TagVocabulary>, AppError> {
    Ok(Json(
        services::tag_vocabulary::update(&state.pool, &user, id, req).await?,
    ))
}

/// DELETE /api/admin/tag-vocabulary/{id}
pub async fn delete(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    services::tag_vocabulary::delete(&state.pool, &user, id).await?;
    Ok(StatusCode::NO_CONTENT)
}
