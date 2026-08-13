/**
 * The one place the repository's public address is written.
 *
 * The launch runbook (rockysurf-ftl9.8) re-cuts history into `amroja-biz/rockysurf` and that
 * repo goes public at v0.1.0 — so the UI links there, not at the private dev archive. If the
 * launch repo ever moves, this file is the whole change.
 */
export const GITHUB_URL = 'https://github.com/amroja-biz/rockysurf'

/** A file in the repository, by its in-tree path — for linking the normative docs. */
export function repoDocUrl(path: string): string {
  return `${GITHUB_URL}/blob/main/${path}`
}
