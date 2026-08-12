import { chmodSync, mkdirSync, statSync } from 'node:fs'

/**
 * The data directory holds everything that must not leak: the SQLite database with its
 * encrypted secret rows, and `secret.key` itself.
 */
export const DATA_DIR_MODE = 0o700

export interface EnsureDataDirResult {
  path: string
  /** True when this call created it — which is what "first boot" means to the CLI. */
  created: boolean
  /**
   * Set when the directory exists with looser permissions than {@link DATA_DIR_MODE} and we
   * could not tighten it. A warning, not a failure: the operator may have deliberate reasons,
   * and refusing to start over a directory mode would be worse than saying so.
   */
  warning?: string
}

/**
 * Create the data directory, owner-only.
 *
 * Called FIRST in the boot path, before the database is opened or the master key is loaded,
 * because both of those create the directory themselves as a side effect of writing into it —
 * and both use the default mode, which honours the process umask and on a typical machine
 * yields 0755. A world-readable directory containing `secret.key` is exactly the kind of
 * quiet mistake self-hosting has to not make, so the mode is set explicitly here and the
 * later writers find the directory already correct.
 *
 * `mkdir` is given the mode directly rather than chmod-ed afterwards, so there is no window
 * in which the directory exists with the wrong permissions.
 */
export function ensureDataDir(path: string): EnsureDataDirResult {
  let existed = true
  try {
    statSync(path)
  } catch {
    existed = false
  }

  mkdirSync(path, { recursive: true, mode: DATA_DIR_MODE })

  if (!existed) return { path, created: true }

  // An existing directory keeps whatever mode it has — mkdir's `mode` applies only on
  // creation. Tighten it if we can; say so if we cannot.
  try {
    const mode = statSync(path).mode & 0o777
    if (mode !== DATA_DIR_MODE) {
      chmodSync(path, DATA_DIR_MODE)
    }
  } catch (err) {
    return {
      path,
      created: false,
      warning:
        `could not set permissions on ${path} to 0${DATA_DIR_MODE.toString(8)}: ${err instanceof Error ? err.message : String(err)}\n` +
        'It holds secret.key and the database — check it is not readable by other users.',
    }
  }

  return { path, created: false }
}
