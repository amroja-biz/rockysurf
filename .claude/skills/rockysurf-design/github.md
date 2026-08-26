repo: amroja-biz/rockysurf
branch: main
path: packages/web

## Last sync

date: 2026-08-26T18:41:00Z

### Updated in this project

- Ported `packages/web/src/App.css` into `tokens/` + `css/` — every colour, radius and spacing step verbatim.
- Authored 24 components from the app's real markup and class names.
- Copied the logo, the shipped favicons and all ten Surge Pack PNGs into `assets/`.
- Built `ui_kits/rockysurf-app/` as a click-through of login, dashboard, create, detail and packs.
- Added the etched skin — nine logo-derived components plus an opt-in `data-rs-skin` scope.
- Wrote `handoff/` — a drop-in `etched.css` and `etched.tsx` for `packages/web`, additive only.

**Upstream moved between the two reads** (tree `1eb29bfed693` → `e5094d70a75e`): `App.css`
51→64 KB; new `ProviderErrorNotice`, `StaleServersNotice`, `Tabs.tsx`, `lib/serverActions.ts`;
Help, Settings, Dashboard and ServerDetail all grew substantially. The UI kit reflects the
EARLIER read; the handoff is written to be additive so it does not overwrite any of it.

## Screen map

| Screen | Built from |
|---|---|
| `ui_kits/rockysurf-app/LoginScreen.jsx` | `packages/web/src/pages/LoginPage.tsx` |
| `ui_kits/rockysurf-app/DashboardScreen.jsx` | `packages/web/src/pages/DashboardPage.tsx`, `components/ActivityFeed.tsx`, `BackupReminder.tsx`, `IpChangeAlert.tsx`, `StillBillingNotice.tsx` |
| `ui_kits/rockysurf-app/CreateServerScreen.jsx` | `packages/web/src/pages/CreateServerPage.tsx` (class names via `App.css`) |
| `ui_kits/rockysurf-app/ServerDetailScreen.jsx` | `packages/web/src/pages/ServerDetailPage.tsx`, `components/ToolList.tsx`, `ProvisioningFeed.tsx` |
| `ui_kits/rockysurf-app/PacksScreen.jsx` | `packages/web/src/pages/PacksPage.tsx` (class names via `App.css`), `components/PackIcon.tsx`, `TrustBadge.tsx`, `PackDisclosure.tsx` |
| `ui_kits/rockysurf-app/HomeScreen.jsx` | `packages/web/src/pages/HomePage.tsx`, root `README.md` |
| `ui_kits/rockysurf-app/App.jsx` | `packages/web/src/App.tsx`, `components/AppShell.tsx` |
| `tokens/*.css`, `css/*.css` | `packages/web/src/App.css` |
| `components/**` | `packages/web/src/components/*`, `lib/format.ts` |
| `components/etched/**` | Original — derived from `assets/logo.png`, not from repo source |
| `handoff/etched.css`, `handoff/etched.tsx.txt` | Ports of the above, targeting `packages/web/src` |
