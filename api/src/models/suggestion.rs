//! 익명 건의함 DTO.
//! 팀원 참고: 이 모듈의 어떤 구조체에도 작성자·공감자(닉네임, user_id 등) 필드를 추가하지 않는다.
//! 바이너리 값(토큰, 서명, 공개키)은 모두 소문자 hex 문자열로 주고받는다.

use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use time::Date;

/// suggestions 조회 행
#[derive(Debug, FromRow)]
pub struct SuggestionRow {
    pub id: i64,
    pub title: String,
    pub content: String,
    pub author_ref: String,
    pub author_digest: String,
    pub vote_pk_der: Vec<u8>,
    pub created_on: Date,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionDto {
    pub id: i64,
    pub title: String,
    pub content: String,
    /// `YYYY-MM-DD`. 시각은 저장하지 않는다
    pub created_on: String,
    pub vote_count: i64,
    /// 작성자 브라우저가 만든 무작위 값. 브라우저가 자기 키로 "내 건의" 인지 판별할 때 쓴다
    pub author_ref: String,
    /// SHA-256(작성자 토큰). 브라우저 키 없이는 누구 것인지 알 수 없다
    pub author_digest: String,
    /// 이 건의 전용 공감 서명 공개키의 modulus (e = 65537)
    pub vote_key: String,
    /// 공감 nullifier 앞 16자리. 브라우저가 자기 공감 여부를 스스로 확인할 때 쓴다
    pub vote_tags: Vec<String>,
}

/// GET /api/suggestions 쿼리
#[derive(Debug, Default, Deserialize)]
pub struct SuggestionListQuery {
    /// `votes`(공감순, 기본) 또는 `latest`(최신순)
    pub sort: Option<String>,
}

/// GET /api/suggestions/keys 응답
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionKeysDto {
    /// 작성 토큰 서명 공개키의 modulus (e = 65537)
    pub post_key: String,
    /// 하루에 받을 수 있는 작성 토큰 수
    pub post_tokens_per_day: i64,
}

/// POST /api/suggestions/post-tokens
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostTokenRequest {
    pub blinded_messages: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostTokenResponse {
    /// 요청 순서대로. 오늘 남은 개수만큼만 서명하므로 요청보다 적을 수 있다
    pub blind_signatures: Vec<String>,
}

/// POST /api/suggestions/vote-tokens
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoteTokenRequest {
    pub items: Vec<VoteTokenItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoteTokenItem {
    pub suggestion_id: i64,
    pub blinded_message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoteTokenResponse {
    pub items: Vec<VoteTokenSigned>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoteTokenSigned {
    pub suggestion_id: i64,
    pub blind_signature: String,
}

/// 블라인드 서명을 풀어 얻은 (메시지, 서명) 쌍
#[derive(Debug, Deserialize)]
pub struct SignedToken {
    pub message: String,
    pub signature: String,
}

/// POST /api/suggestions (세션 없이 보낸다)
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSuggestionRequest {
    pub title: String,
    pub content: String,
    pub author_ref: String,
    pub author_digest: String,
    pub token: SignedToken,
}

/// DELETE /api/suggestions/{id} (세션 없이 보낸다)
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSuggestionRequest {
    pub author_token: String,
}

/// DELETE /api/suggestions/{id}/vote (세션 없이 보낸다)
#[derive(Debug, Deserialize)]
pub struct UnvoteRequest {
    pub message: String,
}

/// PUT/DELETE /api/suggestions/{id}/vote 응답
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoteResult {
    pub voted: bool,
    pub vote_count: i64,
}
