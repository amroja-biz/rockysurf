import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import toast from 'react-hot-toast'
import { AppShell } from '../components/AppShell'
import { Shore } from '../components/etched'
import { PackDisclosurePanel } from '../components/PackDisclosure'
import { PackIcon } from '../components/PackIcon'
import { Tabs } from '../components/Tabs'
import { ToolList } from '../components/ToolList'
import { TrustBadge } from '../components/TrustBadge'
import { useAuth } from '../contexts/AuthContext'
import {
  ApiError,
  createAdminSurgePack,
  deleteAdminSurgePack,
  exportSurgePackYaml,
  getPackRegistry,
  getRegistryPack,
  importSurgePack,
  installRegistryPack,
  listAdminSurgePacks,
  listAdminTools,
  listSurgePacks,
  updateAdminSurgePack,
  type AdminSurgePack,
  type AdminTool,
  type PackRegistry,
  type RegistryPack,
  type RegistryPackDetail,
  type SurgePack,
  type PackInput,
  type SurgePackTool,
} from '../lib/api'
import { carryFromSource, forkNameFor, forksByParent, suggestNewPackId } from '../lib/derive-pack'
import { SHOP_URL } from '../lib/links'

/**
 * Surge Packs (rockysurf-4d8h, issue #51).
 *
 * ONE PAGE where there used to be two — `/admin/surge-packs` and `/admin/pack-shop` — both
 * admin-only, both reading `listAdminSurgePacks()`, and neither reachable by a member or
 * showing what a pack actually installs. This page is member-reachable at `/packs` (list) and
 * `/packs/:packId` (detail, same component, branching on `useParams()`), with every admin
 * capability of both old pages surviving, gated on `user.isAdmin` rather than on the route —
 * import and creation sit in the Personal section's header (issue #199), Refresh in Community's.
 *
 * PROVENANCE COMES FROM CORE, NEVER RECOMPUTED HERE. `SurgePack.provenance` is derived
 * server-side from `sourceFile` and a registry install can never claim `official` (ADR-0006).
 * The admin-only `origin` sentence adds detail (which file, which registry) but never
 * overrides the badge, which reads the same three words core sends everywhere else.
 *
 * THE PUBLIC LIST IS ENABLED-ONLY. A disabled pack reaches this page only through the admin
 * list, which is why an admin's view is a MERGE of the public rows (the base) and any admin
 * row the public list withheld — never a second, wider public read.
 *
 * THREE SECTIONS, NAMED BY THE SAME WORD THEIR BADGE USES (issue #199). `official` shipped with
 * this release, `registry` came from a Pack Shop catalogue, `local` was created or imported on
 * this installation — and the headings read Official / Community / Personal, because a section
 * called "Community" that also held locally-created packs, sitting above a *second* block also
 * badged COMMUNITY, was one word carrying three meanings. The wire values above this line never
 * change; `badgeText()` below is the only place they get a different word to wear.
 *
 * COMMUNITY IS ONE SECTION WITH A FILTER, not two blocks. The old "Community" grid (registry
 * packs already installed) and the old "Rocky Surf Pack Shop" block (the registry catalogue,
 * installed or not) covered the same packs from two different reads, so an installed one could
 * appear in both. All / Installed / Not installed — modelled on Claude's Connectors page — picks
 * ONE of those reads at a time: Installed renders `views` (a normal `PackCard`, so it gets the
 * popup and opens the detail page like anything else), Not installed renders the catalogue
 * entries the registry itself says are not (`RegistryPack.installed === false`), and All is the
 * concatenation of both. Because the split is on that flag rather than on set membership, a pack
 * can never land in both halves.
 *
 * THE POPUP AND THE PACK FILE ARE FOR EVERY PACK, not only `official` ones (issue #199 undoes
 * the gate issue #192 put here; see `docs/memories/2026-08-27-everyone-who-runs-an-installation-
 * is-its-admin.md` for why "official only" was never a distinction worth drawing — Export
 * already read the same route for every pack, so withholding the popup and the read-only view
 * of the same bytes was a UI seam with nothing behind it).
 *
 * THE THREE SECTIONS ARE TABS (issue #204), routed the way Settings routes its own (issue #122):
 * `?tab=` in the URL, not a `useState` beside it, so a pasted link lands on the right tab and
 * Back/Forward walk through the ones actually visited. Official is `tabIds[0]` — shown first,
 * same as the stacked layout read top to bottom. All three panels stay mounted (`hidden`, not
 * unmounted), matching Settings' own reason for doing the same: nothing this page fetches is
 * tab-gated, so mounting only the active one would buy nothing and would drop whatever a person
 * had half-typed into Personal's create flow the moment they looked at another tab.
 *
 * COMMUNITY DEFAULTS TO INSTALLED, not All — issue #204 flips the default now that the tab
 * itself already reads "Community", so opening it and seeing only the catalogue (which #204's
 * caption now names as coming from Rocky Surf Shop) was a worse first look than seeing what is
 * already on this installation. `localStorage` still remembers a person's own later choice.
 *
 * PERSONAL'S CREATE FLOW IS A SMALL STATE MACHINE (issue #204), not a single form: one
 * `New Surge Pack` button (cyan, matching #183's `new-action` convention) opens a chooser
 * between uploading a file, starting from an existing pack (the same structured form as
 * `scratch`, seeded from the source's own tools and behaviour fields rather than from Export —
 * see `StartFromExistingPanel`'s own docblock for why Export is the wrong source), and today's
 * blank structured form. An inline panel, not a modal-overlay: the structured form it can still
 * open was already inline before this issue, and a chooser that is sometimes a modal and sometimes
 * not would be two behaviours for one button.
 */

/** What one pack looks like on this page, after the public and admin reads are merged. */
interface PackView {
  packId: string
  name: string
  imageUrl?: string
  theme?: string
  guide?: string
  enabled: boolean
  provenance: SurgePack['provenance']
  tools: SurgePackTool[]
  requiresRepos: boolean
  requiresRdp: boolean
  desktop?: 'xfce'
  webPort?: number
  /** What the pack asks the user for at create time (issue #189). Public list only. */
  inputs?: PackInput[]
  /** The pack this one was forked from (issue #295). Drives the delta on both cards. */
  derivedFromPackId?: string
  displayOrder: number
  /** Admin only: where this pack came from, in more detail than the badge carries. */
  origin?: string
  /** Admin only: the YAML file this row is backed by, or null for a database row. */
  sourceFile?: string | null
  /** Admin only: whether Edit/Delete apply here — false for a file-backed row and for a member. */
  editable: boolean
}

/**
 * The origin sentence, precedence file-backed-first (ported from `AdminPackShopPage`'s
 * `describeInstalled`, rockysurf-4d8h). File-backed is checked FIRST because a row can in
 * principle carry both a `sourceFile` and stale registry columns, and what is on disk is what
 * the boot sync will enforce on the next start.
 */
/**
 * The exact string core stamps on a pack fetched from a one-off URL import, rather than from a
 * source somebody configured (`packs/routes.ts`). Duplicated because the SPA does not import
 * from core; the sentence below is the only thing that depends on it, and a drift shows up as
 * the generic "installed from …" wording rather than as a broken page.
 */
