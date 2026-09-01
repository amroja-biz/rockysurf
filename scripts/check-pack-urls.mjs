#!/usr/bin/env node
/**
 * Every tool's `url:` in `packs/` still resolves, and still points where the software actually
 * comes from (issue #286).
 *
 * WHAT THIS COVERS THAT NOTHING ELSE DOES. `rockysurf pack lint` reads the file and proves the
 * shape: `url` is present, and it is a string. `scripts/pack-smoke.mjs` installs the pack in a
 * container and proves the SCRIPTS work — every URL it exercises is one a `curl` or an
 * `apt-get` fetched. Neither one ever loads the `url` field, because nothing on the box does.
 * It is the tool's home page, shown to the person on the consent screen so they can see what
 * they are about to install (docs/writing-a-pack.md § "Tool fields"). A link that rotted is
 * invisible to both gates and visible to every user.
 *
 * WHY IT IS NOT PART OF `pnpm run lint`. It is the only check in this repository that needs the
 * network, and the hosts it talks to are not test fixtures — they are third-party marketing
 * sites and project pages that get redesigned, rate-limited and put behind WAFs without telling
 * anyone. Every one of them answered 200 when this was written, so it is not flaky TODAY; the
 * point is that whether it passes is not a property of the pull request in front of it. Wiring
 * that into the merge gate buys a check that fails for reasons no pull request caused, and the
 * fix people learn is to re-run it until it passes, which is worse than not having it. So it is
 * a command a human runs — before a launch, and when a pack is added — and it reports rather
 * than gates.
 *
 *   node scripts/check-pack-urls.mjs [--json]
 *
 * WHAT IT REPORTS, in three grades:
 *
 *   DEAD      the URL does not resolve, or answers 404/410. The page is gone; fix the pack.
 *   MOVED     it resolves, but a redirect lands on a different GitHub owner or repository.
 *             This is the interesting one, and it is why the check exists. A GitHub rename
 *             leaves a redirect behind, so the link keeps working and the staleness is
 *             invisible until the day the redirect is switched off. `packs/ai-coding-agents.yaml`
 *             already states the rule for its download URLs — "a redirect is a thing that can be
 *             turned off, so the canonical name is what is written" — and this applies it to the
 *             `url` field too.
 *   BLOCKED   a status that means "a script asked, so no" rather than "this page is gone"
 *             (401, 403, 405, 429). The grade exists so that a host refusing crawlers is
 *             reported as what it is instead of being announced as a dead link. `x.ai/build`
 *             lands here intermittently. Never a failure.
 *
 * Exits 0 when nothing is DEAD or MOVED, 1 otherwise, 2 when the check could not be run.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * RE-EXEC WITH A BIGGER HEADER BUFFER, and why this is not fussiness.
 *
 * Node's `fetch` caps response headers at 16 KB and throws `UND_ERR_HEADERS_OVERFLOW` past it —
 * surfaced to the caller as the same bare "fetch failed" that a dead host produces. Marketing
 * sites behind a CDN routinely exceed it on cookies and CSP alone: `sourcegraph.com/amp` does,
 * and the first version of this script reported it DEAD while `curl` fetched it fine. A checker
 * whose failure mode is a false accusation about a live page is worse than no checker, so the
 * buffer is raised before any request is made. There is no public API for it — `--max-http-header-size`
 * is a process-level flag — hence the re-exec rather than an option object.
 */
if (!process.env.ROCKYSURF_PACK_URLS_CHILD) {
  const child = spawnSync(
    process.execPath,
    ['--max-http-header-size=131072', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, ROCKYSURF_PACK_URLS_CHILD: '1' } },
  )
  process.exit(child.status ?? 2)
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const packsDir = join(repoRoot, 'packs')

/** Per-request ceiling. Generous: some of these are slow marketing pages, not APIs. */
const TIMEOUT_MS = 25_000
/**
 * Attempts per URL, for TRANSPORT failures only — never for an HTTP status, which is an answer.
 * Not optional: `xfce.org` failed once and succeeded on the retry during the very session this
 * script was written in. One dropped connection must not read as "the project's home page is
 * gone".
 */
const ATTEMPTS = 3
/** Statuses that mean "a script asked, so no" rather than "this page is gone". */
const BLOCKED_STATUSES = new Set([401, 403, 405, 429])
/**
 * AN HONEST USER-AGENT, and this is a finding rather than a preference.
 *
 * The obvious move is to send a Chrome string so that fewer hosts refuse a scripted request.
 * Measured against these thirty URLs it is strictly worse, and one host makes the reason plain:
 * `xfce.org` sits behind a WAF that compares the claimed browser against the TLS fingerprint of
 * the client, and Node is not Chrome. Claiming Chrome got the connection dropped — four times
 * out of four, deterministically, reported as a transport error indistinguishable from a dead
 * host. Sending this string instead returns 200 every time. `x.ai/build` behaves the same way in
 * the milder form: 403 to a fake browser, 200 to a named crawler.
 *
 * So identifying the checker honestly is not politeness at the expense of coverage — it IS the
 * coverage. Swapping the Chrome string for this one turned two false DEAD/BLOCKED reports into
 * 200s and introduced none. `x.ai/build` still answers 403 sometimes and 200 sometimes, which is
 * exactly why BLOCKED is not a failure.
 */
