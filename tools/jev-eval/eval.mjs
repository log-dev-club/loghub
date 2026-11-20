// 태그 추천 3단계 시험: 키워드 매칭(현재 서버) 과 Jev AI 결과를 샘플 글로 비교한다.
// 앱 코드는 바꾸지 않는다. 로컬에서 api 서버를 띄운 상태로 실행한다.
//
//   node eval.mjs seed   # 샘플 태그 목록을 로컬 DB 에 등록 (이미 있으면 건너뜀)
//   node eval.mjs run    # 샘플 글마다 두 방식으로 추천 → results/ 에 비교 리포트 저장
//
// 팀원 참고: 실제 팀 게시물은 쓰지 않는다. sample-posts.json 의 공개 가능한 샘플 글만 Jev 로 보낸다.
// 실제 글로 시험하는 것은 팀이 외부 전송에 동의한 뒤에 한다 (기획서 10장).

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const env = (key, fallback) => process.env[key] ?? fallback
const LOGHUB_URL = env('LOGHUB_URL', 'http://127.0.0.1:8080')
const ADMIN_NICKNAME = env('LOGHUB_ADMIN_NICKNAME', 'admin')
const ADMIN_PASSWORD = env('LOGHUB_ADMIN_PASSWORD')
const JEV_API_URL = env('JEV_API_URL')
const JEV_API_KEY = env('JEV_API_KEY')
const JEV_MODEL = env('JEV_MODEL', 'jev-latest')
const JEV_THRESHOLD = Number(env('JEV_THRESHOLD', '0.6'))
const JEV_TIMEOUT_MS = Number(env('JEV_TIMEOUT_MS', '5000'))

const SUGGEST_MAX = 5
// 짧은 글·일상 글용 태그. 기술 주제 태그 비교가 목적이므로 후보와 결과에서 뺀다 (s11·s12 는 주제 태그가 없어야 할 글)
// 팀원 참고: '기타' 는 동의어(일상, 잡담, 공지, 일정, 근황, 스터디, 모임)로만 추천되는 일반 태그다.
//   서버 코드에 특별 처리는 없고, 태그 목록(관리자 화면 / sample-vocabulary.json)에 넣는 것만으로 동작한다.
//   그래서 s12 "주간 스터디 일정 공지" 에도 '기타' 가 붙는데, 이 시험에서 그걸 오답으로 세지 않도록 여기서 뺀다.
//   이름을 바꾸면 sample-vocabulary.json 의 항목 이름도 같이 바꾼다.
const MISC_TAG = '기타'
const BODY_MAX_CHARS = 2000
const TITLE_MAX_CHARS = 200

// ---------------------------------------------------------------------------
// Jev 호출 — 공식 문서를 확인한 뒤 이 함수만 채우면 된다
// ---------------------------------------------------------------------------

/**
 * Jev 에 글과 후보 태그를 넘기고 태그별 확률을 받는다.
 *
 * @param {{ title: string, body: string, candidates: { name: string, description: string }[] }} input
 *   title/body 는 서버와 같은 방식으로 전처리된 값 (코드 블록·이미지·URL 제거, 길이 제한)
 * @param {AbortSignal} signal 타임아웃용. fetch 에 그대로 넘긴다
 * @returns {Promise<{ name: string, score: number }[]>} 후보 이름과 0~1 확률. 순서·개수 제한은 호출부가 처리
 *
 * 팀원 참고: 공식 문서 기준 (2026-11-20 확인)
 *   - POST https://api.typesafe.ai/v1/systemone, 헤더 Authorization: Bearer <키>  (https://docs.typesafe.ai/api/system-one)
 *   - 모델은 요청 본문 `model` 필드. 예시는 별칭 jev-latest, 고정 ID 는 jev-1.14.0  (https://docs.typesafe.ai/models)
 *   - Choice 질문은 후보 중 **하나만** 고른다 (확률 합 1). 다중 라벨이 없으므로 후보마다 Noul(예/아니오) 질문을 하나씩 만든다.
 *     질문 여러 개를 한 요청에 담을 수 있고 병렬로 평가되므로 HTTP 호출은 글당 1회, 질문 수만 후보 수만큼 늘어난다.
 *   - 응답: answers.<질문 ID>.noul = 0~1 확률 ("예" 일 확률)
 *   - 질문 수 제한은 없고 컨텍스트 한도만 있다 (요청 전체 64k 토큰, state + 질문 하나 32k 토큰)
 */
