import { hostname } from 'node:os'
import { join } from 'node:path'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'

/**
 * The advisory lock that makes a data directory single-core (rockysurf-utjq).
 *
 * WAL-mode SQLite is DESIGNED to let two processes write one database, so the database gives
 * no protection against the thing that actually hurts: a second `boot()` on a live data
 * directory runs the startup recovery pass over the first core's in-flight rows and settles
 * them against its OWN provider registry, and then two job loops reconcile and accrue uptime
 * against the same servers. `rockysurf mcp` and `rockysurf token` did exactly this by accident
 * (rockysurf-o2t5); a supervisor restarting core before the old process has exited does it on
 * purpose. What is missing is core refusing to be the second one — that refusal is this file.
 *
 * The shape is a pid file, `core.lock` inside the data directory, taken before the database is
 * opened and released on clean shutdown:
 *
 *  - **acquisition is atomic** — the file is created with `wx` (O_CREAT|O_EXCL), so two
 *    processes racing for a missing lock cannot both win;
 *  - **staleness is decided by the OS, not by the file** — a lock left behind by a SIGKILLed
 *    core must never brick the next start (SQLite is crash-safe; the lock must not be less so).
 *    A recorded pid that no longer exists (`kill(pid, 0)` → ESRCH) means the holder is dead
 *    and the lock is reclaimed. EPERM means the process exists but belongs to someone else,
 *    which is a live holder;
 *  - **refusing is a printed sentence, not a stack trace** — {@link DataDirLockError.message}
 *    names the holding pid, the data directory and the lock file, and says what to do. The CLI
 *    prints it verbatim, the same contract `ConfigError` has.
 *
 * Deliberately NOT `flock()`: Node has no flock without a native dependency, and O_EXCL plus a
 * liveness check is the portable version of the same guarantee. The known residual gap — pid
 * reuse making a dead holder look alive — requires the OS to hand the recycled pid to a
 * process that outlives the operator noticing, and costs one `rm` of a named file; the
 * alternative gaps (a bare pid file with no liveness check bricking every start after a crash)
 * cost more.
 */

export const LOCK_FILENAME = 'core.lock'

/** Where the lock lives for a given data directory — exported so messages and tests agree. */
export function dataDirLockPath(dataDir: string): string {
  return join(dataDir, LOCK_FILENAME)
}

/** What `acquireDataDirLock` writes. JSON so a human staring at the file gets an explanation. */
interface LockRecord {
  pid: number
  hostname: string
  startedAt: string
}

export interface DataDirLock {
  path: string
  /**
   * Remove the lock, if this process still holds it. Safe to call twice, and safe to call
   * after another process has reclaimed the lock (it re-reads the pid before unlinking, so it
   * never deletes a lock it does not own).
   */
  release(): void
}

/** Thrown when another live core holds the lock. The message is meant to be printed verbatim. */
export class DataDirLockError extends Error {
  constructor(
    /** The pid recorded in the lock file — the process that must stop first. */
    readonly pid: number,
    /** The data directory both cores wanted. */
    readonly dataDir: string,
    /** The lock file itself, so a stuck operator knows exactly what to delete. */
    readonly lockPath: string,
  ) {
    super(
      [
        `another rockysurf core (pid ${pid}) is already running on this data directory:`,
        '',
        `  data  ${dataDir}`,
        `  lock  ${lockPath}`,
        '',
        'Two cores writing one database means double job loops, double spend and a corrupted',
        `fleet. Stop the running one first (kill ${pid}), or point this one at a different`,
        'dataDir. A lock left behind by a crashed core is reclaimed automatically — this',
        "one's holder is alive right now.",
      ].join('\n'),
    )
    this.name = 'DataDirLockError'
  }
}

/**
 * Take the lock, or throw {@link DataDirLockError} naming who holds it.
 *
 * Called by `boot()` immediately after the data directory exists and BEFORE the database is
 * opened — migrations and the startup recovery pass are both writes a second core must never
 * make. The retry loop exists for one race: two processes finding the same stale lock, both
 * unlinking it, and both trying to create — one wins `wx`, the loser comes around, reads the
 * winner's pid and refuses.
 */
export function acquireDataDirLock(options: { dataDir: string; log?: (message: string) => void }): DataDirLock {
  const { dataDir } = options
  const log = options.log ?? (() => {})
  const path = dataDirLockPath(dataDir)

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const record: LockRecord = { pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() }
      writeFileSync(path, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 })
      return { path, release: () => releaseLock(path) }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }

    // The lock exists. Somebody holds it — the question is whether they are still alive.
    const holder = readLockPid(path)
    if (holder === undefined) {
      // Vanished between our create failing and our read — whoever held it released it.
      continue
    }
    if (holder !== null && isProcessAlive(holder)) {
      throw new DataDirLockError(holder, dataDir, path)
    }

    // A dead pid, or a file no pid can be read from (a lock this module never wrote — there is
    // no live holder it could belong to). Either way: stale. Reclaim it and go around again,
    // through `wx`, so a racing process can still only win atomically.
    log(
      holder === null
        ? `removing unreadable lock file ${path} — no holding pid could be read from it`
        : `removing stale lock file ${path} — its core (pid ${holder}) is no longer running`,
    )
    try {
      unlinkSync(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  // Five consecutive create-or-reclaim races means something is churning the file faster than
  // we can look at it; refusing with the last known state beats spinning forever.
  const holder = readLockPid(path)
  throw new DataDirLockError(holder ?? 0, dataDir, path)
}

/** The recorded pid; `null` for a file we cannot parse; `undefined` for a file that is gone. */
function readLockPid(path: string): number | null | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockRecord>
    return typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null
  } catch {
    return null
  }
}

/**
 * `kill(pid, 0)` sends no signal; it only asks the OS whether it could.
 *
 * ESRCH is the one answer that means "no such process". EPERM means the pid exists but is not
 * ours to signal — that is a LIVE process, and the honest reading is that some other user's
 * core (or an unrelated process wearing a recycled pid) holds the lock; refusing is the safe
 * side of that ambiguity.
 */
function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Unlink only a lock this process wrote — re-checked at release time, not remembered. */
function releaseLock(path: string): void {
  if (readLockPid(path) !== process.pid) return
  try {
    unlinkSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}
