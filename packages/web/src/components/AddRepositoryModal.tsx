import { useState, type FormEvent } from 'react'
import { addRepository, ApiError } from '../lib/api'

/**
 * Clone another repository onto a running server.
 *
 * The old version listed the user's GitHub repositories through the GitHub App installation
 * and let them pick. v0.1 has no GitHub OAuth and no App, so it takes a URL — which is also
 * the only form that works for a self-hoster using GitLab, a private host, or a plain SSH
 * remote. Validation is deliberately shallow: core clones it and reports what happened, and
 * a client-side allowlist of hostnames would just be wrong for somebody.
 */
export function AddRepositoryModal({
  serverId,
  onAdded,
  onClose,
}: {
  serverId: string
  onAdded: () => void | Promise<void>
  onClose: () => void
}) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await addRepository(serverId, url.trim())
      await onAdded()
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Could not add the repository')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Add a repository">
      <div className="modal">
        <h3>Add a repository</h3>
        <form onSubmit={onSubmit}>
          <label htmlFor="repository-url">Clone URL</label>
          <input
            id="repository-url"
            name="repository-url"
            type="text"
            autoFocus
            placeholder="https://github.com/owner/name.git"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          {error && <p role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="button secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="button primary" disabled={submitting || url.trim().length === 0}>
              {submitting ? 'Adding…' : 'Add'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
