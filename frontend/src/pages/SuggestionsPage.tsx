import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import type { LayoutContext } from '../components/Layout'
import { ApiError } from '../api/client'
import {
  createSuggestion,
  deleteSuggestion,
  fetchSuggestions,
  unvoteSuggestion,
  voteSuggestion,
} from '../api/suggestions'
import {
  authorTokenHex,
  decorate,
  importRecoveryCode,
  postTokenCount,
  prefetchVoteTokens,
  preparePost,
  recoveryCode,
  refillPostTokens,
  voteMessageHex,
  voteToken,
} from '../utils/anonSuggestions'
import type { Suggestion } from '../types'
import './SuggestionsPage.css'

const TITLE_MAX = 100
const CONTENT_MAX = 3000

type View = 'all' | 'mine'
type Sort = 'votes' | 'latest'

/**
 * 익명 건의함. 운영자 개념 없이 모든 멤버가 동등하게 쓰고 공감한다.
 * 작성·삭제·공감은 세션 없이 블라인드 서명 토큰으로 보내고, 내 건의·내 공감은 브라우저 키로만 판별한다
 * (utils/anonSuggestions.ts 참고).
 */
function SuggestionsPage() {
  const { user } = useOutletContext<LayoutContext>()
  const userId = user?.id

  const [items, setItems] = useState<Suggestion[] | null>(null)
  const [view, setView] = useState<View>('all')
  const [sort, setSort] = useState<Sort>('votes')
  const [error, setError] = useState<string | null>(null)

  const [formOpen, setFormOpen] = useState(false)
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(() => {
    if (userId === undefined) return
    setError(null)
    fetchSuggestions({ sort })
      .then((raw) => {
        setItems(decorate(userId, raw))
        // 공감할지와 상관없이 모든 건의의 공감 토큰을 미리 받아 둔다
        prefetchVoteTokens(userId, raw).catch(() => {
          // 공감 버튼을 누를 때 다시 시도한다
        })
      })
      .catch((err: Error) => setError(err.message))
  }, [sort, userId])

  useEffect(() => {
    load()
  }, [load])

  const visible = items && (view === 'mine' ? items.filter((s) => s.mine) : items)

  const replaceItem = (next: Suggestion) =>
    setItems((prev) => prev?.map((s) => (s.id === next.id ? next : s)) ?? prev)

  const removeItem = (id: number) => setItems((prev) => prev?.filter((s) => s.id !== id) ?? prev)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (userId === undefined) return
    setSubmitting(true)
    setError(null)
    try {
      if (postTokenCount(userId) === 0) await refillPostTokens(userId)
      const prepared = preparePost(userId)
      if (!prepared) {
        setError('오늘 받을 수 있는 작성 토큰을 모두 썼어요. 내일 다시 시도해주세요.')
        return
      }
      try {
        await createSuggestion({
          title,
          content,
          authorRef: prepared.authorRef,
          authorDigest: prepared.authorDigest,
          token: prepared.token,
        })
        prepared.consume()
      } catch (err) {
        // 이미 쓴 토큰이면 버리고, 그 밖의 실패(네트워크·입력 오류 등)면 다음에 다시 쓸 수 있게 남긴다
        if (err instanceof ApiError && err.status === 409) prepared.consume()
        throw err
      }
      setTitle('')
      setContent('')
      setFormOpen(false)
      setNotice(
        '익명으로 올라갔어요. 운영자를 포함해 누구도 작성자를 알 수 없어요. 다른 기기에서 "내 건의" 를 보려면 복구 코드를 옮겨 주세요.',
      )
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '건의를 보내지 못했습니다')
    } finally {
      setSubmitting(false)
    }
  }

  if (user === undefined) {
    return (
      <div className="suggestions-page">
        <p className="suggestions-page__empty">불러오는 중...</p>
      </div>
    )
  }

  if (user === null) {
    return (
      <div className="suggestions-page">
        <h1 className="suggestions-page__title">익명 건의함</h1>
        <p className="suggestions-page__empty">
          스터디 멤버만 볼 수 있어요. <Link to="/login">로그인</Link> 후 이용해주세요.
        </p>
      </div>
    )
  }

  return (
    <div className="suggestions-page">
      <header className="suggestions-page__head">
        <div>
          <h1 className="suggestions-page__title">익명 건의함</h1>
          <p className="suggestions-page__subtitle">
            스터디에 바라는 점을 편하게 남겨주세요. 운영자도 DB·서버로 작성자와 공감한 사람을 알 수
            없어요.
          </p>
        </div>
        <div className="suggestions-page__head-actions">
          <button type="button" onClick={() => setRecoveryOpen((v) => !v)}>
            복구 코드
          </button>
          {!formOpen && (
            <button
              type="button"
              className="suggestions-page__primary"
              onClick={() => {
                setFormOpen(true)
                setNotice(null)
              }}
            >
              건의하기
            </button>
          )}
        </div>
      </header>

      {recoveryOpen && (
        <RecoveryPanel
          userId={user.id}
          onImported={() => {
            setRecoveryOpen(false)
            setNotice('복구 코드를 적용했어요. 이 기기에서도 내 건의·내 공감이 보여요.')
            load()
          }}
        />
      )}

      {formOpen && (
        <form className="suggestion-form" onSubmit={submit}>
          <label className="suggestion-form__field">
            <span>
              제목
              <em>
                {title.length}/{TITLE_MAX}
              </em>
            </span>
            <input
              value={title}
              maxLength={TITLE_MAX}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="예) 발표 순서를 돌아가면서 정했으면 좋겠어요"
              autoFocus
            />
          </label>
          <label className="suggestion-form__field">
            <span>
              내용
              <em>
                {content.length}/{CONTENT_MAX}
              </em>
            </span>
            <textarea
              value={content}
              maxLength={CONTENT_MAX}
              rows={6}
              onChange={(e) => setContent(e.target.value)}
              placeholder="무엇이 불편했고, 어떻게 바뀌면 좋을지 적어주세요"
            />
          </label>
          <div className="suggestion-form__footer">
            <p className="suggestion-form__hint">
              💡 특정 날짜·대화·말버릇처럼 나를 알아볼 수 있는 표현은 피하면 더 안전해요.
            </p>
            <div className="suggestion-form__actions">
              <button type="button" onClick={() => setFormOpen(false)} disabled={submitting}>
                취소
              </button>
              <button
                type="submit"
                className="suggestions-page__primary"
                disabled={submitting || !title.trim() || !content.trim()}
              >
                {submitting ? '보내는 중...' : '익명으로 올리기'}
              </button>
            </div>
          </div>
        </form>
      )}

      {notice && <p className="suggestions-page__notice">{notice}</p>}
      {error && <p className="suggestions-page__error">{error}</p>}

      <div className="suggestions-toolbar">
        <div className="suggestions-toolbar__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'all'}
            className={view === 'all' ? 'is-active' : ''}
            onClick={() => setView('all')}
          >
            전체
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'mine'}
            className={view === 'mine' ? 'is-active' : ''}
            onClick={() => setView('mine')}
          >
            내 건의
          </button>
        </div>
        <div className="suggestions-toolbar__sort">
          <button
            type="button"
            className={sort === 'votes' ? 'is-active' : ''}
            onClick={() => setSort('votes')}
          >
            공감순
          </button>
          <button
            type="button"
            className={sort === 'latest' ? 'is-active' : ''}
            onClick={() => setSort('latest')}
          >
            최신순
          </button>
        </div>
      </div>

      {visible === null ? (
        <p className="suggestions-page__empty">불러오는 중...</p>
      ) : visible.length === 0 ? (
        <p className="suggestions-page__empty">
          {view === 'mine'
            ? '이 기기에서 쓴 건의가 없어요. 다른 기기에서 썼다면 복구 코드를 옮겨 주세요.'
            : '아직 건의가 없어요. 첫 번째로 의견을 남겨보세요.'}
        </p>
      ) : (
        <ul className="suggestion-list">
          {visible.map((item) => (
            <SuggestionItem
              key={item.id}
              userId={user.id}
              item={item}
              onChange={replaceItem}
              onRemove={removeItem}
              onError={setError}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function RecoveryPanel({ userId, onImported }: { userId: number; onImported: () => void }) {
  const [code] = useState(() => recoveryCode(userId))
  const [input, setInput] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  const copy = () => {
    if (!navigator.clipboard) {
      setMessage('복사할 수 없는 환경이에요. 직접 선택해 복사해주세요.')
      return
    }
    navigator.clipboard
      .writeText(code)
      .then(() => setMessage('복사했어요.'))
      .catch(() => setMessage('복사하지 못했어요. 직접 선택해 복사해주세요.'))
  }

  const apply = (event: FormEvent) => {
    event.preventDefault()
    if (importRecoveryCode(userId, input)) onImported()
    else setMessage('복구 코드 형식이 올바르지 않아요 (영문·숫자 64자).')
  }

  return (
    <section className="suggestion-recovery">
      <p className="suggestion-recovery__desc">
        내 건의·내 공감을 알아보는 열쇠는 서버가 아니라 <strong>이 브라우저에만</strong> 저장돼요.
        다른 기기에서도 보려면 아래 코드를 그 기기의 건의함에 붙여넣으세요. 코드를 잃어버리면 내
        건의를 삭제할 수 없어요. 누구에게도 보여주지 마세요.
      </p>
      <div className="suggestion-recovery__row">
        <code className="suggestion-recovery__code">{code}</code>
        <button type="button" onClick={copy}>
          복사
        </button>
      </div>
      <form className="suggestion-recovery__row" onSubmit={apply}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="다른 기기의 복구 코드 붙여넣기"
          aria-label="다른 기기의 복구 코드"
        />
        <button type="submit" disabled={!input.trim()}>
          적용
        </button>
      </form>
      {message && <p className="suggestion-recovery__desc">{message}</p>}
    </section>
  )
}

interface ItemProps {
  userId: number
  item: Suggestion
  onChange: (next: Suggestion) => void
  onRemove: (id: number) => void
  onError: (message: string) => void
}

function SuggestionItem({ userId, item, onChange, onRemove, onError }: ItemProps) {
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const run = async (task: () => Promise<void>) => {
    setBusy(true)
    try {
      await task()
    } catch (err) {
      onError(err instanceof Error ? err.message : '요청에 실패했습니다')
    } finally {
      setBusy(false)
    }
  }

  const toggleVote = () =>
    run(async () => {
      if (item.voted) {
        const result = await unvoteSuggestion(item.id, voteMessageHex(userId, item.id))
        onChange({ ...item, ...result })
        return
      }
      let token = voteToken(userId, item.id)
      if (!token) {
        await prefetchVoteTokens(userId, [item])
        token = voteToken(userId, item.id)
      }
      if (!token) {
        throw new Error('이 건의의 공감 토큰을 받지 못했어요. 새로고침 후 다시 시도해주세요.')
      }
      const result = await voteSuggestion(item.id, token)
      onChange({ ...item, ...result })
    })

  const remove = () =>
    run(async () => {
      await deleteSuggestion(item.id, authorTokenHex(userId, item.authorRef))
      onRemove(item.id)
    })

  return (
    <li className="suggestion-item">
      <button
        type="button"
        className={`suggestion-item__vote ${item.voted ? 'is-voted' : ''}`}
        onClick={toggleVote}
        disabled={busy}
        aria-pressed={item.voted}
        title={item.voted ? '공감 취소' : '나도 공감해요'}
      >
        <span aria-hidden="true">▲</span>
        <strong>{item.voteCount}</strong>
        <small>공감</small>
      </button>

      <div className="suggestion-item__body">
        <div className="suggestion-item__meta">
          {item.mine && <span className="suggestion-item__mine">내 건의</span>}
          <span>익명 · {item.createdOn.replaceAll('-', '. ')}.</span>
        </div>
        <h2 className="suggestion-item__title">{item.title}</h2>
        <p className="suggestion-item__content">{item.content}</p>

        {item.mine && (
          <div className="suggestion-item__actions">
            {confirmDelete ? (
              <>
                <span className="suggestion-item__confirm">정말 삭제할까요? 되돌릴 수 없어요.</span>
                <button type="button" className="is-danger" onClick={remove} disabled={busy}>
                  삭제
                </button>
                <button type="button" onClick={() => setConfirmDelete(false)} disabled={busy}>
                  취소
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setConfirmDelete(true)} disabled={busy}>
                삭제
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

export default SuggestionsPage
