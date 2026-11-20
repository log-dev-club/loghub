import { api } from './client'
import type { Comment } from '../types'

export const fetchComments = (postId: number) => api<Comment[]>(`/api/posts/${postId}/comments`)

/** parentId 를 넘기면 그 댓글에 다는 답글 */
export const createComment = (postId: number, content: string, parentId?: number) =>
  api<Comment>(`/api/posts/${postId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ content, parentId }),
  })

export const updateComment = (id: number, content: string) =>
  api<Comment>(`/api/comments/${id}`, { method: 'PATCH', body: JSON.stringify({ content }) })

export const deleteComment = (id: number) => api<void>(`/api/comments/${id}`, { method: 'DELETE' })
