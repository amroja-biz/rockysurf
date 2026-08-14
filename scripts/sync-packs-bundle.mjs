#!/usr/bin/env node
/**
 * Copy the repository's `packs/` into `packages/core/packs`, so the published package ships them
 * (rockysurf-io02).
 *
 * WHY THIS EXISTS. Neither `rockysurf` nor `@rockysurf/core` listed `packs` in its `files`, so a
 * published install contained no pack files at all: `resolvePacksDir` found no checkout, fell
 * through to an empty `<dataDir>/packs`, and a fresh `npx rockysurf` rendered "No Surge Packs are
 * available yet" on the first screen after the wizard. The boot logic was right — a boot with
 * nothing to compare against deletes nothing (rockysurf-96ce) — the gap was packaging.
 *
 * It matters more than a missing default now that the pack shop exists. The owner's ruling on
 * issue #9 defines an OFFICIAL pack as one shipped with the release you are running, and a
 * release that ships none cannot honour that definition. The registry is community packs only,
 * so nothing else would ever supply them.
 *
 * SECOND CONSUMER: the shop's CI. A community pack references the shared base toolchain by tool
 * id, and `amroja-biz/rockysurf-shop` does not contain it, so its checks have to point
 * `--base-packs` at those definitions. Today that means cloning this repository; once the packs
 * are in the tarball, `rockysurf pack lint` reads them out of the version the shop already pins.
 * Better pinned than tracking a branch, and it drops the shop's only coupling to this repo's main.
 *
 * SAME SHAPE AS `sync-web-bundle.mjs`, and for the same two reasons: the copy belongs in the
 * build rather than in a release runbook somebody performs by hand, and it lands by rename rather
 * than in place so a reader of `packages/core/packs` sees the whole old set or the whole new one.
 *
 * Usage: node ../../scripts/sync-packs-bundle.mjs   — cwd is packages/core, as pnpm runs it.
 */
import { cpSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const coreDir = process.cwd()
const source = join(coreDir, '..', '..', 'packs')
const target = join(coreDir, 'packs')
const staging = `${target}.build`
const previous = `${target}.prev`

if (!existsSync(source)) {
  console.error(`sync-packs-bundle: no packs to copy — ${source} does not exist`)
  process.exit(1)
}

// An empty source would publish a package whose pack directory exists and holds nothing, which
// `resolvePacksDir` reads as "this installation ships no packs" — the bug this script exists to
// fix, arriving through the fix. Better to fail the build.
const packFiles = readdirSync(source).filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
if (packFiles.length === 0) {
  console.error(`sync-packs-bundle: ${source} holds no pack files — refusing to publish an empty set`)
  process.exit(1)
}

const discard = (path) => rmSync(path, { recursive: true, force: true })
discard(staging)
discard(previous)

// Only the pack files. `packs/README.md` is for someone reading the repository and has no
// business in a runtime directory the loader scans.
cpSync(source, staging, {
  recursive: true,
  filter: (path) => path === source || path.endsWith('.yaml') || path.endsWith('.yml'),
})
if (existsSync(target)) renameSync(target, previous)
renameSync(staging, target)
discard(previous)

console.error(`packs bundle: ${packFiles.length} pack file(s) into ${target}`)
