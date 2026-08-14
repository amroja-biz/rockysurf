#!/usr/bin/env node
/**
 * Nothing under a package's `src/` may be gitignored (rockysurf-ys0i).
 *
 * WHY THIS EXISTS, and it is a scar rather than a style preference. `packages/core/.gitignore`
 * gained a bare `packs/` to hide the generated pack bundle that lives at the package root. A
 * gitignore pattern with no slash in it matches a directory of that name at ANY depth, so it
 * also matched `packages/core/src/packs/` — the pack loader's own source directory. A new file
 * added there, `src/packs/bundled.ts`, was therefore reported by git as IGNORED rather than
 * untracked, `git add -A` skipped it without a word, and the branch was pushed containing two
 * imports of a module it did not contain.
 *
 * Every visible signal said fine. The commit succeeded, the local gate was green because the
 * file existed in the working tree, and only a fresh clone showed the truth. THAT is the failure
 * mode worth a lint: not that the mistake is hard to make, but that nothing tells you when you
 * have made it.
 *
 * WHAT IT CHECKS. For every package, every directory and file under `src/` is put to
 * `git check-ignore`, which is git's own matcher rather than a reimplementation of gitignore
 * semantics here — the subtlety that caused this is exactly the kind a hand-rolled matcher gets
 * wrong. Anything ignored is a failure, and the report names the pattern and the file that
 * matched, because "your gitignore is too broad" without those two facts is a puzzle.
 *
 * `--no-index` is what makes it work at all: without it, git reports nothing for a path that is
 * already tracked, and the interesting case is precisely a file that is NOT yet tracked because
 * a pattern is hiding it.
 *
 * WHY THE RULE IS "NOTHING UNDER src/" RATHER THAN "NO UNANCHORED PATTERNS". Unanchored patterns
 * are overwhelmingly the right thing — `dist/` and `node_modules/` appear in every package here
 * and are harmless, because no package has a `src/dist`. Flagging the shape would cry wolf eight
 * times over on a tree with no bug in it, and a lint that is usually wrong gets silenced. So this
 * fires on the COLLISION, which is the thing that actually costs someone a broken branch.
 *
 * IF YOU HIT THIS and genuinely need something under `src/` ignored: anchor the pattern to where
 * the generated thing really is (`/packs/` rather than `packs/`), which is the fix that was
 * applied here. If a package truly needs to ignore a path inside its own sources, that is a
 * conversation rather than a lint exemption — say so in review.
 *
 * IT PROVES ITSELF ON EVERY RUN, before it looks at this repository at all. `gitleaks-selftest`
 * is the precedent and the reasoning is identical: a checker's failure mode is SILENCE — a
 * detector that has stopped detecting passes, and a passing run looks exactly like a clean tree.
 * So the self-test builds a throwaway git repository containing the exact hazardous shape,
 * asserts the detector fires on it, then rebuilds it anchored and asserts it goes quiet. Both
 * halves matter: one proves it can fail, the other proves it is not simply always failing.
 *
 * Exits 0 when clean, 1 on any ignored source path, 2 when the self-test itself does not hold.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const packagesDir = join(repoRoot, 'packages')

/**
 * Ask git which of `paths` are ignored, from `cwd`. Returns the raw `--verbose` lines.
 *
 * `--no-index` is what makes this work at all: without it git reports nothing for a path that is
 * already tracked, and the interesting case is precisely a file NOT yet tracked because a
 * pattern is hiding it. `check-ignore` exits 0 when something matched and 1 when nothing did, so
 * a non-zero status is not on its own an error and has to be told apart from a real one.
 */
