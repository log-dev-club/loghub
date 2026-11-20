import { useCallback, useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import Header from './Header'
import { fetchMe } from '../api/auth'
import { refillPostTokens } from '../utils/anonSuggestions'
import type { UserProfile } from '../types'

/** 모든 페이지가 useOutletContext<LayoutContext>() 로 받는 값 */
export interface LayoutContext {
  query: string
  /** 로그인 사용자. 비로그인이면 null, 아직 확인 전이면 undefined */
  user: UserProfile | null | undefined
  setUser: (user: UserProfile | null) => void
  refreshUser: () => Promise<void>
}

function Layout() {
  const [query, setQuery] = useState('')
  const [user, setUser] = useState<UserProfile | null | undefined>(undefined)

  const refreshUser = useCallback(async () => {
    try {
      setUser(await fetchMe())
    } catch {
      setUser(null)
    }
  }, [])

  // 최초 진입 시 세션 쿠키로 로그인 상태 확인
  useEffect(() => {
    let cancelled = false
    fetchMe()
      .then((me) => {
        if (!cancelled) setUser(me)
      })
      .catch(() => {
        if (!cancelled) setUser(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 익명 건의함 작성 토큰은 건의함에 들어갈 때가 아니라 사이트에 들어올 때 미리 받아 둔다.
  // 받는 시점과 건의를 올리는 시점이 떨어져 있어야 운영자가 시각으로 작성자를 추측하기 어렵다
  const userId = user?.id
  useEffect(() => {
    if (userId === undefined) return
    refillPostTokens(userId).catch(() => {
      // 실패하면 다음 방문 때 다시 받는다
    })
  }, [userId])

  return (
    <div className="app-shell">
      <Header query={query} onQueryChange={setQuery} user={user ?? null} />
      <main className="app-content">
        <Outlet context={{ query, user, setUser, refreshUser } satisfies LayoutContext} />
      </main>
    </div>
  )
}

export default Layout
