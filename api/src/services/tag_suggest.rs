//! 글쓰기 화면의 태그 자동 추천.
//! 관리자가 관리하는 태그 목록(`tag_vocabulary`) 안에서만 고른다. 지금은 키워드 매칭만 쓰고,
//! 이후 Jev AI 연동이 들어오면 이 파일에서 방식을 고르고 실패 시 키워드 매칭으로 대체한다.

use std::{collections::HashSet, sync::LazyLock};

use regex::Regex;
use sqlx::PgPool;

use super::{tag_vocabulary, tags::normalize_tag, truncate_chars};
use crate::{
    error::AppError,
    models::tag::{SuggestTagsRequest, TagSuggestion, TagSuggestionResponse},
};

/// 추천 개수 상한
const SUGGEST_MAX: usize = 5;
/// 매칭에 쓰는 본문 길이 상한 (앞부분만 본다)
const BODY_MAX_CHARS: usize = 2_000;
const TITLE_MAX_CHARS: usize = 200;
/// 제목에 나온 단어는 본문보다 이 배수만큼 더 친다
const TITLE_WEIGHT: usize = 3;

static IMAGE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!\[[^\]]*\]\([^)]*\)").unwrap());
static LINK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[([^\]]*)\]\([^)]*\)").unwrap());
static URL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https?://\S+").unwrap());

pub async fn suggest(
    pool: &PgPool,
    req: SuggestTagsRequest,
) -> Result<TagSuggestionResponse, AppError> {
    if req.title.trim().is_empty() && req.content.trim().is_empty() {
        return Err(AppError::bad_request("제목이나 본문을 먼저 입력해 주세요"));
    }

    let terms = tag_vocabulary::all_terms(pool).await?;
    let title = truncate_chars(&req.title, TITLE_MAX_CHARS).to_lowercase();
    let body = truncate_chars(&strip_markdown_noise(&req.content), BODY_MAX_CHARS).to_lowercase();
    let exclude: HashSet<String> = req.exclude.iter().map(|t| normalize_tag(t)).collect();

    Ok(TagSuggestionResponse {
        tags: rank(&terms, &title, &body, &exclude),
        source: "keyword",
    })
}

/// 매칭을 방해하는 마크다운 요소 제거: 코드 블록, 이미지, 링크 URL, 맨 URL
fn strip_markdown_noise(markdown: &str) -> String {
    let mut out = String::with_capacity(markdown.len());
    let mut in_code = false;
    for line in markdown.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code = !in_code;
            continue;
        }
        if !in_code {
            out.push_str(line);
            out.push('\n');
        }
    }
    let out = IMAGE_RE.replace_all(&out, " ");
    let out = LINK_RE.replace_all(&out, "$1");
    URL_RE.replace_all(&out, " ").into_owned()
}

/// 태그 목록의 각 항목(이름 + 동의어)이 제목·본문에 나온 횟수로 점수를 매겨 상위 몇 개를 고른다.
/// `title`, `body` 는 이미 소문자여야 한다.
fn rank(
    terms: &[(String, Vec<String>)],
    title: &str,
    body: &str,
    exclude: &HashSet<String>,
) -> Vec<TagSuggestion> {
    let mut scored: Vec<(usize, &str)> = terms
        .iter()
        .filter(|(name, _)| !exclude.contains(name))
        .map(|(name, aliases)| {
            let raw = std::iter::once(name)
                .chain(aliases)
                .map(|kw| TITLE_WEIGHT * count_matches(title, kw) + count_matches(body, kw))
                .sum();
            (raw, name.as_str())
        })
        .filter(|(raw, _)| *raw > 0)
        .collect();

    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1)));
    scored
        .into_iter()
        .take(SUGGEST_MAX)
        .map(|(raw, name)| TagSuggestion {
            name: name.to_string(),
            score: normalize_score(raw),
        })
        .collect()
}

/// 원점수(0~)를 0~1 로. 1회 0.33, 2회 0.5, 6회 0.75 처럼 많이 나올수록 1 에 가까워진다
fn normalize_score(raw: usize) -> f64 {
    let raw = raw as f64;
    (raw / (raw + 2.0) * 100.0).round() / 100.0
}

/// `haystack` 에 `keyword` 가 몇 번 나오는지.
/// 영문·숫자 키워드는 단어 경계를 본다 (`go` 가 `google` 에 걸리지 않게).
/// 한글 등이 섞인 키워드는 조사가 바로 붙으므로(`리액트를`) 부분 일치로 센다.
fn count_matches(haystack: &str, keyword: &str) -> usize {
    if keyword.is_empty() {
        return 0;
    }
    if !keyword.is_ascii() {
        return haystack.matches(keyword).count();
    }
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    haystack
        .match_indices(keyword)
        .filter(|(i, _)| {
            let before = haystack[..*i].chars().next_back();
            let after = haystack[i + keyword.len()..].chars().next();
            !before.is_some_and(is_word) && !after.is_some_and(is_word)
        })
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terms() -> Vec<(String, Vec<String>)> {
        vec![
            (
                "react".into(),
                vec!["jsx".into(), "usestate".into(), "리액트".into()],
            ),
            ("go".into(), vec!["golang".into()]),
            ("rust".into(), vec!["cargo".into(), "axum".into()]),
            ("docker".into(), vec![]),
        ]
    }

    #[test]
    fn ascii_keywords_respect_word_boundaries() {
        assert_eq!(count_matches("google go golang", "go"), 1);
        assert_eq!(count_matches("go, go! (go)", "go"), 3);
        assert_eq!(count_matches("node.js 와 c++", "c++"), 1);
        assert_eq!(count_matches("my_go_var", "go"), 0);
    }

    #[test]
    fn korean_keywords_match_with_particles() {
        assert_eq!(count_matches("리액트를 쓰다가 리액트로", "리액트"), 2);
    }

    #[test]
    fn title_weighs_more_and_results_are_sorted() {
        let title = "axum 으로 api 만들기";
        let body = "docker 로 배포. docker compose 사용. 리액트 프론트";
        let out = rank(&terms(), title, body, &HashSet::new());
        let names: Vec<_> = out.iter().map(|t| t.name.as_str()).collect();
        // rust: 제목 1회 × 3 = 3, docker: 본문 2회 = 2, react: 본문 1회 = 1
        assert_eq!(names, vec!["rust", "docker", "react"]);
        assert_eq!(out[0].score, 0.6);
    }

    #[test]
    fn excluded_and_unmatched_tags_are_left_out() {
        let exclude = HashSet::from(["rust".to_string()]);
        let out = rank(&terms(), "axum", "", &exclude);
        assert!(out.is_empty());
    }

    #[test]
    fn code_blocks_images_and_urls_are_ignored() {
        let md = "본문\n```rust\nlet cargo = 1;\n```\n![docker](https://x.io/docker.png)\n\
                  [문서](https://golang.org) https://react.dev";
        let cleaned = strip_markdown_noise(md);
        assert!(!cleaned.contains("cargo"));
        assert!(!cleaned.contains("docker"));
        assert!(!cleaned.contains("golang"));
        assert!(!cleaned.contains("react"));
        assert!(cleaned.contains("문서"));
    }
}
