import { mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configSchema, createPreferenceReader } from './index.js'

/**
 * THE ONE BLOCK THAT IS RE-READ WHILE ROCKY SURF IS RUNNING (issue #124).
 *
 * The behaviour these pin is the difference between the feature working and not working. A
 * saved type is a note the user leaves themselves on the New Server page; if it needed the
 * control plane restarted before it applied, the "make this my default" button would be a
 * button that appears to do nothing, and the issue's own words — "the same types appear every
 * time" — would be false until someone bounced the process.
 *
 * The other half is that a re-read must never turn a broken file into a failed create. Every
 * bad-file case below falls back to what this process booted with, which is what the rest of
 * core is already using; reporting a broken file stays the boot path's job.
 */

const BOOTED = configSchema.parse({
  preferences: { tiers: { aws: { small: 'booted-type' } } },
}).preferences

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rockysurf-prefs-'))
  path = join(dir, 'rockysurf.config.yaml')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Write the file, then push its mtime forward.
 *
 * The reader caches on mtime, and two writes inside the same filesystem timestamp tick would be
 * indistinguishable — so a test that did not do this could pass for a reader that never
 * re-reads anything, which is precisely the defect these tests exist to catch. Counting up
 * rather than using the clock keeps each write strictly newer than the last.
 */
let tick = 0
function write(text: string): void {
  writeFileSync(path, text)
  const stamp = new Date(Date.now() + ++tick * 1000)
  utimesSync(path, stamp, stamp)
}

describe('a saved type is read from the file, not from the boot snapshot', () => {
  it('reads what the file says now', () => {
    write('preferences:\n  tiers:\n    aws:\n      small: from-the-file\n')
    const read = createPreferenceReader({ configPath: path, booted: BOOTED })
    expect(read('aws', 'small')).toBe('from-the-file')
  })

  it('picks up a change made after this process started', () => {
    write('preferences:\n  tiers:\n    aws:\n      small: first\n')
    const read = createPreferenceReader({ configPath: path, booted: BOOTED })
    expect(read('aws', 'small')).toBe('first')

    // THE POINT OF THE WHOLE MODULE. Saving from the New Server page writes this file; the very
    // next create has to use it, on every surface, without a restart.
    write('preferences:\n  tiers:\n    aws:\n      small: second\n')
    expect(read('aws', 'small')).toBe('second')
  })

  it('notices a preference being cleared, not only changed', () => {
    write('preferences:\n  tiers:\n    aws:\n      small: first\n')
    const read = createPreferenceReader({ configPath: path, booted: BOOTED })
    expect(read('aws', 'small')).toBe('first')

    write('server:\n  port: 3000\n')
    expect(read('aws', 'small')).toBeUndefined()
  })

  it('answers undefined for a size and a cloud with nothing saved', () => {
    write('preferences:\n  tiers:\n    aws:\n      small: only-small\n')
    const read = createPreferenceReader({ configPath: path, booted: BOOTED })
    expect(read('aws', 'large')).toBeUndefined()
    expect(read('gcp', 'small')).toBeUndefined()
  })
})

describe('a file it cannot use falls back to what this process booted with', () => {
  it('falls back when the file is not valid YAML', () => {
    write('preferences: [this is not\n  a mapping\n')
    const read = createPreferenceReader({ configPath: path, booted: BOOTED })
    expect(read('aws', 'small')).toBe('booted-type')
  })

  it('falls back when the preferences block itself is wrong', () => {
    // A number where a machine type belongs. The block is judged on its own terms, and a block
    // that fails is worth nothing — but it is not worth a failed create either.
    write('preferences:\n  tiers:\n    aws:\n      small: [1, 2]\n')
    const read = createPreferenceReader({ configPath: path, booted: BOOTED })
    expect(read('aws', 'small')).toBe('booted-type')
  })

  it('keeps the saved types when some OTHER section of the file is broken', () => {
    // The case that decides between validating this block alone and validating the whole file:
    // an operator mid-repair of `providers.aws` must not also lose the preference they saved an
    // hour ago, because nothing about it depends on the section they are fixing.
    write('providers:\n  aws:\n    region: 12345\n    enabled: "yes please"\npreferences:\n  tiers:\n    aws:\n      small: survives\n')
    const read = createPreferenceReader({ configPath: path, booted: BOOTED })
    expect(read('aws', 'small')).toBe('survives')
  })

  it('falls back when the file has been deleted', () => {
    write('preferences:\n  tiers:\n    aws:\n      small: here-for-now\n')
    const read = createPreferenceReader({ configPath: path, booted: BOOTED })
    expect(read('aws', 'small')).toBe('here-for-now')
    unlinkSync(path)
    expect(read('aws', 'small')).toBe('booted-type')
  })

  it('uses the booted value when there is no config path at all', () => {
    // An embedded core, and every test that does not care. Nothing to re-read, so nothing is.
    const read = createPreferenceReader({ booted: BOOTED })
    expect(read('aws', 'small')).toBe('booted-type')
  })
})
