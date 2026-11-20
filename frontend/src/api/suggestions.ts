import { api, toQuery } from './client'
import type { SignedToken, SuggestionKeys, SuggestionRaw, VoteResult } from '../types'

/**
 * 익명 건의함 API.
 * 팀원 참고: 작성·삭제·공감·공감 취소는 반드시 `anon()` 으로 보낸다. 세션 쿠키가 함께 가면
 * 서버(=운영자)가 요청한 사람을 알 수 있어 익명이 깨진다. 멤버 증명은 블라인드 서명 토큰으로 한다.
 */
const anon = <T>(path: string, init: RequestInit) =>
  api<T>(path, { ...init, credentials: 'omit' })

export interface SuggestionListParams {
  sort?: 'votes' | 'latest'
}

// --- 로그인 필요 (읽기·토큰 발급: 누가 했는지 알려져도 건의·공감과 연결되지 않음) ---

export const fetchSuggestions = (params: SuggestionListParams = {}) =>
  api<SuggestionRaw[]>(`/api/suggestions${toQuery(params)}`)

export const fetchSuggestionKeys = () => api<SuggestionKeys>('/api/suggestions/keys')

/** postKey: 블라인드에 쓴 작성 키. 그 사이 달이 바뀌어 키가 달라지면 409 */
export const requestPostTokens = (postKey: string, blindedMessages: string[]) =>
  api<{ blindSignatures: string[] }>('/api/suggestions/post-tokens', {
    method: 'POST',
    body: JSON.stringify({ postKey, blindedMessages }),
  })

export const requestVoteTokens = (items: { suggestionId: number; blindedMessage: string }[]) =>
  api<{ items: { suggestionId: number; blindSignature: string }[] }>(
    '/api/suggestions/vote-tokens',
    { method: 'POST', body: JSON.stringify({ items }) },
  )

// --- 익명 (세션 쿠키를 보내지 않음) ---

export const createSuggestion = (body: {
  title: string
  content: string
  authorRef: string
  authorDigest: string
  token: SignedToken
}) => anon<SuggestionRaw>('/api/suggestions', { method: 'POST', body: JSON.stringify(body) })

/** 작성자 토큰을 아는 사람(작성자 본인)만 삭제할 수 있다 */
export const deleteSuggestion = (id: number, authorToken: string) =>
  anon<void>(`/api/suggestions/${id}`, {
    method: 'DELETE',
    body: JSON.stringify({ authorToken }),
  })

export const voteSuggestion = (id: number, token: SignedToken) =>
  anon<VoteResult>(`/api/suggestions/${id}/vote`, { method: 'PUT', body: JSON.stringify(token) })

export const unvoteSuggestion = (id: number, message: string) =>
  anon<VoteResult>(`/api/suggestions/${id}/vote`, {
    method: 'DELETE',
    body: JSON.stringify({ message }),
  })
