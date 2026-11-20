-- 게시물 조회수. 상세 조회(GET /api/posts/{id}) 때마다 1씩 올라간다 (작성자 본인이 볼 때는 제외).
-- 기존 게시물은 0 부터 시작한다.
ALTER TABLE posts ADD COLUMN view_count BIGINT NOT NULL DEFAULT 0;
