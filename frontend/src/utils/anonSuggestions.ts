/**
 * 익명 건의함의 브라우저 쪽 비밀 상태와 토큰 흐름.
 *
 * 운영자가 DB·서버 설정·컨테이너를 모두 볼 수 있다고 가정하므로, "누가 썼는지·누가 공감했는지" 를
 * 알 수 있는 값은 이 브라우저(localStorage)에만 둔다.
 * - 건의함 키(32바이트): 복구 코드. "내 건의"·"내 공감" 판별, 작성자 토큰·공감 메시지 생성에 쓴다. 서버로 보내지 않는다.
 * - 작성 토큰: 로그인 상태로 미리 받아 둔 블라인드 서명 토큰. 건의를 올릴 때 하나씩 쓴다.
 * - 공감 토큰 서명: 건의별로 미리 받아 둔다 (목록을 볼 때마다 모든 건의에 대해 받으므로 받는 것 자체는 의미가 없다).
 *
 * 팀원 참고: 토큰은 "쓰기 직전" 이 아니라 "미리" 받는다. 받는 요청(쿠키 있음)과 쓰는 요청(쿠키 없음)이
 * 시간상 붙어 있으면 운영자가 시각을 맞춰 추측할 여지가 생기기 때문이다.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { blind, finalize, fromHex, parsePublicKey, toHex } from './blindRsa'
import {
  fetchSuggestionKeys,
  requestPostTokens,
  requestVoteTokens,
} from '../api/suggestions'
import type { SignedToken, Suggestion, SuggestionRaw } from '../types'

/** 쌓아 둘 작성 토큰 최대 개수 (넘치면 오래된 것부터 버린다) */
const POST_TOKEN_POOL_MAX = 10
const VOTE_TAG_LEN = 16

/** 작성 토큰. 서명한 작성 키(월별)를 함께 기억해 만료된 것을 버린다 */
interface PostToken extends SignedToken {
  key: string
}

interface Vault {
  /** 건의함 키 (hex 64자) */
  key: string
  postTokens: PostToken[]
  /** 마지막으로 작성 토큰을 받은 날 (YYYY-MM-DD) */
  postTokensFetchedOn?: string
  /** 건의 id → 공감 토큰 서명 (hex) */
  voteSignatures: Record<string, string>
}

const storageKey = (userId: number) => `loghub.suggestions.v1.${userId}`

const utf8 = (text: string) => new TextEncoder().encode(text)

const randomBytes = (length: number) => crypto.getRandomValues(new Uint8Array(length))

const today = () => {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function load(userId: number): Vault {
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Vault>
      if (typeof parsed.key === 'string' && /^[0-9a-f]{64}$/.test(parsed.key)) {
        return {
          key: parsed.key,
          // 작성 키를 기억하지 않는 예전 형식 토큰은 버린다
          postTokens: (parsed.postTokens ?? []).filter((t) => typeof t.key === 'string'),
          postTokensFetchedOn: parsed.postTokensFetchedOn,
          voteSignatures: parsed.voteSignatures ?? {},
        }
      }
    }
  } catch {
    // 손상된 값이면 새 키로 시작한다
  }
  const vault: Vault = { key: toHex(randomBytes(32)), postTokens: [], voteSignatures: {} }
  save(userId, vault)
  return vault
}

function save(userId: number, vault: Vault) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(vault))
  } catch {
    // 저장 공간이 막혀 있으면 이번 화면에서만 유지된다
  }
}

const keyBytes = (vault: Vault) => fromHex(vault.key)

function authorToken(vault: Vault, authorRef: string): Uint8Array {
  return hmac(sha256, keyBytes(vault), utf8(`author:${authorRef}`))
}

function voteMessage(vault: Vault, suggestionId: number): Uint8Array {
  return hmac(sha256, keyBytes(vault), utf8(`vote:${suggestionId}`))
}

/** 공감 블라인드 인수. 같은 키·같은 건의면 항상 같아서 다른 기기에서도 같은 블라인드 값이 나온다 */
function voteBlindRandomness(vault: Vault, suggestionId: number, attempt: number, length: number) {
  const out = new Uint8Array(length)
  for (let i = 0, offset = 0; offset < length; i++, offset += 32) {
    const block = hmac(sha256, keyBytes(vault), utf8(`vote-blind:${suggestionId}:${attempt}:${i}`))
    out.set(block.subarray(0, Math.min(32, length - offset)), offset)
  }
  return out
}

