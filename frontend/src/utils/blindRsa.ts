/**
 * RFC 9474 RSA 블라인드 서명의 클라이언트 쪽 (RSABSSA-SHA384-PSSZERO-Deterministic).
 * 서버(api/src/services/suggestions.rs, blind-rsa-signatures 크레이트)와 같은 방식이어야 한다.
 *
 * 팀원 참고: 블라인드 인수 r 을 호출하는 쪽에서 넘겨받는다. 공감 토큰은 브라우저 키로 r 을 만들어
 * 같은 복구 코드를 쓰는 다른 기기에서도 똑같은 블라인드 값을 만들 수 있게 한다.
 * HTTP(비보안 컨텍스트)에서도 동작하도록 WebCrypto 대신 @noble/hashes 를 쓴다.
 */
import { sha384 } from '@noble/hashes/sha2.js'

const E = 65537n
const H_LEN = 48

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error('hex 형식이 아닙니다')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bytesToInt(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : BigInt(`0x${toHex(bytes)}`)
}

function intToBytes(value: bigint, length: number): Uint8Array {
  const hex = value.toString(16).padStart(length * 2, '0')
  if (hex.length > length * 2) throw new Error('정수가 너무 큽니다')
  return fromHex(hex)
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n
  let b = base % mod
  let e = exp
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod
    b = (b * b) % mod
    e >>= 1n
  }
  return result
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b]
  return a
}

function modInv(a: bigint, mod: bigint): bigint {
  let [oldR, r] = [a % mod, mod]
  let [oldS, s] = [1n, 0n]
  while (r !== 0n) {
    const q = oldR / r
    ;[oldR, r] = [r, oldR - q * r]
    ;[oldS, s] = [s, oldS - q * s]
  }
  if (oldR !== 1n) throw new Error('역원이 없습니다')
  return ((oldS % mod) + mod) % mod
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

function mgf1(seed: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let counter = 0, offset = 0; offset < length; counter++) {
    const c = new Uint8Array([counter >>> 24, (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff])
    const block = sha384(concat(seed, c))
    out.set(block.subarray(0, Math.min(block.length, length - offset)), offset)
    offset += block.length
  }
  return out
}

/** EMSA-PSS-ENCODE (SHA-384, MGF1-SHA384, salt 길이 0) */
function pssEncode(msg: Uint8Array, emBits: number): Uint8Array {
  const emLen = Math.ceil(emBits / 8)
  const mHash = sha384(msg)
  const h = sha384(concat(new Uint8Array(8), mHash))
  const db = new Uint8Array(emLen - H_LEN - 1)
  db[db.length - 1] = 0x01
  const mask = mgf1(h, db.length)
  for (let i = 0; i < db.length; i++) db[i] ^= mask[i]
  db[0] &= 0xff >> (8 * emLen - emBits)
  return concat(db, h, new Uint8Array([0xbc]))
}

export interface RsaPublicKey {
  n: bigint
  /** modulus 바이트 길이 */
  size: number
  /** modulus 비트 길이 */
  bits: number
}

/** 서버가 hex 로 준 modulus (e = 65537) */
export function parsePublicKey(modulusHex: string): RsaPublicKey {
  const bytes = fromHex(modulusHex)
  const n = bytesToInt(bytes)
  return { n, size: bytes.length, bits: n.toString(2).length }
}

export interface Blinded {
  blindedMessage: Uint8Array
  /** r^-1 mod n. 서버에 보내지 않는다 */
  inverse: bigint
}

/**
 * 메시지를 블라인드한다. `randomness` 는 modulus 보다 32바이트 이상 길어야 한다 (mod n 편향 제거).
 * r 이 n 과 서로소가 아니면(사실상 일어나지 않음) null 을 돌려주므로 다른 값으로 다시 부른다.
 */
export function blind(pk: RsaPublicKey, msg: Uint8Array, randomness: Uint8Array): Blinded | null {
  if (randomness.length < pk.size + 32) throw new Error('블라인드 난수가 짧습니다')
  const m = bytesToInt(pssEncode(msg, pk.bits - 1))
  if (gcd(m, pk.n) !== 1n) return null
  const r = bytesToInt(randomness) % pk.n
  if (r === 0n || gcd(r, pk.n) !== 1n) return null
  const z = (m * modPow(r, E, pk.n)) % pk.n
  return { blindedMessage: intToBytes(z, pk.size), inverse: modInv(r, pk.n) }
}

/** 서버의 블라인드 서명을 풀어 실제 서명을 얻는다. 서명이 올바르지 않으면 예외 */
export function finalize(
  pk: RsaPublicKey,
  msg: Uint8Array,
  blindSignature: Uint8Array,
  inverse: bigint,
): Uint8Array {
  const s = (bytesToInt(blindSignature) * inverse) % pk.n
  if (!verify(pk, msg, s)) throw new Error('서버 서명이 올바르지 않습니다')
  return intToBytes(s, pk.size)
}

function verify(pk: RsaPublicKey, msg: Uint8Array, s: bigint): boolean {
  return modPow(s, E, pk.n) === bytesToInt(pssEncode(msg, pk.bits - 1))
}
