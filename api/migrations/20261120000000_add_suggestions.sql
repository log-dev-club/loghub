-- 익명 건의함. 운영자 개념 없이 모든 멤버가 동등하게 쓰고 공감한다.
-- 익명성 원칙: 작성자의 user_id, 닉네임, IP, 정확한 작성 시각은 어떤 형태로도 저장하지 않는다.
CREATE TABLE suggestions (
    id          BIGSERIAL PRIMARY KEY,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL,
    -- HMAC-SHA256(서버 비밀 키, "author:사용자id:건의id")
    -- 로그인한 본인만 "내 건의" 를 다시 찾고 삭제할 수 있게 하는 값.
    -- 건의마다 값이 달라 같은 사람이 쓴 건의끼리 묶을 수 없고, 비밀 키 없이 DB 만으로는 작성자를 알 수 없다.
    author_hash TEXT NOT NULL,
    -- 접속 기록과 시각을 맞춰 작성자를 추측하지 못하도록 날짜까지만 저장한다
    created_on  DATE NOT NULL DEFAULT CURRENT_DATE
);

-- 공감. voter_hash = HMAC-SHA256(서버 비밀 키, "vote:사용자id:건의id")
CREATE TABLE suggestion_votes (
    suggestion_id BIGINT NOT NULL REFERENCES suggestions (id) ON DELETE CASCADE,
    voter_hash    TEXT NOT NULL,
    PRIMARY KEY (suggestion_id, voter_hash)
);