const URL_IMPORT_SOURCE = 'a URL import'

/**
 * Community's All / Installed / Not installed filter (issue #199), modelled on Claude's
 * Connectors page. Remembered per browser — a preference about how someone reads this section,
 * not data, so `localStorage` rather than a server round trip. Default `installed` (issue #204;
 * was `all`): with the sections now tabbed and Community's caption naming where the catalogue
 * comes from, opening the tab to nothing but "not on this installation yet" was the wrong first
 * look.
 */
type CommunityFilter = 'all' | 'installed' | 'not-installed'
const COMMUNITY_FILTER_KEY = 'rockysurf.packs.communityFilter'
const COMMUNITY_FILTERS: readonly { key: CommunityFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'installed', label: 'Installed' },
  { key: 'not-installed', label: 'Not installed' },
]

function readStoredCommunityFilter(): CommunityFilter {
  try {
    const stored = localStorage.getItem(COMMUNITY_FILTER_KEY)
    if (stored === 'all' || stored === 'installed' || stored === 'not-installed') return stored
  } catch {
    // Private browsing, or storage disabled — the default is a fine fallback either way.
  }
  return 'installed'
}

/**
 * The three sections as tabs (issue #204), routed like Settings' own (issue #122):
 * `?tab=<key>` in the URL is the only place the active tab lives. Official first, matching the
 * order the stacked layout read top to bottom.
 */
type PacksTab = 'official' | 'community' | 'personal'
const PACKS_TAB_PARAM = 'tab'
const PACKS_TABS: readonly { key: PacksTab; label: string; controls: string }[] = [
  { key: 'official', label: 'Official', controls: 'packs-panel-official' },
  { key: 'community', label: 'Community', controls: 'packs-panel-community' },
  { key: 'personal', label: 'Personal', controls: 'packs-panel-personal' },
]
const PACKS_TAB_KEYS = PACKS_TABS.map((t) => t.key)

function originOf(pack: AdminSurgePack): string {
  if (pack.sourceFile) return `shipped with this release · ${pack.sourceFile}`
  /**
   * THE URL IS PART OF THE ANSWER (issue #88). "Installed from My packs" says which shelf an
   * admin clicked; it does not say what this installation actually fetched, and with personal
   * sources that is the question — these are install scripts that run as root on every box
   * created with the pack. The URL is admin-only, like everything else in this sentence.
   */
  if (pack.registry?.source === URL_IMPORT_SOURCE && pack.registry.url) return `imported from ${pack.registry.url}`
  if (pack.registry?.source) {
    return pack.registry.url
      ? `installed from ${pack.registry.source} · ${pack.registry.url}`
      : `installed from ${pack.registry.source}`
  }
  return 'created here, in this installation'
}

/** The same three-way split core computes for the public list, applied to an admin-only row. */
function provenanceOf(pack: AdminSurgePack): SurgePack['provenance'] {
  if (pack.sourceFile) return 'official'
  if (pack.registry?.source) return 'registry'
  return 'local'
}

function toSurgePackTool(tool: AdminTool): SurgePackTool {
  return { toolId: tool.toolId, name: tool.name, description: tool.description, category: tool.category, url: tool.url }
}

function expandTools(ids: string[], toolsById: Map<string, AdminTool>): SurgePackTool[] {
  return ids.map((id) => {
    const tool = toolsById.get(id)
    return tool ? toSurgePackTool(tool) : { toolId: id, name: id, description: '', category: 'base', url: '' }
  })
}

function buildViews(
  publicPacks: SurgePack[],
  adminPacksById: Map<string, AdminSurgePack>,
  toolsById: Map<string, AdminTool>,
  isAdmin: boolean,
): PackView[] {
  const seen = new Set(publicPacks.map((p) => p.packId))

  const fromPublic: PackView[] = publicPacks.map((p) => {
    const admin = adminPacksById.get(p.packId)
    return {
      packId: p.packId,
      name: p.name,
      imageUrl: p.imageUrl,
      theme: p.theme,
      guide: p.guide,
      enabled: p.enabled,
      provenance: p.provenance,
      tools: p.tools,
      requiresRepos: p.requiresRepos,
      requiresRdp: p.requiresRdp,
      desktop: p.desktop,
      webPort: p.webPort,
      inputs: p.inputs,
      derivedFromPackId: p.derivedFromPackId,
      displayOrder: p.displayOrder,
      origin: isAdmin && admin ? originOf(admin) : undefined,
      sourceFile: admin?.sourceFile ?? null,
      editable: isAdmin ? !admin?.sourceFile : false,
    }
  })

  // Everything the public list withheld because it is disabled (§3.4) — admin-only, and its
  // tools arrive as ids that need expanding through the tool catalogue.
  const fromAdminOnly: PackView[] = isAdmin
    ? [...adminPacksById.values()]
        .filter((p) => !seen.has(p.packId))
        .map((p) => ({
          packId: p.packId,
          name: p.name,
          imageUrl: p.imageUrl,
          theme: p.theme,
          guide: p.guide,
          enabled: p.enabled,
          provenance: provenanceOf(p),
          tools: expandTools(p.tools, toolsById),
          requiresRepos: p.requiresRepos,
          requiresRdp: p.requiresRdp,
          desktop: p.desktop,
          webPort: p.webPort,
          derivedFromPackId: p.derivedFromPackId,
          displayOrder: p.displayOrder,
          origin: originOf(p),
          sourceFile: p.sourceFile ?? null,
          editable: !p.sourceFile,
        }))
    : []

  return [...fromPublic, ...fromAdminOnly]
}

/** Same order core sorts the public list by: `displayOrder`, then `packId`. */
const byOrder = (a: PackView, b: PackView) => a.displayOrder - b.displayOrder || a.packId.localeCompare(b.packId)

/**
 * The word a badge shows, as distinct from `provenance` itself (issue #199). Everywhere this
 * page passes a wire value to `TrustBadge`'s `label` — the styling and the `data-testid` — this
 * is what it passes as `text`, the word a person reads. `official` needs no entry: its badge
 * already reads the same word as its heading.
 */
function badgeText(provenance: 'official' | 'registry' | 'local'): string {
  return provenance === 'registry' ? 'community' : provenance === 'local' ? 'personal' : provenance
}

/* `suggestNewPackId`, `forkNameFor` and `carryFromSource` moved to `lib/derive-pack.ts` when
 * "Add to a pack…" became a second door onto forking (issue #295). */

function behaviourChips(
  view: Pick<PackView, 'requiresRepos' | 'requiresRdp' | 'desktop' | 'webPort' | 'inputs'>,
): string[] {
  const inputCount = view.inputs?.length ?? 0
  return [
    view.requiresRepos ? 'needs a repository' : null,
    view.requiresRdp ? 'remote desktop' : null,
    view.desktop ? `${view.desktop} desktop` : null,
    view.webPort ? `web UI on :${view.webPort}` : null,
    // What the pack will ASK you for (issue #189) — a count rather than the names, because this
    // is a card in a list and the names are on the create form and in the disclosure, where a
    // person is deciding rather than browsing.
    inputCount > 0 ? `asks for ${inputCount} setting${inputCount === 1 ? '' : 's'}` : null,
  ].filter((chip): chip is string => Boolean(chip))
}

