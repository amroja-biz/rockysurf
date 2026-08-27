repo: amroja-biz/rockysurf
branch: main
path: packages/web

## Last sync

date: 2026-08-27T12:07:34Z

Read `packages/web/src/etched.css` at `main` to ground a button-styling change against the real
upstream file, rather than this project's own `_ds/` copy alone.

### Updated in this project

- Reworked the etched skin's button rules (`css/etched.css` in the bound design system, and a
  matching upstream-shaped file at `packages/web/src/etched.css` in this project, ready to drop
  into the repo at that same path) — flat green fill on the primary button in place of the
  diagonal hatch, 6px radius + top-highlight/drop-shadow/press bevel, and a new `.stop-action`
  (yellow, `#d29922`/`#e3b341`) modifier for reversible "Stop" actions, distinct from neutral
  secondary and destructive/red.
- `Ember screens.dc.html` now uses `.stop-action` on both Stop buttons and corrected "Copy
  command" from `.primary` (green) to secondary/neutral.
- Compared upstream `packages/web/src` against the bound design system and wrote `Sync report.dc.html`.
- Confirmed all twenty `:root` tokens in `App.css` still match the system's `tokens/` verbatim.
- Confirmed the etched skin has SHIPPED upstream (`src/etched.css`, `src/components/etched.tsx`);
  its seventeen tokens match `tokens/etched.css` exactly, so `handoff/` is now describing work already done.
- Added `.new-action` (cyan, `--rs-cyan` `#39c5cf`) for "New" buttons — approved after preview —
  alongside `.stop-action`, in both `css/etched.css` and `packages/web/src/etched.css`; documented
  in the guide as a sixth accent, scoped to buttons.

### Needs doing upstream

- Apply `packages/web/src/etched.css` (in this project) over the repo's current
  `packages/web/src/etched.css` — button rules only changed; every other rule is untouched.
- Add `.stop-action`/`.new-action` to the Stop/New button `className`s wherever
  `ServerCard`/`ServerDetailPage`/`DashboardPage` render them (currently plain, unmodified `button`).

### Needs doing in the design-system project

- Retire `handoff/`; re-read the shipped `etched.tsx` (20 KB) for parts the system lacks.
- Decide on two new dependencies: CodeMirror 6 (one-dark theme, foreign palette) and
  react-hot-toast (transient feedback, which the motion rule currently forbids).
- Add nine components: SpendCapBanner, ProviderErrorNotice, StaleServersNotice, CodeEditor,
  ToolFormModal, BootstrapReport, InstallPreview, ConnectGitHubCard, PackDisclosure.
- Port five missing CSS blocks: `.provider-error-*`, `.stale-servers-notice*`, `.code-editor`,
  `.tab-marker`, `.wizard > header`.
- Recreate settings, costs, admin tools and the wizard as screens.

## Screen map

| Screen | Built from |
|---|---|
| `Sync report.dc.html` | `packages/web/package.json`, `src/App.css`, `src/etched.css`, `src/components/*`, `src/pages/*` (tree survey) |
