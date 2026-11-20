import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  createTagVocabulary,
  deleteTagVocabulary,
  fetchTagVocabulary,
  updateTagVocabulary,
} from '../api/tagVocabulary'
import { fetchTags } from '../api/tags'
import type { TagCount, TagVocabulary } from '../types'
import './TagVocabularyManager.css'

/** 사용 중인 태그 중 목록에 없는 것을 몇 개까지 후보로 보여줄지 */
const CANDIDATE_LIMIT = 20

interface Draft {
  name: string
  description: string
  aliasesInput: string
}

const EMPTY_DRAFT: Draft = { name: '', description: '', aliasesInput: '' }

/** 쉼표로 구분한 동의어 입력을 배열로. 정규화(소문자·중복 제거)는 서버가 한다 */
function parseAliases(input: string) {
  return input
    .split(',')
    .map((alias) => alias.trim())
    .filter(Boolean)
}

const toDraft = (item: TagVocabulary): Draft => ({
  name: item.name,
  description: item.description,
  aliasesInput: item.aliases.join(', '),
})

/** 관리자 페이지의 "태그 목록" 영역. 태그 추천이 이 목록 안에서만 태그를 고른다 */
function TagVocabularyManager() {
  const [items, setItems] = useState<TagVocabulary[] | null>(null)
  const [usedTags, setUsedTags] = useState<TagCount[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [form, setForm] = useState<Draft>(EMPTY_DRAFT)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT)
  const nameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetchTagVocabulary()
      .then(setItems)
      .catch((err: Error) => setError(err.message))
    // 후보 목록은 없어도 관리 기능에는 지장이 없으므로 실패해도 조용히 넘어간다
    fetchTags()
      .then(setUsedTags)
      .catch(() => setUsedTags([]))
  }, [])

  // 사용 중인 태그 중 아직 목록에 없는 것 (게시물 수 많은 순). 다른 태그의 동의어로 등록된 것도 제외
  const candidates = useMemo(() => {
    const registered = new Set(items?.flatMap((item) => [item.name, ...item.aliases]))
    return usedTags.filter((tag) => !registered.has(tag.name)).slice(0, CANDIDATE_LIMIT)
  }, [items, usedTags])

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : '요청에 실패했습니다')
    } finally {
      setBusy(false)
    }
  }

  const sortByName = (list: TagVocabulary[]) =>
    [...list].sort((a, b) => a.name.localeCompare(b.name))

  const submitCreate = (event: FormEvent) => {
    event.preventDefault()
    if (!form.name.trim()) return
    void run(async () => {
      const created = await createTagVocabulary({
        name: form.name,
        description: form.description,
        aliases: parseAliases(form.aliasesInput),
      })
      setItems((prev) => sortByName([...(prev ?? []), created]))
      setForm(EMPTY_DRAFT)
    })
  }

  const startEdit = (item: TagVocabulary) => {
    setEditingId(item.id)
    setEditDraft(toDraft(item))
    setError(null)
  }

  const saveEdit = (id: number) =>
    run(async () => {
      const updated = await updateTagVocabulary(id, {
        name: editDraft.name,
        description: editDraft.description,
        aliases: parseAliases(editDraft.aliasesInput),
      })
      setItems((prev) => sortByName((prev ?? []).map((item) => (item.id === id ? updated : item))))
      setEditingId(null)
    })

  const remove = (item: TagVocabulary) => {
    if (!window.confirm(`'${item.name}' 태그를 목록에서 삭제할까요? 기존 게시물의 태그는 그대로 남습니다.`)) {
      return
    }
    void run(async () => {
      await deleteTagVocabulary(item.id)
      setItems((prev) => (prev ?? []).filter((other) => other.id !== item.id))
    })
  }

  // 후보 칩을 누르면 추가 폼의 이름 칸에 채운다 (설명·동의어는 관리자가 입력)
  const pickCandidate = (tag: TagCount) => {
    setForm({ ...EMPTY_DRAFT, name: tag.name })
    nameInputRef.current?.focus()
  }

  return (
    <section className="tag-vocab">
      <h2 className="tag-vocab__title">태그 목록</h2>
      <p className="tag-vocab__help">
        태그 추천은 이 목록 안에서만 태그를 고릅니다. 동의어가 제목·본문에 나오면 해당 태그를 추천합니다.
      </p>

      <form className="tag-vocab__form" onSubmit={submitCreate}>
        <input
          ref={nameInputRef}
          type="text"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="태그 (예: react)"
          maxLength={50}
        />
        <input
          type="text"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="설명 (선택)"
          maxLength={200}
        />
        <input
          type="text"
          value={form.aliasesInput}
          onChange={(e) => setForm({ ...form, aliasesInput: e.target.value })}
          placeholder="동의어, 쉼표로 구분 (예: jsx, usestate, 리액트)"
        />
        <button type="submit" disabled={busy || !form.name.trim()}>
          추가
        </button>
      </form>

      {candidates.length > 0 && (
        <div className="tag-vocab__candidates">
          <span className="tag-vocab__candidates-label">사용 중이지만 목록에 없는 태그</span>
          {candidates.map((tag) => (
            <button
              key={tag.name}
              type="button"
              className="tag-vocab__chip"
              onClick={() => pickCandidate(tag)}
              title="클릭하면 추가 칸에 채웁니다"
            >
              {tag.name} <span className="tag-vocab__chip-count">{tag.postCount}</span>
            </button>
          ))}
        </div>
      )}

      {error && <p className="admin-page__error">{error}</p>}

      {items === null ? (
        <p className="admin-page__empty">불러오는 중...</p>
      ) : items.length === 0 ? (
        <p className="admin-page__empty">등록된 태그가 없습니다.</p>
      ) : (
        <table className="admin-page__table tag-vocab__table">
          <thead>
            <tr>
              <th>태그</th>
              <th>설명</th>
              <th>동의어</th>
              <th>관리</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) =>
              editingId === item.id ? (
                <tr key={item.id}>
                  <td>
                    <input
                      type="text"
                      value={editDraft.name}
                      onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })}
                      maxLength={50}
                      aria-label="태그"
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      value={editDraft.description}
                      onChange={(e) => setEditDraft({ ...editDraft, description: e.target.value })}
                      maxLength={200}
                      aria-label="설명"
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      value={editDraft.aliasesInput}
                      onChange={(e) => setEditDraft({ ...editDraft, aliasesInput: e.target.value })}
                      aria-label="동의어"
                    />
                  </td>
                  <td className="tag-vocab__actions">
                    <button type="button" onClick={() => void saveEdit(item.id)} disabled={busy}>
                      저장
                    </button>
                    <button type="button" onClick={() => setEditingId(null)} disabled={busy}>
                      취소
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={item.id}>
                  <td className="tag-vocab__name">{item.name}</td>
                  <td className="tag-vocab__muted">{item.description}</td>
                  <td className="tag-vocab__muted">{item.aliases.join(', ')}</td>
                  <td className="tag-vocab__actions">
                    <button type="button" onClick={() => startEdit(item)} disabled={busy}>
                      수정
                    </button>
                    <button type="button" onClick={() => remove(item)} disabled={busy}>
                      삭제
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
    </section>
  )
}

export default TagVocabularyManager
