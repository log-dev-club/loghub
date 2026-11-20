use axum::{
    Router,
    routing::{delete, get, post, put},
};

use crate::{config::Config, handlers::suggestions, rate_limit, state::AppState};

pub fn router(config: &Config) -> Router<AppState> {
    // 도배 방지: 작성만 IP 당 요청 횟수를 제한한다 (IP 는 메모리에만 잠시 머물고 저장되지 않음)
    let limited = Router::new().route("/api/suggestions", post(suggestions::create));
    let limited = rate_limit::limit_per_ip(limited, config);

    Router::new()
        .route("/api/suggestions", get(suggestions::list))
        .route("/api/suggestions/{id}", delete(suggestions::delete))
        .route(
            "/api/suggestions/{id}/vote",
            put(suggestions::vote).delete(suggestions::unvote),
        )
        .merge(limited)
}
