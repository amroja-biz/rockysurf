import { Toaster } from 'react-hot-toast'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import './App.css'
// The etched skin (#174). Additive: every rule is scoped under [data-rs-skin='etched'], set on
// <html> in index.html. Must come after App.css so its token re-declarations win. Remove the
// attribute and the app renders exactly as it did; remove this import and the skin is gone.
import './etched.css'
import { AdminRoute, ProtectedRoute } from './components/ProtectedRoute'
import { AuthProvider } from './contexts/AuthContext'
import { EventsProvider } from './contexts/EventsContext'
import { CreateServerPage } from './pages/CreateServerPage'
import { DashboardPage } from './pages/DashboardPage'
import { LoginPage } from './pages/LoginPage'
import { ServerDetailPage } from './pages/ServerDetailPage'
import { AdminToolsPage } from './pages/AdminToolsPage'
import { SettingsPage } from './pages/SettingsPage'
import { CostsPage } from './pages/CostsPage'
import { SetupGate, WizardPage } from './pages/WizardPage'
import { PacksPage } from './pages/PacksPage'
import { HomePage } from './pages/HomePage'
import { HelpPage } from './pages/HelpPage'

export const APP_NAME = 'Rocky Surf'

/**
 * The app shell.
 *
 * Ported from the legacy SPA's app shell, with the routes that no longer exist removed rather
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
          {/* Toast styling is a prop, not a stylesheet — react-hot-toast renders its surface
              inline and defaults to white, which is why the port losing this made toasts the
              one light rectangle on a dark page (rockysurf-a29w). The surface and text follow
              the skin's tokens (#174); the two status colours are the product's own and the
              skin leaves them alone. */}
          <Toaster
            position="bottom-right"
            toastOptions={{
              duration: 4000,
              style: {
                background: 'var(--rs-surface)',
                color: 'var(--rs-text)',
                border: '1px solid var(--rs-border)',
                borderRadius: 'var(--rs-radius)',
              },
              success: { iconTheme: { primary: '#238636', secondary: '#171420' } },
              error: {
                style: { borderColor: '#f85149' },
                iconTheme: { primary: '#f85149', secondary: '#171420' },
              },
            }}
          />
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
            {/* Admin-only (rockysurf-m29b): this page writes the config file, which names the
                provider credential references and decides what the MCP server may do. */}
            <Route
              path="/settings"
              element={
                <AdminRoute>
                  <SettingsPage />
                </AdminRoute>
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
            {/* Surge Packs (rockysurf-4d8h, issue #51): one page, member-reachable, replacing
                the two admin-only pages that used to live at these paths. Both redirect here
                for old bookmarks and the docs/skill references that still name them. */}
            <Route
              path="/packs"
              element={
                <ProtectedRoute>
                  <PacksPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/packs/:packId"
              element={
                <ProtectedRoute>
                  <PacksPage />
                </ProtectedRoute>
              }
            />
            <Route path="/admin/surge-packs" element={<Navigate to="/packs" replace />} />
            <Route path="/admin/pack-shop" element={<Navigate to="/packs" replace />} />

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

            {/* Home and Help (rockysurf-n0zr, issue #16). Home is NOT the index route: `/` is
                the dashboard people work from, and mid-flight that stays put. Home is where
                the navbar brand goes — what the product is, for someone who just got here. */}
            <Route
              path="/home"
              element={
                <ProtectedRoute>
                  <HomePage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/help"
              element={
                <ProtectedRoute>
                  <HelpPage />
                </ProtectedRoute>
              }
            />
          </Routes>
        </EventsProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
