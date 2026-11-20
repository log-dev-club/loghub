use axum::{
    Router,
    routing::{get, post, put},
};

use crate::{config::Config, handlers::suggestions, rate_limit, state::AppState};

pub fn router(config: &Config) -> Router<AppState> {
    // 도배 방지: 작성은 RSA 키 생성이 있어 IP 당 요청 횟수를 제한한다 (IP 는 메모리에만 잠시 머물고 저장되지 않음)
    let limited = Router::new().route("/api/suggestions", post(suggestions::create));
    let limited = rate_limit::limit_per_ip(limited, config);

    Router::new()
        .route("/api/suggestions", get(suggestions::list))
        .route("/api/suggestions/keys", get(suggestions::keys))
        .route(
            "/api/suggestions/post-tokens",
            post(suggestions::post_tokens),
        )
        .route(
            "/api/suggestions/vote-tokens",
            post(suggestions::vote_tokens),
        )
        .route(
            "/api/suggestions/{id}",
            axum::routing::delete(suggestions::delete),
        )
        .route(
            "/api/suggestions/{id}/vote",
            put(suggestions::vote).delete(suggestions::unvote),
        )
        .merge(limited)
}