async function callJev({ title, body, candidates }, signal) {
  const url = JEV_API_URL ?? 'https://api.typesafe.ai/v1/systemone'
  // 질문 ID 는 모델에 전달되지 않으므로 태그 이름 대신 순번을 쓰고 응답에서 다시 이름으로 바꾼다
  const questions = {}
  candidates.forEach((c, i) => {
    questions[`t${i}`] = {
      type: 'noul',
      instructions: `이 글의 주제를 나타내는 태그로 "${c.name}" (${c.description}) 이(가) 적절한가? 글이 이 주제를 직접 다루면 예, 지나가듯 언급하거나 비교 대상으로만 나오면 아니오.`,
    }
  })

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${JEV_API_KEY}` },
    body: JSON.stringify({ model: JEV_MODEL, state: { title, body }, questions }),
    signal,
  })
  if (!res.ok) {
    // 응답 본문만 남긴다. 요청 헤더(키)는 로그에 넣지 않는다
    const detail = (await res.text().catch(() => '')).slice(0, 200)
    throw new Error(`Jev HTTP ${res.status} ${detail}`)
  }
  const data = await res.json()
  return candidates
    .map((c, i) => ({ name: c.name, score: data.answers?.[`t${i}`]?.noul }))
    .filter((t) => typeof t.score === 'number')
}

// ---------------------------------------------------------------------------
// 서버와 같은 전처리 (api/src/services/tag_suggest.rs 와 맞춘다)
// ---------------------------------------------------------------------------

function stripMarkdownNoise(markdown) {
  let inCode = false
  const lines = []
  for (const line of markdown.split('\n')) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inCode = !inCode
      continue
    }
    if (!inCode) lines.push(line)
  }
  return lines
    .join('\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
}

const takeChars = (s, n) => Array.from(s).slice(0, n).join('')

// ---------------------------------------------------------------------------
// loghub API
// ---------------------------------------------------------------------------

async function login() {
  if (!ADMIN_PASSWORD) {
    throw new Error('LOGHUB_ADMIN_PASSWORD 환경 변수가 필요합니다 (관리자 계정 비밀번호)')
  }
  const res = await fetch(`${LOGHUB_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: ADMIN_NICKNAME, password: ADMIN_PASSWORD }),
  })
  if (!res.ok) throw new Error(`로그인 실패 (${res.status}): ${await res.text()}`)
  const session = res.headers.getSetCookie().find((c) => c.startsWith('session='))
  if (!session) throw new Error('로그인 응답에 session 쿠키가 없습니다')
  return session.split(';')[0]
}

