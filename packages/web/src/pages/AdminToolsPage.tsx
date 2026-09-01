import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { AppShell } from '../components/AppShell'
import { ConfirmModal } from '../components/ConfirmModal'
import { InstallPreview } from '../components/InstallPreview'
import { ToolFormModal } from '../components/ToolFormModal'
import {
  ApiError,
  deleteAdminTool,
  exportToolYaml,
  importTools,
  listAdminSurgePacks,
  listAdminTools,
  type AdminSurgePack,
  type AdminTool,
} from '../lib/api'

/**
 * Tools administration.
 *
 * Ported from the legacy SPA's admin tools page. The list is ordered the way the plan
 * will run — `bootstrap` first, then `installOrder`, ties by `toolId` — so the table reads as
 * the sequence it describes rather than as an arbitrary list.
 *
 * PROVENANCE, matching the packs half so the two admin surfaces behave identically: `packs/*.yaml`
 * is the source of truth for shipped content and the boot sync rewrites those rows from disk
 * (ADR-0004), so a row carrying `sourceFile` renders READ-ONLY with a badge naming its file.
 * An edit offered here would vanish on the next restart, and an editor that lets someone type
 * into a field it is going to discard is worse than one that explains why it is closed. Rows
 * created here — including anything re-imported, which core stores with a null `sourceFile` —
 * are editable normally.
 */
