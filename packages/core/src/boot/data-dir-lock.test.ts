import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireDataDirLock, DataDirLockError, dataDirLockPath, LOCK_FILENAME } from './data-dir-lock.js'

/**
 * The lock module alone (rockysurf-utjq). The boot-level composition — that `boot()` actually
 * takes this lock before touching the database, refuses as the second core, and releases on
 * `close()` — is proved in `server.test.ts` and in the composition root's
 * `live-datadir.test.ts`; a module test cannot see a missing composition (lesson 55fx.13).
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rockysurf-lock-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * A pid that certainly existed and certainly no longer does: spawn a Node that runs nothing
 * and wait for it. `spawnSync` does not return until the child has exited, and the OS will not
 * hand its pid out again in the microseconds before the assertion runs.
 */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''])
  expect(child.status).toBe(0)
  return child.pid!
}

describe('acquireDataDirLock', () => {
  it('creates the lock file, recording this process', () => {
    const lock = acquireDataDirLock({ dataDir: dir })

    expect(lock.path).toBe(join(dir, LOCK_FILENAME))
    expect(lock.path).toBe(dataDirLockPath(dir))
    const record = JSON.parse(readFileSync(lock.path, 'utf8')) as { pid: number }
    expect(record.pid).toBe(process.pid)
  })

  it('refuses a second acquisition while the holder is alive, naming pid, directory and lock file', () => {
    acquireDataDirLock({ dataDir: dir })

    let refused: DataDirLockError | undefined
    try {
      acquireDataDirLock({ dataDir: dir })
    } catch (err) {
      if (err instanceof DataDirLockError) refused = err
      else throw err
    }

    expect(refused).toBeDefined()
    expect(refused!.pid).toBe(process.pid)
    expect(refused!.dataDir).toBe(dir)
    expect(refused!.lockPath).toBe(dataDirLockPath(dir))
    // The message is the interface: it is printed verbatim at a terminal, so it must carry
    // everything the operator needs — who holds it, where, and what to do about it.
    expect(refused!.message).toContain(`pid ${process.pid}`)
    expect(refused!.message).toContain(dir)
    expect(refused!.message).toContain(dataDirLockPath(dir))
    expect(refused!.message).toContain(`kill ${process.pid}`)
  })

  it('reclaims a lock whose recorded pid is dead — a crash must not brick the directory', () => {
    const stale = { pid: deadPid(), hostname: 'gone', startedAt: new Date().toISOString() }
    writeFileSync(dataDirLockPath(dir), `${JSON.stringify(stale)}\n`)
    const reclaims: string[] = []

    const lock = acquireDataDirLock({ dataDir: dir, log: (m) => reclaims.push(m) })

    const record = JSON.parse(readFileSync(lock.path, 'utf8')) as { pid: number }
    expect(record.pid).toBe(process.pid)
    // Reclaiming is silent success, but not SILENT silent: the log line is how an operator
    // later understands why a lock they saw in `ls` was gone.
    expect(reclaims.some((m) => m.includes('stale') && m.includes(String(stale.pid)))).toBe(true)
  })

  it('reclaims a lock file it cannot parse — garbage this module never wrote has no live holder', () => {
    writeFileSync(dataDirLockPath(dir), 'not json at all')

    const lock = acquireDataDirLock({ dataDir: dir })

    const record = JSON.parse(readFileSync(lock.path, 'utf8')) as { pid: number }
    expect(record.pid).toBe(process.pid)
  })

  it('release removes the lock, and is safe to call twice', () => {
    const lock = acquireDataDirLock({ dataDir: dir })

    lock.release()
    expect(existsSync(lock.path)).toBe(false)
    lock.release()

    // And the directory is immediately usable again, which is what the sequential test suites
    // that boot repeatedly over one temp directory depend on.
    const again = acquireDataDirLock({ dataDir: dir })
    expect(existsSync(again.path)).toBe(true)
  })

  it('release never deletes a lock this process no longer owns', () => {
    const lock = acquireDataDirLock({ dataDir: dir })
    // Another core reclaimed and re-took the lock (as it would after our SIGKILL). Simulated
    // by rewriting the file, because two live cores cannot hold it at once by construction.
    const other = { pid: deadPid(), hostname: 'other', startedAt: new Date().toISOString() }
    writeFileSync(lock.path, `${JSON.stringify(other)}\n`)

    lock.release()

    expect(existsSync(lock.path)).toBe(true)
    expect((JSON.parse(readFileSync(lock.path, 'utf8')) as { pid: number }).pid).toBe(other.pid)
  })
})
