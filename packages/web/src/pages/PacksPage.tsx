import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import toast from 'react-hot-toast'
import { AppShell } from '../components/AppShell'
import { PackDisclosurePanel } from '../components/PackDisclosure'
import { PackIcon } from '../components/PackIcon'
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
  type SurgePackTool,
} from '../lib/api'

/**
 * Surge Packs (rockysurf-4d8h, issue #51).
 *
 * ONE PAGE where there used to be two — `/admin/surge-packs` and `/admin/pack-shop` — both
 * admin-only, both reading `listAdminSurgePacks()`, and neither reachable by a member or
 * showing what a pack actually installs. This page is member-reachable at `/packs` (list) and
 * `/packs/:packId` (detail, same component, branching on `useParams()`), with every admin
 * capability of both old pages surviving in a "Manage packs" region gated on `user.isAdmin`
 * rather than on the route.
 *
 * PROVENANCE COMES FROM CORE, NEVER RECOMPUTED HERE. `SurgePack.provenance` is derived
 * server-side from `sourceFile` and a registry install can never claim `official` (ADR-0006).
 * The admin-only `origin` sentence adds detail (which file, which registry) but never
 * overrides the badge, which reads the same three words core sends everywhere else.
 *
 * THE PUBLIC LIST IS ENABLED-ONLY. A disabled pack reaches this page only through the admin
 * list, which is why an admin's view is a MERGE of the public rows (the base) and any admin
 * row the public list withheld — never a second, wider public read.
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

function behaviourChips(view: Pick<PackView, 'requiresRepos' | 'requiresRdp' | 'desktop' | 'webPort'>): string[] {
  return [
    view.requiresRepos ? 'needs a repository' : null,
    view.requiresRdp ? 'remote desktop' : null,
    view.desktop ? `${view.desktop} desktop` : null,
    view.webPort ? `web UI on :${view.webPort}` : null,
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
 */
