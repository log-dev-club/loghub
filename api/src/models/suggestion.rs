//! 익명 건의함 DTO.
//! 팀원 참고: 이 모듈의 어떤 구조체에도 작성자(닉네임, user_id 등) 필드를 추가하지 않는다.

use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use time::Date;

/// suggestions 조회 행. author_hash 는 서버 안에서 "내 건의" 판별에만 쓰고 응답에는 넣지 않는다
#[derive(Debug, FromRow)]
pub struct SuggestionRow {
    pub id: i64,
    pub title: String,
    pub content: String,
    pub author_hash: String,
    pub created_on: Date,
    pub vote_count: i64,
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
    /// 현재 사용자가 공감했는지
    pub voted: bool,
    /// 현재 사용자가 쓴 건의인지 (본인에게만 true 로 보인다)
    pub mine: bool,
}

impl SuggestionDto {
    pub fn from_row(r: SuggestionRow, voted: bool, mine: bool) -> Self {
        Self {
            id: r.id,
            title: r.title,
            content: r.content,
            created_on: r.created_on.to_string(),
            vote_count: r.vote_count,
            voted,
            mine,
        }
    }
}

/// GET /api/suggestions 쿼리
#[derive(Debug, Default, Deserialize)]
pub struct SuggestionListQuery {
    /// `votes`(공감순, 기본) 또는 `latest`(최신순)
    pub sort: Option<String>,
    /// true 면 내가 쓴 건의만
    pub mine: Option<bool>,
}

/// POST /api/suggestions
#[derive(Debug, Deserialize)]
pub struct CreateSuggestionRequest {
    pub title: String,
    pub content: String,
}

/// PUT/DELETE /api/suggestions/{id}/vote 응답
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoteResult {
    pub voted: bool,
    pub vote_count: i64,
}
