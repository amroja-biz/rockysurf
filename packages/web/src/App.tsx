import { Toaster } from 'react-hot-toast'
import { BrowserRouter, Route, Routes } from 'react-router'
import { AdminRoute, ProtectedRoute } from './components/ProtectedRoute'
import { AuthProvider } from './contexts/AuthContext'
import { EventsProvider } from './contexts/EventsContext'
import { CreateServerPage } from './pages/CreateServerPage'
import { DashboardPage } from './pages/DashboardPage'
import { LoginPage } from './pages/LoginPage'
import { ServerDetailPage } from './pages/ServerDetailPage'
import { AdminToolsPage } from './pages/AdminToolsPage'
import { SettingsPage } from './pages/placeholders'
import { CostsPage } from './pages/CostsPage'
import { SetupGate, WizardPage } from './pages/WizardPage'
import { AdminSurgePacksPage } from './pages/AdminSurgePacksPage'

export const APP_NAME = 'Rocky Surf'

/**
 * The app shell.
 *
 * Ported from `frontend/src/App.tsx`, with the routes that no longer exist removed rather
 * than stubbed: `/billing` (self-hosted — the operator pays their own cloud bill),
 * `/auth/callback` and `/auth/error` (no OAuth round trip to come back from), and
 * `/admin/limit-requests` (no multi-tenant quota). What is left is the same tree.
 *
 * Provider order is load-bearing: `EventsProvider` reads `useAuth`, so it must sit inside
 * `AuthProvider`, and both sit inside the router because `AuthContext` consumers navigate.
 *
 * ── ADDING A PAGE ─────────────────────────────────────────────────────────────────────
 * Two lines, both APPENDS, so concurrent additions touch different lines instead of one
 * contested block:
 *
 *   1. an import at the end of the import list;
 *   2. a `<Route>` at the END of the `<Routes>` block — after the `path="*"` catch-all is
 *      fine. React Router has ranked matching, so source order does not decide which route
 *      wins; the catch-all only fires when nothing more specific matches. Nobody needs to
 *      insert into the middle.
 *
 * Wrap in `<ProtectedRoute>`, or `<AdminRoute>` for admin-only pages. Pages get `useAuth`,
 * `useServerUpdates`, `useEvents` and `lib/api` from the shell — please don't rebuild those.
 * ──────────────────────────────────────────────────────────────────────────────────────
 */
export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <EventsProvider>
          <Toaster position="bottom-right" toastOptions={{ duration: 4000 }} />
          <Routes>
            <Route path="/login" element={<LoginPage />} />

            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <SetupGate>
                    <DashboardPage />
                  </SetupGate>
                </ProtectedRoute>
              }
            />
            <Route
              path="/servers/new"
              element={
                <ProtectedRoute>
                  <CreateServerPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/servers/:serverId"
              element={
                <ProtectedRoute>
                  <ServerDetailPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/settings"
              element={
                <ProtectedRoute>
                  <SettingsPage />
                </ProtectedRoute>
              }
            />

            <Route
              path="/admin/tools"
              element={
                <AdminRoute>
                  <AdminToolsPage />
                </AdminRoute>
              }
            />
            <Route
              path="/admin/surge-packs"
              element={
                <AdminRoute>
                  <AdminSurgePacksPage />
                </AdminRoute>
              }
            />

            {/* Unknown paths fall back to the dashboard, as they did before. */}
            <Route
              path="*"
              element={
                <ProtectedRoute>
                  <DashboardPage />
                </ProtectedRoute>
              }
            />

            {/* Costs (rockysurf-hzi7.4). */}
            <Route
              path="/costs"
              element={
                <ProtectedRoute>
                  <CostsPage />
                </ProtectedRoute>
              }
            />

            {/* Pack admin (rockysurf-hzi7.5). Admin-only. */}
            <Route
              path="/admin/surge-packs"
              element={
                <AdminRoute>
                  <AdminSurgePacksPage />
                </AdminRoute>
              }
            />

            {/* First-run wizard (rockysurf-hzi7.2). Signed-in, but NOT wrapped in SetupGate —
                this is where the gate sends people, so gating it would loop. */}
            <Route
              path="/setup"
              element={
                <ProtectedRoute>
                  <WizardPage />
                </ProtectedRoute>
              }
            />
          </Routes>
        </EventsProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
