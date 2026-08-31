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

/** A file in the repository, by its in-tree path — for linking the normative docs. */
export function repoDocUrl(path: string): string {
  return `${GITHUB_URL}/blob/main/${path}`
}
