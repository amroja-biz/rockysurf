import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { getCurrentUser, login as loginRequest, logout as logoutRequest, setAuthToken, setOnUnauthorized, type User } from '../lib/api'

/**
 * Session state, reworked for single-admin auth.
 *
 * The old provider handled a GitHub OAuth round trip: read a token out of the URL fragment
 * after the callback redirect, stash it in localStorage, clear the hash. None of that exists
 * in v0.1 — there is one local admin and a password form (ADR-0001).
 *
 * WHERE THE SESSION LIVES. Core sets an httpOnly cookie on login, which is the real
 * credential: a token in localStorage is readable by any script on the page, and httpOnly is
 * not. The bearer token core also returns is kept in memory only, for the same-tab lifetime,
 * because the cookie already survives a reload and duplicating it into storage would trade the
 * protection away for nothing.
 *
 * The consequence is deliberate: a page refresh re-validates against `/auth/me` rather than
 * trusting anything the browser handed us.
 */

interface AuthContextValue {
  user: User | null
  isAuthenticated: boolean
  isLoading: boolean
  /** In-memory only. Present for the current tab; null after a reload, cookie unaffected. */
  token: string | null
  login: (password: string) => Promise<void>
  logout: () => Promise<void>
  refreshUser: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const clearAuth = useCallback(() => {
    setUser(null)
    setToken(null)
    setAuthToken(null)
  }, [])

  // Any 401 from anywhere drops the session. Registered once, before the first request.
  useEffect(() => {
    setOnUnauthorized(clearAuth)
  }, [clearAuth])

  const refreshUser = useCallback(async () => {
    try {
      setUser(await getCurrentUser())
    } catch {
      // Not signed in, or the cookie expired. Not an error worth surfacing on first paint.
      clearAuth()
    }
  }, [clearAuth])

  // On mount, ask core who we are. The cookie makes this succeed across a reload.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      await refreshUser()
      if (!cancelled) setIsLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [refreshUser])

  const login = useCallback(async (password: string) => {
    const result = await loginRequest(password)
    setAuthToken(result.token)
    setToken(result.token)
    setUser(result.user)
  }, [])

  const logout = useCallback(async () => {
    try {
      await logoutRequest()
    } finally {
      // Local state clears even if the round trip failed: the user asked to be signed out.
      clearAuth()
    }
  }, [clearAuth])

  return (
    <AuthContext.Provider
      value={{ user, isAuthenticated: user !== null, isLoading, token, login, logout, refreshUser }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within an AuthProvider')
  return context
}
