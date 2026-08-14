#!/usr/bin/env node
/**
 * Self-test for `.gitleaks.toml` (rockysurf-ftl9.5).
 *
 * A secret scanner is the one check whose failure mode is silence. If a rule stops matching —
 * an edited regex, a TOML key a gitleaks upgrade renamed, an `[[allowlists]]` block that grew
 * one entry too many — the job goes GREEN, and green is exactly what it looks like when there
 * is nothing to find. Nobody investigates a passing scan. So the rules get a test, the same as
 * any other code that is only useful when it says no.
 *
 * Three assertions, and each catches a different way the configuration can rot:
 *
 *   1. EVERY PROJECT RULE FIRES. A fixture is written to a scratch directory containing every
 *      pinned legacy value in the context it actually appeared in, and each rule must report at
 *      least one finding on it. Per-rule, not "some finding was reported": a config where four
 *      of five rules had been deleted would otherwise pass.
 *   2. THE NEGATIVE CONTROLS DO NOT FIRE. A second fixture holds the near-misses that exist in
 *      the live tree — Hetzner's `price_hourly` keys, a 12-digit number that is not the account
 *      id, a plausible username. A rule broad enough to flag those is a rule someone will turn
 *      off within a week.
 *   3. THE FIXTURE EXEMPTION HAS NOT OUTLIVED ITS SUBJECT. Every path in the test-fixture
 *      allowlist block must still match something in the working tree. Move or delete one of
 *      those files and this fails until the exemption is updated with it — otherwise the
 *      allowlist silently becomes a blind spot at a path anyone can later recreate.
 *      (The pre-scrub legacy tree and the history-only exemptions this test used to police were
 *      deleted together with the legacy tree when the fresh public history was cut.)
 *
 * The fixtures live in a temp directory, NEVER in the repository: a file of pinned secret values
 * checked in beside the rules that catch them is a file every future scan has to be taught to
 * ignore. The only in-repo copy of these strings is this script, and `.gitleaks.toml` exempts
 * exactly these two files by path.
 *
 * Usage: node scripts/gitleaks-selftest.mjs [--json]
 *   Requires `gitleaks` on PATH (override with $GITLEAKS). Exits 0 clean, 1 on any failure,
 *   2 when the check could not be run at all.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const configPath = join(repoRoot, '.gitleaks.toml')
const GITLEAKS = process.env['GITLEAKS'] ?? 'gitleaks'
const JSON_OUT = process.argv.includes('--json')

/**
 * One entry per project-specific rule, in the surrounding context the value really appeared in,
 * because a rule anchored on punctuation would pass a bare-value fixture and fail on the file
 * it was written for. Where a rule is pinned to a literal (the account id, the app id, the
 * handle) the sample necessarily carries that literal. Where a rule matches a SHAPE (client
 * ids, price ids) the sample value is synthetic — the real ones do not appear anywhere in this
 * repository, this file included.
 */
const MUST_DETECT = [
  {
    rule: 'rockysurf-legacy-aws-account',
    sample: "aws cloudformation deploy --profile AdministratorAccess-277707111475 --region us-east-1",
  },
  {
    rule: 'rockysurf-legacy-github-app-client-id',
    sample: "GITHUB_CLIENT_ID: 'Iv23liSynth3t1cSampl'  # and the OAuth app it was confused with: Ov23liSynth3t1cSampl",
  },
  { rule: 'rockysurf-legacy-github-app-id', sample: 'GitHubAppId: 2773473' },
  { rule: 'rockysurf-legacy-stripe-price-id', sample: "STRIPE_METER_PRICE_ID: 'price_1Synth3t1cV4lu3F0rT3st'" },
  { rule: 'rockysurf-legacy-operator-handle', sample: "AllowedGitHubUsers: 'jbdamask,someoneelse'" },
  { rule: 'rockysurf-legacy-local-username', sample: 'binary /Users/johndamask/code/somewhere/dist/bin.js' },
  { rule: 'rockysurf-legacy-private-worktree', sample: 'cwd /Users/someone/code/1-open-source-rocky-surf-v0-1/packages' },
]

/**
 * Values that look like the ones above and are not. Every line here is either in the live tree
 * today or one edit away from being.
 */
const MUST_IGNORE = [
  "// Hetzner prices arrive as { price_hourly: { gross }, price_monthly: { gross } }",
  "const priceKeys = ['price_hourly', 'price_monthly'] as const",
  'arn:aws:iam::123456789012:role/rocky-surf-provider', // the documentation placeholder account
  'accountId: 277707111476', // one digit off
  'AllowedGitHubUsers: "octocat,hubot"',
  'appId: 27734730', // \b on the rule means a longer number is not the app id
  "const stripePrice = 'price_test123'",
  'client_id: Xv23liSynth3t1cSampl', // wrong prefix letter
]

const failures = []
const results = []
const fail = (what, detail) => {
  failures.push({ what, detail })
  results.push({ ok: false, what, detail })
  if (!JSON_OUT) console.log(`  ✗ ${what}\n      ${detail}`)
}
const pass = (what, detail = '') => {
  results.push({ ok: true, what, ...(detail ? { detail } : {}) })
  if (!JSON_OUT) console.log(`  ✓ ${what}${detail ? ` — ${detail}` : ''}`)
}

