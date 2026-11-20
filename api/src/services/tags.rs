use sqlx::PgPool;

use crate::{error::AppError, models::tag::TagCount};

/// 태그 이름 최대 길이 (게시물 태그, 태그 추천 목록 공통)
pub(crate) const TAG_MAX_LEN: usize = 50;

/// 태그 한 개 정규화: 앞뒤 공백 제거, 선행 `#` 제거, 소문자.
/// 게시물 태그와 태그 추천 목록이 같은 규칙을 쓰도록 여기 한 곳에 둔다.
pub(crate) fn normalize_tag(raw: &str) -> String {
    raw.trim().trim_start_matches('#').trim().to_lowercase()
}

/// 사용 중인 태그와 게시물 수 (많이 쓰인 순). 게시물이 하나도 없는 태그는 제외.
pub async fn list(pool: &PgPool) -> Result<Vec<TagCount>, AppError> {
    let rows = sqlx::query_as::<_, TagCount>(
        "SELECT t.name::text AS name, count(pt.post_id) AS post_count \
         FROM tags t JOIN post_tags pt ON pt.tag_id = t.id \
         GROUP BY t.id ORDER BY post_count DESC, t.name ASC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}