export function AdminToolsPage() {
  const [tools, setTools] = useState<AdminTool[]>([])
  const [packs, setPacks] = useState<AdminSurgePack[]>([])
  const [previewPackId, setPreviewPackId] = useState<string>('')
  const [editing, setEditing] = useState<AdminTool | 'new' | null>(null)
  const [deleting, setDeleting] = useState<AdminTool | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const [nextTools, nextPacks] = await Promise.all([listAdminTools(), listAdminSurgePacks()])
      setTools(nextTools)
      setPacks(nextPacks)
      setPreviewPackId((current) => current || (nextPacks[0]?.packId ?? ''))
      setError(null)
    } catch {
      setError('Could not load tools')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** Same predicate the packs page uses, so "file-backed" means one thing across the surface. */
  const isFileBacked = (tool: AdminTool): boolean => Boolean(tool.sourceFile)

  const byInstallOrder = (a: AdminTool, b: AdminTool) =>
    Number(b.bootstrap) - Number(a.bootstrap) ||
    a.installOrder - b.installOrder ||
    a.toolId.localeCompare(b.toolId)

  /**
   * OFFICIAL AND PERSONAL, the same two words and the same predicate the packs page uses
   * (issue #289). A tool that arrived in the tarball and one this installation registered are
   * different in exactly one way that matters — whether the next boot rewrites it — and naming
   * that split is most of what "a personal tools registry" means here.
   *
   * "Personal" is about WHERE THE ROW CAME FROM, not about who owns it: everyone who runs an
   * installation is its admin (issue #192), so there is no per-user registry to build.
   */
  const official = tools.filter(isFileBacked).sort(byInstallOrder)
  const personal = tools.filter((t) => !isFileBacked(t)).sort(byInstallOrder)
  const previewPack = packs.find((p) => p.packId === previewPackId)

  async function remove(tool: AdminTool) {
    setDeleting(null)
    try {
      await deleteAdminTool(tool.toolId)
      toast.success(`${tool.name} deleted`)
      await refresh()
    } catch (err) {
      // Core refuses to delete a tool a pack still uses, and names the packs. That message is
      // more useful than anything this page could invent.
      toast.error(err instanceof ApiError ? err.detail : `Could not delete ${tool.name}`)
    }
  }

  /**
   * Export one tool as a file, the same shape the packs page's Export uses — a download rather
   * than text on screen, because the point of exporting is to hand the file to somebody.
   *
   * Offered on EVERY row, file-backed ones included: a shipped tool is exactly what an operator
   * wants to send to a colleague who is not running this installation.
   */
  async function downloadYaml(tool: AdminTool) {
    try {
      const yaml = await exportToolYaml(tool.toolId)
      const url = URL.createObjectURL(new Blob([yaml], { type: 'application/yaml' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `${tool.toolId}.yaml`
      link.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      // A toast, not `setError`: a failed download is no reason to replace the whole table.
      toast.error(err instanceof ApiError ? err.detail : 'Export failed')
    }
  }

  /**
   * Import from a file on the operator's own disk. There is no URL box beside this, and the
   * absence is deliberate — see `importTools` in the API client.
   */
  async function importFromFile(file: File) {
    try {
      const imported = await importTools(await file.text())
      toast.success(
        imported.length === 1
          ? `Imported ${imported[0]!.toolId}. Add it to a pack to put it on a box.`
          : `Imported ${imported.length} tools. Add them to a pack to put them on a box.`,
      )
      await refresh()
    } catch (err) {
      // Core's message names the tool and the reason — a file-backed collision, a pack file
      // pasted into the wrong door — and anything this page invented would be vaguer.
      toast.error(err instanceof ApiError ? err.detail : 'Import failed')
    }
  }

  /** One section per provenance. Same columns in both, so the eye compares them directly. */
  function renderTable(heading: string, rows: AdminTool[], blurb: string) {
    return (
      <section className="tools-section">
        <h2>{heading}</h2>
        <p className="tools-section-blurb">{blurb}</p>
        {rows.length === 0 ? (
          <p>
            {heading === 'Personal'
              ? 'No tools of your own yet. New tool writes one; Import a tool file takes one somebody sent you.'
              : 'No tools loaded from files.'}
          </p>
        ) : (
          <table className="tools-table">
            <caption>In the order they install</caption>
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Tool</th>
                <th scope="col">Category</th>
                <th scope="col">Runs as</th>
                <th scope="col">Source</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((tool) => (
                <tr key={tool.toolId} data-enabled={tool.enabled}>
                  <td>{tool.installOrder}</td>
                  <td>
                    <code>{tool.toolId}</code>
                    <span className="tool-name">{tool.name}</span>
                    {!tool.enabled && <span className="badge">disabled</span>}
                    {tool.bootstrap && <span className="badge">runtime-guaranteed</span>}
                  </td>
                  <td>{tool.category}</td>
                  <td>{tool.runAs}</td>
                  <td>
                    {isFileBacked(tool) ? (
                      <span
                        data-testid={`file-backed-${tool.toolId}`}
                        title="Edit the YAML file; the boot sync rewrites this row from disk"
                      >
                        file: <code>{tool.sourceFile}</code>
                      </span>
                    ) : (
                      <span>database</span>
                    )}
                  </td>
                  <td>
                    <button data-testid={`export-${tool.toolId}`} onClick={() => void downloadYaml(tool)}>
                      Export
                    </button>
                    {isFileBacked(tool) ? (
                      <small data-testid={`readonly-hint-${tool.toolId}`}>
                        Read-only — edit <code>{tool.sourceFile}</code> and restart
                      </small>
                    ) : (
                      <>
                        <button onClick={() => setEditing(tool)}>Edit</button>
                        <button className="destructive" onClick={() => setDeleting(tool)}>
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    )
  }

  return (
    <AppShell title="Tools">
      <div className="admin-actions">
        <button className="button primary new-action" onClick={() => setEditing('new')}>
          New tool
        </button>
        <label className="button" htmlFor="import-tool-file">
          Import a tool file
        </label>
        <input
          id="import-tool-file"
          type="file"
          accept=".yaml,.yml"
          className="visually-hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            // Cleared so choosing the same file twice fires again — a re-import after an edit
            // is a normal thing to do.
            e.target.value = ''
            if (file) void importFromFile(file)
          }}
        />
      </div>

      {loading && <p>Loading…</p>}
      {error && <p role="alert">{error}</p>}

      {!loading && !error && (
        <>
          {renderTable('Personal', personal, 'Registered on this installation. Yours to edit, export and share.')}
          {renderTable('Official', official, 'Loaded from packs/*.yaml. The next restart rewrites these from disk.')}
        </>
      )}

      {packs.length > 0 && (
        <section className="preview-section">
          <label htmlFor="preview-pack">Preview install order for</label>
          <select id="preview-pack" value={previewPackId} onChange={(e) => setPreviewPackId(e.target.value)}>
            {packs.map((pack) => (
              <option key={pack.packId} value={pack.packId}>
                {pack.name}
              </option>
            ))}
          </select>
          {previewPack && <InstallPreview pack={previewPack} tools={tools} />}
        </section>
      )}

      <footer>
        <p style={{ fontSize: '0.875rem' }}>
          The preview is resolved here rather than by core — there is no endpoint that will order a
          hypothetical pack, only the plan snapshotted when a server is created. Drag-to-reorder is not
          wired either; set <code>installOrder</code> directly, in gaps of 10.
        </p>
      </footer>

      {editing && (
        <ToolFormModal
          {...(editing === 'new' ? {} : { tool: editing })}
          onSaved={refresh}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <ConfirmModal
          title={`Delete ${deleting.name}?`}
          message={
            deleting.sourceFile
              ? `This tool comes from packs/${deleting.sourceFile}. Deleting it here removes the row until the next restart, which loads it back from the file.`
              : 'This removes the tool. Packs still using it will refuse to delete it.'
          }
          confirmLabel="Delete"
          isDestructive
          onCancel={() => setDeleting(null)}
          onConfirm={() => void remove(deleting)}
        />
      )}
    </AppShell>
  )
}
