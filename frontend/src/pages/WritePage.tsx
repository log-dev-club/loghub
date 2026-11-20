import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom'
import BlockEditor from '../components/editor/BlockEditor'
import type { BlockEditorHandle } from '../components/editor/BlockEditor'
import type { LayoutContext } from '../components/Layout'
import { createPost, fetchPost, updatePost } from '../api/posts'
import { deleteAttachment, uploadAttachment } from '../api/attachments'
import { deleteDraft, fetchDraft, saveDraft } from '../api/drafts'
import type { Draft } from '../api/drafts'
import { ApiError } from '../api/client'
import { suggestTags } from '../api/tags'
import { buildHashedRelease } from '../utils/hashFile'
import type { HashedRelease } from '../utils/hashFile'
import type { Attachment, TagSuggestion } from '../types'
import './WritePage.css'

interface AttachedFile {
  file: File
  hashed: HashedRelease
}

const AUTOSAVE_DELAY_MS = 1500

function formatSavedAt(iso: string) {
  return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
}

// 제목/태그 입력창에서 Enter 로 폼이 바로 제출되는 것을 막는다
function preventEnterSubmit(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key === 'Enter') event.preventDefault()
}

// 쉼표로 구분한 태그 입력을 배열로
function parseTags(input: string) {
  return input
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
}

function isDraftEmpty(draft: Pick<Draft, 'title' | 'tagsInput' | 'content'>) {
  return !draft.title.trim() && !draft.tagsInput.trim() && !draft.content.trim()
}

