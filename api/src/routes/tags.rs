use axum::{
    Router,
    routing::{get, post},
};

use crate::{handlers::tags, state::AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tags", get(tags::list))
        .route("/api/tags/suggestions", post(tags::suggest))
}
