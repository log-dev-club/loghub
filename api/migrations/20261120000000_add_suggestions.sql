-- 익명 건의함. 운영자 개념 없이 모든 멤버가 동등하게 쓰고 공감한다.
--
-- 익명성 원칙: 운영자가 DB·서버 설정·컨테이너를 모두 볼 수 있다고 가정한다.
-- 따라서 서버(와 이 DB)에는 "사용자 ↔ 건의/공감" 을 이어 줄 값이 어떤 형태로도 없어야 한다.
-- - 작성·삭제·공감 요청은 세션 쿠키 없이 보내고, 멤버인지는 블라인드 서명 토큰(RFC 9474)으로만 증명한다.
--   서버는 토큰을 서명해 줄 때 내용을 보지 못하므로(블라인드), 나중에 쓰인 토큰이 누구에게 준 것인지 알 수 없다.
-- - "내 건의"·"내 공감" 확인용 비밀 키는 사용자 브라우저에만 있다 (서버로 보내지 않음).
-- - 작성자 id, 닉네임, IP, 정확한 작성 시각은 저장하지 않는다.

CREATE TABLE suggestions (
    id            BIGSERIAL PRIMARY KEY,
    title         TEXT NOT NULL,
    content       TEXT NOT NULL,
    -- 작성자 브라우저가 만든 무작위 값(hex). 작성자 토큰 = HMAC(브라우저 키, "author:" || author_ref)
    author_ref    TEXT NOT NULL,
    -- SHA-256(작성자 토큰). 본인 삭제 시 작성자 토큰을 받아 이 값과 비교한다
    author_digest TEXT NOT NULL,
    -- 이 건의 전용 공감 서명 키 (RSA-2048). 건의마다 키가 달라 공감 토큰을 다른 건의에 쓸 수 없다
    vote_pk_der   BYTEA NOT NULL,
    vote_sk_der   BYTEA NOT NULL,
    -- 접속 기록과 시각을 맞춰 작성자를 추측하지 못하도록 날짜까지만 저장한다
    created_on    DATE NOT NULL DEFAULT CURRENT_DATE
);

-- 공감. nullifier = SHA-256(공감 메시지). 공감 메시지는 브라우저 키로만 만들 수 있다
CREATE TABLE suggestion_votes (
    suggestion_id BIGINT NOT NULL REFERENCES suggestions (id) ON DELETE CASCADE,
    nullifier     TEXT NOT NULL,
    PRIMARY KEY (suggestion_id, nullifier)
);

-- 서버 전역 서명 키 (현재는 작성 토큰용 'post' 하나)
CREATE TABLE suggestion_signing_keys (
    purpose TEXT PRIMARY KEY,
    pk_der  BYTEA NOT NULL,
    sk_der  BYTEA NOT NULL
);

-- 이미 쓴 작성 토큰. SHA-256(토큰 메시지) 만 남겨 같은 토큰을 두 번 쓰지 못하게 한다
CREATE TABLE suggestion_spent_tokens (
    token_digest TEXT PRIMARY KEY
);

-- 작성 토큰 발급 횟수 (사람당 하루 N개). 오늘 것만 남기고 지난 날짜 행은 발급 때 지운다
CREATE TABLE suggestion_post_token_issuance (
    user_id   BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    issued_on DATE NOT NULL DEFAULT CURRENT_DATE,
    issued    INTEGER NOT NULL,
    PRIMARY KEY (user_id, issued_on)
);

-- 공감 토큰 발급 기록 (사람당 건의 하나에 하나). 블라인드된 값의 해시만 남긴다.
-- 같은 브라우저 키로 만든 요청은 항상 같은 값이 되므로, 다른 기기에서 복구 코드로 다시 받는 것은 허용한다.
-- 브라우저는 목록을 볼 때마다 모든 건의에 대해 토큰을 미리 받아 두므로, 이 기록은 "공감했다" 가 아니라 "목록을 봤다" 만 뜻한다.
CREATE TABLE suggestion_vote_token_issuance (
    suggestion_id  BIGINT NOT NULL REFERENCES suggestions (id) ON DELETE CASCADE,
    user_id        BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    blinded_digest TEXT NOT NULL,
    PRIMARY KEY (suggestion_id, user_id)
);
