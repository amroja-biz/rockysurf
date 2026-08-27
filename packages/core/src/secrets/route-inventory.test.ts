import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The custody rule, enforced rather than documented: **no HTTP route may return decrypted
 * secret material.**
 *
 * There are no routes in core yet — the Hono app lands later in Milestone 4a — so today this
 * test mostly guards the future. It is written against the source tree rather than against a
 * running app precisely so that it starts failing the moment someone adds a handler that
 * reaches for plaintext, instead of passing quietly until someone remembers to extend it.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url))

/** Anything that reads a decrypted value. Metadata accessors are deliberately absent. */
const PLAINTEXT_ACCESSORS = [
  'getSecret',
  'requireSecret',
  'getServerKeyMaterial',
  'getGithubToken',
  'getRdpPassword',
  'getPackInputSecrets',
  'getServerEnvironmentSecrets',
  'getProviderToken',
  'ensureSessionSigningKey',
]

/** How a Hono route registration looks, whatever the app variable is called. */
const ROUTE_PATTERN = /\b[a-zA-Z_$][\w$]*\.(get|post|put|patch|delete|all|on)\s*\(\s*['"`]/

/**
 * THE EXEMPTION LIST. One entry, and adding a second one is a decision, not a formality.
 *
 * `ssh/routes.ts` is the private-key download: the operator has to be able to get the key for
 * a server they own, so exactly one route in this codebase returns decrypted material. It is
 * listed here — an allowlist with a reason — rather than by loosening the pattern above,
 * because the point of this test is that every OTHER route still fails it. A relaxed rule
 * would protect nothing; a named exemption protects everything except the file it names.
 *
 * What earns an entry: a route whose entire purpose is handing custody of a secret to the
 * human who owns it, that authenticates and authorizes before doing so, and that audits the
 * handover. `ssh/routes.ts` does all three — see its header comment.
 */
const PLAINTEXT_ROUTE_EXEMPTIONS = [join('ssh', 'routes.ts')]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return []
    return [full]
  })
}

describe('custody rule', () => {
  const files = sourceFiles(SRC).map((path) => ({ path, text: readFileSync(path, 'utf8') }))

  it('finds the source tree, so an empty glob cannot make this vacuous', () => {
    expect(files.length).toBeGreaterThan(5)
    expect(files.some((f) => f.path.endsWith(join('secrets', 'store.ts')))).toBe(true)
  })

  it('the exemption list names files that exist and really do define routes', () => {
    // An exemption for a file that has been renamed or deleted is a hole nobody notices.
    for (const exempt of PLAINTEXT_ROUTE_EXEMPTIONS) {
      const file = files.find((f) => f.path.endsWith(exempt))
      expect(file, `exempted file ${exempt} no longer exists`).toBeDefined()
      expect(ROUTE_PATTERN.test(file!.text), `${exempt} is exempted but defines no routes`).toBe(true)
    }
  })

  it('no file that defines HTTP routes reads plaintext secrets', () => {
    const routeFiles = files
      .filter((f) => ROUTE_PATTERN.test(f.text))
      .filter((f) => !PLAINTEXT_ROUTE_EXEMPTIONS.some((exempt) => f.path.endsWith(exempt)))
    const offenders = routeFiles.flatMap((f) => {
      const used = PLAINTEXT_ACCESSORS.filter((accessor) => new RegExp(`\\b${accessor}\\s*\\(`).test(f.text))
      return used.length > 0 ? [`${f.path}: ${used.join(', ')}`] : []
    })

    expect(
      offenders,
      'HTTP handlers must never decrypt secrets. Pass the secret to the SSH/git/provider client ' +
        'instead, or return metadata from listSecretRefs.',
    ).toEqual([])
  })

  it('the store exposes exactly one listing, and it returns metadata', () => {
    const store = files.find((f) => f.path.endsWith(join('secrets', 'store.ts')))
    expect(store).toBeDefined()
    // A `listSecrets` returning values is the shape this rule exists to prevent.
    expect(store?.text).toContain('listSecretRefs')
    expect(store?.text).not.toMatch(/\blistSecrets\s*\(/)
  })

  it('plaintext accessors are marked at their declaration', () => {
    const store = readFileSync(join(SRC, 'secrets', 'store.ts'), 'utf8')
    // The interface carries the warning where an implementer will actually read it.
    expect(store).toMatch(/PLAINTEXT[\s\S]*getSecret/)
    expect(store).toMatch(/PLAINTEXT[\s\S]*requireSecret/)
  })
})