function ignoredPaths(cwd, paths) {
  try {
    return execFileSync('git', ['check-ignore', '--no-index', '--verbose', '--stdin'], {
      cwd,
      input: paths.join('\n'),
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
  } catch (error) {
    if (error.status === 1) return []
    throw new Error(`git check-ignore failed in ${cwd}: ${error.message}`)
  }
}

/**
 * Build a throwaway repository with `ignoreBody`, and report whether `src/packs/bundled.ts`
 * comes back ignored. The fixture mirrors the real shape rather than a simplified one: a
 * package with a generated directory at its root and a source directory of the same name.
 */
function detectsHazard(ignoreBody) {
  const dir = mkdtempSync(join(tmpdir(), 'rockysurf-gitignore-selftest-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    mkdirSync(join(dir, 'packages/core/src/packs'), { recursive: true })
    mkdirSync(join(dir, 'packages/core/packs'), { recursive: true })
    writeFileSync(join(dir, 'packages/core/.gitignore'), ignoreBody)
    writeFileSync(join(dir, 'packages/core/src/packs/bundled.ts'), 'export const x = 1\n')
    writeFileSync(join(dir, 'packages/core/packs/a.yaml'), 'version: 1\n')
    const target = join(dir, 'packages/core/src/packs/bundled.ts')
    return ignoredPaths(dir, [target]).length > 0
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Prove the detector can fail, and prove it is not always failing. Both, or neither means much. */
function selfTest() {
  // The exact shape that hid `bundled.ts`: a bare directory name, which matches at any depth.
  if (!detectsHazard('dist/\npacks/\n')) {
    console.error('gitignore anchors: SELF-TEST FAILED — the detector did not fire on an unanchored')
    console.error('  `packs/` that shadows src/packs. It would pass this repository for the wrong')
    console.error('  reason, which is worse than not running at all.')
    process.exit(2)
  }
  // The fix, which must be quiet — otherwise the check is unusable and would be silenced.
  if (detectsHazard('dist/\n/packs/\n')) {
    console.error('gitignore anchors: SELF-TEST FAILED — the detector fired on an ANCHORED `/packs/`,')
    console.error('  which is the correct spelling. A check that cannot be satisfied gets turned off.')
    process.exit(2)
  }
}

selfTest()

/** Every path under a directory, files and directories both. Directories matter: a pattern like
 *  `packs/` matches the directory, and everything beneath it disappears with it. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    out.push(path)
    // `node_modules` under src/ would be somebody else's problem and is ignored everywhere by
    // design; descending into it would make this check slow for no signal.
    if (entry !== 'node_modules' && statSync(path).isDirectory()) walk(path, out)
  }
  return out
}

const packages = existsSync(packagesDir)
  ? readdirSync(packagesDir).filter((name) => statSync(join(packagesDir, name)).isDirectory())
  : []

if (packages.length === 0) {
  console.error(`gitignore anchors: no packages found under ${packagesDir}`)
  process.exit(1)
}

const paths = []
for (const name of packages) {
  const src = join(packagesDir, name, 'src')
  if (existsSync(src)) paths.push(...walk(src))
}

if (paths.length === 0) {
  // Every package here has a `src/`. None at all means this script is looking at the wrong tree,
  // and reporting "clean" would be the fail-open answer.
  console.error('gitignore anchors: found no source paths to check — is the layout what this expects?')
  process.exit(1)
}

let lines
try {
  lines = ignoredPaths(repoRoot, paths)
} catch (error) {
  console.error(`gitignore anchors: ${error.message}`)
  process.exit(1)
}

const hits = lines
  .map((line) => {
    // `<source>:<line>:<pattern>\t<path>`
    const [rule, path] = line.split('\t')
    const parts = rule.split(':')
    return { path, pattern: parts.at(-1), source: parts.slice(0, -2).join(':'), line: parts.at(-2) }
  })

if (hits.length > 0) {
  console.error('gitignore anchors: these source paths are IGNORED, so git will not see them:')
  for (const hit of hits) {
    console.error(`  ${relative(repoRoot, hit.path)}`)
    console.error(`    matched by "${hit.pattern}" at ${hit.source}:${hit.line}`)
  }
  console.error('')
  console.error('  A pattern with no slash matches that name at ANY depth, including under src/.')
  console.error('  Anchor it to where the generated thing actually is — "/packs/" rather than "packs/".')
  console.error('')
  console.error('  This is rockysurf-ys0i: the shape that silently kept a source file out of a commit.')
  process.exit(1)
}

console.error(
  `gitignore anchors: OK — ${paths.length} source path(s) across ${packages.length} package(s), none ignored` +
    ' (self-test passed: the detector fires on an unanchored pattern and not on an anchored one)',
)
