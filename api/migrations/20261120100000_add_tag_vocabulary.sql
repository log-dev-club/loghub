-- 태그 추천용 태그 목록 (관리자가 관리).
-- 게시물의 실제 태그(tags/post_tags)와는 연결하지 않는다. 목록에서 지워도 기존 게시물 태그는 그대로 남는다.

CREATE TABLE tag_vocabulary (
    id           BIGSERIAL    PRIMARY KEY,
    name         VARCHAR(50)  NOT NULL UNIQUE,          -- 추천할 태그 이름 (소문자 정규화)
    description  VARCHAR(200) NOT NULL DEFAULT '',      -- 태그 설명 한 줄 (AI 추천 시 참고용)
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 동의어·키워드. 본문에 이 단어가 나오면 해당 태그를 추천한다 (예: react ← jsx, usestate, 리액트)
CREATE TABLE tag_aliases (
    vocabulary_id  BIGINT      NOT NULL REFERENCES tag_vocabulary(id) ON DELETE CASCADE,
    alias          VARCHAR(50) NOT NULL,                -- 소문자 정규화
    PRIMARY KEY (vocabulary_id, alias)
);
