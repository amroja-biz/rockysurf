import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { User } from '../lib/api'
import { AdminRoute, ProtectedRoute } from './ProtectedRoute'

/**
 * The rule under test: a spinner replaces `children`, and replacing a React subtree UNMOUNTS
 * it, taking all of its state with it. So the gate must block only while we do not yet know
 * who the user is — never during a revalidation of a session we already have.
 */

const auth = vi.hoisted(() => ({ value: { user: null as User | null, isAuthenticated: false, isLoading: true } }))
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth.value }))

const ADMIN: User = { id: 'usr-1', username: 'admin', email: null, avatarUrl: null, isAdmin: true }
const MEMBER: User = { ...ADMIN, isAdmin: false }

function setAuth(next: Partial<typeof auth.value>) {
  auth.value = { ...auth.value, ...next }
}

/** A form whose typed value is the evidence: if it survives, the subtree was never unmounted. */
function TypeableForm() {
  const [value, setValue] = useState('')
  return <input aria-label="server name" value={value} onChange={(e) => setValue(e.target.value)} />
}

/** Renders the gate inside a router, with a login route to catch redirects. */
function renderGate(children: React.ReactNode, Gate: typeof ProtectedRoute = ProtectedRoute) {
  return render(
    <MemoryRouter initialEntries={['/protected']}>
      <Routes>
        <Route path="/protected" element={<Gate>{children}</Gate>} />
        <Route path="/login" element={<p>login page</p>} />
        <Route path="/" element={<p>dashboard</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ProtectedRoute blocks only on the first load', () => {
  it('shows the spinner before the user is known', () => {
    setAuth({ user: null, isAuthenticated: false, isLoading: true })
    renderGate(<p>secret</p>)

    expect(screen.getByText('Loading…')).toBeTruthy()
    expect(screen.queryByText('secret')).toBeNull()
  })

  it('renders children once the user is known', () => {
    setAuth({ user: ADMIN, isAuthenticated: true, isLoading: false })
    renderGate(<p>secret</p>)
    expect(screen.getByText('secret')).toBeTruthy()
  })

  it('redirects to login when loading finished with no user', () => {
    setAuth({ user: null, isAuthenticated: false, isLoading: false })
    renderGate(<p>secret</p>)

    expect(screen.getByText('login page')).toBeTruthy()
    expect(screen.queryByText('secret')).toBeNull()
  })

  /**
   * THE REGRESSION. Before the fix this failed: `isLoading` alone gated the spinner, so a
   * revalidation of an already-known session swapped `children` for it, unmounted the form,
   * and the typed value came back empty.
   */
  it('keeps typed form state across a revalidation of a known session', async () => {
    const user = userEvent.setup()
    setAuth({ user: ADMIN, isAuthenticated: true, isLoading: false })
    const { rerender } = renderGate(<TypeableForm />)

    const field = screen.getByLabelText('server name')
    await user.type(field, 'half-filled-form')
    expect(screen.getByLabelText('server name')).toHaveProperty('value', 'half-filled-form')

    // Revalidation begins: still signed in, still the same user, but loading again.
    setAuth({ isLoading: true })
    rerender(
      <MemoryRouter initialEntries={['/protected']}>
        <Routes>
          <Route
            path="/protected"
            element={
              <ProtectedRoute>
                <TypeableForm />
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>,
    )

    // No spinner, and — the point — the subtree was never unmounted, so the value is intact.
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.getByLabelText('server name')).toHaveProperty('value', 'half-filled-form')
  })

  it('still blocks when a revalidation happens to clear the user', () => {
    setAuth({ user: null, isAuthenticated: false, isLoading: true })
    renderGate(<p>secret</p>)
    // No user and loading: we genuinely do not know yet, so blocking is correct.
    expect(screen.getByText('Loading…')).toBeTruthy()
  })
})

describe('AdminRoute follows the same rule', () => {
  it('blocks before the user is known', () => {
    setAuth({ user: null, isAuthenticated: false, isLoading: true })
    renderGate(<p>admin area</p>, AdminRoute)
    expect(screen.getByText('Loading…')).toBeTruthy()
  })

  it('renders for an admin mid-revalidation rather than unmounting', () => {
    setAuth({ user: ADMIN, isAuthenticated: true, isLoading: true })
    renderGate(<p>admin area</p>, AdminRoute)
    expect(screen.getByText('admin area')).toBeTruthy()
  })

  it('sends a non-admin away', () => {
    setAuth({ user: MEMBER, isAuthenticated: true, isLoading: false })
    renderGate(<p>admin area</p>, AdminRoute)
    expect(screen.queryByText('admin area')).toBeNull()
  })
})
