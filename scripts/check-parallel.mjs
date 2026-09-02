#!/usr/bin/env node
/**
 * The parallel local gate (#307).
 *
 * `pnpm run check` is the reference gate and it stays exactly as it is. This is a second way to
 * run the same work that finishes sooner, for the case the reference gate is bad at: a human or
 * an agent waiting on a laptop before pushing.
 *
 * WHERE THE TIME ACTUALLY GOES, measured rather than assumed. On the machine this was written
 * on, `pnpm run check` on a clean tree splits lint 2s / typecheck 7s / tests ~85s. So tests are
 * the whole gate, and two things make them slower than they need to be:
 *
 *   1. `pnpm -r test` runs in TOPOLOGICAL order. That is right for `build` — core cannot compile
 *      before provider-sdk has a `dist/` — and it is pure loss for `test`, because one package's
 *      test run is not an input to another's. `packages/web` owns ~42s of that 85s all by
 *      itself and waits its turn behind packages that have nothing to do with it.
 *   2. lint, typecheck and tests run one after another, though only the build is upstream of any
 *      of them.
 *
 * So: build once, in dependency order, exactly as today. Then run everything downstream of the
 * build at once, longest suite first, with no ordering between suites at all. Measured over three
 * alternating runs on the same machine and a clean tree: 93-97s for a build plus `pnpm run check`,
 * 58-60s for this. What is left is almost exactly `packages/web`, which runs its files one at a
 * time by its own choice and is now the critical path all by itself.
 *
 * PORTABILITY IS THE HARD CONSTRAINT (the acceptance criterion, and reviewable by grep). This
 * script runs on whatever machine a contributor has. There is no core count, port number, temp
 * path, username, hostname or platform test written down anywhere in it. Everything
 * machine-shaped is discovered at runtime:
 *
 *   - how much CPU to use     -> `os.availableParallelism()`, less a small reserve
 *   - where to put temp files -> `mkdtemp` under `os.tmpdir()`
 *   - which packages exist    -> `packages/<*>/package.json`
 *   - how big each suite is   -> counting its test files
 *   - whether a suite can use
 *     more than one worker    -> reading its own vitest config
 *
 * The same rule binds any test this script touches: a suite that needed a fixed port or a fixed
 * temp path to pass would be a portability bug in the suite, not something to paper over here.
 *
 * Usage:
 *   node scripts/check-parallel.mjs            run the gate
 *   node scripts/check-parallel.mjs --list     print the plan and exit without running anything
 *   node scripts/check-parallel.mjs --json     print the plan or the result as JSON
 *
 * Exits 0 when every shard passed, 1 when anything is red — the same verdict `pnpm run check`
 * would reach. If the two ever disagree, `pnpm run check` is right and this is the bug.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const packagesDir = join(repoRoot, 'packages')

/**
 * How much of the machine to take: the number of gate processes allowed to run at once.
 *
 * `availableParallelism()` is what Node itself reports for this box — it honours cgroup CPU
 * limits in a container, unlike a raw core count — and the reserve leaves room for this process,
 * the pnpm wrappers it spawns, and whatever else the contributor is doing. It floors at one, so
 * the script still runs on a single-core machine; it just runs everything one at a time there.
 *
 * THE BUDGET IS WORKERS, NOT PROCESSES, and it took two wrong answers to get here.
 *
 * The first attempt divided the budget into per-suite QUOTAS. That starves the suite that needs
 * the workers most: `packages/core` has 79 test files and finishes in ~17s on its natural worker
 * count, but 98s held to one worker, and any quota hands the small packages a worker each with
 * nothing left for core. The parallel gate came out SLOWER than the serial one — 198s against
 * 118s.
 *
 * The second attempt over-corrected: count PROCESSES instead, and let each one take as many
 * workers as it likes. That is not a budget at all. Ten concurrent processes each allowed ten
 * workers is a hundred workers on twelve cores, and a saturated machine breaks the tests that
 * measure time — a React suite whose assertions run a tick after a `waitFor` starts finding a
 * half-rendered page. It went red on a clean tree twice in two runs, in two different files.
 *
 * So: a shard's cost IS its worker allowance, and the in-flight allowances add up to the budget.
 * The guard against one suite monopolising the machine is a ceiling — no suite gets more workers
 * than it has files to put them on, and none gets more than `budget - 1`, so there is always room
 * for something to run beside the biggest suite.
 */
