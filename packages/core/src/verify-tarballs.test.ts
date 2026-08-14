import { describe, expect, it } from 'vitest'
// @ts-expect-error — a plain .mjs release script with no types, imported for its pure rule function.
import { checkTarball } from '../../../scripts/verify-tarballs.mjs'

/**
 * Proves `scripts/verify-tarballs.mjs` fails on the tarballs it exists to catch.
 *
 * Same argument as `npx-closure.test.ts`: a check nobody has watched fail is a check nobody
 * knows works — and this one guards a release, where the cost of a false clean is a published
 * version that cannot be unpublished. Two of the cases below are not hypothetical:
 *
 *  - the empty-`dist` tarball is what a concurrent build produced during the rockysurf-3hz9
 *    verification, and `pnpm pack` reported success for it;
 *  - the `private: true` manifest is rockysurf-3hz9 itself, where four of the CLI's five
 *    workspace dependencies were unpublishable and the CLI's own manifest looked perfectly fine.
 *
 * `checkTarball` is a pure function of (name, entry list, manifest), so every case here is a
 * literal rather than a fixture workspace someone has to keep in sync.
 *
 * PACKAGE NAMES ARE ASSEMBLED FROM FRAGMENTS for the reason the neighbouring test files give:
 * this file lives under `packages/core/src`, which `check-core-deps.mjs` walks, and a name that
 * is only ever a string today should not be one keystroke from becoming an import.
 */

const SDK = `@rockysurf/${'provider'}-sdk`

const goodEntries = [
  'package/package.json',
  'package/LICENSE',
  'package/README.md',
  'package/dist/index.js',
  'package/dist/index.d.ts',
  // Core's two GENERATED publishables. Both are produced by a build and both are listed in its
  // `files`, and npm does not complain when a `files` entry matches nothing — so a tarball
  // without them packs cleanly and ships a control plane with no UI and no official packs.
  'package/public/index.html',
  'package/public/assets/index-abc123.js',
  'package/packs/ai-coding-agents.yaml',
]

const goodManifest = {
  name: `@rockysurf/${'core'}`,
  version: '0.1.0',
  license: 'MIT',
  publishConfig: { access: 'public' },
  dependencies: { [SDK]: '0.1.0', zod: '^4.4.3' },
}

const details = (violations: Array<{ detail: string }>) => violations.map((v) => v.detail).join('\n')

describe('verify-tarballs', () => {
  it('passes a tarball that is actually publishable', () => {
    expect(checkTarball(goodManifest.name, goodEntries, goodManifest)).toEqual([])
  })

  it('fails the three-file tarball a cleaned dist produces', () => {
    const entries = ['package/package.json', 'package/LICENSE', 'package/README.md']
    const violations = checkTarball(goodManifest.name, entries, goodManifest)

    // The point of the case: pack succeeds, the manifest is correct, and the package is empty.
    expect(details(violations)).toContain('no dist/')
  })

  it('fails a core with no SPA — a control plane that serves no web UI', () => {
    // The shape this catches: a release built with a filtered `pnpm --filter … build` that never
    // built `@rockysurf/web`, so `sync-web-bundle.mjs` never ran and `public/` is absent. npm
    // packs it happily, and it looks like a normal release until somebody opens a browser.
    const entries = goodEntries.filter((e) => !e.startsWith('package/public/'))
    expect(details(checkTarball(goodManifest.name, entries, goodManifest))).toContain('serves no web UI')
  })

  it('fails a core with no packs — a release for which "official" would mean nothing', () => {
    // ADR-0006 leans on "official means shipped with the release you are running". A release
    // that ships none cannot honour that sentence, and rockysurf-io02 is the bug where it did
    // not — invisible then, and asserted here now.
    const entries = goodEntries.filter((e) => !e.startsWith('package/packs/'))
    expect(details(checkTarball(goodManifest.name, entries, goodManifest))).toContain('no packs/*.yaml')
  })

  it('does not demand core’s generated directories of every other package', () => {
    // They are core's alone. A provider with no `public/` is not broken, and a rule that said
    // otherwise would fail eight packages to catch one.
    const entries = goodEntries.filter((e) => !e.startsWith('package/public/') && !e.startsWith('package/packs/'))
    expect(checkTarball(SDK, entries, { ...goodManifest, name: SDK })).toEqual([])
  })

  it('fails a tarball packed by npm rather than pnpm, which loses the license text', () => {
    const entries = goodEntries.filter((e) => e !== 'package/LICENSE')
    expect(details(checkTarball(goodManifest.name, entries, goodManifest))).toContain('no LICENSE')
  })

  it('fails a manifest that is still private', () => {
    const violations = checkTarball(goodManifest.name, goodEntries, { ...goodManifest, private: true })
    expect(details(violations)).toContain('`private: true` survived')
  })

  it('fails a scoped package npm would publish restricted', () => {
    const { publishConfig: _dropped, ...noAccess } = goodManifest
    expect(details(checkTarball(noAccess.name, goodEntries, noAccess))).toContain('restricted')
  })

  it('accepts an unscoped package without publishConfig, where public is the default', () => {
    const { publishConfig: _dropped, ...noAccess } = goodManifest
    expect(checkTarball('rockysurf', goodEntries, { ...noAccess, name: 'rockysurf' })).toEqual([])
  })

  it('fails a workspace specifier that survived the publish rewrite', () => {
    const manifest = { ...goodManifest, dependencies: { [SDK]: 'workspace:*' } }
    expect(details(checkTarball(manifest.name, goodEntries, manifest))).toContain('workspace:')
  })

  it('fails sources, tests, tsconfigs and vendored modules', () => {
    const entries = [
      ...goodEntries,
      'package/src/index.ts',
      'package/dist/index.test.js',
      'package/tsconfig.build.json',
      'package/node_modules/left-pad/index.js',
    ]
    const report = details(checkTarball(goodManifest.name, entries, goodManifest))

    expect(report).toContain('source file')
    expect(report).toContain('test file')
    expect(report).toContain('tsconfig')
    expect(report).toContain('node_modules')
  })

  /**
   * A MAP WITHOUT ITS SOURCES (rockysurf-sxbm).
   *
   * The same rule as the `src/` ban above, from the other end: a tarball ships `dist` and not
   * `src`, so every map's `sources: ["../src/*.ts"]` resolves to nothing on a consumer's disk
   * and their stack traces name files they do not have. Seven packages shipped them — including
   * `core`, at 55% of its unpacked size, on every `npx rockysurf`.
   */
  it('fails a tarball carrying source maps, which point at sources it does not ship', () => {
    const entries = [...goodEntries, 'package/dist/index.js.map', 'package/dist/index.d.ts.map']
    const report = details(checkTarball(goodManifest.name, entries, goodManifest))
    expect(report).toContain('source map')
    // Both kinds, because `declarationMap` and `sourceMap` are separate settings and a package
    // that turned off only one would still ship the other.
    expect(report.match(/source map/g)).toHaveLength(2)
  })

  it('fails a manifest with no license field, since the file alone is not the claim', () => {
    const { license: _dropped, ...noLicense } = goodManifest
    expect(details(checkTarball(noLicense.name, goodEntries, noLicense))).toContain('no `license` field')
  })
})
