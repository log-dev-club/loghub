use axum::{
    Router,
    routing::{get, patch},
};

use crate::{handlers::tag_vocabulary, state::AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/admin/tag-vocabulary",
            get(tag_vocabulary::list).post(tag_vocabulary::create),
        )
        .route(
            "/api/admin/tag-vocabulary/{id}",
            patch(tag_vocabulary::update).delete(tag_vocabulary::delete),
        )
}