const CPU_RESERVE = 2
const budget = Math.max(1, availableParallelism() - CPU_RESERVE)

/**
 * Tests that are sensitive to CPU LOAD, and so are held out of the parallel wave and run on their
 * own afterwards.
 *
 * Read the sentence above twice, because the list is easy to abuse. This is not "tests that fail
 * on my machine" and it is not a skip list — every file here still runs, still counts, and still
 * turns the gate red when it fails. It is the set of tests whose assertions are about elapsed
 * wall-clock time, which is the one thing running twelve processes at once genuinely changes.
 *
 * Adding an entry needs a reason that names the timing dependency. "It was flaky" is not a
 * reason; `scripts/check-parallel.test.mjs` enforces that every entry points at a file that
 * exists, and a reviewer should enforce the rest.
 */
const QUARANTINE = [
  {
    file: 'packages/web/src/pages/SettingsPage.wiring.test.tsx',
    reason:
      'the token-list save awaits a SECOND real HTTP round trip inside a fixed 5000ms waitFor budget (rockysurf-zn33: the same wait was observed giving up at ~1.2s on a loaded runner, green on an immediate rerun)',
  },
  {
    file: 'packages/web/src/pages/DashboardPage.wiring.test.tsx',
    reason:
      'the per-cloud tab assertions await the TABS rendering and then query the server cards synchronously, so a machine slow enough to split those two renders across ticks finds a half-drawn page (observed red under the parallel wave; the serial gate has never shown it)',
  },
]

const args = new Set(process.argv.slice(2))
const wantList = args.has('--list')
const wantJson = args.has('--json')
if (args.has('--help') || args.has('-h')) {
  console.log(
    [
      'node scripts/check-parallel.mjs [--list] [--json]',
      '',
      '  --list   print the shard plan and exit without running anything',
      '  --json   emit JSON instead of the human summary',
    ].join('\n'),
  )
  process.exit(0)
}

/** Every workspace package, with the scripts this gate cares about. */
function discoverPackages() {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(packagesDir, entry.name)
      const manifestPath = join(dir, 'package.json')
      if (!existsSync(manifestPath)) return null
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const scripts = manifest.scripts ?? {}
      return {
        name: manifest.name,
        dir,
        hasTest: typeof scripts.test === 'string',
        hasTypecheck: typeof scripts.typecheck === 'string',
      }
    })
    .filter((pkg) => pkg !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Paths, always with forward slashes.
 *
 * Every path this script writes down or compares — the quarantine list above, vitest's positional
 * file filter, its `--exclude` globs — is POSIX-shaped. `path.relative` hands back backslashes on
 * Windows, and a glob matcher given a backslash path silently matches nothing, which here would
 * mean a quarantined file quietly running in neither wave. So separators are normalised once, at
 * the two places paths are made, rather than trusted.
 */
const posixRelativeToRoot = (absolute) => relative(repoRoot, absolute).split(sep).join('/')
const inPackagePath = (pkg, repoRelativeFile) =>
  relative(pkg.dir, join(repoRoot, repoRelativeFile)).split(sep).join('/')

/** Test files under a package, as repo-relative paths. */
function testFilesOf(pkg) {
  const found = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.test\.[cm]?[jt]sx?$/.test(entry.name)) found.push(posixRelativeToRoot(full))
    }
  }
  walk(join(pkg.dir, 'src'))
  return found.sort()
}

/**
 * Whether a package's own vitest config forbids running its files in parallel.
 *
 * `packages/web` sets `fileParallelism: false` and explains at length why it is staying that
 * way. Extra workers would do nothing at all for that package, so the config is READ rather than
 * assumed and the package is split across processes instead — and if web ever turns the setting
 * back on, this picks it up on the next run with nothing to update here.
 *
 * Conservative in the right direction: a config this fails to understand just looks parallel,
 * which costs a little scheduling accuracy and breaks nothing.
 */
function serialisesFiles(pkg) {
  for (const candidate of ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vite.config.ts']) {
    const path = join(pkg.dir, candidate)
    if (!existsSync(path)) continue
    if (/fileParallelism\s*:\s*false/.test(readFileSync(path, 'utf8'))) return true
  }
  return false
}

