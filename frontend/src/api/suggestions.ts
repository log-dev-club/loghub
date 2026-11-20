import { api, toQuery } from './client'
import type { Suggestion, VoteResult } from '../types'

export interface SuggestionListParams {
  sort?: 'votes' | 'latest'
  /** 'true' 면 내가 쓴 건의만 */
  mine?: 'true'
}

export const fetchSuggestions = (params: SuggestionListParams = {}) =>
  api<Suggestion[]>(`/api/suggestions${toQuery(params)}`)

export const createSuggestion = (title: string, content: string) =>
  api<Suggestion>('/api/suggestions', {
    method: 'POST',
    body: JSON.stringify({ title, content }),
  })

/** 작성자 본인만 삭제할 수 있다 */
export const deleteSuggestion = (id: number) =>
  api<void>(`/api/suggestions/${id}`, { method: 'DELETE' })

export const voteSuggestion = (id: number) =>
  api<VoteResult>(`/api/suggestions/${id}/vote`, { method: 'PUT' })

export const unvoteSuggestion = (id: number) =>
  api<VoteResult>(`/api/suggestions/${id}/vote`, { method: 'DELETE' })
