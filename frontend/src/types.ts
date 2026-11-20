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

/** 익명 건의 (서버 응답). 작성자·공감자 정보는 API 에 아예 존재하지 않는다 */
export interface SuggestionRaw {
  id: number
  title: string
  content: string
  /** YYYY-MM-DD (익명성을 위해 시각은 저장하지 않음) */
  createdOn: string
  voteCount: number
  /** 작성자 브라우저가 만든 무작위 값 */
  authorRef: string
  /** SHA-256(작성자 토큰). 브라우저 키로만 "내 건의" 인지 알 수 있다 */
  authorDigest: string
  /** 이 건의 전용 공감 서명 공개키 modulus (hex) */
  voteKey: string
  /** 공감 nullifier 앞 16자리 */
  voteTags: string[]
}

/** 화면용 건의. mine·voted 는 브라우저가 자기 키로 계산한다 */
export interface Suggestion extends SuggestionRaw {
  mine: boolean
  voted: boolean
}

export interface SuggestionKeys {
  postKey: string
  postTokensPerDay: number
}

export interface SignedToken {
  message: string
  signature: string
}

export interface VoteResult {
  voted: boolean
  voteCount: number
}
