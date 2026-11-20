// 백엔드 DTO 와 1:1 (docs/api.md 참고). 필드명은 camelCase.

export interface Author {
  nickname: string
  avatarUrl?: string
}

/** 목록 항목 (GET /api/posts). content 없음 */
export interface PostSummary {
  id: number
  title: string
  excerpt: string
  author: Author
  tags: string[]
  createdAt: string // RFC 3339
  updatedAt: string
  commentCount: number
  starCount: number
  starred: boolean
  hasImage: boolean
}

/** 상세 (GET /api/posts/{id}) */
export interface PostDetail extends PostSummary {
  content: string
  attachments: Attachment[]
}

export interface PostPage {
  items: PostSummary[]
  page: number
  limit: number
  total: number
}

export interface Comment {
  id: number
  postId: number
  content: string
  author: Author
  createdAt: string
  updatedAt: string
}

export interface Attachment {
  id: number
  postId: number
  originalName: string
  hashedName: string
  size: number
  sentAt: number // ms epoch
  downloadUrl: string
  createdAt: string
}

/** POST /api/images 응답. url 을 그대로 마크다운 이미지 문법에 삽입 */
export interface UploadedImage {
  url: string
}

export type UserRole = 'user' | 'admin' | 'super_admin'

export interface UserProfile {
  id: number
  nickname: string
  avatarUrl?: string
  bio?: string
  /** GitHub 로 가입/연동한 경우 GitHub 로그인명 */
  githubLogin?: string
  role: UserRole
  createdAt: string
  postCount: number
  starCount: number
}

export interface TagCount {
  name: string
  postCount: number
}

/** POST /api/tags/suggestions 응답의 추천 태그. score 는 0~1 */
export interface TagSuggestion {
  name: string
  score: number
}

export interface TagSuggestionResponse {
  tags: TagSuggestion[]
  /** 추천 방식. 지금은 키워드 매칭(keyword)만 있다 */
  source: 'keyword' | 'jev'
}

/** 태그 추천용 목록 항목 (GET /api/admin/tag-vocabulary) */
export interface TagVocabulary {
  id: number
  /** 추천할 태그 이름 (소문자) */
  name: string
  /** 태그 설명 한 줄. 없으면 빈 문자열 */
  description: string
  /** 동의어·키워드 (소문자, 이름순) */
  aliases: string[]
  createdAt: string
  updatedAt: string
}

/** GET /api/admin/users 목록 항목 */
export interface AdminUserSummary {
  id: number
  nickname: string
  avatarUrl?: string
  role: UserRole
  createdAt: string
  postCount: number
}

export interface AdminUserPage {
  items: AdminUserSummary[]
  page: number
  limit: number
  total: number
}
