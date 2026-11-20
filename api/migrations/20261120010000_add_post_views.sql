-- 게시물을 본 사용자 기록. 조회수를 "로그인한 사람당 한 번" 만 세기 위해 쓴다.
-- 같은 사용자가 같은 게시물을 다시 보면 PK 충돌로 기록이 추가되지 않고, 그때는 posts.view_count 도 올리지 않는다.
-- 비로그인 조회와 작성자 본인 조회는 기록하지 않는다 (services/posts.rs 의 view_post 참고).
CREATE TABLE post_views (
    post_id     BIGINT      NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (post_id, user_id)
);