function requireGitleaks() {
  const probe = spawnSync(GITLEAKS, ['version'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) {
    console.error(
      `gitleaks is not runnable as "${GITLEAKS}".\n` +
        'Install it (a single binary: https://github.com/gitleaks/gitleaks/releases) or set\n' +
        '$GITLEAKS to its path. CI pins a version and a checksum in .github/workflows/ci.yml.',
    )
    process.exit(2)
  }
  return probe.stdout.trim()
}

/** Scan a directory with the repository's config and return the findings as objects. */
function scan(dir) {
  const report = join(dir, '..', 'report.json')
  rmSync(report, { force: true })
  const run = spawnSync(
    GITLEAKS,
    ['dir', dir, '--config', configPath, '--no-banner', '--redact', '--report-format', 'json', '--report-path', report, '--log-level', 'error', '--exit-code', '0'],
    { encoding: 'utf8' },
  )
  // `--exit-code 0` makes findings a normal outcome, so a non-zero status here is gitleaks
  // itself failing — a config it cannot parse, most likely, which is the thing this test is
  // most useful for catching.
  if (run.status !== 0) {
    console.error(`gitleaks could not scan the fixture (exit ${run.status}):\n${run.stderr || run.stdout}`)
    process.exit(2)
  }
  if (!existsSync(report)) return []
  return JSON.parse(readFileSync(report, 'utf8') || '[]')
}

/** Paths tracked by git, for the two exemption-staleness checks. */
function trackedPaths() {
  return execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean)
}

/**
 * Pull the `paths` list out of one `[[allowlists]]` block, found by its description.
 *
 * A hand-rolled reader rather than a TOML parser because the project takes no new dependencies
 * for a check, and the shape it reads is fixed by the file it reads: one `paths = [` array of
 * triple-quoted strings per block. It fails loudly if the block is missing, which is itself
 * worth knowing — a renamed description means the config was restructured without this test.
 */
function allowlistPaths(description) {
  const toml = readFileSync(configPath, 'utf8')
  const blocks = toml.split(/^\[\[allowlists\]\]$/m).slice(1)
  const block = blocks.find((b) => b.includes(`description = "${description}"`))
  if (!block) throw new Error(`no [[allowlists]] block described as "${description}" in .gitleaks.toml`)
  const list = block.match(/paths\s*=\s*\[([\s\S]*?)\n\]/)
  if (!list) throw new Error(`the "${description}" allowlist has no paths array`)
  return [...list[1].matchAll(/'''(.*?)'''/g)].map((m) => m[1])
}

// ------------------------------------------------------------------------------------ run
const version = requireGitleaks()
if (!JSON_OUT) console.log(`gitleaks ${version}, config ${configPath}\n`)

const work = mkdtempSync(join(tmpdir(), 'rockysurf-gitleaks-'))
try {
  /* --- 1 + 2: the rules themselves ------------------------------------------------------ */
  const fixtures = join(work, 'fixtures')
  execFileSync('mkdir', ['-p', fixtures])
  writeFileSync(
    join(fixtures, 'legacy-values.txt'),
    ['# Fixture for scripts/gitleaks-selftest.mjs. Generated; never committed.', ...MUST_DETECT.map((c) => c.sample), ''].join('\n'),
  )
  writeFileSync(
    join(fixtures, 'near-misses.txt'),
    ['# Values that must NOT be reported.', ...MUST_IGNORE, ''].join('\n'),
  )

  const findings = scan(fixtures)
  const byRule = new Map()
  for (const f of findings) byRule.set(f.RuleID, (byRule.get(f.RuleID) ?? 0) + 1)

  for (const { rule } of MUST_DETECT) {
    if (byRule.get(rule)) pass(`rule fires: ${rule}`, `${byRule.get(rule)} finding(s)`)
    else fail(`rule fires: ${rule}`, 'the fixture line for this rule produced no finding — the rule is dead')
  }

  const falsePositives = findings.filter((f) => f.File.endsWith('near-misses.txt'))
  if (falsePositives.length === 0) pass('negative controls stay quiet', `${MUST_IGNORE.length} near-miss line(s)`)
  else
    for (const f of falsePositives)
      fail('negative controls stay quiet', `${f.RuleID} matched a near-miss on line ${f.StartLine}: ${f.Match}`)

  /* --- 3: the fixture exemption must still have a subject -------------------------------- */
  const tracked = trackedPaths()
  const fixturePaths = [
    ...allowlistPaths('PEM banners and request fixtures in the test suites — no key material'),
    // rockysurf-5ypc: the recorded-evidence exemption is the same shape of hole — a named-file
    // pass on two identifier rules — so its paths get the same not-outlived-its-subject check.
    ...allowlistPaths('Recorded evidence carrying the operator\'s local username or the private worktree name'),
  ]
  const orphaned = fixturePaths.filter((p) => !tracked.some((f) => new RegExp(p).test(f)))
  if (orphaned.length === 0) pass('every fixture exemption still has files to excuse', `${fixturePaths.length} path pattern(s)`)
  else
    fail(
      'every fixture exemption still has files to excuse',
      `these .gitleaks.toml allowlist entries no longer match anything — the files moved or were deleted, so UPDATE OR REMOVE ` +
        `THE ENTRIES too, or they become blind spots at paths anyone can recreate: ${orphaned.join(', ')}`,
    )
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (JSON_OUT) console.log(JSON.stringify({ ok: failures.length === 0, gitleaks: version, results }, null, 2))
else {
  console.log()
  console.log(failures.length === 0 ? 'gitleaks self-test: all checks passed' : `gitleaks self-test: ${failures.length} check(s) failed`)
}
process.exit(failures.length === 0 ? 0 : 1)