/* ------------------------------------------------------------------------- create/edit form */

interface PackFormState {
  packId: string
  name: string
  tools: string[]
  displayOrder: number
  enabled: boolean
  requiresRepos: boolean
  requiresRdp: boolean
  desktop: '' | 'xfce'
  /** As typed: '' means "no web UI". Parsed to a number only when the payload is built. */
  webPort: string
}

const emptyForm: PackFormState = {
  packId: '',
  name: '',
  tools: [],
  displayOrder: 0,
  enabled: true,
  requiresRepos: false,
  requiresRdp: false,
  desktop: '',
  webPort: '',
}

const toForm = (pack: AdminSurgePack): PackFormState => ({
  packId: pack.packId,
  name: pack.name,
  tools: pack.tools,
  displayOrder: pack.displayOrder,
  enabled: pack.enabled,
  requiresRepos: pack.requiresRepos,
  requiresRdp: pack.requiresRdp,
  desktop: pack.desktop ?? '',
  webPort: pack.webPort?.toString() ?? '',
})

/**
 * The create/edit form (ported verbatim from `AdminSurgePacksPage`, rockysurf-4d8h). Behaviour
 * fields exist so a pack describes itself rather than the application special-casing a packId.
 *
 * `seed`, IGNORED WHEN `initial` IS SET (issue #204) — this is still create mode, not edit mode,
 * for "start from an existing pack": the Pack ID field stays visible and editable exactly as it
 * does for a blank form, only pre-filled with a suggested new id rather than empty. Whatever
 * `tools` it seeds are ids `form.tools` already only ever holds — a checkbox list over the
 * existing catalogue — so submitting a seeded form REFERENCES those tools, never redefines them,
 * which is the whole reason this reads `AdminSurgePack.tools` and not `Export`'s inlined YAML
 * (`docs/writing-a-pack.md` § "Building on an existing pack"; the `create-surge-pack` skill's
 * own warning against using Export as a "fork this pack" button is the trap this form's shape
 * sidesteps for free).
 */
