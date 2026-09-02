#!/usr/bin/env node
/**
 * Self-test for the parallel gate's plan (#307).
 *
 * `scripts/check-parallel.mjs` is a runner, and the thing about a runner that rots quietly is its
 * PLAN — the quarantine list keeps pointing at a file somebody renamed, a package stops being
 * covered because its manifest changed shape, or a machine-specific constant gets typed into it
 * during a debugging session and never taken out again. None of that turns anything red on its
 * own: the gate would just silently stop running some tests, or stop being portable, and still
 * print PASS.
 *
 * So this drives `--list --json`, which is the plan without any of the work, and asserts the
 * properties that have to hold for the gate to mean anything. It is fast and it runs offline.
 *
 * THE PORTABILITY ASSERTION IS THE POINT OF THE FILE. The issue's acceptance criterion is "zero
 * machine-specific constants anywhere, reviewable by grep" — so the grep is written down here
 * rather than left to a reviewer's memory. Every command the plan emits is scanned for the
 * things that would tie this repository to one person's laptop.
 *
 * Run directly: node --test scripts/check-parallel.test.mjs
 * Wired into `pnpm run lint`, same as this repository's other self-tests.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const runnerPath = join(repoRoot, 'scripts/check-parallel.mjs')
const runnerSource = readFileSync(runnerPath, 'utf8')

const plan = JSON.parse(
  execFileSync(process.execPath, [runnerPath, '--list', '--json'], { cwd: repoRoot, encoding: 'utf8' }),
)

test('the plan sizes itself from the machine it is running on', () => {
  assert.equal(plan.availableParallelism, availableParallelism())
  assert.ok(plan.budget >= 1, 'the budget never drops below one, or nothing would ever be admitted')
  assert.ok(plan.budget <= availableParallelism(), 'the budget never exceeds what the machine reports')
})

test('every quarantined file exists and carries a reason', () => {
  for (const shard of plan.quarantine) {
    const file = shard.id.replace(/^quarantine:/, '')
    assert.ok(existsSync(join(repoRoot, file)), `quarantine points at a file that is not there: ${file}`)
    assert.ok(
      typeof shard.reason === 'string' && shard.reason.length > 20,
      `quarantine entry for ${file} needs a reason naming its timing dependency, not a shrug`,
    )
  }
})

test('a quarantined file is held out of the parallel wave, not run twice and not dropped', () => {
  for (const shard of plan.quarantine) {
    const basename = shard.id.split('/').pop()
    const waveShardsForThatPackage = plan.shards.filter(
      (candidate) => candidate.id.startsWith('test:') && candidate.command.includes('--exclude'),
    )
    assert.ok(
      waveShardsForThatPackage.length > 0,
      `${basename} is quarantined but no wave shard excludes anything — it would run in both waves`,
    )
    for (const waveShard of waveShardsForThatPackage) {
      assert.ok(
        waveShard.command.some((argument) => argument.endsWith(basename)),
        `${waveShard.id} does not exclude ${basename}, so it would run under load anyway`,
      )
    }
  }
})

test('the quarantine wave runs one shard at a time', () => {
  // There is no way to see this in the emitted plan — it is a property of how the wave is driven,
  // and it was wrong once: the quarantine reused the full budget, so two load-sensitive timing
  // tests ran side by side, which is precisely the condition they are held back from. The second
  // started eight seconds before the first had finished and nothing said a word about it.
  assert.match(
    runnerSource,
    /runWave\(plan\.quarantine,\s*1,/,
    'the quarantine wave must be driven with a concurrency of 1, or it is not a quarantine',
  )
  assert.match(
    runnerSource,
    /runWave\(plan\.shards,\s*budget,/,
    'the parallel wave must be driven at the budget derived from this machine',
  )
})

test('every quarantined shard is limited to a single vitest worker', () => {
  for (const shard of plan.quarantine) {
    assert.ok(
      shard.command.includes('--maxWorkers=1'),
      `${shard.id} runs with more than one worker, so it is still being timed under load`,
    )
  }
})

test('every package that can be tested or typechecked is covered by a shard', () => {
  const covered = new Set(plan.shards.map((shard) => shard.id.replace(/ \(shard \d+\/\d+\)$/, '')))
  for (const entry of readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(repoRoot, 'packages', entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.scripts?.test) assert.ok(covered.has(`test:${manifest.name}`), `no test shard for ${manifest.name}`)
    if (manifest.scripts?.typecheck) {
      assert.ok(covered.has(`typecheck:${manifest.name}`), `no typecheck shard for ${manifest.name}`)
    }
  }
})

test('the build runs first and everything else waits for it', () => {
  const build = plan.shards.find((shard) => shard.id === 'build')
  assert.ok(build, 'there is no build shard')
  assert.deepEqual(build.needs, [], 'the build waits for nothing')
  for (const shard of plan.shards) {
    if (shard.id === 'build') continue
    assert.deepEqual(shard.needs, ['build'], `${shard.id} must wait for the build — dist/ is gitignored`)
  }
})

test('the lint the parallel gate runs is the lint the serial gate runs', () => {
  // If these drift, `check:parallel` starts passing things `check` would have caught, which is
  // the one failure mode that makes a fast gate worse than no gate at all.
  const lint = plan.shards.find((shard) => shard.id === 'lint')
  assert.ok(lint, 'there is no lint shard')
  assert.deepEqual(lint.command, ['pnpm', 'run', 'lint'])
})

test('no package shard is addressed by a name the workspace root also answers to', () => {
  // The root manifest is called `rockysurf` and so is `packages/rockysurf`, so
  // `pnpm --filter rockysurf` matches BOTH and the root's `test` script is `pnpm -r test`. That
  // collision made one shard re-run every suite in the repository. Shards run in the package
  // directory instead, and nothing in the plan may go back to filtering by name.
  for (const shard of [...plan.shards, ...plan.quarantine]) {
    assert.ok(!shard.command.includes('--filter'), `${shard.id} filters by package name; run it in its own directory`)
  }
})

test('nothing machine-specific is written down, in the plan or in the runner', () => {
  const forbidden = [
    [/\/Users\/|\/home\/|C:\\\\/, 'an absolute path into somebody\u2019s home directory'],
    [/localhost:\d|127\.0\.0\.1:\d/, 'a hardcoded host and port'],
    [/\/(var|private)\/folders\/|\/tmp\//, 'a resolved temp directory'],
  ]

  for (const shard of [...plan.shards, ...plan.quarantine]) {
    const rendered = shard.command.join(' ')
    for (const [pattern, what] of forbidden) {
      assert.ok(!pattern.test(rendered), `${shard.id} has ${what}: ${rendered}`)
    }
    // A resolved number in the PLAN is the good case — it is what "derived at runtime" produces.
    // What has to hold is that it was derived from this machine, so it stays inside the budget.
    for (const argument of shard.command) {
      const workers = /^--maxWorkers=(\d+)$/.exec(argument)
      if (!workers) continue
      const count = Number(workers[1])
      assert.ok(count >= 1 && count <= plan.budget, `${shard.id} asks for ${count} workers, outside the budget`)
    }
  }

  // The runner's own SOURCE is where a machine constant would actually be typed. Prose is
  // stripped first: the doc comments quote measured timings and paths on purpose.
  const code = runnerSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/\/Users\/|\/home\//.test(code), 'the runner has an absolute home path in it')
  assert.ok(!/\/(var|private)\/folders\//.test(code), 'the runner has a resolved temp directory in it')
  assert.ok(!/maxWorkers=\d/.test(code.replace(/maxWorkers=1'/g, '')), 'the runner has a literal worker count in it')
  assert.ok(
    code.includes('availableParallelism()'),
    'the runner must derive its concurrency from os.availableParallelism(), not from a constant',
  )
  assert.ok(code.includes('mkdtempSync'), 'the runner must take its temp directory from mkdtemp, not from a fixed name')
})
