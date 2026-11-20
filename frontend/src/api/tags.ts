import { api } from './client'
import type { TagCount, TagSuggestionResponse } from '../types'

/** 사용 중인 태그와 게시물 수 (많이 쓰인 순) */
export const fetchTags = () => api<TagCount[]>('/api/tags')

export interface SuggestTagsInput {
  title: string
  content: string
  /** 이미 입력한 태그. 추천에서 빠진다 */
  exclude: string[]
}

/** 제목·본문으로 태그 추천 (로그인 필요). 관리자가 등록한 태그 목록 안에서만 고른다 */
export const suggestTags = (input: SuggestTagsInput) =>
  api<TagSuggestionResponse>('/api/tags/suggestions', {
    method: 'POST',
    body: JSON.stringify(input),
  })
