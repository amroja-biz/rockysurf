import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

/**
 * A REAL ROCKY SURF, BOOTED FOR THE BROWSER TO DRIVE.
 *
 * This is the whole reason the suite above it can see what the other three test layers could
 * not (issue #310). Unit tests build their own wiring, component tests render one component
 * into jsdom, and the API tests speak HTTP to a `createApp()` assembled by the test. All three
 * were green on the day a settings section rendered no controls at all, and green again on the
 * day the save button dead-locked — because none of them ever loaded the built SPA into a
 * browser engine and clicked the thing an operator clicks.
 *
 * So: the shipped binary (`packages/rockysurf/dist/bin.js`), the built SPA that core serves out
 * of its own process, a configuration file on disk that the settings page writes back to, and a
 * real Chromium. The only things faked are the ones that would otherwise cost money or need the
 * network — see `configYaml` below.
 *
 * NOTHING HERE TOUCHES THE OPERATOR'S INSTALLATION. Every instance gets a fresh `mkdtemp`
 * directory holding its own `config.yaml`, data directory, database and master key, and `HOME`
 * is redirected into it as well, because `~/.rockysurf/config.yaml` is the second place the
 * binary looks for a config and `~/.rockysurf` is the default data directory. A test that
 * leaked would otherwise write into the machine's real one.
 *
 * NO MACHINE-SPECIFIC CONSTANTS (owner ruling, issue #307). The port is whatever the OS hands
 * out and the paths come from `mkdtemp`, so the suite runs on a contributor's laptop, on a
 * machine already running Rocky Surf on 3000, and on several CI workers at once.
 */

