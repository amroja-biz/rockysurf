# Rocky Surf — design system

Rocky Surf is an open-source control plane for **cloud servers for agentic engineering**. You run
one process on your own machine; it creates a Linux box on your own cloud account, installs your
coding agents on it from a **Surge Pack**, and hands you an SSH command. No SaaS, no accounts, no
telemetry, no phone-home. AWS, Azure, GCP, Hetzner, and BYO machines over SSH are supported.

The product is one thing, and this design system covers one surface: **the control plane's web
UI** — a single-page app served by the same process that holds the API. There is no marketing
site, no docs site, and no mobile app in the source, so there are no UI kits for them here.

## Sources this was built from

| Source | What was read |
|---|---|
| [github.com/amroja-biz/rockysurf](https://github.com/amroja-biz/rockysurf) | `packages/web/src/App.css` (the whole stylesheet — every token below is lifted from it), `App.tsx`, `components/AppShell.tsx`, `StatusBadge.tsx`, `PackIcon.tsx`, `TrustBadge.tsx`, `ToolList.tsx`, `ConfirmModal.tsx`, `ActivityFeed.tsx`, `ProvisioningFeed.tsx`, `pages/DashboardPage.tsx`, `ServerDetailPage.tsx`, `LoginPage.tsx`, `HomePage.tsx`, `lib/format.ts`, plus `README.md` and `CORE-PRINCIPLES.md` for voice |
| `uploads/logo.png` | The brand painting. Its palette was sampled to produce the `--rs-brand-*` tokens |
| Repo assets copied in | `docs/media/logo.png`, the shipped favicons, and all ten Surge Pack PNGs |

**Read the repository yourself before designing anything substantial.** `packages/web/src/App.css`
carries a comment on nearly every rule explaining why the value is what it is; the pages carry
long doc comments explaining what the UI refuses to do and why. That reasoning is the real design
system, and it is longer than this file.

Not read in full: `pages/SettingsPage.tsx` (60KB), `CreateServerPage.tsx` (67KB),
`PacksPage.tsx`, `HelpPage.tsx`, `CostsPage.tsx`. Their class names all appear in `App.css`, so
their treatments are represented, but the screens themselves were not recreated field-for-field.

---

## Content fundamentals

**Voice: a peer who has already made the mistake.** The README opens with a joke — "Are your
coding agents telling you they need their own space?" — and then never jokes again. Product copy
is flat, specific, and slightly grim about money and credentials.

- **Second person, always.** "Your AWS account, your Hetzner project." "Rocky Surf holds the
  credential and calls the API. The resources and the bill are yours." Never "we", never
  "users".
- **Sentence case everywhere.** Buttons: "New server", "Download dev-box.pem", "Sign out".
  Headings: "Where your servers and settings are kept". The only uppercase is `BYOC`, `SSH`,
  `MCP`, `YAML`, and an occasional bolded lead-in.
- **Name the fix inside the error.** Core's message is passed through verbatim rather than
  replaced: "server is still stopping; try again in a moment" beats "Could not stop dev-box".
  A UI that rewrites an error throws away the remedy.
- **State the consequence in the user's terms.** Stop: "The disk is kept, so you can start it
  again later. You are not billed for a stopped instance's compute." Terminate: "This destroys
  the server and its disk. It cannot be undone." Never "Are you sure?".
- **Say what the product will not do.** "Rocky Surf will not show it to you." "There is no way
  to add a token to a running box." "Rocky Surf resells nothing and sits in the middle of
  nothing." Refusals are features here and are written as such.
- **Numbers carry their caveat.** Every cost is followed by "Estimate. Rounds down: uptime
  accrues on a timer, so a running server has cost slightly more than shown." A missing value is
  an em dash with the reason in its `title`, never a zero.
- **Empty and pending states are a fact plus one action.** "No servers yet. Create one to get
  started." "Stopping…" — the ellipsis is the spinner.
- **No emoji.** Not one, anywhere in the source. Do not introduce any.
- **Lowercase monospace for anything the user types or copies**: `~/.rockysurf`,
  `docker compose up --build`, `sudo passwd rocky`.

## Visual foundations

**Colour.** GitHub-dark, one theme only — there is no light mode and no theme switch. Five
surfaces from `#0d1117` up to `#30363d`; five text levels; and accents with fixed meanings:
green acts and confirms, red refuses, yellow warns without failing yet, blue links and focuses,
purple appears exactly once (the agents callout). A notice body is its accent at 20% alpha over
the page, bordered in the accent at full strength.

**Type.** The system UI stack, no webfont, no fallback download. 28px page titles, 18px section
headings, and a 14px working size that most of the app lives at, with 13px and 12px for values
and hints. Line-height 1.5 in the app, 1.6 in prose, 1.25 on headings. Monospace is
information-carrying, not decorative: every IP, offering id, path, command, and pack guide is
monospaced, and prose never is.

**Space.** rem quarters, with 0.375/0.625/0.875 as real steps. Cards are padded 1.25rem (1.5rem
in the wizard and settings), a dashboard card 1rem. Each page sets its own measure: 1200px for
the dashboard, 760px for the create form and help, 680px for the wizard and home, 400px for
login.

**Backgrounds.** Flat colour. No gradients, no patterns, no textures, no noise, no blur, no
transparency except the notice washes and the modal overlay (`rgba(0,0,0,0.7)`). The one
photographic element in the entire product is the logo painting, used full-width as the home
page's hero; the app itself uses no imagery at all beyond 40px pack tiles.

**Borders and shadows.** **There are no shadows in this system.** A card is told from the page by
a 1px `#30363d` hairline and one step of lightness. Radii: 6px for nearly everything, 4px for a
box inside a card, 3px for inline code, 10px for the large pack tile, and a full pill for status
badges and chips. The only coloured borders are the active tab's 2px blue underline, the agents
callout's 3px purple left rule, and a notice's accent border.

**Motion.** Two transitions (`0.15s ease` on background and border colour, and on nav colour) and
two keyframes: `rs-pulse` at 1.5s for "this is happening right now" — the active timeline step, a
connecting stream, an unconfirmed stop — and `rs-spin` at 1s for a wait. Nothing slides, scales,
fades in, or bounces.

**Hover and press.** Hover lightens: a secondary button goes `#21262d` → `#30363d`, a nav link
gains the raised background, a card's border goes blue, a chip's border goes green. Press states
are **not** styled — no scale, no darkening. Disabled is 0.6 opacity and `not-allowed`. Focus is
a 2px blue outline, or on inputs, the border turning blue; it is never removed, only moved
inward.

**Layout rules.** One fixed element: the header, a surface bar with one hairline under it, which
every authenticated page goes through. Content is a single centred column — no sidebar anywhere.
Grids auto-fill: server cards at 320px minimum, pack cards at 260px. Below 768px, everything
collapses to one column and page padding drops to 1.25rem.

**Imagery.** Cool, dark, high-contrast. The logo is an engraved cross-hatch painting of a
lighthouse on a moonlit rocky shore — deep blue-blacks, warm brown rock, one cream light source.
Its palette is available as `--rs-brand-*` for editorial work (covers, slides, a hero). The
product UI never reaches for those tokens.

## Iconography

**There is one icon in the product, and it is GitHub's mark**, inlined as SVG in the header so
the bundle stays self-contained and the glyph follows `currentColor`. There is no icon library,
no icon font, no sprite sheet, and no CDN dependency — and adding one would be a change of
direction, not a fill-in.

Everything else is typographic. The activity feed's four events are `+`, `▶`, `■`, `×`; notices
open with `⚠` (yellow) or `●` (red); a dismiss control is `×`; an external link ends `↗`; a
missing value is `—`. The timeline's dots and rail are CSS pseudo-elements, not glyphs. **No
emoji.**

The one real image system is Surge Pack marks: a 2.5rem PNG at 6px radius (4.5rem at 10px for the
large variant), with a deterministic monogram tile as fallback — the first letters of the first
two words of the pack's name, on one of six accents chosen by a stable hash of `packId`. All ten
shipped pack PNGs are in `assets/surge-packs/`. Never `Math.random`, never the list index: a pack
must look the same on every reload.

---

## Index

| Path | What it is |
|---|---|
| `styles.css` | The global entry point — `@import` lines only. Consumers link this one file. |
| `tokens/` | `colors.css`, `typography.css`, `spacing.css`, `borders.css`, `motion.css` |
| `css/` | The product's own stylesheet, split by concern: `base`, `layout`, `buttons`, `forms`, `cards`, `badges`, `feedback`, `tables`, `packs` |
| `assets/` | `logo.png` (the painting), `mark-48.png` / `mark-192.png` / `favicon.ico`, `openclaw-wallpaper.png`, `surge-packs/` (ten PNGs) |
| `guidelines/` | 17 specimen cards — colours, type, spacing, radii, motion, iconography, pack marks, the logo |
| `components/` | The reusable primitives, below |
| `ui_kits/rockysurf-app/` | The click-through control plane. Start at `index.html`; `README.md` maps each screen to its source file |
| `thumbnail.html` | The homepage tile |
| `handoff/` | Dropping the etched skin into `packages/web`: `etched.css`, `etched.tsx.txt`, and a README with the rollout order and the upstream delta |
| `SKILL.md` | Agent Skills front matter, for using this system in Claude Code |
| `github.md` | The source-repo association and sync record |

### Components

**`components/core/`** — `Button`, `StatusBadge`, `Badge`, `ArchBadge`, `Notice`, `EmptyState`,
plus `statusLabels.js` (`STATUS_LABELS`, `TRANSITION_LABELS`, `STEP_LABELS`, `STEP_ORDER` — core's
vocabulary, in one place so two screens cannot disagree about what a step is called).

**`components/forms/`** — `Field`, `RadioOption`, `Tabs`, `CheckboxRow`, `Chip`.

**`components/surfaces/`** — `Card`, `Inset`, `Modal`, `ConfirmModal`, `DataTable`.

**`components/feedback/`** — `StepList`, `ActivityFeed`, `ConnectionStatus`, `IpChangeAlert`,
`BackupReminder`, `StillBillingNotice`.

**`components/packs/`** — `PackIcon`, `PackCard`, `ToolList`, `PackGuide`.

**`components/servers/`** — `ServerCard`, `MetaList`.

**`components/shell/`** — `AppShell`.

**`components/etched/`** — the logo-derived parts, for the etched skin: `EtchedDefs`, `Lamp`,
`Tally`, `Waterline`, `Moon`, `Beacon`, `Swell`, `Shore`, `Plate`.

Each directory has a `.d.ts` props contract and a `.prompt.md` usage note per component, and one
`@dsCard` HTML showing its states.

## The etched skin

The logo is an engraving — the beam drawn as swept arcs, water as repeated strokes, rock as
angular hatched mass, the moon as a hatched disc. The etched skin takes those marks and gives
each one a job, rather than laying texture over the GitHub-dark app.

Opt in with `data-rs-skin="etched"` on `<html>` (or any subtree). It changes three things and
nothing else: the ground becomes the painting's night, the ink its cream, and the single accent
its beam `#e8c37a` — which also replaces blue for links and focus. **The five status meanings
are untouched**: green still acts, red still refuses, yellow still warns. Corners square, labels
are cut in letterspaced caps, and nothing is filled except the one thing currently true.

| Part | What it replaces | Why that mark |
|---|---|---|
| `Lamp` | `StatusBadge` | The lighthouse's own light: three swept arcs running, two dashed and pulsing while provisioning, a lens with the beam cut when it failed |
| `Tally` | the uptime value's mark | One stroke an hour, crossed at each fifth. Uptime has no ceiling, so it must not be drawn as a gauge — a bar or a curve implies an axis that does not exist |
| `Waterline` | a level against a cap | Ticked staff, hatched water, one wave stroke at the surface. Only for a quantity whose ceiling is named beside it — spend against the cap is the only one in this product |
| `Moon` | the spend-cap headline | A real lunar phase: the terminator is an ellipse of width \|1 − 2f\|, so it never reads as a pie slice |
| `Beacon` | `StepList` | The timeline as the beam: the tower at left, the light widening down the list as far as the work has got |
| `Swell` | the 1px divider | The same separation, said in the illustration's hand |
| `Shore` | `EmptyState` | The rock mass under a horizon — what the plate is actually a picture of |
| `Plate` | `Card`'s frame | A rule, an inset margin, and registration ticks at the corners, instead of a 6px radius |

Two honest caveats. **The line art is drawn geometry, not illustration** — competent, consistent,
and no substitute for a real engraver's hand; `Lamp` and `Shore` in particular deserve drawn
assets if this becomes the product's face. And `Waterline` deliberately does not appear on a
server card: there is no room there to name the cap, and a level without its ceiling is a
decoration.

Every part needs `<EtchedDefs />` mounted once per page for its hatch pattern; without it the
strokes still draw and only the fills are missing.

Explorations that led here are in `ui_kits/explorations/` — A/B/C (palette, light, material),
D/E/F (three readings of "etched" applied to the existing components), and G, the first screen
built from the parts themselves.

### Intentional additions

The source has no component library — the app is pages plus a `components/` folder of one-offs
against a global stylesheet. These are named in `App.css` as classes but had no component of
their own upstream, and were factored out here because a consuming design needs them by name:
`Button`, `Badge`/`ArchBadge`, `Notice`, `EmptyState`, `Field`, `RadioOption`, `Tabs`,
`CheckboxRow`/`Chip`, `Card`/`Inset`, `Modal`, `DataTable`, `MetaList`, `ServerCard`,
`PackCard`, `PackGuide`. Every one of them uses the class names and values already in the
stylesheet; none invents a treatment.

### Known gaps

- **No webfont files**, because the product uses none. `--font-ui` is the system stack minus
  `Oxygen` (dropped only so this system does not claim a font file it has no binary for);
  `--rs-mono` is the system mono stack. If Rocky Surf ever adopts a typeface, that is a real
  change and not a substitution to make quietly.
- **No slide template**, because none was provided.
- `/settings`, `/costs`, `/admin/tools` and the first-run wizard are not recreated as screens.
