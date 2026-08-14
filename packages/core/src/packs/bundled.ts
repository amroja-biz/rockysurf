import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The pack files this release ships (rockysurf-io02).
 *
 * `packages/core/packs` is produced by this package's own build, which copies the repository's
 * root `packs/` into it (`scripts/sync-packs-bundle.mjs`), and it is listed in `files` so the
 * published tarball carries it. It is gitignored: the source of truth is still `packs/` at the
 * repository root, exactly as ADR-0004 says.
 *
 * WHY THE PACKAGE SHIPS THEM AT ALL. It did not, and a fresh `npx rockysurf` therefore had an
 * empty pack picker on the first screen after the wizard. That became load-bearing rather than
 * merely embarrassing once the pack shop existed: the owner's ruling on issue #9 defines an
 * OFFICIAL pack as one shipped with the release you are running, the registry is community packs
 * only, and so a release that ships none can never have an official pack at all.
 *
 * `../../packs` resolves identically from `src/packs/` and from `dist/packs/`, because both sit
 * two levels below the package root — the same trick `AGENT_SCRIPT_PATH` uses one level up, and
 * the reason the depth is spelled out here is that getting it wrong yields `dist/packs`, a
 * directory that plausibly exists and never contains a pack. In a checkout that has not been
 * built the directory is simply absent, and every caller treats that as empty.
 */
export const BUNDLED_PACKS_DIR = fileURLToPath(new URL('../../packs', import.meta.url))

/**
 * The bundled directory, or `undefined` when this installation has none.
 *
 * Callers that want a base toolchain to resolve references against — `rockysurf pack lint` and
 * friends — need to tell "the packs are over there" from "there are no packs", and an absent
 * directory is not an error for either of them. Returning `undefined` rather than a path that
 * does not exist is what keeps a caller from passing a phantom directory to the loader and
 * getting a silent empty set back.
 */
export function bundledPacksDir(): string | undefined {
  try {
    const hasPacks = readdirSync(BUNDLED_PACKS_DIR).some((n) => n.endsWith('.yaml') || n.endsWith('.yml'))
    return hasPacks ? BUNDLED_PACKS_DIR : undefined
  } catch {
    return undefined
  }
}
