import { api } from './client'
import type { TagVocabulary } from '../types'

/** 태그 추천용 목록 관리 API. 관리자/최고 관리자만 호출 가능 */
export interface TagVocabularyInput {
  name: string
  description?: string
  aliases?: string[]
}

export const fetchTagVocabulary = () => api<TagVocabulary[]>('/api/admin/tag-vocabulary')

export const createTagVocabulary = (input: TagVocabularyInput) =>
  api<TagVocabulary>('/api/admin/tag-vocabulary', {
    method: 'POST',
    body: JSON.stringify(input),
  })

/** 보낸 필드만 수정. aliases 는 전체 교체 */
export const updateTagVocabulary = (id: number, input: Partial<TagVocabularyInput>) =>
  api<TagVocabulary>(`/api/admin/tag-vocabulary/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })

export const deleteTagVocabulary = (id: number) =>
  api<void>(`/api/admin/tag-vocabulary/${id}`, { method: 'DELETE' })
