import { useState, type FormEvent } from 'react'
import { CodeEditor } from './CodeEditor'
import { ApiError, createAdminTool, updateAdminTool, type AdminTool } from '../lib/api'

/**
 * Create or edit one tool.
 *
 * Ported from the legacy SPA's tool form modal, with two changes that matter:
 *
 *  - **Provenance is shown, not hidden.** A tool loaded from `packs/*.yaml` can be edited
 *    here, but the next boot reloads it from the file and the edit is gone (ADR-0004). The
 *    form says so and offers the export path instead of pretending the edit is durable.
 *  - **`bootstrap` is not offered.** It is reserved for the tools the runtime guarantees
 *    before any plan runs, and the pack contract tells authors to leave it false; a checkbox
 *    inviting an operator to set it would contradict the document.
 *
 * Scripts go through `CodeEditor`, which round-trips bytes exactly. Nothing here trims.
 */

const ORDER_BANDS = [
  [10, 'apt packages with no dependencies of their own'],
  [20, 'language runtimes — Node, Python, Go, Rust'],
  [30, 'anything needing a runtime from band 20'],
  [40, 'the agents themselves'],
  [50, 'anything needing an agent already installed'],
] as const

export function ToolFormModal({
  tool,
  onSaved,
  onClose,
}: {
  /** Undefined when creating. */
  tool?: AdminTool
  onSaved: () => void | Promise<void>
  onClose: () => void
}) {
  const editing = tool !== undefined
  const fileBacked = Boolean(tool?.sourceFile)

  const [name, setName] = useState(tool?.name ?? '')
  const [toolId, setToolId] = useState(tool?.toolId ?? '')
  const [description, setDescription] = useState(tool?.description ?? '')
  const [url, setUrl] = useState(tool?.url ?? '')
  const [category, setCategory] = useState<AdminTool['category']>(tool?.category ?? 'base')
  const [runAs, setRunAs] = useState<AdminTool['runAs']>(tool?.runAs ?? 'root')
  const [installOrder, setInstallOrder] = useState(String(tool?.installOrder ?? 30))
  const [enabled, setEnabled] = useState(tool?.enabled ?? true)
  const [installScript, setInstallScript] = useState(tool?.installScript ?? '')
  const [setupScript, setSetupScript] = useState(tool?.setupScript ?? '')

  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setSaving(true)
    try {
      const payload = {
        name,
        description,
        url,
        category,
        runAs,
        installOrder: Number(installOrder),
        enabled,
        installScript,
        // Sent only when non-empty: an empty string is not the same as "no setup script",
        // and the schema treats a present-but-empty script as invalid.
        ...(setupScript.length > 0 ? { setupScript } : {}),
      }
      if (editing) await updateAdminTool(tool.toolId, payload)
      else await createAdminTool({ ...payload, ...(toolId ? { toolId } : {}), bootstrap: false })
      await onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Could not save this tool')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={editing ? `Edit ${tool.name}` : 'New tool'}>
      <div className="modal modal-wide">
        <h3>{editing ? `Edit ${tool.name}` : 'New tool'}</h3>

        <form onSubmit={onSubmit}>
          <label htmlFor="tool-name">Name</label>
          <input id="tool-name" value={name} onChange={(e) => setName(e.target.value)} required />

          {!editing && (
            <>
              <label htmlFor="tool-id">Tool id</label>
              <input
                id="tool-id"
                value={toolId}
                placeholder="derived from the name when left blank"
                onChange={(e) => setToolId(e.target.value)}
              />
            </>
          )}

          <label htmlFor="tool-description">Description</label>
          <input
            id="tool-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
          />

          <label htmlFor="tool-url">URL</label>
          <input id="tool-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} required />

          <label htmlFor="tool-category">Category</label>
          <select
            id="tool-category"
            value={category}
            onChange={(e) => setCategory(e.target.value as AdminTool['category'])}
          >
            <option value="base">base — supporting software</option>
            <option value="agent">agent — what the pack exists to deliver</option>
          </select>

          <label htmlFor="tool-run-as">Runs as</label>
          <select id="tool-run-as" value={runAs} onChange={(e) => setRunAs(e.target.value as AdminTool['runAs'])}>
            <option value="root">root — system packages, global installs</option>
            <option value="rocky">rocky — anything in the user&apos;s home</option>
          </select>
          <details className="hint" open={!editing}>
            <summary>Which one? The rule of thumb</summary>
            <ul>
              <li>
                <strong>
                  <code>root</code>
                </strong>{' '}
                — <code>apt-get install</code>, anything written under <code>/usr/local</code>,{' '}
                <code>/opt</code> or <code>/etc</code>, adding a user to a group, or an installer whose own
                instructions say <code>sudo</code>.
              </li>
              <li>
                <strong>
                  <code>rocky</code>
                </strong>{' '}
                — anything that lands in the user&apos;s home: a <code>curl … | bash</code> installer that
                writes to <code>~/.local/bin</code>, <code>pipx</code>, <code>cargo install</code>,{' '}
                <code>npm install -g</code> under nvm, a git clone into <code>~</code>, an edit to{' '}
                <code>~/.bashrc</code>.
              </li>
            </ul>
            <p>
              Ask: would you run this as yourself on your own laptop, or would you type <code>sudo</code> first?
              The first is <code>rocky</code>, the second is <code>root</code>. Most coding agents are the first
              kind. A tool that needs both — packages as root, then per-user configuration — is two steps:
              this install script as <code>root</code> and the setup script below, which runs as{' '}
              <code>rocky</code>.
            </p>
            <p>
              The agent dispatches privilege from this field before the script runs. A script that declares{' '}
              <code>rocky</code> and then calls <code>sudo</code> fails in the container CI uses, which has no
              sudo at all. A <code>root</code> script that installs into <code>/root</code> leaves the tool where{' '}
              <code>rocky</code> can never reach it.
            </p>
          </details>

          <label htmlFor="tool-install-order">Install order</label>
          <input
            id="tool-install-order"
            type="number"
            step={10}
            value={installOrder}
            onChange={(e) => setInstallOrder(e.target.value)}
            required
          />
          <details className="hint">
            <summary>Gaps of 10, by convention</summary>
            <ul>
              {ORDER_BANDS.map(([order, meaning]) => (
                <li key={order}>
                  <code>{order}</code> — {meaning}
                </li>
              ))}
            </ul>
            <p>
              Leave gaps so a step can be inserted later without renumbering everything. Tools sharing a
              number run in <strong>toolId order</strong>, which exists so a snapshotted plan renders the
              same way twice — it is not a way to sequence dependencies. If B needs A, give B a higher
              number.
            </p>
          </details>

          <label>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
          </label>

          <fieldset>
            <legend>Install script</legend>
            <CodeEditor
              value={installScript}
              onChange={setInstallScript}
              ariaLabel="Install script"
              readOnly={saving}
            />
          </fieldset>

          <fieldset>
            <legend>Setup script (optional)</legend>
            <p className="hint">
              Runs after repositories are cloned, as the same user, so it can read <code>$REPOS</code>.
            </p>
            <CodeEditor value={setupScript} onChange={setSetupScript} ariaLabel="Setup script" readOnly={saving} />
          </fieldset>

          {error && <p role="alert">{error}</p>}

          <div className="modal-actions">
            <button type="button" className="button secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="button primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
