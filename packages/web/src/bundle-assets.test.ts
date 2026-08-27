import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The bundle actually carries its styles, and the copy of it that core serves is this one.
 *
 * WHY THIS TEST EXISTS. Every component test in this package passed while the shipped app had
 * no CSS at all (rockysurf-a29w): the 4d port carried the markup and left `App.css` behind, and
 * a test that renders a component and reads its text cannot tell a styled page from an unstyled
 * one. The owner found it by opening a browser. This is the cheap structural guard for that
 * class of bug — not "does it look right", which needs eyes, but "did the stylesheet make it
 * into the build, and into the directory core serves from", which is a file that either exists
 * or does not.
 *
 * It also pins the second half of the same bug: nothing in the build chain copied
 * `packages/web/dist` into `packages/core/public`, so the served bundle was a hand-copy from
 * whenever somebody last ran `cp` — the styles could be in `dist` and still not be in the app.
 * `scripts/sync-web-bundle.mjs` does that copy now, and the identity assertions below are what
 * would notice if it stopped.
 *
 * These assertions read build OUTPUT, so `pnpm --filter @rockysurf/web build` has to have run.
 * CI runs `pnpm -r build` before `pnpm -r test` for exactly this reason. Missing output fails
 * loudly rather than skipping: a guard that quietly opts out when the thing it guards is absent
 * is how the original bug survived a green suite.
 */

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(webDir, 'dist')
const publicDir = join(webDir, '..', 'core', 'public')

const BUILD_FIRST = 'Run `pnpm --filter @rockysurf/web build` first — this suite reads build output.'

function readIndex(dir: string, what: string): string {
  const index = join(dir, 'index.html')
  if (!existsSync(index)) throw new Error(`${what} has no index.html at ${index}. ${BUILD_FIRST}`)
  return readFileSync(index, 'utf8')
}

