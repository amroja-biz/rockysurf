import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createConfigStore, PINNED_PATHS, readLive } from './live-config.js'
import { configSchema, type Config } from './schema.js'

/**
 * THE CONFIG STORE (issue #264).
 *
 * What these cases are about is not "does it parse YAML" — `config/load.ts` owns that and is
 * tested at length. They are about the four promises the store makes to everything reading
 * through it: that an adoption is whole, that a file it cannot use changes nothing, that the
 * facts about the running process survive whatever the file says, and that the things BUILT
 * from config hear about it.
 */

let dir: string
let configPath: string

const booted: Config = configSchema.parse({ server: { port: 3000 }, limits: { maxServers: 5 } })

const write = (text: string) => writeFileSync(configPath, text)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rockysurf-live-config-'))
  configPath = join(dir, 'rockysurf.config.yaml')
  write('limits:\n  maxServers: 5\n')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const store = (env: NodeJS.ProcessEnv = {}) => createConfigStore({ booted, configPath, env })

describe('adopting the file', () => {
  it('serves the booted config until something asks it to reload', () => {
    const s = store()
    write('limits:\n  maxServers: 40\n')
    expect(s.current().limits.maxServers).toBe(5)
    expect(s.reload().applied).toBe(true)
    expect(s.current().limits.maxServers).toBe(40)
  })

  it('swaps the whole config at once, never half of it', () => {
    const s = store()
    const before = s.current()
    write('limits:\n  maxServers: 40\n  createRatePerHour: 2\n')
    s.reload()
    // The object identity changes; the one the caller was holding is unchanged, so a request
    // that read the config a moment ago cannot see a mixture of the two.
    expect(s.current()).not.toBe(before)
    expect(before.limits.maxServers).toBe(5)
    expect(s.current().limits.createRatePerHour).toBe(2)
  })

  it('keeps what it had when the file will not validate, and says what is wrong', () => {
    const s = store()
    write('limits:\n  maxServers: "not a number"\n')
    const outcome = s.reload()
    expect(outcome.applied).toBe(false)
    expect(outcome.blocked).toContain('limits.maxServers')
    expect(s.current().limits.maxServers).toBe(5)
  })

  it('keeps what it had when the file is not YAML at all', () => {
    const s = store()
    write('limits:\n\tmaxServers: 5\n  broken: [')
    expect(s.reload().applied).toBe(false)
    expect(s.current().limits.maxServers).toBe(5)
  })

  /**
   * The `rockysurf-1z5q` case, which is the ordinary one immediately after a save: the operator
   * typed a variable NAME and cannot export it into a process that is already running. The file
   * is written, and its values are not knowable — so there is nothing to adopt, and the sentence
   * has to name the variable rather than say "invalid".
   */
  it('will not adopt a file that names a variable this process cannot see', () => {
    const s = store()
    write('providers:\n  hetzner:\n    enabled: true\n    token: "${NOT_EXPORTED}"\n')
    const outcome = s.reload()
    expect(outcome.applied).toBe(false)
    expect(outcome.blocked).toContain('NOT_EXPORTED')
    expect(s.current().providers.hetzner.enabled).toBe(false)
  })

  it('adopts the same file once the variable is exported', () => {
    const s = store({ NOT_EXPORTED: 'hcloud-value' })
    write('providers:\n  hetzner:\n    enabled: true\n    token: "${NOT_EXPORTED}"\n')
    expect(s.reload().applied).toBe(true)
    expect(s.current().providers.hetzner.token).toBe('hcloud-value')
  })

  it('changes nothing when the file has been deleted, and says so', () => {
    const s = store()
    rmSync(configPath)
    const outcome = s.reload()
    expect(outcome.applied).toBe(false)
    expect(outcome.blocked).toContain('does not exist')
    expect(s.current().limits.maxServers).toBe(5)
  })

  it('is a constant when there is no file to re-read at all', () => {
    const s = createConfigStore({ booted })
    const outcome = s.reload()
    expect(outcome.applied).toBe(false)
    expect(outcome.blocked).toContain('nothing to re-read')
    expect(s.current()).toBe(booted)
  })
})

/**
 * THE FACTS ABOUT THIS PROCESS OUTLIVE THE FILE. A listener that is bound, a database that is
 * open and a login mode every live session was issued by are not opinions the file gets to
 * revise while core runs — `PINNED_PATHS`, and `settings/fields.test.ts` holds the settings page
 * to saying so about each of them.
 */
describe('the pinned running facts', () => {
  it('keeps the booted port, host, data directory and auth mode', () => {
    const s = store()
    write(
      ['server:', '  port: 9999', '  host: 0.0.0.0', '  dataDir: /somewhere/else', 'auth:', '  mode: local', ''].join(
        '\n',
      ),
    )
    expect(s.reload().applied).toBe(true)
    expect(s.current().server.port).toBe(booted.server.port)
    expect(s.current().server.host).toBe(booted.server.host)
    expect(s.current().server.dataDir).toBe(booted.server.dataDir)
    expect(s.current().auth.mode).toBe(booted.auth.mode)
  })

  it('adopts everything else in the same block', () => {
    const s = store()
    write('server:\n  port: 9999\n  publicUrl: https://rocky.example\n')
    s.reload()
    expect(s.current().server.publicUrl).toBe('https://rocky.example')
    expect(s.current().server.port).toBe(booted.server.port)
  })

  it('names four paths, and only paths the schema actually has', () => {
    expect([...PINNED_PATHS]).toEqual(['server.port', 'server.host', 'server.dataDir', 'auth.mode'])
    for (const path of PINNED_PATHS) {
      let node: unknown = booted
      for (const segment of path.split('.')) node = (node as Record<string, unknown>)[segment]
      expect(node, path).toBeDefined()
    }
  })
})

describe('telling the things that were built from it', () => {
  it('calls a listener with the new config and the one it replaced', () => {
    const s = store()
    const seen: [number, number][] = []
    s.onChange((next, previous) => seen.push([previous.limits.maxServers, next.limits.maxServers]))
    write('limits:\n  maxServers: 11\n')
    s.reload()
    expect(seen).toEqual([[5, 11]])
  })

  it('does not call one for a reload it could not apply', () => {
    const s = store()
    let calls = 0
    s.onChange(() => (calls += 1))
    write('limits:\n  maxServers: "nope"\n')
    s.reload()
    expect(calls).toBe(0)
  })

  it('stops calling one that has unsubscribed', () => {
    const s = store()
    let calls = 0
    const off = s.onChange(() => (calls += 1))
    write('limits:\n  maxServers: 11\n')
    s.reload()
    off()
    write('limits:\n  maxServers: 12\n')
    s.reload()
    expect(calls).toBe(1)
  })
})

describe('readLive', () => {
  it('passes a plain value straight through, which is what keeps old callers working', () => {
    expect(readLive({ maxServers: 3 })).toEqual({ maxServers: 3 })
  })

  it('calls a function every time, rather than resolving it once', () => {
    let n = 0
    const live = () => ({ maxServers: (n += 1) })
    expect(readLive(live).maxServers).toBe(1)
    expect(readLive(live).maxServers).toBe(2)
  })
})
