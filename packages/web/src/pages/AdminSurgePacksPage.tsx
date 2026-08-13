import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createAdminSurgePack,
  deleteAdminSurgePack,
  exportSurgePackYaml,
  importSurgePack,
  listAdminSurgePacks,
  listAdminTools,
  updateAdminSurgePack,
  type AdminSurgePack,
  type AdminTool,
} from '../lib/api'
import { AppShell } from '../components/AppShell'

/**
 * Pack administration (rockysurf-hzi7.5).
 *
 * Ported from the legacy SPA's pack admin page, with one change that reshapes the
 * whole page: packs now have PROVENANCE. Files in `packs/` are the source of truth (ADR-0004)
 * and the boot sync rewrites their rows from disk, so a row carrying `sourceFile` cannot be
 * edited here — an edit would vanish on the next start, which is worse than not offering it.
 * Those rows render read-only with a badge pointing at the file. Rows created here, or
 * imported, remain fully editable.
 *
 * The three fields the old app never had — `requiresRepos`, `requiresRdp`, `desktop` — get
 * real controls, because they are how a pack describes its own behaviour instead of the
 * application special-casing a pack id.
 */

interface PackFormState {
  packId: string
  name: string
  tools: string[]
  displayOrder: number
  enabled: boolean
  requiresRepos: boolean
  requiresRdp: boolean
  desktop: '' | 'xfce'
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
})

const isFileBacked = (pack: AdminSurgePack): boolean => Boolean(pack.sourceFile)

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

      {/* The three behaviour flags. They exist so pack behaviour is described BY the pack;
          if you find yourself wanting the app to special-case a packId, that is a bug in this
          format rather than a missing branch. */}
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

export function AdminSurgePacksPage() {
  const [packs, setPacks] = useState<AdminSurgePack[]>([])
  const [tools, setTools] = useState<AdminTool[]>([])
  const [editing, setEditing] = useState<AdminSurgePack | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [importUrl, setImportUrl] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      const [loadedPacks, loadedTools] = await Promise.all([listAdminSurgePacks(), listAdminTools()])
      setPacks(loadedPacks)
      setTools(loadedTools)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load Surge Packs')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function download(pack: AdminSurgePack) {
    try {
      const yaml = await exportSurgePackYaml(pack.packId)
      // A real file, so the operator can drop it into `packs/` and have it become the source
      // of truth — which is the whole point of exporting rather than showing the text.
      const url = URL.createObjectURL(new Blob([yaml], { type: 'application/yaml' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `${pack.packId}.yaml`
      link.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed')
    }
  }

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
      // SSRF: core fetches this URL server-side, so it can reach whatever core can reach.
      // Admin-only and http/https-restricted today; rockysurf-ftl9.9 tracks the allowlist or
      // egress policy this needs before release, and may restrict or remove the endpoint.
      const imported = await importSurgePack({ url: importUrl })
      setNotice(`Imported ${imported.packId} from URL.`)
      setImportUrl('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    }
  }

  async function remove(pack: AdminSurgePack) {
    if (!confirm(`Delete the Surge Pack ${pack.packId}? This removes the database row, not the YAML file.`))
      return
    try {
      await deleteAdminSurgePack(pack.packId)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  return (
    <AppShell title="Surge Packs">
      {error && <p role="alert">{error}</p>}
      {notice && <p data-testid="notice">{notice}</p>}

      <section>
        <h2>Import</h2>
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
      </section>

      <section>
        <h2>Surge Packs</h2>
        {!creating && !editing && (
          <button type="button" onClick={() => setCreating(true)}>
            New Surge Pack
          </button>
        )}
        {(creating || editing) && (
          <SurgePackFormModal
            initial={editing}
            tools={tools}
            onCancel={() => {
              setCreating(false)
              setEditing(null)
            }}
            onSaved={() => {
              setCreating(false)
              setEditing(null)
              void load()
            }}
          />
        )}

        <table>
          <thead>
            <tr>
              <th>Surge Pack</th>
              <th>Tools</th>
              <th>Behaviour</th>
              <th>Source</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {packs.map((pack) => (
              <tr key={pack.packId} data-testid={`pack-row-${pack.packId}`}>
                <td>
                  {/* The card image the pack names, if any — an operator setting `imageUrl` in a
                      YAML file has no other way to see whether the path actually resolves. */}
                  {pack.imageUrl && (
                    <img
                      className="pack-icon"
                      src={pack.imageUrl}
                      alt=""
                      loading="lazy"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none'
                      }}
                    />
                  )}
                  {pack.name} <small>({pack.packId})</small>
                  {!pack.enabled && <small> — disabled</small>}
                  {/* The post-boot guide, read-only (rockysurf-7ckx). There is no editor for it
                      here: every pack that has one today is file-backed, so the YAML file is
                      where it is edited, and this is the round-trip check that it survived the
                      load. Text in a <pre>, never markup — same posture as the server page. */}
                  {pack.guide && (
                    <details data-testid={`guide-${pack.packId}`}>
                      <summary>Guide</summary>
                      <pre className="pack-guide-text">{pack.guide}</pre>
                    </details>
                  )}
                </td>
                <td>{pack.tools.length}</td>
                <td>
                  {[
                    pack.requiresRepos ? 'repos' : null,
                    pack.requiresRdp ? 'rdp' : null,
                    pack.desktop ?? null,
                  ]
                    .filter(Boolean)
                    .join(', ') || '—'}
                </td>
                <td>
                  {isFileBacked(pack) ? (
                    <span data-testid={`file-backed-${pack.packId}`} title="Edit the YAML file; the boot sync rewrites this row from disk">
                      file: {pack.sourceFile}
                    </span>
                  ) : (
                    <span>database</span>
                  )}
                </td>
                <td>
                  <button type="button" onClick={() => void download(pack)}>
                    Export
                  </button>
                  {isFileBacked(pack) ? (
                    <small data-testid={`readonly-hint-${pack.packId}`}>
                      Read-only — edit {pack.sourceFile} and restart
                    </small>
                  ) : (
                    <>
                      <button type="button" onClick={() => setEditing(pack)}>
                        Edit
                      </button>
                      <button type="button" onClick={() => void remove(pack)}>
                        Delete
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <footer>
        <p style={{ fontSize: '0.875rem' }}>
          Surge Pack images and guides are not editable here yet — core has no upload route, and every
          pack that carries a guide today is file-backed. Set <code>imageUrl</code> and{' '}
          <code>guide</code> in the YAML file. The shipped packs point <code>imageUrl</code> at{' '}
          <code>/images/surge-packs/…</code>, which is bundled with the app rather than fetched from
          anywhere.
        </p>
      </footer>
    </AppShell>
  )
}