/**
 * How many vitest workers one package's suite is allowed — which is also what it costs to run,
 * because these workers ARE the budget being spent.
 *
 * A suite gets one worker per test file, capped so no single suite can take the whole budget.
 * There has to be room for at least one other shard beside the biggest one, or the longest suite
 * in the repository could never overlap with anything and the gate would be a serial run wearing
 * a scheduler.
 *
 * A package that sets `fileParallelism: false` gets exactly one worker, because that is what the
 * setting means, and it is NOT sharded across processes to get around it. That was tried:
 * splitting `packages/web` over two `--shard` processes made the whole run no faster — the sweep
 * over 2, 3, 4, 5, 6 and 10 shards moved it only between 58s and 64s, worst at 10 — because web
 * is not the critical path once everything else runs beside it. All it bought was a second jsdom
 * environment on an already-crowded machine, which is the last thing that suite needs. The config
 * is honoured exactly as written.
 */
function workersFor(pkg, files) {
  if (serialisesFiles(pkg)) return 1
  return Math.max(1, Math.min(files, Math.max(1, budget - 1)))
}

/** The one child process that runs a package's suite, minus anything quarantined out of it. */
function processFor(workers, excludes) {
  // Vitest 3's `--exclude` replaces `test.exclude` rather than adding to it in some versions, so
  // the defaults are restated here and the call is correct under either reading.
  const excludeArgs =
    excludes.length === 0 ? [] : ['**/node_modules/**', '**/dist/**', ...excludes].flatMap((glob) => ['--exclude', glob])
  return ['pnpm', 'run', 'test', ...excludeArgs, `--maxWorkers=${workers}`]
}

function buildPlan() {
  const packages = discoverPackages()
  const fileCounts = new Map(packages.map((pkg) => [pkg.name, testFilesOf(pkg)]))

  const quarantinedByPackage = new Map()
  for (const entry of QUARANTINE) {
    const pkg = packages.find((candidate) => entry.file.startsWith(`${posixRelativeToRoot(candidate.dir)}/`))
    if (!pkg) throw new Error(`quarantine entry is not inside any package: ${entry.file}`)
    if (!quarantinedByPackage.has(pkg.name)) quarantinedByPackage.set(pkg.name, [])
    quarantinedByPackage.get(pkg.name).push(entry)
  }

  /**
   * The build is the only shard anything waits for.
   *
   * Everything else could in principle start immediately — CI's own Lint job proves the lint
   * needs no `dist/` — but core's build runs `sync-packs-bundle.mjs`, which WRITES the very file
   * `check-packs-bundle.mjs` reads. Running the two at once would race a generator against its
   * own checker and could turn the gate red for no reason at all. One dependency edge costs a
   * few seconds off a hundred and removes the whole class of problem.
   *
   * ONE OTHER SHARD WRITES `dist/` AND IT IS DELIBERATELY LEFT IN THE WAVE.
   * `packages/rockysurf/vitest.global-setup.ts` recompiles the binary and its dependencies before
   * that package's suite runs, because CI's test job has no build step ahead of it. That write
   * lands while other shards are importing the same `dist/` trees, which sounds like exactly the
   * race the paragraph above avoids — and it is not one, because `scripts/build-package.mjs`
   * compiles into a scratch directory and renames it into place (rockysurf-hwfw). A reader sees
   * the whole old tree or the whole new one, and the window between the two renames is two
   * syscalls rather than a compile. `pnpm run check` already runs these suites concurrently at
   * pnpm's own default workspace concurrency, so this gate widens a window the serial gate
   * already has, against a swap built for precisely this case.
   */
  const shards = [
    { id: 'build', label: 'build', slots: 1, needs: [], cwd: repoRoot, command: ['pnpm', '-r', 'build'] },
  ]

  // Longest first: the scheduler admits shards in order, so the suite most likely to be the last
  // one still running should be the first one started.
  const testPackages = packages
    .filter((pkg) => pkg.hasTest)
    .sort((a, b) => fileCounts.get(b.name).length - fileCounts.get(a.name).length)

  for (const pkg of testPackages) {
    const held = quarantinedByPackage.get(pkg.name) ?? []
    // Exclude by the file's whole path, not its basename: two files can share a basename in one
    // package, and excluding both would drop one of them from the gate entirely without a word.
    const excludes = held.map((entry) => `**/${inPackagePath(pkg, entry.file)}`)
    const files = fileCounts.get(pkg.name).length - held.length
    const workers = workersFor(pkg, files)
    shards.push({
      id: `test:${pkg.name}`,
      label: `test ${pkg.name}`,
      slots: workers,
      needs: ['build'],
      cwd: pkg.dir,
      command: processFor(workers, excludes),
    })
  }

  for (const pkg of packages.filter((candidate) => candidate.hasTypecheck)) {
    shards.push({
      id: `typecheck:${pkg.name}`,
      label: `typecheck ${pkg.name}`,
      slots: 1,
      needs: ['build'],
      cwd: pkg.dir,
      command: ['pnpm', 'run', 'typecheck'],
    })
  }

  shards.push({ id: 'lint', label: 'lint', slots: 1, needs: ['build'], cwd: repoRoot, command: ['pnpm', 'run', 'lint'] })

  /**
   * The quarantine wave: one file at a time, one worker, after the parallel wave has drained and
   * the machine is quiet again. This is the same assertion the parallel wave would have made —
   * just not while eleven other processes are competing for the clock it is measuring.
   */
  const quarantine = QUARANTINE.map((entry) => {
    const pkg = packages.find((candidate) => entry.file.startsWith(`${posixRelativeToRoot(candidate.dir)}/`))
    return {
      id: `quarantine:${entry.file}`,
      label: `quarantine ${entry.file}`,
      slots: 1,
      needs: [],
      reason: entry.reason,
      cwd: pkg.dir,
      command: ['pnpm', 'run', 'test', inPackagePath(pkg, entry.file), '--maxWorkers=1'],
    }
  })

  return { shards, quarantine }
}

