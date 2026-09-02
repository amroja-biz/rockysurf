import { useRef, useState } from 'react'
import { Link } from 'react-router'
import { ApiError, downloadBackup, restoreBackup, type RestoreResult } from '../lib/api'

/**
 * The Backup tab's two cards (issue #331, ADR-0022).
 *
 * Hand-written contents for the `backup` section core declares — the ConnectGitHubCard
 * pattern: the tab, its heading and its help come from the server's inventory, and this
 * component supplies the controls.
 *
 * BACKUP is one click and one honest paragraph: what the file holds, what it deliberately
 * does not (the master key, and every GitHub token from the configuration file — the owner's
 * ruling is that cleartext tokens never travel), and the one thing the operator must do
 * themselves (carry the key). RESTORE is a file picker, an explicit second click, and a
 * report that says what landed, what was skipped, what was refused and what to re-enter — a
 * restore is a merge with reasons, never a silent replace.
 */

interface BackupRestoreCardsProps {
  /** How many literal GitHub tokens the config file currently holds ('set'-state fields). */
  literalTokenCount: number
  /** Reload the page's data after a restore changed the file and the database. */
  onRestored: () => void
}

const summarize = (result: RestoreResult): string[] => {
  const lines: string[] = []
  const domain = (label: string, d: { restored: number; skipped: number; refused: { reason: string }[] }) => {
    if (d.restored === 0 && d.skipped === 0 && d.refused.length === 0) return
    const parts = [`${d.restored} restored`]
    if (d.skipped > 0) parts.push(`${d.skipped} already here`)
    if (d.refused.length > 0) parts.push(`${d.refused.length} refused`)
    lines.push(`${label}: ${parts.join(', ')}`)
  }
  domain('Servers', result.report.servers)
  domain('Surge Packs', result.report.packs)
  domain('Tools', result.report.tools)
  domain('Accounts', result.report.users)
  const s = result.report.secrets
  if (s.restored > 0 || s.dropped.length > 0 || s.skipped > 0) {
    const parts = [`${s.restored} restored`]
    if (s.restored > 0) parts.push(s.unreadable === 0 ? 'all readable with this machine’s key' : `${s.unreadable} unreadable until your old secret.key is in place`)
    if (s.skipped > 0) parts.push(`${s.skipped} already here`)
    lines.push(`Encrypted secrets: ${parts.join(', ')}`)
  }
  return lines
}

