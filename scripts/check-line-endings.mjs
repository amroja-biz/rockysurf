#!/usr/bin/env node
/**
 * Every file a Linux shell or Docker reads must be checked out with LF, on every OS (issue #516).
 *
 * WHY THIS EXISTS. Git for Windows defaults to core.autocrlf=true, so any text file without an
 * `eol` rule in .gitattributes is checked out with CRLF on Windows. For most files that is
 * harmless. For a shell script it is not: `#!/bin/sh\r` makes the kernel look for a program
 * called `sh\r`, so a CRLF docker/entrypoint.sh stops the container from starting (`exec: not
 * found`), and bash rejects a CRLF packages/core/bootstrap/agent.sh with a syntax error, which
 * breaks setup on every Server an image built from that checkout creates. No macOS or Linux
 * checkout ever shows the problem, so nothing noticed it until a Windows user tried.
 *
 * WHAT IT CHECKS. Every tracked file that is a `*.sh`, a `Dockerfile`, or starts with a shebang
 * naming a POSIX shell must resolve to `eol: lf` according to `git check-attr`, which is git's
 * own attribute matcher rather than a reimplementation. Node shebangs are exempt, because
 * scripts with them are run as `node <file>` and Node accepts CRLF.
 *
 * IT PROVES ITSELF FIRST, like check-gitignore-anchors.mjs: a throwaway repository holding a
 * shell script with no rule must fail, and the same repository with the rule must pass.
 *
 * Exits 0 when clean, 1 when a file is not pinned to LF, 2 when the self-test does not hold.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const git = (cwd, args, input) => execFileSync('git', args, { cwd, input, encoding: 'utf8' })

/** A shebang that runs the file with a POSIX shell rather than with Node. */
const SHELL_SHEBANG = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?(?:sh|bash|dash|zsh|ksh)\b/

/** Tracked files that must be LF, whatever the attributes currently say. */
function filesNeedingLf(cwd) {
  return git(cwd, ['ls-files', '-z'])
    .split('\0')
    .filter(Boolean)
    .filter((path) => {
      if (path.endsWith('.sh') || basename(path) === 'Dockerfile') return true
      try {
        return SHELL_SHEBANG.test(readFileSync(join(cwd, path), 'utf8').slice(0, 200))
      } catch {
        return false // listed but not on disk, e.g. a deletion not yet committed
      }
    })
}

/** The subset of `paths` whose `eol` attribute is not `lf`. */
function notPinnedToLf(cwd, paths) {
  if (paths.length === 0) return []
  // `-z` output is path NUL attribute NUL value NUL, repeated.
  const fields = git(cwd, ['check-attr', '-z', '--stdin', 'eol'], paths.join('\0')).split('\0')
  const unpinned = []
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 2] !== 'lf') unpinned.push(fields[i])
  }
  return unpinned
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'check-line-endings-'))
  try {
    git(dir, ['init', '-q'])
    writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\necho hi\n')
    writeFileSync(join(dir, 'tool'), '#!/usr/bin/env bash\necho hi\n')
    writeFileSync(join(dir, 'cli.mjs'), '#!/usr/bin/env node\nconsole.log(1)\n')
    git(dir, ['add', '.'])
    const before = notPinnedToLf(dir, filesNeedingLf(dir)).sort().join(',')
    if (before !== 'run.sh,tool') return `expected run.sh and tool to be flagged, got [${before}]`
    writeFileSync(join(dir, '.gitattributes'), '*.sh text eol=lf\ntool text eol=lf\n')
    const after = notPinnedToLf(dir, filesNeedingLf(dir))
    if (after.length > 0) return `expected nothing flagged once pinned, got [${after.join(',')}]`
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const selfTestFailure = selfTest()
if (selfTestFailure) {
  console.error(`check-line-endings: self-test failed: ${selfTestFailure}`)
  process.exit(2)
}

const unpinned = notPinnedToLf(repoRoot, filesNeedingLf(repoRoot))
if (unpinned.length > 0) {
  console.error('check-line-endings: these files are read by a Linux shell or Docker but are not')
  console.error('pinned to LF in .gitattributes, so a Windows checkout gives them CRLF (issue #516):')
  for (const path of unpinned) console.error(`  ${path}`)
  console.error('Add an `eol=lf` rule that covers them.')
  process.exit(1)
}
console.error('check-line-endings: every shell script and Dockerfile is pinned to LF')