async function api(cookie, path, init = {}) {
  const res = await fetch(`${LOGHUB_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...init.headers },
  })
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  return { status: res.status, data }
}

const readJson = async (name) => JSON.parse(await readFile(join(HERE, name), 'utf8'))

// ---------------------------------------------------------------------------
// 명령
// ---------------------------------------------------------------------------

async function seed() {
  const cookie = await login()
  const vocabulary = await readJson('sample-vocabulary.json')
  for (const item of vocabulary) {
    const { status, data } = await api(cookie, '/api/admin/tag-vocabulary', {
      method: 'POST',
      body: JSON.stringify(item),
    })
    const note = status === 201 ? '등록' : status === 409 ? '이미 있음' : `실패 ${status} ${data?.error ?? ''}`
    console.log(`${item.name.padEnd(14)} ${note}`)
  }
}

async function run() {
  const cookie = await login()
  const posts = await readJson('sample-posts.json')
  const vocab = await api(cookie, '/api/admin/tag-vocabulary')
  if (vocab.status !== 200) throw new Error(`태그 목록 조회 실패 (${vocab.status})`)
  // Jev 후보에서 '기타' 를 뺀다. 넣으면 Jev 에 "기타가 적절한가?" 를 묻게 되는데, 주제 태그 비교와 상관없는 질문이다
  const candidates = vocab.data
    .filter(({ name }) => name !== MISC_TAG)
    .map(({ name, description }) => ({ name, description }))
  const candidateNames = new Set(candidates.map((c) => c.name))
  if (candidates.length === 0) throw new Error('태그 목록이 비어 있습니다. 먼저 `node eval.mjs seed`')

  const useJev = Boolean(JEV_API_KEY)
  if (!useJev) console.log('JEV_API_KEY 미설정: 키워드 매칭 결과만 수집합니다')
  if (useJev && !JEV_API_URL) console.log('참고: JEV_API_URL 미설정 (callJev 구현에서 필요하면 설정)')

  const rows = []
  for (const post of posts) {
    const kw = await api(cookie, '/api/tags/suggestions', {
      method: 'POST',
      body: JSON.stringify({ title: post.title, content: post.content, exclude: [] }),
    })
    // 키워드 매칭 결과에서도 '기타' 를 뺀다. 서버는 그대로 추천하지만 Jev 와 같은 조건으로 비교하기 위해서다
    const keyword =
      kw.status === 200 ? kw.data.tags.map((t) => t.name).filter((n) => n !== MISC_TAG) : null

    let jev = null
    let jevError = null
    let jevMs = null
    if (useJev) {
      const started = performance.now()
      try {
        const raw = await callJev(
          {
            title: takeChars(post.title, TITLE_MAX_CHARS),
            body: takeChars(stripMarkdownNoise(post.content), BODY_MAX_CHARS),
            candidates,
          },
          AbortSignal.timeout(JEV_TIMEOUT_MS),
        )
        // 서버에서 할 검증과 같게: 목록에 있는 이름만, 기준 확률 이상, 높은 순 최대 5개
        jev = raw
          .filter((t) => candidateNames.has(t.name) && t.score >= JEV_THRESHOLD)
          .sort((a, b) => b.score - a.score)
          .slice(0, SUGGEST_MAX)
          .map((t) => `${t.name}(${t.score.toFixed(2)})`)
      } catch (err) {
        jevError = err instanceof Error ? err.message : String(err)
      }
      jevMs = Math.round(performance.now() - started)
    }

    rows.push({ post, keyword, keywordError: keyword ? null : `HTTP ${kw.status}`, jev, jevError, jevMs })
    console.log(`${post.id} 키워드=${keyword?.join(',') ?? kw.status} jev=${jev?.join(',') ?? jevError ?? '-'}`)
  }

  const report = buildReport(rows, useJev)
  const dir = join(HERE, 'results')
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = join(dir, `report-${stamp}.md`)
  await writeFile(file, report)
  console.log(`\n리포트: ${file}`)
}

// ---------------------------------------------------------------------------
// 리포트
// ---------------------------------------------------------------------------

/** 정답(expected)과 비교한 적중 수. jev 결과의 "(0.83)" 확률 표기는 떼고 비교한다 */
function score(predicted, expected) {
  const names = predicted.map((p) => p.replace(/\(.*\)$/, ''))
  const hits = names.filter((n) => expected.includes(n)).length
  return { hits, predicted: names.length, expected: expected.length }
}

function summarize(rows, pick) {
  let hits = 0
  let predicted = 0
  let expected = 0
  let emptyCorrect = 0
  let emptyTotal = 0
  let failed = 0
  for (const row of rows) {
    const result = pick(row)
    if (!result) {
      failed += 1
      continue
    }
    const s = score(result, row.post.expected)
    hits += s.hits
    predicted += s.predicted
    expected += s.expected
    if (row.post.expected.length === 0) {
      emptyTotal += 1
      if (s.predicted === 0) emptyCorrect += 1
    }
  }
  const pct = (a, b) => (b === 0 ? '-' : `${Math.round((a / b) * 100)}%`)
  return {
    precision: pct(hits, predicted),
    recall: pct(hits, expected),
    empty: `${emptyCorrect}/${emptyTotal}`,
    failed,
  }
}

function buildReport(rows, useJev) {
  const cell = (list, error) => (list ? list.join(', ') || '(없음)' : `오류: ${error}`)
  const lines = [
    '# 태그 추천 비교 리포트',
    '',
    `- 실행: ${new Date().toISOString()}`,
    `- 샘플 글 ${rows.length}개, Jev 기준 확률 ${JEV_THRESHOLD}, 타임아웃 ${JEV_TIMEOUT_MS}ms`,
    '',
    '## 요약',
    '',
    '| 방식 | 정밀도 (추천 중 정답) | 재현율 (정답 중 추천됨) | 태그 없어야 할 글에서 비추천 | 실패 |',
    '| --- | --- | --- | --- | --- |',
  ]
  const kw = summarize(rows, (r) => r.keyword)
  lines.push(`| 키워드 매칭 | ${kw.precision} | ${kw.recall} | ${kw.empty} | ${kw.failed} |`)
  if (useJev) {
    const jv = summarize(rows, (r) => r.jev)
    const times = rows.map((r) => r.jevMs).filter((ms) => ms !== null)
    const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : '-'
    lines.push(`| Jev | ${jv.precision} | ${jv.recall} | ${jv.empty} | ${jv.failed} |`)
    lines.push('', `Jev 평균 응답 시간: ${avg}ms`)
  }
  lines.push('', '## 글별 결과', '')
  lines.push(useJev ? '| 글 | 정답 | 키워드 매칭 | Jev | Jev ms |' : '| 글 | 정답 | 키워드 매칭 |')
  lines.push(useJev ? '| --- | --- | --- | --- | --- |' : '| --- | --- | --- |')
  for (const r of rows) {
    const base = `| ${r.post.id} ${r.post.title} | ${r.post.expected.join(', ') || '(없음)'} | ${cell(r.keyword, r.keywordError)}`
    lines.push(useJev ? `${base} | ${cell(r.jev, r.jevError)} | ${r.jevMs ?? '-'} |` : `${base} |`)
  }
  return `${lines.join('\n')}\n`
}

const command = process.argv[2]
const commands = { seed, run }
if (!commands[command]) {
  console.log('사용법: node eval.mjs <seed|run>')
  process.exit(1)
}
commands[command]().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
