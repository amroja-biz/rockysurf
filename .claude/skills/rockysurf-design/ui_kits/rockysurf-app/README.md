# UI kit — the Rocky Surf control plane

A click-through recreation of the app at `packages/web` in
[amroja-biz/rockysurf](https://github.com/amroja-biz/rockysurf). Open `index.html`: the flow is
sign in → your servers → create a server → watch it provision → open it → Surge Packs.

The password is anything four characters or longer; nothing here talks to a network.

| File | The screen it recreates | Source it was read from |
|---|---|---|
| `LoginScreen.jsx` | `/login` — single-admin password | `pages/LoginPage.tsx` |
| `DashboardScreen.jsx` | `/` — the server grid and activity feed | `pages/DashboardPage.tsx` |
| `CreateServerScreen.jsx` | `/servers/new` — provider, size, pack, repos | `pages/CreateServerPage.tsx`, `App.css` |
| `ServerDetailScreen.jsx` | `/servers/:id` — summary, Connect, guide, repos, installed | `pages/ServerDetailPage.tsx` |
| `PacksScreen.jsx` | `/packs` and `/packs/:packId` — the shop and one pack | `pages/PacksPage.tsx` classes in `App.css`, `components/PackIcon.tsx`, `TrustBadge.tsx` |
| `HomeScreen.jsx` | `/home` — what the product is | `pages/HomePage.tsx` |
| `App.jsx` | Routing and the fake lifecycle | `App.tsx`, `components/AppShell.tsx` |
| `data.js` | Fixtures. Shapes follow `lib/api.ts`; values invented. | — |

## Deliberately not recreated

`/settings` (a 60KB config editor), `/costs`, `/admin/tools` and the first-run `/setup` wizard.
The wizard's step pills and the settings card treatment are in the stylesheet
(`.wizard > header li`, `.settings-entry`) and in the Spacing cards, so they can be built without
guessing — the screens themselves were left out rather than approximated. The create form's
machine-type picker table and the install-preview modal are also stubs here: the real ones are
driven by a live provider catalogue.
