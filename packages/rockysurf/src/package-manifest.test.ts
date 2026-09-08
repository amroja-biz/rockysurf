import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
) as Record<string, unknown>

/**
 * Issue #470. `npx -y rockysurf` on a machine running Node 20 did not print the "needs Node 24"
 * message from bin.ts; it ran `rockysurf@0.0.1`, the empty name-claiming placeholder, and died
 * with "could not determine executable to run". npm's version picker skips every version whose
 * `engines.node` the running Node fails and falls back to the newest one that passes, and the
 * placeholder declares none. So on THIS package an `engines` field does not warn old-Node users;
 * it hides the version that would have. The runtime check in bin.ts is the guard, and the
 * workspace root's `engines` still covers contributors.
 */
describe('the rockysurf package manifest', () => {
  it('declares no engines field, so npx always resolves latest and bin.ts explains old Node', () => {
    expect(manifest).not.toHaveProperty('engines')
  })

  it('still ships the bin that npx runs', () => {
    expect(manifest.bin).toEqual({ rockysurf: './dist/bin.js' })
  })
})