function sameHex(a: string, b: string) {
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.min(a.length, b.length); i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// --- 복구 코드 ---

/** 다른 기기로 옮길 복구 코드 (4자리씩 끊은 hex) */
export function recoveryCode(userId: number): string {
  return load(userId).key.match(/.{4}/g)!.join('-')
}

/** 다른 기기의 복구 코드로 바꾼다. 형식이 틀리면 false */
export function importRecoveryCode(userId: number, code: string): boolean {
  const key = code.toLowerCase().replace(/[^0-9a-f]/g, '')
  if (key.length !== 64) return false
  const vault = load(userId)
  // 공감 토큰은 키에서 나온 값이라 키가 바뀌면 다시 받아야 한다. 작성 토큰은 키와 무관해 유지한다
  save(userId, { ...vault, key, voteSignatures: {} })
  return true
}

// --- 목록 ---

/** 서버 응답에 내 건의·내 공감 여부를 브라우저 키로 계산해 붙인다 */
export function decorate(userId: number, items: SuggestionRaw[]): Suggestion[] {
  const vault = load(userId)
  return items.map((item) => {
    const digest = toHex(sha256(authorToken(vault, item.authorRef)))
    const tag = toHex(sha256(voteMessage(vault, item.id))).slice(0, VOTE_TAG_LEN)
    return {
      ...item,
      mine: sameHex(digest, item.authorDigest),
      voted: item.voteTags.includes(tag),
    }
  })
}

/** 아직 공감 토큰이 없는 건의들의 토큰을 한 번에 받아 둔다 (공감 여부와 상관없이 전부) */
export async function prefetchVoteTokens(userId: number, items: SuggestionRaw[]) {
  const vault = load(userId)
  const pending = items
    .filter((item) => !vault.voteSignatures[item.id])
    .map((item) => {
      const pk = parsePublicKey(item.voteKey)
      const msg = voteMessage(vault, item.id)
      for (let attempt = 0; attempt < 8; attempt++) {
        const blinded = blind(pk, msg, voteBlindRandomness(vault, item.id, attempt, pk.size + 32))
        if (blinded) return { item, pk, msg, blinded }
      }
      throw new Error('공감 토큰을 만들지 못했습니다')
    })
  if (pending.length === 0) return

  const { items: signed } = await requestVoteTokens(
    pending.map(({ item, blinded }) => ({
      suggestionId: item.id,
      blindedMessage: toHex(blinded.blindedMessage),
    })),
  )
  const latest = load(userId)
  if (latest.key !== vault.key) return // 그 사이 복구 코드가 바뀌었다
  for (const { suggestionId, blindSignature } of signed) {
    const p = pending.find(({ item }) => item.id === suggestionId)
    if (!p) continue
    const signature = finalize(p.pk, p.msg, fromHex(blindSignature), p.blinded.inverse)
    latest.voteSignatures[suggestionId] = toHex(signature)
  }
  save(userId, latest)
}

/** 공감 요청에 쓸 토큰. 미리 받지 못했으면 null */
export function voteToken(userId: number, suggestionId: number): SignedToken | null {
  const vault = load(userId)
  const signature = vault.voteSignatures[suggestionId]
  if (!signature) return null
  return { message: toHex(voteMessage(vault, suggestionId)), signature }
}

/** 공감 취소에 쓸 메시지 */
export function voteMessageHex(userId: number, suggestionId: number): string {
  return toHex(voteMessage(load(userId), suggestionId))
}

// --- 작성 ---

/**
 * 하루 한 번 작성 토큰을 받아 둔다. 사용 여부와 상관없이 매일 같은 개수를 요청해야
 * 요청 패턴으로 "토큰을 썼는지" 가 드러나지 않는다. 사이트에 들어올 때마다 부른다.
 */
export async function refillPostTokens(userId: number) {
  const vault = load(userId)
  if (vault.postTokensFetchedOn === today()) return

  const { postKey, previousPostKey, postTokensPerDay } = await fetchSuggestionKeys()
  const pk = parsePublicKey(postKey)
  const prepared = Array.from({ length: postTokensPerDay }, () => {
    const msg = randomBytes(32)
    for (;;) {
      const blinded = blind(pk, msg, randomBytes(pk.size + 32))
      if (blinded) return { msg, blinded }
    }
  })
  const { blindSignatures } = await requestPostTokens(
    postKey,
    prepared.map((p) => toHex(p.blinded.blindedMessage)),
  )
  const fresh: PostToken[] = blindSignatures.map((sig, i) => ({
    key: postKey,
    message: toHex(prepared[i].msg),
    signature: toHex(finalize(pk, prepared[i].msg, fromHex(sig), prepared[i].blinded.inverse)),
  }))

  const latest = load(userId)
  // 서버가 더 이상 받지 않는 키(지난달보다 오래된 것)로 서명된 토큰은 버린다
  const kept = latest.postTokens.filter((t) => t.key === postKey || t.key === previousPostKey)
  save(userId, {
    ...latest,
    postTokens: [...kept, ...fresh].slice(-POST_TOKEN_POOL_MAX),
    postTokensFetchedOn: today(),
  })
}

export function postTokenCount(userId: number): number {
  return load(userId).postTokens.length
}

/** 건의 작성 요청 본문에 들어갈 값. 토큰은 꺼내는 순간 목록에서 빠진다 */
export function preparePost(userId: number) {
  const vault = load(userId)
  const stored = vault.postTokens[0]
  if (!stored) return null
  const token: SignedToken = { message: stored.message, signature: stored.signature }
  const authorRef = toHex(randomBytes(16))
  return {
    token,
    authorRef,
    authorDigest: toHex(sha256(authorToken(vault, authorRef))),
    /** 서버가 토큰을 받았으면(성공, 또는 만료·이미 쓴 토큰이라 409) 호출해 목록에서 지운다 */
    consume: () => {
      const latest = load(userId)
      save(userId, {
        ...latest,
        postTokens: latest.postTokens.filter((t) => t.message !== token.message),
      })
    },
  }
}

/** 내 건의 삭제에 쓸 작성자 토큰 */
export function authorTokenHex(userId: number, authorRef: string): string {
  return toHex(authorToken(load(userId), authorRef))
}
