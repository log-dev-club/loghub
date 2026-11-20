//! 댓글 CRUD. 수정은 작성자만, 삭제는 댓글 작성자·게시물 작성자 또는 관리자.
//!
//! 대댓글(답글)은 1단계만 허용한다. 답글에 다시 답글을 달면 같은 최상위 댓글 아래에 붙는다.
//! 최상위 댓글을 삭제하면 그 아래 답글도 함께 삭제된다 (`parent_id` 의 ON DELETE CASCADE).

use sqlx::PgPool;

use super::posts;
use crate::{
    error::AppError,
    models::{
        comment::{CommentDto, CommentRow},
        user::UserRow,
    },
};

const CONTENT_MAX: usize = 2000;

const COMMENT_SELECT: &str = "SELECT c.id, c.post_id, c.parent_id, c.content, c.created_at, \
            c.updated_at, u.nickname, u.avatar_url \
     FROM comments c JOIN users u ON u.id = c.user_id";

fn validate_content(content: &str) -> Result<String, AppError> {
    let content = content.trim();
    if content.is_empty() {
        return Err(AppError::bad_request("댓글 내용을 입력해주세요"));
    }
    if content.chars().count() > CONTENT_MAX {
        return Err(AppError::bad_request(format!(
            "댓글은 {CONTENT_MAX}자 이하여야 합니다"
        )));
    }
    Ok(content.to_string())
}

/// 최상위 댓글과 답글을 모두 오래된 순으로 돌려준다. 묶어서 보여주는 것은 프론트엔드가 한다.
pub async fn list_for_post(pool: &PgPool, post_id: i64) -> Result<Vec<CommentDto>, AppError> {
    posts::owner_id(pool, post_id).await?; // 존재 확인 (404)
    let rows = sqlx::query_as::<_, CommentRow>(&format!(
        "{COMMENT_SELECT} WHERE c.post_id = $1 ORDER BY c.created_at ASC, c.id ASC"
    ))
    .bind(post_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(CommentDto::from).collect())
}

async fn get_comment(pool: &PgPool, comment_id: i64) -> Result<CommentDto, AppError> {
    sqlx::query_as::<_, CommentRow>(&format!("{COMMENT_SELECT} WHERE c.id = $1"))
        .bind(comment_id)
        .fetch_optional(pool)
        .await?
        .map(CommentDto::from)
        .ok_or_else(|| AppError::not_found("댓글을 찾을 수 없습니다"))
}

/// 답글을 달 댓글을 검사하고, 실제로 붙일 최상위 댓글 id 를 돌려준다.
async fn resolve_parent(pool: &PgPool, post_id: i64, parent_id: i64) -> Result<i64, AppError> {
    // (게시물 id, 부모의 부모 id)
    let (parent_post_id, grandparent_id): (i64, Option<i64>) =
        sqlx::query_as("SELECT post_id, parent_id FROM comments WHERE id = $1")
            .bind(parent_id)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| AppError::not_found("답글을 달 댓글을 찾을 수 없습니다"))?;

    if parent_post_id != post_id {
        return Err(AppError::bad_request(
            "같은 게시물의 댓글에만 답글을 달 수 있습니다",
        ));
    }
    // 답글에 단 답글은 같은 최상위 댓글 아래로 붙인다 (1단계 제한)
    Ok(grandparent_id.unwrap_or(parent_id))
}

pub async fn create(
    pool: &PgPool,
    post_id: i64,
    user_id: i64,
    content: &str,
    parent_id: Option<i64>,
) -> Result<CommentDto, AppError> {
    posts::owner_id(pool, post_id).await?;
    let content = validate_content(content)?;
    let parent_id = match parent_id {
        Some(id) => Some(resolve_parent(pool, post_id, id).await?),
        None => None,
    };

    let (id,): (i64,) = sqlx::query_as(
        "INSERT INTO comments (post_id, user_id, content, parent_id) \
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(post_id)
    .bind(user_id)
    .bind(content)
    .bind(parent_id)
    .fetch_one(pool)
    .await?;

    get_comment(pool, id).await
}

/// (댓글 작성자 id, 게시물 작성자 id)
async fn owners(pool: &PgPool, comment_id: i64) -> Result<(i64, i64), AppError> {
    sqlx::query_as::<_, (i64, i64)>(
        "SELECT c.user_id, p.user_id FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = $1",
    )
    .bind(comment_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::not_found("댓글을 찾을 수 없습니다"))
}

pub async fn update(
    pool: &PgPool,
    comment_id: i64,
    user_id: i64,
    content: &str,
) -> Result<CommentDto, AppError> {
    let (author_id, _) = owners(pool, comment_id).await?;
    if author_id != user_id {
        return Err(AppError::Forbidden);
    }
    let content = validate_content(content)?;

    sqlx::query("UPDATE comments SET content = $2, updated_at = now() WHERE id = $1")
        .bind(comment_id)
        .bind(content)
        .execute(pool)
        .await?;

    get_comment(pool, comment_id).await
}

/// 최상위 댓글을 지우면 DB 의 ON DELETE CASCADE 로 그 아래 답글도 함께 지워진다.
pub async fn delete(pool: &PgPool, comment_id: i64, actor: &UserRow) -> Result<(), AppError> {
    let (author_id, post_owner_id) = owners(pool, comment_id).await?;
    if author_id != actor.id && post_owner_id != actor.id && !actor.is_admin() {
        return Err(AppError::Forbidden);
    }
    sqlx::query("DELETE FROM comments WHERE id = $1")
        .bind(comment_id)
        .execute(pool)
        .await?;
    Ok(())
}
