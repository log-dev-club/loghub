import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import type { LayoutContext } from '../components/Layout'
import {
  createSuggestion,
  deleteSuggestion,
  fetchSuggestions,
  unvoteSuggestion,
  voteSuggestion,
} from '../api/suggestions'
import type { Suggestion } from '../types'
import './SuggestionsPage.css'

const TITLE_MAX = 100
const CONTENT_MAX = 3000

type View = 'all' | 'mine'
type Sort = 'votes' | 'latest'

/** 익명 건의함. 운영자 개념 없이 모든 멤버가 동등하게 쓰고 공감한다 */
function SuggestionsPage() {
  const { user } = useOutletContext<LayoutContext>()

  const [items, setItems] = useState<Suggestion[] | null>(null)
  const [view, setView] = useState<View>('all')
  const [sort, setSort] = useState<Sort>('votes')
  const [error, setError] = useState<string | null>(null)

  const [formOpen, setFormOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    fetchSuggestions({ sort, mine: view === 'mine' ? 'true' : undefined })
      .then(setItems)
      .catch((err: Error) => setError(err.message))
  }, [sort, view])

  useEffect(() => {
    if (user) load()
  }, [user, load])

  const replaceItem = (next: Suggestion) =>
    setItems((prev) => prev?.map((s) => (s.id === next.id ? next : s)) ?? prev)

  const removeItem = (id: number) => setItems((prev) => prev?.filter((s) => s.id !== id) ?? prev)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await createSuggestion(title, content)
      setTitle('')
      setContent('')
      setFormOpen(false)
      setNotice('익명으로 올라갔어요. 다른 사람에게는 작성자가 보이지 않고, 나는 "내 건의" 탭에서 언제든 다시 볼 수 있어요.')
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
            스터디에 바라는 점을 편하게 남겨주세요. 누가 썼는지는 아무도 알 수 없어요.
          </p>
        </div>
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
      </header>

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

      {items === null ? (
        <p className="suggestions-page__empty">불러오는 중...</p>
      ) : items.length === 0 ? (
        <p className="suggestions-page__empty">
          {view === 'mine'
            ? '아직 내가 쓴 건의가 없어요.'
            : '아직 건의가 없어요. 첫 번째로 의견을 남겨보세요.'}
        </p>
      ) : (
        <ul className="suggestion-list">
          {items.map((item) => (
            <SuggestionItem
              key={item.id}
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

interface ItemProps {
  item: Suggestion
  onChange: (next: Suggestion) => void
  onRemove: (id: number) => void
  onError: (message: string) => void
}

function SuggestionItem({ item, onChange, onRemove, onError }: ItemProps) {
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
      const result = item.voted ? await unvoteSuggestion(item.id) : await voteSuggestion(item.id)
      onChange({ ...item, ...result })
    })

  const remove = () =>
    run(async () => {
      await deleteSuggestion(item.id)
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