export function BackupRestoreCards({ literalTokenCount, onRestored }: BackupRestoreCardsProps) {
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<{ name: string; text: string } | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [result, setResult] = useState<RestoreResult | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)

  async function download(): Promise<void> {
    setDownloading(true)
    setDownloadError(null)
    try {
      const { filename, text } = await downloadBackup()
      /* The browser's own save path: a Blob URL on a transient anchor. Nothing external. */
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setDownloadError(err instanceof ApiError ? err.detail : 'Could not build the backup.')
    } finally {
      setDownloading(false)
    }
  }

  async function pick(file: File | undefined): Promise<void> {
    setRestoreError(null)
    setResult(null)
    if (!file) {
      setChosen(null)
      return
    }
    setChosen({ name: file.name, text: await file.text() })
  }

  async function restore(): Promise<void> {
    if (!chosen) return
    setRestoring(true)
    setRestoreError(null)
    let artifact: unknown
    try {
      artifact = JSON.parse(chosen.text)
    } catch {
      setRestoreError(`${chosen.name} is not a Rocky Surf backup — the file is not valid JSON.`)
      setRestoring(false)
      return
    }
    try {
      const outcome = await restoreBackup(artifact)
      setResult(outcome)
      setChosen(null)
      if (fileInput.current) fileInput.current.value = ''
      onRestored()
    } catch (err) {
      setRestoreError(err instanceof ApiError ? err.detail : 'The restore failed.')
    } finally {
      setRestoring(false)
    }
  }

  return (
    <>
      <div className="settings-entry" data-backup-card>
        <h3>Back up this installation</h3>
        <p className="field-help">
          One JSON file: your servers&rsquo; records, your Surge Packs and tools, your settings
          file, your spend history, and every stored secret <strong>as the encrypted
          ciphertext it already is</strong>. Your cloud machines are not in it — they live in
          your cloud accounts and never left.
        </p>
        <p className="hint">
          <strong>The encryption key is not in the backup, on purpose.</strong> To read the
          restored secrets on another machine, carry your data directory&rsquo;s{' '}
          <code>secret.key</code> there yourself (or set <code>ROCKYSURF_SECRET_KEY</code>).
          Without it, everything else still restores — the secrets just stay sealed until the
          key arrives.
        </p>
        {literalTokenCount > 0 && (
          <p className="hint" data-backup-token-notice>
            {literalTokenCount === 1
              ? 'The 1 GitHub token pasted into your configuration file will NOT be included'
              : `The ${literalTokenCount} GitHub tokens pasted into your configuration file will NOT be included`}{' '}
            — a backup never carries a cleartext token. After a restore, you re-enter{' '}
            {literalTokenCount === 1 ? 'it' : 'them'} here, and the restore report lists{' '}
            {literalTokenCount === 1 ? 'it' : 'them'} by name.
          </p>
        )}
        <button type="button" className="btn-primary" data-backup-download disabled={downloading} onClick={() => void download()}>
          {downloading ? 'Building backup…' : 'Download backup'}
        </button>
        {downloadError && <p className="settings-warning">{downloadError}</p>}
        <p className="hint">
          The full-fidelity alternative — the whole data directory, key included, taken with the
          process stopped — is in <Link to="/help#backup">Backing up your data</Link>.
        </p>
      </div>

      <div className="settings-entry" data-restore-card>
        <h3>Restore from a backup</h3>
        <p className="field-help">
          Reads a backup file into this installation. Nothing already here is overwritten or
          deleted — everything in the file is added, skipped because it already exists, or
          refused with a reason, and the report below says which. This machine&rsquo;s own
          address, port, data directory and sign-in mode are kept.
        </p>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          aria-label="Backup file"
          onChange={(e) => void pick(e.target.files?.[0])}
        />
        {chosen && (
          <button type="button" className="btn-primary" data-restore-confirm disabled={restoring} onClick={() => void restore()}>
            {restoring ? 'Restoring…' : `Restore ${chosen.name}`}
          </button>
        )}
        {restoreError && <p className="settings-warning" data-restore-error>{restoreError}</p>}

        {result && (
          <div data-restore-report>
            <h4>Restored</h4>
            <ul>
              {summarize(result).map((line) => (
                <li key={line}>{line}</li>
              ))}
              {summarize(result).length === 0 && <li>Nothing new — everything in the backup was already here.</li>}
            </ul>
            {[
              ...result.report.users.refused,
              ...result.report.tools.refused,
              ...result.report.packs.refused,
              ...result.report.servers.refused,
              ...result.report.secrets.dropped,
            ].map((item, index) => (
              <p className="hint" key={`${item.id}-${index}`}>
                {item.id}: {item.reason}
              </p>
            ))}
            {result.tokensToReenter.length > 0 && (
              <p className="hint" data-tokens-to-reenter>
                <strong>These GitHub tokens need re-adding on the GitHub access tokens tab:</strong>{' '}
                {result.tokensToReenter.join(', ')}. The backup carried their names, never their
                values.
              </p>
            )}
            {result.config.written ? (
              <p className="hint" data-restore-config>
                Configuration restored{result.config.applied ? ' and in force' : ''}.
                {result.config.pinnedKept.length > 0 &&
                  ` Kept this machine’s ${result.config.pinnedKept.join(', ')}.`}
                {result.config.warnings?.length
                  ? ` Waiting on environment variables: ${result.config.warnings.map((w) => w.message).join('; ')}`
                  : ''}
              </p>
            ) : (
              <p className="settings-warning" data-restore-config>
                {result.config.skipped ??
                  `The configuration portion was refused: ${(result.config.refused ?? [])
                    .map((issue) => `${issue.path}: ${issue.message}`)
                    .join('; ')}. Everything above still landed — fix the configuration issue and restore the same file again.`}
              </p>
            )}
          </div>
        )}
      </div>
    </>
  )
}
