import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { useAuth } from '../contexts/AuthContext'

/**
 * Gate for signed-in routes. Ported unchanged apart from the router import — React Router
 * merged `react-router-dom` into `react-router` at v7.
 *
 * The loading branch matters: without it, the first paint of a reloaded page renders
 * unauthenticated (because `/auth/me` has not answered yet) and bounces the user to the login
 * screen they were already past.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading, user } = useAuth()
  const location = useLocation()

  // Block ONLY while we do not yet know who the user is — the first load.
  //
  // The `&& !user` is the whole fix (rockysurf-hzi7.8). Returning a spinner in place of
  // `children` UNMOUNTS them, and an unmounted React subtree loses all of its state: a
  // half-filled create-server form, a half-typed pack YAML, a scroll position. Gating on
  // `isLoading` alone means any future revalidation that flips the flag back to true silently
  // wipes whatever the user was in the middle of, everywhere in the app at once.
  //
  // Today nothing sets it back — `AuthContext` flips it false exactly once — so this is a trap
  // rather than an active bug. But `refreshUser` is exported for callers to use, and the
  // obvious next step for anyone adding periodic revalidation is to have it set a loading
  // flag. Then the trap springs, far from this file, and the symptom (forms clearing at
  // random) looks nothing like the cause.
  if (isLoading && !user) {
    return (
      <div className="loading-container">
        <div className="loading-spinner" />
        <p>Loading…</p>
      </div>
    )
  }

  if (!isAuthenticated) return <Navigate to="/login" state={{ from: location }} replace />

  return <>{children}</>
}

/** Admin-only routes. In single-admin mode the only account is an admin, but the check is
 * kept so the component ports and so a future non-admin user is refused by default. */
export function AdminRoute({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth()

  // Same rule, same reason: only block before we know who the user is.
  if (isLoading && !user) return <p>Loading…</p>
  if (!user) return <Navigate to="/login" replace />
  if (!user.isAdmin) return <Navigate to="/" replace />

  return <>{children}</>
}