function WritePage() {
  const { user } = useOutletContext<LayoutContext>()
  const navigate = useNavigate()
  const location = useLocation()
  const { id } = useParams<{ id: string }>()
  const postId = id ? Number(id) : null
  const isEdit = postId !== null && Number.isInteger(postId)

  const [title, setTitle] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [content, setContent] = useState('')
  const [initialContent, setInitialContent] = useState('')
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [existingAttachments, setExistingAttachments] = useState<Attachment[]>([])
  const [isHashing, setIsHashing] = useState(false)
  const [draftBanner, setDraftBanner] = useState<Draft | null>(null)
  const [draftChecked, setDraftChecked] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadingPost, setLoadingPost] = useState(isEdit)
  const [loadFailed, setLoadFailed] = useState(false)
  const editorRef = useRef<BlockEditorHandle>(null)
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([])
  const [suggesting, setSuggesting] = useState(false)
  const [suggestMessage, setSuggestMessage] = useState<string | null>(null)

  // 비로그인이면 로그인 후 이 페이지로 돌아오도록
  useEffect(() => {
    if (user === null) navigate('/login', { replace: true, state: { from: location.pathname } })
  }, [user, navigate, location.pathname])

  // 수정 모드: 기존 게시물을 불러와 폼을 채운다. 작성자가 아니면 상세 화면으로 돌려보낸다
  useEffect(() => {
    if (!isEdit || !user || postId === null) return
    let cancelled = false
    fetchPost(postId)
      .then((loaded) => {
        if (cancelled) return
        if (loaded.author.nickname !== user.nickname) {
          navigate(`/posts/${postId}`, { replace: true })
          return
        }
        setTitle(loaded.title)
        setTagsInput(loaded.tags.join(', '))
        setContent(loaded.content)
        setInitialContent(loaded.content)
        setExistingAttachments(loaded.attachments)
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
      .finally(() => {
        if (!cancelled) setLoadingPost(false)
      })
    return () => {
      cancelled = true
    }
  }, [isEdit, postId, user, navigate])

  // 로그인 확인되면 서버에 저장된 임시저장이 있는지 확인 (새 글 작성 모드에서만)
  useEffect(() => {
    if (!user || isEdit) return
    let cancelled = false
    fetchDraft()
      .then((draft) => {
        if (!cancelled && draft && !isDraftEmpty(draft)) setDraftBanner(draft)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setDraftChecked(true)
      })
    return () => {
      cancelled = true
    }
  }, [user, isEdit])

  // 자동 임시저장 (디바운스, 새 글 작성 모드에서만). 복원 배너가 떠 있는 동안엔 덮어쓰지 않는다
  useEffect(() => {
    if (!user || isEdit || !draftChecked || draftBanner) return
    if (!title.trim() && !tagsInput.trim() && !content.trim()) return

    const timer = window.setTimeout(() => {
      saveDraft({ title, content, tagsInput })
        .then((saved) => setLastSavedAt(saved.updatedAt))
        .catch(() => {})
    }, AUTOSAVE_DELAY_MS)

    return () => window.clearTimeout(timer)
  }, [user, isEdit, title, tagsInput, content, draftChecked, draftBanner])

  const handleRestoreDraft = () => {
    if (!draftBanner) return
    setTitle(draftBanner.title)
    setTagsInput(draftBanner.tagsInput)
    setContent(draftBanner.content)
    editorRef.current?.setContent(draftBanner.content)
    setLastSavedAt(draftBanner.updatedAt)
    setDraftBanner(null)
  }

  const handleDiscardDraft = () => {
    setDraftBanner(null)
    deleteDraft().catch(() => {})
  }

  const handleSaveDraft = () => {
    saveDraft({ title, content, tagsInput })
      .then((saved) => setLastSavedAt(saved.updatedAt))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : '임시저장에 실패했습니다'))
  }

  const handleFilesSelected = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    setIsHashing(true)
    setError(null)
    try {
      const newAttachments = await Promise.all(
        Array.from(fileList).map(async (file) => ({
          file,
          hashed: await buildHashedRelease(file),
        })),
      )
      setAttachments((prev) => [...prev, ...newAttachments])
    } catch {
      setError('첨부파일 처리에 실패했습니다')
    } finally {
      setIsHashing(false)
    }
  }

  const removeAttachment = (hashedName: string) => {
    setAttachments((prev) => prev.filter((item) => item.hashed.hashedName !== hashedName))
  }

  const removeExistingAttachment = async (hashedName: string) => {
    if (!window.confirm('첨부파일을 삭제할까요?')) return
    try {
      await deleteAttachment(hashedName)
      setExistingAttachments((prev) => prev.filter((item) => item.hashedName !== hashedName))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '첨부파일 삭제에 실패했습니다')
    }
  }

  /**
   * 새 글: 1) POST /api/posts 로 저장 (서버가 Discord 알림 전송) 2) 첨부파일 업로드 3) 임시저장 삭제
   * 수정: 1) PATCH /api/posts/{id} 로 저장 2) 새로 추가된 첨부파일만 업로드
   */
  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting || isHashing) return
    if (!title.trim() || !content.trim()) return

    const tags = parseTags(tagsInput)

    setSubmitting(true)
    setError(null)
    try {
      const post = isEdit && postId !== null ? await updatePost(postId, { title, content, tags }) : await createPost({ title, content, tags })

      const failed: string[] = []
      for (const { file, hashed } of attachments) {
        try {
          await uploadAttachment(post.id, file, hashed)
        } catch (err) {
          failed.push(`${file.name}: ${err instanceof Error ? err.message : '업로드 실패'}`)
        }
      }
      if (failed.length > 0) {
        window.alert(`게시물은 저장되었지만 일부 첨부파일 업로드에 실패했습니다.\n${failed.join('\n')}`)
      }

      if (!isEdit) await deleteDraft().catch(() => {})
      navigate(`/posts/${post.id}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '게시물 저장에 실패했습니다')
    } finally {
      setSubmitting(false)
    }
  }

  // 태그 추천: 버튼을 눌렀을 때만 호출한다. 추천 태그는 칩을 눌러야 입력란에 들어간다
  const handleSuggestTags = async () => {
    if (suggesting) return
    setSuggesting(true)
    setSuggestMessage(null)
    try {
      const result = await suggestTags({ title, content, exclude: parseTags(tagsInput) })
      setSuggestions(result.tags)
      if (result.tags.length === 0) setSuggestMessage('추천할 태그가 없습니다')
    } catch (err) {
      setSuggestions([])
      if (err instanceof ApiError && err.status === 429) {
        setSuggestMessage('잠시 후 다시 시도해 주세요')
      } else {
        setSuggestMessage(err instanceof Error ? err.message : '태그 추천에 실패했습니다')
      }
    } finally {
      setSuggesting(false)
    }
  }

  const addSuggestedTag = (name: string) => {
    setTagsInput((prev) => [...parseTags(prev), name].join(', '))
    setSuggestions((prev) => prev.filter((tag) => tag.name !== name))
  }

  // 사용자가 직접 입력한 태그와 겹치는 추천은 숨긴다
  const currentTags = new Set(parseTags(tagsInput).map((tag) => tag.toLowerCase()))
  const visibleSuggestions = suggestions.filter((tag) => !currentTags.has(tag.name))

  // 로그인 확인 전이거나 비로그인으로 리다이렉트되는 중에는 그리지 않는다
  if (!user) return null

  if (isEdit && loadFailed) {
    return (
      <div className="write-page">
        <p className="write-form__error">게시물을 찾을 수 없습니다.</p>
      </div>
    )
  }

  if (isEdit && loadingPost) {
    return (
      <div className="write-page">
        <p>불러오는 중...</p>
      </div>
    )
  }

  return (
    <div className="write-page">
      {draftBanner && (
        <div className="write-draft-banner">
          <span>{formatSavedAt(draftBanner.updatedAt)}에 임시저장된 글이 있습니다.</span>
          <div className="write-draft-banner__actions">
            <button type="button" onClick={handleRestoreDraft}>
              불러오기
            </button>
            <button type="button" onClick={handleDiscardDraft}>
              삭제
            </button>
          </div>
        </div>
      )}

      <form className="write-form" onSubmit={handleSubmit}>
        <input
          className="write-form__title"
          type="text"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={preventEnterSubmit}
          placeholder="제목을 입력하세요"
          required
        />

        <div className="write-form__tags-row">
          <input
            className="write-form__tags"
            type="text"
            value={tagsInput}
            onChange={(event) => setTagsInput(event.target.value)}
            onKeyDown={preventEnterSubmit}
            placeholder="태그 추가 (쉼표로 구분, 예: react, frontend)"
          />
          <button
            type="button"
            className="write-form__suggest"
            onClick={handleSuggestTags}
            disabled={suggesting || (!title.trim() && !content.trim())}
            title="제목과 본문을 보고 태그 목록에서 알맞은 태그를 추천합니다"
          >
            {suggesting ? '추천 중…' : '태그 추천'}
          </button>
        </div>

        {(visibleSuggestions.length > 0 || suggestMessage) && (
          <div className="write-form__suggestions">
            {visibleSuggestions.map((tag) => (
              <button
                key={tag.name}
                type="button"
                className="write-form__suggestion"
                onClick={() => addSuggestedTag(tag.name)}
                title="클릭하면 태그에 추가합니다"
              >
                + {tag.name}
              </button>
            ))}
            {suggestMessage && <span className="write-form__hint">{suggestMessage}</span>}
          </div>
        )}

        <div className="write-form__editor">
          <BlockEditor ref={editorRef} onChange={setContent} initialContent={initialContent} />
        </div>

        <div className="write-form__attachments">
          <label className="write-form__attachments-label">
            릴리즈 파일 첨부 (zip, exe 등)
            <input type="file" multiple onChange={(event) => handleFilesSelected(event.target.files)} />
          </label>
          {isHashing && <p className="write-form__hint">파일 이름을 해싱하는 중...</p>}

          {existingAttachments.length > 0 && (
            <ul className="attachment-list">
              {existingAttachments.map((attachment) => (
                <li key={attachment.id} className="attachment-list__item">
                  <div className="attachment-list__info">
                    <span className="attachment-list__name">{attachment.originalName}</span>
                    <span className="attachment-list__hash">→ {attachment.hashedName}</span>
                  </div>
                  <button type="button" onClick={() => removeExistingAttachment(attachment.hashedName)}>
                    제거
                  </button>
                </li>
              ))}
            </ul>
          )}

          {attachments.length > 0 && (
            <ul className="attachment-list">
              {attachments.map(({ file, hashed }) => (
                <li key={hashed.hashedName} className="attachment-list__item">
                  <div className="attachment-list__info">
                    <span className="attachment-list__name">{file.name}</span>
                    <span className="attachment-list__hash">→ {hashed.hashedName}</span>
                  </div>
                  <button type="button" onClick={() => removeAttachment(hashed.hashedName)}>
                    제거
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && <p className="write-form__error">{error}</p>}

        <div className="write-form__actions">
          <button
            type="submit"
            className="write-form__submit"
            disabled={submitting || isHashing || !title.trim() || !content.trim()}
          >
            {isEdit ? (submitting ? '수정 중...' : '수정하기') : submitting ? '게시 중...' : '게시하기'}
          </button>
          {!isEdit && (
            <button type="button" className="write-form__draft-save" onClick={handleSaveDraft} disabled={submitting}>
              임시저장
            </button>
          )}
          {!isEdit && lastSavedAt && (
            <span className="write-form__saved-at">{formatSavedAt(lastSavedAt)}에 저장됨</span>
          )}
        </div>
      </form>
    </div>
  )
}

export default WritePage
