/**
 * The one place the public addresses are written.
 *
 * The launch runbook (rockysurf-ftl9.8) re-cuts history into `amroja-biz/rockysurf` and that
 * repo goes public at v0.1.0 — so the UI links there, not at the private dev archive. If either
 * repo ever moves, this file is the whole change.
 */
export const GITHUB_URL = 'https://github.com/amroja-biz/rockysurf'

/** Community Surge Packs. Official packs live in this repository and ship with a release. */
export const SHOP_URL = 'https://github.com/amroja-biz/rockysurf-shop'

/**
 * The same repository's provider listing (issue #394). Rocky Surf links at it rather than
 * listing or installing providers itself: installing one is a command-line step, and what the
 * app owns is the configuration afterwards.
 */
export const SHOP_PROVIDERS_URL = `${SHOP_URL}#providers`

/** A file in the repository, by its in-tree path — for linking the normative docs. */
export function repoDocUrl(path: string): string {
  return `${GITHUB_URL}/blob/main/${path}`
}