/** Every stylesheet the document links, as paths relative to the document. */
function stylesheetHrefs(html: string): string[] {
  return [...html.matchAll(/<link\b[^>]*>/gi)]
    .filter((tag) => /rel\s*=\s*["']stylesheet["']/i.test(tag[0]))
    .map((tag) => /href\s*=\s*["']([^"']+)["']/i.exec(tag[0])?.[1])
    .filter((href): href is string => href !== undefined)
}

describe('the built bundle', () => {
  it('links at least one stylesheet from index.html', () => {
    // The exact assertion the shipped-unstyled bug would have failed: vite emits a CSS asset
    // only if something in the graph imports one, so an empty list means no styles shipped.
    expect(stylesheetHrefs(readIndex(distDir, 'the web build'))).not.toHaveLength(0)
  })

  it('ships the linked stylesheet as a real, non-empty asset', () => {
    const [href] = stylesheetHrefs(readIndex(distDir, 'the web build'))
    const asset = join(distDir, href!)
    expect(existsSync(asset), `${href} is linked but missing from dist`).toBe(true)
    // A stylesheet that exists but is a few bytes long is the same bug wearing a hat: it means
    // the import resolved to nothing rather than to the app's styles.
    expect(statSync(asset).size).toBeGreaterThan(1000)
  })

  it('references its assets by absolute path, so client-side routes can load them', () => {
    // The bug this pins (found verifying rockysurf-a29w): with `base: './'`, a reload of
    // `/servers/new` gets index.html, resolves `./assets/index-x.css` against `/servers/`, and
    // asks for a file that does not exist — which the SPA fallback answers with index.html, so
    // the browser gets text/html where it wanted CSS and JS and renders a blank white page.
    // Only single-segment routes were unaffected, which is why `/` and `/login` looked fine.
    const html = readIndex(distDir, 'the web build')
    const refs = [...stylesheetHrefs(html), ...[...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!)]
    expect(refs.length).toBeGreaterThan(1)
    for (const ref of refs) expect(ref, `${ref} is not root-absolute`).toMatch(/^\//)
  })

  it('carries the app palette rather than some empty shell of a stylesheet', () => {
    const [href] = stylesheetHrefs(readIndex(distDir, 'the web build'))
    const css = readFileSync(join(distDir, href!), 'utf8')
    // The page background from the legacy design. If this is gone, whatever shipped is not
    // the ported stylesheet.
    expect(css).toContain('#0d1117')
  })
})

describe('the Surge Pack images', () => {
  /**
   * The pack cards point `imageUrl` at a path this bundle is supposed to carry, and the two
   * halves live in different trees: the value is in `packs/*.yaml`, the file is in
   * `packages/web/public`. Nothing else connects them, so a renamed PNG or a typo'd path is a
   * broken image in the product and a green test suite everywhere — the a29w failure mode
   * wearing different clothes. This reads the YAML and asks for the file.
   *
   * Only paths that look bundled are checked. A third-party pack pointing `imageUrl` at
   * `https://…` is legitimate and not this test's business.
   */
  const packsDir = join(webDir, '..', '..', 'packs')
  const packFiles = readdirSync(packsDir).filter((name: string) => name.endsWith('.yaml'))
  const bundledImageUrls: Array<[string, string]> = packFiles.flatMap((name: string) => {
    const url = /^\s*imageUrl:\s*(\S+)\s*$/m.exec(readFileSync(join(packsDir, name), 'utf8'))?.[1]
    return url?.startsWith('/') ? [[name, url] as [string, string]] : []
  })

  /**
   * The pack files this repository ships with a bundled card image, pinned by name so that
   * dropping one fails here. NOT counted from the directory: `imageUrl` is optional in
   * `schema.ts` and in `docs/writing-a-pack.md`, so requiring one per file made a contributed
   * pack fail a test about our own cards (rockysurf-d5an). Adding a pack file changes nothing
   * about this list.
   */
  const SHIPPED_WITH_IMAGES = [
    'ai-coding-agents.yaml',
    'amp-agents.yaml',
    'codex-cli.yaml',
    'cursor-cli.yaml',
    'deepseek-harness.yaml',
    'gas-town.yaml',
    'grok-build.yaml',
    'omp.yaml',
    'open-claw.yaml',
    'open-code.yaml',
  ]

  it('every pack this repository ships names one', () => {
    // A pack card with no image is the thing di5z existed to fix, and these ten are the cards
    // this repository is responsible for.
    expect(packFiles).toEqual(expect.arrayContaining(SHIPPED_WITH_IMAGES))
    expect(bundledImageUrls.map(([name]) => name)).toEqual(expect.arrayContaining(SHIPPED_WITH_IMAGES))
  })

  it.each(bundledImageUrls)('%s: %s is in the build and in the bundle core serves', (_pack, url) => {
    for (const [dir, what] of [
      [distDir, 'the web build'],
      [publicDir, 'packages/core/public'],
    ] as const) {
      const asset = join(dir, url)
      expect(existsSync(asset), `${url} is missing from ${what}. ${BUILD_FIRST}`).toBe(true)
      expect(statSync(asset).size).toBeGreaterThan(0)
    }
  })

  it('stays small enough that the SPA is not shipping megabytes of PNG', () => {
    // The originals were 0.9–6 MB each. They are downscaled to 256px and palette-quantised;
    // this is the guard that keeps somebody from dropping a full-size export back in.
    const total = bundledImageUrls.reduce((sum: number, [, url]) => sum + statSync(join(distDir, url)).size, 0)
    expect(total).toBeLessThan(512 * 1024)
  })
})

describe('the home hero (rockysurf-n0zr)', () => {
  // HomePage points its hero at this path the same way pack cards point at theirs: the value
  // is in a component, the file is in `public/`, and nothing else connects them.
  const HERO = 'images/logo.png'

  it('is in the build and in the bundle core serves', () => {
    for (const [dir, what] of [
      [distDir, 'the web build'],
      [publicDir, 'packages/core/public'],
    ] as const) {
      const asset = join(dir, HERO)
      expect(existsSync(asset), `${HERO} is missing from ${what}. ${BUILD_FIRST}`).toBe(true)
      expect(statSync(asset).size).toBeGreaterThan(0)
    }
  })

  it('is the quantised export, not a full-size original', () => {
    // docs/media/logo.png is already downscaled and palette-quantised (~370KB). The README's
    // original-asset history says originals ran to megabytes; this keeps one from landing here.
    expect(statSync(join(distDir, HERO)).size).toBeLessThan(400 * 1024)
  })
})

describe('the bundle core serves', () => {
  it('is the build that was just produced, not an older hand-copy', () => {
    // Byte identity, because the failure being guarded against is a STALE public/: a copy made
    // by hand months ago serves perfectly and silently disagrees with the source tree.
    expect(readIndex(publicDir, 'packages/core/public')).toBe(readIndex(distDir, 'the web build'))
  })

  it('contains the stylesheet that index.html links', () => {
    const [href] = stylesheetHrefs(readIndex(publicDir, 'packages/core/public'))
    expect(href, 'core/public/index.html links no stylesheet').toBeDefined()
    const served = join(publicDir, href!)
    expect(existsSync(served), `${href} is linked but missing from core/public`).toBe(true)
    expect(readFileSync(served)).toEqual(readFileSync(join(distDir, href!)))
  })
})
