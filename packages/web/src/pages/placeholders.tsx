import { AppShell } from '../components/AppShell'

/**
 * PLACEHOLDERS. Each is its own bead in this milestone; the shell routes to them so the
 * navigation is whole while they land one at a time.
 *
 * Shrinking as pages arrive — Dashboard, ServerDetail, CreateServer, Costs, Wizard, Tools and
 * Surge packs have all moved out into their own files. Settings is the last one left. When you
 * replace it, delete this file and import your page in `App.tsx` directly.
 */

export const SettingsPage = () => <AppShell title="Settings">{PLACEHOLDER}</AppShell>

const PLACEHOLDER = <p className="hint">This page is a placeholder. Its real implementation is a later task.</p>