const USER_AGENT = 'rockysurf-pack-url-check (+https://github.com/amroja-biz/rockysurf)'

/**
 * The `url:` lines, with the pack file and line number that carry them.
 *
 * Read as TEXT rather than through core's loader on purpose: this script's whole job is to
 * report a location a human then edits, and the loader hands back a parsed tool with no line
 * number on it. A regex over `url:` at tool-field indentation is exact for this file format —
 * `lintPacksDir` has already proven the documents parse before anyone runs this.
 */
function packUrls() {
  const files = readdirSync(packsDir)
    .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
    .sort()
  const found = []
  for (const file of files) {
    const lines = readFileSync(join(packsDir, file), 'utf8').split('\n')
    lines.forEach((line, i) => {
      // Tool `url:` fields only, at any indentation — pinning the exact column would silently
      // skip a pack that indents differently, and a link checker that quietly checks nothing is
      // the failure mode to avoid. `imageUrl:` cannot match (the key after the indent is not
      // `url`), and a URL inside an install script is indented under a block scalar as part of a
      // longer line, so it cannot either; those are the smoke test's job.
      const m = /^\s+url:\s*(\S+)\s*$/.exec(line)
      if (m && /^https?:\/\//.test(m[1])) found.push({ file, line: i + 1, url: m[1] })
    })
  }
  return found
}

/** owner/repo for a GitHub URL, so a rename can be told from an ordinary path redirect. */
function githubRepo(url) {
  try {
    const u = new URL(url)
    if (u.hostname !== 'github.com') return null
    const [owner, repo] = u.pathname.split('/').filter(Boolean)
    return owner && repo ? `${owner}/${repo}`.toLowerCase() : null
  } catch {
    return null
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function attempt(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    // GET, not HEAD: enough hosts answer HEAD with 405 that a HEAD-based check reports
    // BLOCKED for pages that are perfectly alive.
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' },
    })
    return { status: res.status, finalUrl: res.url }
  } catch (err) {
    const cause = err instanceof Error ? err.cause : undefined
    const detail = cause?.message ?? (err instanceof Error ? err.message : String(err))
    return { status: 0, finalUrl: url, error: detail }
  } finally {
    clearTimeout(timer)
  }
}

/** Retries transport failures, with a short backoff. An HTTP status is an answer; it stands. */
async function probe(url) {
  let last
  for (let i = 1; i <= ATTEMPTS; i++) {
    last = await attempt(url)
    if (last.status !== 0) return last
    if (i < ATTEMPTS) await sleep(1000 * i)
  }
  return { ...last, error: `${last.error} (after ${ATTEMPTS} attempts)` }
}

function grade({ url, status, finalUrl, error }) {
  if (status === 0) return { grade: 'DEAD', detail: `did not resolve — ${error}` }
  if (status === 404 || status === 410) return { grade: 'DEAD', detail: `HTTP ${status}` }
  if (BLOCKED_STATUSES.has(status)) return { grade: 'BLOCKED', detail: `HTTP ${status} to a scripted request` }
  if (status >= 400) return { grade: 'DEAD', detail: `HTTP ${status}` }

  const from = githubRepo(url)
  const to = githubRepo(finalUrl)
  if (from && to && from !== to) {
    return { grade: 'MOVED', detail: `redirects to ${finalUrl} — write the canonical name` }
  }
  return { grade: 'OK', detail: `HTTP ${status}` }
}

const entries = packUrls()
if (entries.length === 0) {
  console.error(`pack urls: no tool url: fields found in ${packsDir} — this check assumes the repository layout`)
  process.exit(2)
}

// Sequential, not Promise.all. Thirty requests is nothing, and a burst at one host is the
// fastest way to turn an honest check into a rate-limited one.
const results = []
for (const entry of entries) {
  const probed = await probe(entry.url)
  results.push({ ...entry, ...grade({ url: entry.url, ...probed }), status: probed.status })
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: !results.some((r) => r.grade === 'DEAD' || r.grade === 'MOVED'), results }, null, 2))
} else {
  for (const r of results) {
    const where = `${r.file}:${r.line}`
    if (r.grade === 'OK') console.log(`  ok       ${r.url}`)
    else console.log(`  ${r.grade.padEnd(8)} ${r.url}\n             ${where} — ${r.detail}`)
  }
  const dead = results.filter((r) => r.grade === 'DEAD').length
  const moved = results.filter((r) => r.grade === 'MOVED').length
  const blocked = results.filter((r) => r.grade === 'BLOCKED').length
  console.log()
  console.log(
    `pack urls: ${results.length} checked, ${dead} dead, ${moved} moved, ${blocked} blocked (blocked is not a failure)`,
  )
}

process.exit(results.some((r) => r.grade === 'DEAD' || r.grade === 'MOVED') ? 1 : 0)