function SurgePackFormModal({
  initial,
  tools,
  onCancel,
  onSaved,
}: {
  initial: AdminSurgePack | null
  tools: AdminTool[]
  onCancel: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<PackFormState>(initial ? toForm(initial) : emptyForm)
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
      else await createAdminSurgePack({ ...payload, ...(form.packId ? { packId: form.packId } : {}) })
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

/** One configured registry and its packs (ported from `AdminPackShopPage`, rockysurf-4d8h). */
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
    <section className="shop-section" data-testid={`shelf-${shelf.source.name}`}>
      <div className="shop-section-head">
        <h2>
          {shelf.source.name} <TrustBadge label={shelf.source.trust} />
        </h2>
        <span className="muted">{shelf.source.url}</span>
      </div>

      {shelf.failure ? (
        <p className="warning" data-testid={`shelf-failure-${shelf.source.name}`}>
          {shelf.failure.reason}
        </p>
      ) : shelf.packs.length === 0 ? (
        <p className="empty">This registry has no packs yet.</p>
      ) : (
        <ul className="pack-grid">
          {shelf.packs.map((pack) => {
            const key = `${pack.sourceName}/${pack.packId}`
            return (
              <li key={pack.packId} className="pack-card" data-testid={`registry-${pack.packId}`}>
                <div className="pack-card-head">
                  <h3>{pack.name}</h3>
                  <TrustBadge label={pack.trust} />
                </div>
                <p className="muted">{pack.description}</p>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => onSelect(pack)}
                  disabled={busyKey === key}
                >
                  {busyKey === key ? 'Reading…' : pack.installed ? 'Review and reinstall' : 'Review'}
                </button>
                {pack.installed && <span className="size-detail">already installed</span>}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/* --------------------------------------------------------------------------------- pack card */

function PackCard({ view, isAdmin }: { view: PackView; isAdmin: boolean }): React.JSX.Element {
  return (
    <li key={view.packId}>
      <Link to={`/packs/${view.packId}`} className="pack-card" data-testid={`pack-card-${view.packId}`}>
        <div className="pack-card-head">
          <PackIcon pack={view} />
          <h3>{view.name}</h3>
          {/* Core's own three words, unchanged — see the file docblock on why this never
              recomputes provenance. */}
          <TrustBadge label={view.provenance === 'official' ? 'official' : view.provenance} />
        </div>
        <p className="size-detail">{view.tools.length} tool(s)</p>
        {isAdmin && view.origin && <p className="muted">{view.origin}</p>}
        {!view.enabled && <p className="hint">— disabled</p>}
      </Link>
    </li>
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
  const [importUrl, setImportUrl] = useState('')
  const [formTarget, setFormTarget] = useState<'new' | string | null>(null)
  const [selectedRegistryPack, setSelectedRegistryPack] = useState<RegistryPackDetail | null>(null)
  const [selectingKey, setSelectingKey] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

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
  const official = useMemo(() => views.filter((v) => v.provenance === 'official').sort(byOrder), [views])
  const community = useMemo(() => views.filter((v) => v.provenance !== 'official').sort(byOrder), [views])

  async function importFromFile(file: File) {
    try {
      const imported = await importSurgePack({ yaml: await file.text() })
      setNotice(`Imported ${imported.packId}. It is a database row — put the file in packs/ to make it source-controlled.`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    }
  }

  async function importFromUrl() {
    try {
      const imported = await importSurgePack({ url: importUrl })
      setNotice(`Imported ${imported.packId} from URL.`)
      setImportUrl('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    }
  }

  async function download(id: string) {
    try {
      const yaml = await exportSurgePackYaml(id)
      // A real file, so the operator can drop it into `packs/` and have it become the source
      // of truth — which is the whole point of exporting rather than showing the text.
      const url = URL.createObjectURL(new Blob([yaml], { type: 'application/yaml' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `${id}.yaml`
      link.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed')
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
          <PackIcon pack={view} size="large" />
          <div>
            <TrustBadge label={view.provenance === 'official' ? 'official' : view.provenance} />
            {isAdmin && view.origin && <p className="muted">{view.origin}</p>}
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
            <Link className="btn-primary" to={`/servers/new?pack=${view.packId}`}>
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

        {isAdmin && (
          <section className="pack-admin-actions">
            <button type="button" onClick={() => void download(view.packId)}>
              Export
            </button>
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
  return (
    <AppShell title="Surge Packs">
      <p className="hint">
        A Surge Pack decides which tools a new box is set up with. Official packs shipped with
        this Rocky Surf release; Community packs were installed from a registry or created here.
      </p>

      <section className="shop-section">
        <h2>Official</h2>
        {official.length === 0 ? (
          <p className="empty">No packs from this Rocky Surf release are enabled.</p>
        ) : (
          <ul className="pack-grid">
            {official.map((view) => (
              <PackCard key={view.packId} view={view} isAdmin={isAdmin} />
            ))}
          </ul>
        )}
      </section>

      <section className="shop-section">
        <h2>Community</h2>
        {community.length === 0 ? (
          <p className="empty">No community packs are installed.</p>
        ) : (
          <ul className="pack-grid">
            {community.map((view) => (
              <PackCard key={view.packId} view={view} isAdmin={isAdmin} />
            ))}
          </ul>
        )}
      </section>

      {isAdmin && (
        <section className="shop-section">
          <div className="shop-section-head">
            <h2>Manage packs</h2>
            <button
              type="button"
              className="button secondary"
              onClick={() => void load({ refreshRegistry: true })}
              disabled={refreshing}
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>

          {notice && <p data-testid="notice">{notice}</p>}

          <div className="pack-import">
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
            <label>
              …or from a URL
              <input
                type="url"
                value={importUrl}
                data-testid="import-url"
                onChange={(e) => setImportUrl(e.target.value)}
                placeholder="https://example.com/pack.yaml"
              />
            </label>
            <button type="button" onClick={() => void importFromUrl()} disabled={!importUrl}>
              Import from URL
            </button>
          </div>

          {formTarget === null && (
            <button type="button" onClick={() => setFormTarget('new')}>
              New Surge Pack
            </button>
          )}
          {formTarget === 'new' && (
            <SurgePackFormModal
              initial={null}
              tools={tools}
              onCancel={() => setFormTarget(null)}
              onSaved={() => {
                setFormTarget(null)
                void load()
              }}
            />
          )}

          {registry && !registry.enabled && (
            <p className="hint" data-testid="registry-disabled">
              The pack registry is switched off (<code>registry.enabled: false</code>). Packs
              already installed are unaffected, and you can still create packs above.
            </p>
          )}

          {registry?.shelves.map((shelf) => (
            <ShelfSection
              key={shelf.source.name}
              shelf={shelf}
              busyKey={selectingKey}
              onSelect={(pack) => void openDisclosure(pack)}
            />
          ))}
        </section>
      )}

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
