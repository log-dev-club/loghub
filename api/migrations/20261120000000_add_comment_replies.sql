-- 대댓글(답글) 지원
-- parent_id: 답글이 달린 최상위 댓글 id. 최상위 댓글은 NULL.
--            답글은 1단계만 허용하므로 parent_id 가 가리키는 댓글의 parent_id 는 항상 NULL 이다.
--            ON DELETE CASCADE: 최상위 댓글을 삭제하면 그 아래 답글도 함께 삭제된다.
ALTER TABLE comments
    ADD COLUMN parent_id BIGINT REFERENCES comments(id) ON DELETE CASCADE;

CREATE INDEX idx_comments_parent_id ON comments (parent_id);
