import { useState, type FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router'
import { useAuth } from '../contexts/AuthContext'
import { ApiError } from '../lib/api'

/**
 * Single-admin password login.
 *
 * This replaces the old page's "Sign in with GitHub" button entirely: v0.1 has no GitHub
 * OAuth, one local admin account, and a password printed once on first boot (ADR-0001).
 */
export function LoginPage() {
  const { isAuthenticated, isLoading, login } = useAuth()
  const location = useLocation()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (isLoading) return <p>Loading…</p>
  if (isAuthenticated) {
    const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname
    return <Navigate to={from ?? '/'} replace />
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await login(password)
    } catch (err) {
      // A wrong password is a 401 and is the expected case, so it gets a plain message
      // rather than the raw status line.
      setError(err instanceof ApiError && err.status === 401 ? 'Incorrect password' : 'Could not sign in')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="login-page">
      <h1>Rocky Surf</h1>
      <form onSubmit={onSubmit}>
        <label htmlFor="password">Admin password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button type="submit" disabled={submitting || password.length === 0}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
      <p className="hint">
        Your password was printed once, on first boot. Set <code>ROCKYSURF_ADMIN_PASSWORD</code> to choose
        another.
      </p>
    </main>
  )
}
