import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { AppShell } from '../components/AppShell'
import { ConfirmModal } from '../components/ConfirmModal'
import { InstallPreview } from '../components/InstallPreview'
import { ToolFormModal } from '../components/ToolFormModal'
import {
  ApiError,
  deleteAdminTool,
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

  const ordered = [...tools].sort(
    (a, b) =>
      Number(b.bootstrap) - Number(a.bootstrap) ||
      a.installOrder - b.installOrder ||
      a.toolId.localeCompare(b.toolId),
  )
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

  return (
    <AppShell title="Tools">
      <div className="admin-actions">
        <button className="button primary new-action" onClick={() => setEditing('new')}>
          New tool
        </button>
      </div>

      {loading && <p>Loading…</p>}
      {error && <p role="alert">{error}</p>}

      {!loading && !error && (
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
            {ordered.map((tool) => (
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
                      file: {tool.sourceFile}
                    </span>
                  ) : (
                    <span>database</span>
                  )}
                </td>
                <td>
                  {isFileBacked(tool) ? (
                    <small data-testid={`readonly-hint-${tool.toolId}`}>
                      Read-only — edit {tool.sourceFile} and restart
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