const binPath = fileURLToPath(new URL('../../rockysurf/dist/bin.js', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

/**
 * THE ADMIN PASSWORD, GENERATED PER RUN AND NEVER COMMITTED.
 *
 * The owner's instruction for this suite was that it must actually log in — driving the real
 * form, not a cookie injected past it — which means something has to know a password. It is
 * minted here, held in memory for the life of one control plane, and dies with the temp
 * directory; there is no fixture file, no `.env`, and nothing for `gitleaks` to find.
 *
 * `ROCKYSURF_UI_TEST_PASSWORD` overrides it, which is for a person debugging by hand: export
 * it, run the suite headed, and you can sign in to the same instance yourself. It is not for
 * CI and CI does not set it.
 */
function adminPassword(): string {
  return process.env['ROCKYSURF_UI_TEST_PASSWORD'] ?? `ui-${randomBytes(18).toString('base64url')}`
}

/**
 * A port the OS says is free, asked for at the moment it is needed.
 *
 * `listen(0)` then read then close is the same trick `src/test-server.ts` plays for the
 * component suite, and for the same reason: a port picked out of a range collides eventually,
 * and it collides as a timeout in a different file. There is a race between the close here and
 * the bind in the child, which `start()` handles by retrying the whole boot — cheaper and more
 * honest than holding the socket open and hoping SO_REUSEADDR does the right thing.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close()
        reject(new Error('the OS did not report a port'))
        return
      }
      const { port } = address
      probe.close(() => resolve(port))
    })
  })
}

/**
 * The installation these tests drive.
 *
 * BYO IS THE ONLY PROVIDER ON, and that is a deliberate choice rather than a convenience. The
 * New Server page needs a provider that offers machines or it has nothing to draw, and every
 * cloud provider would reach a real API for its offerings — a credential this suite must not
 * have, a network call CI must not depend on, and a bill. BYO's "machine types" are the hosts
 * named right here in this file, so the page renders a complete, honest picker and no packet
 * leaves the machine. The host itself is a documentation-range address that is never dialled:
 * nothing in these flows creates a server.
 *
 * `registry.enabled: false` and `pricing.enabled: false` for the same reason — both are
 * outbound fetches on page load, and a suite whose result depends on GitHub being up is a
 * suite that will be muted within a month.
 */
/**
 * The personal provider fixture (ADR-0026): a plain-JS package beside these tests, named by PATH
 * in the config below. DISABLED, so every test that was written against a BYO-only installation
 * still sees exactly one loaded provider; what it adds is a personal section for the Settings
 * page to draw, and a factory the binary has loaded so a test can switch it on from that page.
 */
const personalProviderDir = fileURLToPath(new URL('./fixtures/personal-provider', import.meta.url))

function configYaml(port: number, dataDir: string, sshPort: number): string {
  return [
    'server:',
    `  port: ${port}`,
    `  dataDir: ${dataDir}`,
    'providers:',
    '  byo:',
    '    enabled: true',
    '    hosts:',
    '      - name: workshop',
    '        host: 127.0.0.1',
    `        port: ${sshPort}`,
    '  nimbus:',
    `    package: ${personalProviderDir}`,
    '    enabled: false',
    '    token: "${NIMBUS_TOKEN}"',
    '    region: sky-1',
    'registry:',
    '  enabled: false',
    'pricing:',
    '  enabled: false',
    '',
  ].join('\n')
}

type ServerProcess = ChildProcessByStdio<null, Readable, Readable>

export interface ControlPlane {
  /** Where the browser points. `http://127.0.0.1:<port>`. */
  readonly origin: string
  /** What the login form is filled with. Generated per instance; see `adminPassword`. */
  readonly password: string
  /** The `config.yaml` the settings page reads and writes. */
  readonly configPath: string
  /** Its current contents, re-read from disk — the persistence assertions' evidence. */
  readConfig(): string
  /** Everything the process wrote to stderr, for a failure message worth reading. */
  log(): string
  stop(): Promise<void>
}

/** How long the binary gets to come up. Generous: CI runners are slow and cold. */
const BOOT_TIMEOUT_MS = 90_000

async function boot(): Promise<ControlPlane> {
  const dir = mkdtempSync(join(tmpdir(), 'rockysurf-ui-'))
  const dataDir = join(dir, 'data')
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  const configPath = join(dir, 'config.yaml')
  const port = await freePort()
  /* The BYO host's SSH port — see `configYaml`. Also from the OS, and deliberately NOT bound:
     a loopback port with no listener refuses instantly, which is the behaviour wanted here. */
  const sshPort = await freePort()
  const password = adminPassword()
  writeFileSync(configPath, configYaml(port, dataDir, sshPort))

  const child: ServerProcess = spawn(process.execPath, [binPath, '--config', configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // `cwd` is the repo root so the binary finds the checkout's `packs/`, which is what the
    // Packs page renders — the same packs a contributor sees when they run it by hand.
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      ROCKYSURF_ADMIN_PASSWORD: password,
      // Not inherited: a contributor with a real installation would otherwise hand this
      // instance their own master key, and every secret it writes would be readable with it.
      ROCKYSURF_SECRET_KEY: '',
      // The personal fixture's credential (`token: "${NIMBUS_TOKEN}"` above). A reference the
      // environment cannot satisfy is a boot error, so the variable exists; the value is nothing.
      NIMBUS_TOKEN: 'nimbus-fixture-token',
    },
  })

  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
  child.stdout.on('data', () => {})

  const origin = `http://127.0.0.1:${port}`
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  let healthy = false
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      rmSync(dir, { recursive: true, force: true })
      throw new Error(`Rocky Surf exited during boot (${child.exitCode}):\n${stderr}`)
    }
    try {
      const res = await fetch(`${origin}/health`)
      if (res.ok) {
        healthy = true
        break
      }
    } catch {
      // Not accepting connections yet.
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  if (!healthy) {
    child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`Rocky Surf never answered /health on ${port} within ${BOOT_TIMEOUT_MS}ms:\n${stderr}`)
  }

  let stopped = false
  return {
    origin,
    password,
    configPath,
    readConfig: () => readFileSync(configPath, 'utf8'),
    log: () => stderr,
    async stop() {
      if (stopped) return
      stopped = true
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000)).then(() => child.kill('SIGKILL'))])
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Boot one, retrying the port race.
 *
 * The only failure this retries is a port that something else took between `freePort` closing
 * its probe and the child binding — a genuine race with a genuinely different outcome next
 * time. Anything else (a missing build, a config the schema refuses) fails the same way twice
 * and is reported at once rather than after three attempts and a minute of waiting.
 */
export async function startControlPlane(): Promise<ControlPlane> {
  let last: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await boot()
    } catch (err) {
      last = err
      const message = err instanceof Error ? err.message : String(err)
      if (!message.includes('EADDRINUSE') && !message.includes('never answered /health')) throw err
    }
  }
  throw new Error(
    `could not start Rocky Surf after 3 attempts. If this says "Cannot find module", the ` +
      `workspace is not built — run \`pnpm -r build\` first.\n${last instanceof Error ? last.message : String(last)}`,
  )
}