/** Run one shard, streaming everything it says into its own log file. */
function runShard(shard, logDir) {
  const safeId = shard.id.replace(/[^a-zA-Z0-9._-]+/g, '_')
  const logPath = join(logDir, `${safeId}.log`)

  /**
   * Every shard gets its own temp directory, and it is handed over as the child's TMPDIR rather
   * than as anything the tests have to know about. `os.tmpdir()` reads these variables, so a
   * suite that does `mkdtemp(join(tmpdir(), 'x-'))` — or writes a SQLite file under the temp
   * directory — lands inside its shard's private tree without a line of test code changing.
   * The run's root is itself an `mkdtemp`, so two contributors, or two copies of this script,
   * cannot collide either.
   */
  const shardTmp = join(logDir, 'tmp', safeId)
  mkdirSync(shardTmp, { recursive: true })

  const started = Date.now()
  const [command, ...commandArgs] = shard.command
  return new Promise((resolve) => {
    const chunks = []
    const child = spawn(command, commandArgs, {
      // Each package's shard runs IN that package, never `pnpm --filter <name>` from the root.
      // The workspace root's own package is called `rockysurf` and so is `packages/rockysurf`,
      // so `--filter rockysurf` matches both and the root's `test` script is `pnpm -r test` —
      // one shard quietly re-ran every suite in the repository and took 102s doing it.
      cwd: shard.cwd,
      env: {
        ...process.env,
        TMPDIR: shardTmp,
        TEMP: shardTmp,
        TMP: shardTmp,
        // Colour codes in a file nobody is watching live only make the failure tail harder to
        // read, and vitest's rewriting reporter is noise once it is not attached to a terminal.
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.on('data', (chunk) => chunks.push(chunk))
    child.on('error', (error) => {
      chunks.push(Buffer.from(`\n${command}: ${error.message}\n`))
      finish(1)
    })
    child.on('close', (code) => finish(code ?? 1))

    let done = false
    function finish(code) {
      if (done) return
      done = true
      const output = Buffer.concat(chunks).toString('utf8')
      writeFileSync(logPath, output)
      resolve({ id: shard.id, label: shard.label, code, ms: Date.now() - started, logPath, output })
    }
  })
}

/**
 * Admit shards while their dependencies are green and there is room under `limit`.
 *
 * `limit` is a parameter rather than the budget because the quarantine wave's whole point is that
 * it runs ONE AT A TIME. Reusing the budget there would put two load-sensitive timing tests on the
 * machine simultaneously, which is the exact condition they were held back from — and it did,
 * before this was a parameter: two quarantined files overlapped and the second started 8s before
 * the first had finished.
 *
 * The `inFlight === 0` escape hatch matters on a small machine: a suite needing more slots than
 * the whole limit would otherwise wait forever for room that never arrives, so when nothing at all
 * is running the next shard goes regardless of its size.
 */
async function runWave(shards, limit, onSettled) {
  const pending = [...shards]
  const results = new Map()
  let inFlightSlots = 0
  let inFlight = 0

  await new Promise((resolve) => {
    const pump = () => {
      let admittedSomething = true
      while (admittedSomething) {
        admittedSomething = false
        for (let index = 0; index < pending.length; index += 1) {
          const shard = pending[index]
          if (!shard.needs.every((id) => results.has(id))) continue

          const blocker = shard.needs.find((id) => results.get(id).code !== 0)
          if (blocker) {
            pending.splice(index, 1)
            const skipped = { id: shard.id, label: shard.label, code: null, skipped: true, blocker, ms: 0 }
            results.set(shard.id, skipped)
            onSettled(skipped)
            admittedSomething = true
            break
          }

          if (inFlight > 0 && inFlightSlots + shard.slots > limit) continue

          pending.splice(index, 1)
          inFlightSlots += shard.slots
          inFlight += 1
          admittedSomething = true
          runShard(shard, logDir).then((result) => {
            inFlightSlots -= shard.slots
            inFlight -= 1
            results.set(shard.id, result)
            onSettled(result)
            pump()
          })
          break
        }
      }
      if (pending.length === 0 && inFlight === 0) resolve()
    }
    pump()
  })

  return results
}

const plan = buildPlan()

if (wantList) {
  const listed = {
    budget,
    availableParallelism: availableParallelism(),
    shards: plan.shards.map(({ id, slots, needs, command }) => ({ id, slots, needs, command })),
    quarantine: plan.quarantine.map(({ id, reason, command }) => ({ id, reason, command })),
  }
  if (wantJson) {
    console.log(JSON.stringify(listed, null, 2))
  } else {
    console.log(`budget: ${budget} of ${availableParallelism()} reported by os.availableParallelism()`)
    for (const shard of plan.shards) {
      console.log(`  ${String(shard.slots).padStart(2)} slot(s)  ${shard.id}`)
    }
    for (const shard of plan.quarantine) console.log(`  serial     ${shard.id} — ${shard.reason}`)
  }
  process.exit(0)
}

const logDir = mkdtempSync(join(tmpdir(), 'rockysurf-check-parallel-'))
const runStarted = Date.now()

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`

function report(result) {
  if (wantJson) return
  const mark = result.skipped ? 'skip' : result.code === 0 ? ' ok ' : 'FAIL'
  const detail = result.skipped ? `(${result.blocker} failed)` : seconds(result.ms)
  console.log(`[${mark}] ${result.label.padEnd(34)} ${detail}   ${seconds(Date.now() - runStarted)} elapsed`)
}

if (!wantJson) {
  console.log(`check:parallel — ${plan.shards.length} shards, ${budget} at a time, logs in ${logDir}`)
}

const waveResults = await runWave(plan.shards, budget, report)

// The quarantine runs unless the build itself failed, so a red timing test and a red unit test
// both show up in the same run rather than one hiding the other. One at a time — see runWave.
let quarantineResults = new Map()
if (waveResults.get('build')?.code === 0 && plan.quarantine.length > 0) {
  if (!wantJson) console.log('\nquarantine (serial, one worker — load-sensitive timing tests):')
  quarantineResults = await runWave(plan.quarantine, 1, report)
}

const all = [...waveResults.values(), ...quarantineResults.values()]
const failed = all.filter((result) => result.code !== 0 && !result.skipped)
const skipped = all.filter((result) => result.skipped)
const totalMs = Date.now() - runStarted

if (wantJson) {
  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0 && skipped.length === 0,
        totalMs,
        budget,
        logDir,
        shards: all.map(({ id, code, ms, skipped: wasSkipped, logPath }) => ({ id, code, ms, skipped: !!wasSkipped, logPath })),
      },
      null,
      2,
    ),
  )
} else {
  for (const result of failed) {
    console.log(`\n${'='.repeat(72)}\nFAILED: ${result.label}   (full log: ${result.logPath})\n${'='.repeat(72)}`)
    const tail = result.output.trimEnd().split('\n').slice(-40)
    console.log(tail.join('\n'))
  }
  console.log(`\n${'-'.repeat(72)}`)
  console.log(
    `${failed.length === 0 && skipped.length === 0 ? 'PASS' : 'FAIL'} in ${seconds(totalMs)} — ` +
      `${all.length - failed.length - skipped.length} green, ${failed.length} red, ${skipped.length} skipped`,
  )
  if (failed.length > 0) console.log(`red: ${failed.map((result) => result.label).join(', ')}`)
  console.log(`logs: ${logDir}`)
}

process.exit(failed.length === 0 && skipped.length === 0 ? 0 : 1)