function SurgePackFormModal({
  initial,
  seed,
  carry,
  tools,
  onCancel,
  onSaved,
}: {
  initial: AdminSurgePack | null
  seed?: PackFormState
  /**
   * Fields a fork inherits that this form has no control for — the parent id, and the artwork,
   * theme, guide and inputs that come with it (issue #295, `lib/derive-pack.ts`).
   *
   * Applied on CREATE only. They are not editable here and not part of `PackFormState`, so
   * threading them through the form's own state would mean inventing controls for them; this
   * carries them past the form instead, which is what "the fork keeps its parent's face" needs
   * and nothing more.
   */
  carry?: Partial<AdminSurgePack>
  tools: AdminTool[]
  onCancel: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<PackFormState>(initial ? toForm(initial) : (seed ?? emptyForm))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const set = <K extends keyof PackFormState>(key: K, value: PackFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const payload: Partial<AdminSurgePack> = {
        name: form.name,
        tools: form.tools,
        displayOrder: form.displayOrder,
        enabled: form.enabled,
        requiresRepos: form.requiresRepos,
        requiresRdp: form.requiresRdp,
        ...(form.desktop ? { desktop: form.desktop } : {}),
        ...(form.webPort ? { webPort: Number(form.webPort) } : {}),
      }
      if (initial) await updateAdminSurgePack(initial.packId, payload)
      else
        await createAdminSurgePack({
          ...payload,
          ...(carry ?? {}),
          ...(form.packId ? { packId: form.packId } : {}),
        })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the Surge Pack')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} data-testid="pack-form">
      <h3>{initial ? `Edit ${initial.packId}` : 'New Surge Pack'}</h3>
      {error && <p role="alert">{error}</p>}

      <label>
        Name
        <input value={form.name} onChange={(e) => set('name', e.target.value)} required />
      </label>

      {!initial && (
        <label>
          Pack ID <small>(derived from the name when blank)</small>
          <input value={form.packId} onChange={(e) => set('packId', e.target.value)} />
        </label>
      )}

      <fieldset>
        <legend>Tools</legend>
        {tools.map((tool) => (
          <label key={tool.toolId}>
            <input
              type="checkbox"
              checked={form.tools.includes(tool.toolId)}
              onChange={(e) =>
                set(
                  'tools',
                  e.target.checked
                    ? [...form.tools, tool.toolId]
                    : form.tools.filter((id) => id !== tool.toolId),
                )
              }
            />
            {tool.name} <small>({tool.toolId})</small>
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend>Behaviour</legend>
        <label>
          <input
            type="checkbox"
            checked={form.requiresRepos}
            onChange={(e) => set('requiresRepos', e.target.checked)}
          />
          Requires repositories <small>— the user must choose at least one, and $REPOS is set for setup scripts</small>
        </label>
        <label>
          <input type="checkbox" checked={form.requiresRdp} onChange={(e) => set('requiresRdp', e.target.checked)} />
          Requires a remote-desktop password <small>— asked for at create time</small>
        </label>
        <label>
          Desktop
          <select value={form.desktop} onChange={(e) => set('desktop', e.target.value as '' | 'xfce')}>
            <option value="">Headless</option>
            <option value="xfce">xfce</option>
          </select>
        </label>
        <label>
          Web UI port
          <input
            type="number"
            min={1}
            max={65535}
            value={form.webPort}
            onChange={(e) => set('webPort', e.target.value)}
          />
          <small>— the loopback port of a web UI the pack serves, so Connect renders the tunnel. Blank for none</small>
        </label>
      </fieldset>

      <label>
        Display order
        <input
          type="number"
          value={form.displayOrder}
          onChange={(e) => set('displayOrder', Number(e.target.value))}
        />
      </label>

      <label>
        <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
        Enabled
      </label>

      <button type="submit" disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  )
}

/* --------------------------------------------------------------------------- registry shelf */

type Shelf = PackRegistry['shelves'][number]

/**
 * One configured registry's NOT-INSTALLED packs (ported from `AdminPackShopPage`,
 * rockysurf-4d8h; narrowed to not-installed by issue #199). The caller filters `shelf.packs` to
 * `!pack.installed` before this ever renders — an installed registry pack is `Installed`'s job,
 * as a normal `PackCard`, not a second card here — so nothing this component renders ever needs
 * to say "already installed" or offer a reinstall; every card here is one thing, an offer to
 * install something not present yet.
 *
 * BADGED COMMUNITY, not the registry's own `community`/`internal` trust label — that label is
 * still on the shelf header above these cards (it names how much the OPERATOR trusts this
 * particular source), but the per-pack card in a Community section reads the same word every
 * other card in it does.
 *
 * NO RAW URL HERE (issue #204). The shelf's own source URL used to sit beside its name; the tab
 * now carries one fixed caption instead — "Community packs from Rocky Surf Shop" — so a second,
 * differently-worded address per shelf would be back to two things saying where this came from.
 */
function ShelfSection({
  shelf,
  busyKey,
  onSelect,
}: {
  shelf: Shelf
  busyKey: string | null
  onSelect: (pack: RegistryPack) => void
}): React.JSX.Element {
  return (
    <div data-testid={`shelf-${shelf.source.name}`}>
      <div className="shop-section-head">
        <h3>
          {shelf.source.name} <TrustBadge label={shelf.source.trust} />
        </h3>
      </div>

      {shelf.failure ? (
        <p className="warning" data-testid={`shelf-failure-${shelf.source.name}`}>
          {shelf.failure.reason}
        </p>
      ) : shelf.packs.length === 0 ? (
        <Shore>Nothing here to install — every pack from this registry is already on this installation.</Shore>
      ) : (
        <ul className="pack-grid">
          {shelf.packs.map((pack) => {
            const key = `${pack.sourceName}/${pack.packId}`
            return (
              <li key={pack.packId} className="pack-card" data-testid={`registry-${pack.packId}`}>
                <div className="pack-card-head">
                  <h3>{pack.name}</h3>
                  <TrustBadge label="registry" text="community" />
                </div>
                <p className="muted">{pack.description}</p>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => onSelect(pack)}
                  disabled={busyKey === key}
                >
                  {busyKey === key ? 'Reading…' : 'Review'}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/* --------------------------------------------------------------------------------- pack card */

/**
 * How long a pointer (or keyboard focus) has to rest on a card before the popup opens. Long
 * enough that crossing the grid on the way somewhere else never opens one, short enough that
 * stopping on a card is unmistakably a question about it.
 */
const POPUP_DELAY_MS = 1000

/**
 * One card in the grid (issue #192; issue #199 drops the official-only gate).
 *
 * WHAT THE CARD SAYS IS NOW THE MARK, THE NAME AND THE BADGE, and nothing else. The tool count
 * and the admin-only origin sentence both left: neither answers a question anybody has while
 * looking at a wall of packs, and the origin sentence is still on the detail page, where an
 * admin asking "where did this come from" actually is.
 *
 * THE POPUP IS A SIBLING OF THE LINK, NOT A CHILD. The card is one link — that is what makes a
 * click, a middle-click and a touch all open the detail page — and a link may not contain a
 * button or another link. So the `<li>` is the positioned box, the `<a>` fills it, and the
 * popup is absolutely positioned against the `<li>` beneath it. Because the popup is a DOM
 * descendant of the `<li>` that carries the handlers, moving the pointer from the card into
 * the popup is not a mouse-out and the popup does not flicker.
 *
 * EVERY PACK GETS ONE. Issue #192 gated this on `provenance === 'official'`; the owner ruling
 * that followed it (`docs/memories/2026-08-27-everyone-who-runs-an-installation-is-its-admin.md`)
 * is the reason issue #199 removes the gate rather than widening it to a role check — a Rocky
 * Surf installation has no population the popup needed protecting from, official or otherwise,
 * and Export already worked for a registry or local pack, so a card two sections down withholding
 * the same information was a seam with nothing behind it.
 */
function PackCard({
  view,
  derivativeMark,
  copiesMark,
  onExport,
}: {
  view: PackView
  /** "This pack is a copy of another" - the delta's sentence (issue #295). */
  derivativeMark?: string
  /** "A personal version of this exists" - the other mark's sentence. */
  copiesMark?: string
  onExport: (view: PackView) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const link = useRef<HTMLAnchorElement>(null)

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }, [])

  const arm = useCallback(() => {
    if (open || timer.current !== null) return
    timer.current = setTimeout(() => {
      timer.current = null
      setOpen(true)
    }, POPUP_DELAY_MS)
  }, [open])

  const close = useCallback(() => {
    cancel()
    setOpen(false)
  }, [cancel])

  // A card can be unmounted mid-delay — the grid reloads after an install — and a timer that
  // fires into a gone component is a React warning and a leak.
  useEffect(() => cancel, [cancel])

  return (
    <li
      className="pack-card-slot"
      data-testid={`pack-card-slot-${view.packId}`}
      onMouseEnter={arm}
      onMouseLeave={close}
      /* Focus and blur BUBBLE in React, so these cover the link and everything in the popup:
         tabbing onto the card arms the same delay, and focus leaving the whole card — to the
         next card, or out of the grid — closes it. No focus trap: the popup's controls sit
         after the link in the DOM, so Tab walks into them and then out the other side. */
      onFocus={arm}
      onBlur={(event: React.FocusEvent<HTMLLIElement>) => {
        if (event.currentTarget.contains(event.relatedTarget)) return
        close()
      }}
      onKeyDown={(event: React.KeyboardEvent<HTMLLIElement>) => {
        if (event.key !== 'Escape' || !open) return
        // Focus goes back to the card rather than to the document, so Escape does not cost a
        // keyboard user their place in the grid. Nothing re-arms until they leave and come
        // back, which is what dismissing should mean.
        link.current?.focus()
        close()
      }}
    >
      <Link ref={link} to={`/packs/${view.packId}`} className="pack-card" data-testid={`pack-card-${view.packId}`}>
        <div className="pack-card-head">
          <PackIcon
            pack={view}
            {...(derivativeMark ? { derivativeMark } : {})}
            {...(copiesMark ? { copiesMark } : {})}
          />
          <h3>{view.name}</h3>
          {/* Core's own three words key the styling and the testid, unchanged — see the file
              docblock. `badgeText` is only ever the word a person reads. */}
          <TrustBadge label={view.provenance} text={badgeText(view.provenance)} />
        </div>
        {!view.enabled && <p className="hint">— disabled</p>}
      </Link>

      {open && (
        <div className="pack-popup" data-testid={`pack-popup-${view.packId}`} role="group" aria-label={view.name}>
          <h4>Installs</h4>
          {view.tools.length === 0 ? (
            <p className="hint">Nothing — this pack installs no tools.</p>
          ) : (
            <ToolList tools={view.tools} testId={`pack-popup-tools-${view.packId}`} />
          )}
          <div className="pack-popup-actions">
            {view.enabled && (
              <Link className="button primary new-action" to={`/servers/new?pack=${view.packId}`}>
                New server
              </Link>
            )}
            <button type="button" className="button secondary" onClick={() => onExport(view)}>
              Export
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

/* ---------------------------------------------------------------- start from an existing pack */

/**
 * "Start from an existing pack" (issue #204) — one of `New Surge Pack`'s three ways to begin.
 * Picks any installed pack and opens the same structured create form `Start from scratch` does,
 * seeded from the source's own tools and behaviour fields.
 *
 * SEEDED FROM `AdminSurgePack.tools`, THE ID LIST — NOT FROM EXPORT. `docs/writing-a-pack.md` §
 * "Building on an existing pack" builds on a pack by copying its `pack.tools` id LIST and
 * referencing those ids, never redefining them. Export is the wrong source for that: it inlines
 * a FULL definition for every tool the pack references (so the exported file is self-contained),
 * and the `create-surge-pack` skill warns explicitly against reusing that output to fork a
 * pack — importing it back would upsert every inlined tool by id, silently overwriting the
 * shared base definitions instance-wide. The structured form's `tools` field is always ids
 * checked against the existing catalogue, so seeding it this way references the source's tools
 * exactly the way the docs recommend, with no such risk — nothing here calls Export or import.
 */
function StartFromExistingPanel({
  packs,
  adminPacksById,
  tools,
  onCancel,
  onSaved,
}: {
  /** Every installed pack, any provenance — "pick any installed pack" is the issue's own words. */
  packs: PackView[]
  adminPacksById: Map<string, AdminSurgePack>
  tools: AdminTool[]
  onCancel: () => void
  onSaved: () => void
}): React.JSX.Element {
  const sorted = useMemo(() => [...packs].sort(byOrder), [packs])
  const [sourceId, setSourceId] = useState(sorted[0]?.packId ?? '')
  const source = adminPacksById.get(sourceId)

  const seed = useMemo(() => {
    if (!source) return null
    const taken = new Set(packs.map((p) => p.packId))
    return { ...toForm(source), packId: suggestNewPackId(sourceId, taken), name: forkNameFor(source) }
  }, [source, sourceId, packs])

  /** The parent id and the face that goes with it — see `lib/derive-pack.ts`. */
  const carry = useMemo(() => (source ? carryFromSource(source) : undefined), [source])

  return (
    <div className="pack-from-existing" data-testid="pack-from-existing-panel">
      <label>
        Copy from
        <select data-testid="from-existing-source" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
          {sorted.map((p) => (
            <option key={p.packId} value={p.packId}>
              {p.name} ({p.packId})
            </option>
          ))}
        </select>
      </label>

      {seed ? (
        // `key`, so choosing a different source remounts the form onto the new seed rather than
        // keeping whatever the previous source's edits left in state.
        <SurgePackFormModal
          key={sourceId}
          initial={null}
          seed={seed}
          {...(carry ? { carry } : {})}
          tools={tools}
          onCancel={onCancel}
          onSaved={onSaved}
        />
      ) : (
        <p role="alert">That pack could not be read.</p>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------------- the page */

export function PacksPage(): React.JSX.Element {
  const { packId } = useParams()
  const { user } = useAuth()
  const navigate = useNavigate()
  const isAdmin = Boolean(user?.isAdmin)

  const [publicPacks, setPublicPacks] = useState<SurgePack[]>([])
  const [adminPacks, setAdminPacks] = useState<AdminSurgePack[]>([])
  const [tools, setTools] = useState<AdminTool[]>([])
  const [registry, setRegistry] = useState<PackRegistry | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** Editing an existing pack from its own detail page — `formTarget === view.packId`. Creating
   *  a new one is `createFlow` below, not this: the two are different enough flows (this one
   *  always has a real `AdminSurgePack` to seed from, the create flow does not) that sharing one
   *  piece of state meant a `'new'` sentinel standing in for "nothing yet", which is what
   *  `createFlow === 'closed'` says directly. */
  const [formTarget, setFormTarget] = useState<string | null>(null)
  const [selectedRegistryPack, setSelectedRegistryPack] = useState<RegistryPackDetail | null>(null)
  const [selectingKey, setSelectingKey] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [communityFilter, setCommunityFilter] = useState<CommunityFilter>(readStoredCommunityFilter)
  /** Personal's `New Surge Pack` chooser (issue #204) — closed, choosing how to start, or one
   *  of the three ways in. `Cancel` from any of the three returns straight to `closed`, matching
   *  the issue's own words: "Cancel returns to the tab unchanged". */
  const [createFlow, setCreateFlow] = useState<'closed' | 'choose' | 'upload' | 'from-existing' | 'scratch'>('closed')
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    try {
      localStorage.setItem(COMMUNITY_FILTER_KEY, communityFilter)
    } catch {
      // Same fallback as the read: nothing this page does depends on the write succeeding.
    }
  }, [communityFilter])

  /**
   * WHICH TAB IS OPEN lives in the URL (issue #204), same reasoning as Settings' own `?section=`
   * (issue #122): one place to keep in step, a pasted `?tab=community` opens Community, and a
   * value naming nothing falls back to Official rather than to a blank page. `replace` on
   * selection, so switching tabs does not pile up in history.
   */
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedTab = searchParams.get(PACKS_TAB_PARAM)
  const activeTab: PacksTab = (PACKS_TAB_KEYS as readonly string[]).includes(requestedTab ?? '')
    ? (requestedTab as PacksTab)
    : 'official'
  const openTab = useCallback(
    (tab: PacksTab) => {
      const next = new URLSearchParams(searchParams)
      next.set(PACKS_TAB_PARAM, tab)
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  const load = useCallback(
    async (opts: { refreshRegistry?: boolean } = {}) => {
      if (opts.refreshRegistry) setRefreshing(true)
      try {
        const packs = await listSurgePacks()
        setPublicPacks(packs)
        setError(null)

        if (isAdmin) {
          // Admin-only extras, all tolerant of failure — a registry being unreachable or the
          // tool catalogue read failing must not take the member-facing grid above down with it.
          const [adminResult, toolsResult, registryResult] = await Promise.allSettled([
            listAdminSurgePacks(),
            listAdminTools(),
            getPackRegistry({ refresh: opts.refreshRegistry }),
          ])
          setAdminPacks(adminResult.status === 'fulfilled' ? adminResult.value : [])
          setTools(toolsResult.status === 'fulfilled' ? toolsResult.value : [])
          setRegistry(registryResult.status === 'fulfilled' ? registryResult.value : null)
        } else {
          setAdminPacks([])
          setTools([])
          setRegistry(null)
        }
      } catch (err) {
        // A whole-page error is for "the control plane would not answer" — the public read.
        setError(err instanceof Error ? err.message : 'Could not load Surge Packs')
      } finally {
        setLoading(false)
        if (opts.refreshRegistry) setRefreshing(false)
      }
    },
    [isAdmin],
  )

  useEffect(() => {
    void load()
  }, [load])

  const adminPacksById = useMemo(() => new Map(adminPacks.map((p) => [p.packId, p])), [adminPacks])
  const toolsById = useMemo(() => new Map(tools.map((t) => [t.toolId, t])), [tools])
  const views = useMemo(
    () => buildViews(publicPacks, adminPacksById, toolsById, isAdmin),
    [publicPacks, adminPacksById, toolsById, isAdmin],
  )
  /**
   * THE TWO MARKS, derived here from the list the page already has (issue #295).
   *
   * They are two facts, not one fact twice, and one card can carry both — a pack forked from
   * another that somebody has since forked again is a derivative AND has a personal version.
   * `PackIcon` puts them in opposite corners for exactly that reason.
   *
   * `copiesMarkFor` NAMES the fork rather than asserting a bare relationship. Naming it is what
   * makes the claim checkable by whoever reads it, and it is also the honest answer when a pack
   * id has been reused by something unrelated since the fork was made.
   *
   * ONE HOP. A fork of a fork points at its own parent and no further; nothing walks a chain.
   *
   * Deriving both in the browser is what makes them self-healing: delete a fork and its
   * parent's mark goes with it on the next load, with no count to invalidate and no column to
   * keep in step. A fork whose parent is no longer installed marks nothing — there is no card
   * to mark — and keeps its own mark, which still names where it came from.
   */
  const forks = useMemo(() => forksByParent(views), [views])
  const copiesMarkFor = useCallback(
    (view: PackView): string | undefined => {
      const children = forks.get(view.packId)
      if (!children?.length) return undefined
      return children.length === 1
        ? `Personal version: ${children[0]!.name}`
        : `Personal versions: ${children.map((c) => c.name).join(', ')}`
    },
    [forks],
  )
  const derivativeMarkFor = useCallback(
    (view: PackView): string | undefined => {
      if (!view.derivedFromPackId) return undefined
      const parent = views.find((v) => v.packId === view.derivedFromPackId)
      return `Your personal version of ${parent?.name ?? view.derivedFromPackId}`
    },
    [views],
  )

  const official = useMemo(() => views.filter((v) => v.provenance === 'official').sort(byOrder), [views])
  const communityInstalled = useMemo(() => views.filter((v) => v.provenance === 'registry').sort(byOrder), [views])
  const personal = useMemo(() => views.filter((v) => v.provenance === 'local').sort(byOrder), [views])

  /**
   * The catalogue side of Community's filter, one shelf at a time, narrowed to what is not on
   * this installation yet. `RegistryPack.installed` is core's own answer to "is this here
   * already" — the same flag `communityInstalled` above is the other side of — so filtering on
   * it is what keeps a pack from ever appearing under both Installed and Not installed at once.
   * `null` (no registry read — a member, or the fetch failed) renders as no shelves rather than
   * as a hint about who is signed in; see the file docblock.
   */
  const notInstalledShelves = useMemo(
    () => (registry?.shelves ?? []).map((shelf) => ({ ...shelf, packs: shelf.packs.filter((p) => !p.installed) })),
    [registry],
  )

  /**
   * THE PACK FILE ITSELF, on the detail page of every pack (issue #192; issue #199 drops the
   * official-only gate).
   *
   * `download()` used to record the opposite decision — export the file rather than show its
   * text — and for a pack somebody made here that still holds AS A DEFAULT: that text is only
   * useful as a file you can commit. What issue #192 got backwards was treating that as true only
   * of an official pack. It is not: a registry pack's file is exactly as readable, exported
   * through the exact same route, and the operator asking "what will this run on my box as root"
   * does not stop being a real question the moment the pack came from a shop instead of the
   * tarball. Both now, for every pack: the text here, Export beside it.
   *
   * READ OVER THE EXISTING ADMIN EXPORT ROUTE, and no new one. Rocky Surf is self-hosted
   * personal tooling — whoever runs it is its admin — so a second, non-admin read route for a
   * pack's file would be a public surface with no public to serve (owner ruling, #192; restated
   * for the general case at `docs/memories/2026-08-27-everyone-who-runs-an-installation-is-its-
   * admin.md`).
   *
   * Only fetched in detail mode, and only once a pack is found — `detailView` is `undefined` for
   * an unknown `:packId`, and this must not fetch for that.
   */
  const detailView = packId ? views.find((v) => v.packId === packId) : undefined
  const showsPackFile = detailView !== undefined
  const [packFile, setPackFile] = useState<string | null>(null)
  const [packFileProblem, setPackFileProblem] = useState<string | null>(null)

  useEffect(() => {
    if (!packId || !showsPackFile) {
      setPackFile(null)
      setPackFileProblem(null)
      return
    }
    let cancelled = false
    setPackFile(null)
    setPackFileProblem(null)
    exportSurgePackYaml(packId).then(
      (text) => {
        if (!cancelled) setPackFile(text)
      },
      (err: unknown) => {
        // Never the whole page: the rest of this pack's detail is worth reading either way.
        if (!cancelled) setPackFileProblem(err instanceof ApiError ? err.detail : 'Could not read the pack file.')
      },
    )
    return () => {
      cancelled = true
    }
  }, [packId, showsPackFile])

  /**
   * File upload, one of `New Surge Pack`'s three ways in (issue #204 drops the second one, URL
   * import — "nobody installs from a URL" — leaving this and the two flows below it).
   */
  async function importFromFile(file: File) {
    try {
      const imported = await importSurgePack({ yaml: await file.text() })
      setNotice(`Imported ${imported.packId}. It is a database row — put the file in packs/ to make it source-controlled.`)
      setCreateFlow('closed')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    }
  }

  /**
   * Export, from the detail page and from a card's popup — every pack, the same existing admin
   * route in both places (issue #192; issue #199 drops the official-only gate from both).
   *
   * NO SECOND ROUTE AND NO ROLE BRANCH. The obvious alternative was a non-admin read route for a
   * pack's file, so that Export and the file could be shown to a member; the owner's ruling is
   * that there is no such member — a Rocky Surf installation is one engineer's own tooling and
   * whoever runs it is its admin — so the popup's Export is the export that was always there.
   *
   * Still a downloaded FILE here, because the point of exporting is that the operator can drop
   * it into `packs/` and have it become the source of truth. The pack file section on a pack's
   * own page adds the TEXT as well, for every pack now — it does not replace this.
   */
  async function downloadYaml(view: PackView) {
    try {
      const yaml = await exportSurgePackYaml(view.packId)
      const url = URL.createObjectURL(new Blob([yaml], { type: 'application/yaml' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `${view.packId}.yaml`
      link.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      // A toast, not `setError`: a failed download is no reason to replace the grid — or the
      // pack the user was reading — with an error page.
      toast.error(err instanceof ApiError ? err.detail : 'Export failed')
    }
  }

  async function remove(id: string) {
    if (!confirm(`Delete the Surge Pack ${id}? This removes the database row, not the YAML file.`)) return
    try {
      await deleteAdminSurgePack(id)
      await load()
      navigate('/packs')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  async function openDisclosure(pack: RegistryPack) {
    setSelectingKey(`${pack.sourceName}/${pack.packId}`)
    setSelectedRegistryPack(null)
    try {
      setSelectedRegistryPack(await getRegistryPack(pack.sourceName, pack.packId))
    } catch (err) {
      toast.error(err instanceof ApiError ? err.detail : 'Could not read that pack')
    } finally {
      setSelectingKey(null)
    }
  }

  async function install(detail: RegistryPackDetail) {
    setInstalling(true)
    try {
      // Only the address goes over the wire. Core refetches and re-verifies, so nothing the
      // browser holds can decide what actually runs as root.
      const installed = await installRegistryPack(detail.entry.sourceName, detail.entry.packId)
      toast.success(`Installed ${installed.name}. It is available when creating a server now.`)
      setSelectedRegistryPack(null)
      await load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.detail : 'Install failed')
    } finally {
      setInstalling(false)
    }
  }

  if (loading) {
    return (
      <AppShell title="Surge Packs">
        <p>Loading…</p>
      </AppShell>
    )
  }

  if (error) {
    return (
      <AppShell title="Surge Packs">
        <p role="alert">{error}</p>
      </AppShell>
    )
  }

  /* ------------------------------------------------------------------------- detail mode */
  if (packId) {
    const view = views.find((v) => v.packId === packId)
    if (!view) {
      return (
        <AppShell title="Surge Packs">
          <p>No such pack.</p>
          <p>
            <Link to="/packs">← All Surge Packs</Link>
          </p>
        </AppShell>
      )
    }

    const chips = behaviourChips(view)

    return (
      <AppShell title={view.name}>
        <p>
          <Link to="/packs">← All Surge Packs</Link>
        </p>
        <div className="pack-detail-header">
          <PackIcon
            pack={view}
            size="large"
            {...(derivativeMarkFor(view) ? { derivativeMark: derivativeMarkFor(view)! } : {})}
            {...(copiesMarkFor(view) ? { copiesMark: copiesMarkFor(view)! } : {})}
          />
          <div>
            <TrustBadge label={view.provenance} text={badgeText(view.provenance)} />
            {/* The origin sentence, which used to be on the card too (issue #192). One pack's
                page is where "where did this come from, exactly" gets asked; a grid is not.
                `origin` is only ever built from the admin read, so no role check here. */}
            {view.origin && <p className="muted">{view.origin}</p>}
            {/* Where a fork began (issue #295), spelled out here rather than left to the delta's
                tooltip — this IS the page for "where did this come from". The parent is named
                even when it is no longer installed: the id is still the truth, and a pack that
                has left the release is exactly when someone needs to be told what happened. */}
            {view.derivedFromPackId && (
              <p className="muted" data-testid="pack-derived-from">
                Started from{' '}
                {views.find((v) => v.packId === view.derivedFromPackId) ? (
                  <Link to={`/packs/${view.derivedFromPackId}`}>{view.derivedFromPackId}</Link>
                ) : (
                  <>
                    <code>{view.derivedFromPackId}</code>, which is no longer installed
                  </>
                )}
                . It is a copy: nothing here changes when that pack does, except the tools&apos; own
                scripts, which it references rather than copies.
              </p>
            )}
            {!view.enabled && <p className="hint">Disabled — hidden from the New Server form.</p>}
          </div>
        </div>

        {chips.length > 0 && (
          <ul className="behaviour-chips">
            {chips.map((chip) => (
              <li key={chip}>{chip}</li>
            ))}
          </ul>
        )}

        {view.enabled ? (
          <p>
            <Link className="button primary new-action" to={`/servers/new?pack=${view.packId}`}>
              Launch a server with this pack
            </Link>
          </p>
        ) : (
          <p className="hint" data-testid="launch-unavailable">
            This pack is disabled, so it cannot be used to create a server.
          </p>
        )}

        <h2>What&apos;s in it</h2>
        {view.tools.length === 0 ? (
          <p className="hint">This pack installs no tools.</p>
        ) : (
          <ToolList tools={view.tools} testId="pack-tools" />
        )}

        {view.guide && (
          <details>
            <summary>Getting started</summary>
            <pre className="pack-guide-text">{view.guide}</pre>
          </details>
        )}

        {showsPackFile && (
          <section className="pack-file">
            <h2>The pack file</h2>
            <p className="hint">
              {view.provenance === 'official'
                ? 'This file shipped with this Rocky Surf release. It is the whole of what a new box runs for this pack — every install script, in the order they run.'
                : 'This is the whole of what a new box runs for this pack — every install script, in the order they run.'}
            </p>
            {packFileProblem ? (
              <p className="hint" data-testid="pack-file-unavailable">
                {packFileProblem}
              </p>
            ) : packFile === null ? (
              <p className="hint">Reading…</p>
            ) : (
              <pre className="pack-guide-text pack-file-text" data-testid="pack-file-text">
                {packFile}
              </pre>
            )}
            {/* The same file as a download, for the operator who wants it in `packs/` — and the
                reason Export is not in the admin row below: one button per page, in the place
                the file is. */}
            <p>
              <button type="button" className="button secondary" onClick={() => void downloadYaml(view)}>
                Export
              </button>
            </p>
            {/* Said BEFORE the download rather than discovered afterwards (issue #295). A fork
                wears its parent's artwork here, under a delta that says whose it is; neither
                travels, because on somebody else's installation there would be no delta to
                explain the artwork. */}
            {view.derivedFromPackId && view.imageUrl?.startsWith('/') && (
              <p className="hint" data-testid="export-artwork-note">
                The parent&apos;s artwork stays on this installation; a shared copy gets its own mark.
              </p>
            )}
          </section>
        )}

        {isAdmin && (
          <section className="pack-admin-actions">
            {view.editable ? (
              <>
                <button type="button" onClick={() => setFormTarget(view.packId)}>
                  Edit
                </button>
                <button type="button" onClick={() => void remove(view.packId)}>
                  Delete
                </button>
              </>
            ) : (
              <>
                <span data-testid={`file-backed-${view.packId}`}>file: {view.sourceFile}</span>
                <small data-testid={`readonly-hint-${view.packId}`}>
                  Read-only — edit {view.sourceFile} and restart
                </small>
              </>
            )}
          </section>
        )}

        {formTarget === view.packId && (
          <SurgePackFormModal
            initial={adminPacksById.get(view.packId) ?? null}
            tools={tools}
            onCancel={() => setFormTarget(null)}
            onSaved={() => {
              setFormTarget(null)
              void load()
            }}
          />
        )}
      </AppShell>
    )
  }

  /* --------------------------------------------------------------------------- list mode */

  // Which halves of Community the filter shows. "All" is both; the other two are one each — the
  // installed half and the catalogue half never both name the same pack, so there is nothing to
  // dedupe here beyond picking which side(s) to render.
  const showCommunityInstalled = communityFilter !== 'not-installed'
  const showCommunityCatalog = communityFilter !== 'installed'

  return (
    <AppShell title="Surge Packs">
      <p className="hint">
        A Surge Pack decides which tools a new box is set up with. Official packs shipped with
        this Rocky Surf release; Community packs come from a Pack Shop registry, installed here
        or not yet; Personal packs were created or imported on this installation.
      </p>

      <Tabs
        label="Surge Pack sections"
        panelId="packs"
        className="packs-tabs"
        tabs={PACKS_TABS}
        active={activeTab}
        onSelect={openTab}
      />

      <section
        className="shop-section"
        role="tabpanel"
        id="packs-panel-official"
        aria-labelledby="packs-tab-official"
        hidden={activeTab !== 'official'}
      >
        {official.length === 0 ? (
          <Shore>No packs from this Rocky Surf release are enabled.</Shore>
        ) : (
          <ul className="pack-grid">
            {official.map((view) => (
              <PackCard
                key={view.packId}
                view={view}
                {...(derivativeMarkFor(view) ? { derivativeMark: derivativeMarkFor(view)! } : {})}
                {...(copiesMarkFor(view) ? { copiesMark: copiesMarkFor(view)! } : {})}
                onExport={(v) => void downloadYaml(v)}
              />
            ))}
          </ul>
        )}
      </section>

      <section
        className="shop-section"
        role="tabpanel"
        id="packs-panel-community"
        aria-labelledby="packs-tab-community"
        hidden={activeTab !== 'community'}
      >
        {/* No heading here (issue #233): the tab already says "Community". */}
        {isAdmin && (
          <div className="shop-section-head">
            <button
              type="button"
              className="button secondary"
              onClick={() => void load({ refreshRegistry: true })}
              disabled={refreshing}
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        )}

        {/* Verbatim, issue #204 — replaces the raw registry URL that used to sit on each
            shelf below. One fixed sentence naming where the catalogue comes from, rather than
            a URL that reads the same to everyone regardless of what it says. */}
        <p className="hint" data-testid="community-caption">
          Community packs from{' '}
          <a href={SHOP_URL} target="_blank" rel="noreferrer">
            Rocky Surf Shop
          </a>
          .
        </p>

        {/* All / Installed / Not installed (issue #199), modelled on Claude's Connectors page.
            `aria-pressed`, not `role="tab"`: there is one section here, filtered, not several
            panels swapped for one another. */}
        <div className="pack-filter-row" role="group" aria-label="Filter Community packs">
          {COMMUNITY_FILTERS.map((filter) => (
            <button
              key={filter.key}
              type="button"
              className="button secondary"
              aria-pressed={communityFilter === filter.key}
              data-testid={`community-filter-${filter.key}`}
              onClick={() => setCommunityFilter(filter.key)}
            >
              {filter.label}
            </button>
          ))}
        </div>

        {showCommunityInstalled &&
          (communityInstalled.length === 0 ? (
            <Shore>No community packs are installed.</Shore>
          ) : (
            <ul className="pack-grid">
              {communityInstalled.map((view) => (
                <PackCard
                key={view.packId}
                view={view}
                {...(derivativeMarkFor(view) ? { derivativeMark: derivativeMarkFor(view)! } : {})}
                {...(copiesMarkFor(view) ? { copiesMark: copiesMarkFor(view)! } : {})}
                onExport={(v) => void downloadYaml(v)}
              />
              ))}
            </ul>
          ))}

        {showCommunityCatalog && (
          <>
            {registry && !registry.enabled && (
              <p className="hint" data-testid="registry-disabled">
                The pack registry is switched off (<code>registry.enabled: false</code>). Packs
                already installed are unaffected.
              </p>
            )}
            {notInstalledShelves.map((shelf) => (
              <ShelfSection
                key={shelf.source.name}
                shelf={shelf}
                busyKey={selectingKey}
                onSelect={(pack) => void openDisclosure(pack)}
              />
            ))}
          </>
        )}
      </section>

      <section
        className="shop-section"
        role="tabpanel"
        id="packs-panel-personal"
        aria-labelledby="packs-tab-personal"
        hidden={activeTab !== 'personal'}
      >
        {isAdmin && (
          <>
            {notice && <p data-testid="notice">{notice}</p>}

            {createFlow === 'closed' && (
              <button type="button" className="button primary new-action" onClick={() => setCreateFlow('choose')}>
                New Surge Pack
              </button>
            )}

            {/* The chooser (issue #204): upload, start from an existing pack, or start from
                scratch. An inline panel, not a modal-overlay — the structured form it can open
                (`scratch`, below) was already inline before this issue, and a chooser that is
                sometimes a modal and sometimes not would be two behaviours for one button. */}
            {createFlow === 'choose' && (
              <>
                <div className="pack-create-chooser" data-testid="pack-create-chooser">
                  <button
                    type="button"
                    className="pack-create-option"
                    data-testid="create-option-upload"
                    onClick={() => setCreateFlow('upload')}
                  >
                    <strong>Upload a pack file</strong>
                    <span className="hint">Bring a .yaml file from somewhere else.</span>
                  </button>
                  <button
                    type="button"
                    className="pack-create-option"
                    data-testid="create-option-existing"
                    onClick={() => setCreateFlow('from-existing')}
                  >
                    <strong>Start from an existing pack</strong>
                    <span className="hint">Copy an installed pack's file under a new id, and edit it.</span>
                  </button>
                  <button
                    type="button"
                    className="pack-create-option"
                    data-testid="create-option-scratch"
                    onClick={() => setCreateFlow('scratch')}
                  >
                    <strong>Start from scratch</strong>
                    <span className="hint">A blank pack, built from the tools already on this installation.</span>
                  </button>
                </div>
                {/* Out of the grid (issue #224): Cancel is a dismissal, not a fourth way to
                    create a pack, so it does not share the option cards' weight or width. */}
                <button
                  type="button"
                  className="button secondary pack-create-cancel"
                  onClick={() => setCreateFlow('closed')}
                >
                  Cancel
                </button>
              </>
            )}

            {createFlow === 'upload' && (
              <div className="pack-import" data-testid="pack-upload-panel">
                <label
                  className="pack-dropzone"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    const file = e.dataTransfer.files?.[0]
                    if (file) void importFromFile(file)
                  }}
                >
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".yaml,.yml,application/yaml,text/yaml"
                    data-testid="import-file"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) void importFromFile(file)
                    }}
                  />
                  <span>Drop a .yaml file here, or click to choose one</span>
                </label>
                <button type="button" className="button secondary" onClick={() => setCreateFlow('closed')}>
                  Cancel
                </button>
              </div>
            )}

            {createFlow === 'from-existing' && (
              <StartFromExistingPanel
                packs={views}
                adminPacksById={adminPacksById}
                tools={tools}
                onCancel={() => setCreateFlow('closed')}
                onSaved={() => {
                  setCreateFlow('closed')
                  void load()
                }}
              />
            )}

            {createFlow === 'scratch' && (
              <SurgePackFormModal
                initial={null}
                tools={tools}
                onCancel={() => setCreateFlow('closed')}
                onSaved={() => {
                  setCreateFlow('closed')
                  void load()
                }}
              />
            )}
          </>
        )}

        {personal.length === 0 ? (
          <Shore>No personal packs yet.</Shore>
        ) : (
          <ul className="pack-grid">
            {personal.map((view) => (
              <PackCard
                key={view.packId}
                view={view}
                {...(derivativeMarkFor(view) ? { derivativeMark: derivativeMarkFor(view)! } : {})}
                {...(copiesMarkFor(view) ? { copiesMark: copiesMarkFor(view)! } : {})}
                onExport={(v) => void downloadYaml(v)}
              />
            ))}
          </ul>
        )}
      </section>

      {selectedRegistryPack && (
        <PackDisclosurePanel
          detail={selectedRegistryPack}
          installing={installing}
          onCancel={() => setSelectedRegistryPack(null)}
          onInstall={() => void install(selectedRegistryPack)}
        />
      )}
    </AppShell>
  )
}
