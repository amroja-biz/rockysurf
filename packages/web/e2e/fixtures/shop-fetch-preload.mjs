/**
 * A FIXTURE REGISTRY, ANSWERED FROM INSIDE THE CONTROL PLANE'S OWN PROCESS (issue #426).
 *
 * Loaded into the Rocky Surf binary with `node --import` by `control-plane.ts` when a browser
 * test asks for a registry. It replaces `globalThis.fetch` with one that answers requests under
 * ONE origin — `ROCKYSURF_UI_SHOP_ORIGIN`, e.g. `https://203.0.113.10/shop` — from files under
 * `ROCKYSURF_UI_SHOP_DIR`, and hands everything else to the real fetch untouched.
 *
 * WHY NOT A LOCAL HTTP SERVER. Every registry fetch the control plane makes goes through the SSRF
 * guard in `packages/core/src/packs/safe-fetch.ts`, which refuses any host resolving to a loopback
 * or private address — by design, and a test that weakened it to reach `127.0.0.1` would be
 * weakening the control the guard exists for. So the fixture origin is a PUBLIC documentation
 * address (TEST-NET-3, RFC 5737 — never routed, never dialled), which the guard screens and
 * accepts exactly as it would a real shop, and the socket that would follow is the only thing
 * replaced. Everything after the fetch — the digest, the tar reader, the manifest checks, the
 * config write, the restart — is the shipped code path, byte for byte.
 *
 * NOTHING HERE TOUCHES PRODUCTION CODE. It is a test preload in the browser suite's fixtures
 * directory, is never bundled, and the binary knows nothing about it.
 */
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'

const origin = process.env['ROCKYSURF_UI_SHOP_ORIGIN']
const dir = process.env['ROCKYSURF_UI_SHOP_DIR']

const TYPES = {
  '.json': 'application/json',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.tgz': 'application/gzip',
}

if (origin && dir) {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
    if (!url.startsWith(`${origin}/`)) return realFetch(input, init)

    const relative = normalize(url.slice(origin.length + 1).split('?')[0])
    if (relative.startsWith('..') || relative.startsWith(sep)) return new Response('refused', { status: 404 })
    try {
      const bytes = await readFile(join(dir, relative))
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': TYPES[extname(relative)] ?? 'application/octet-stream' },
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  }
}
