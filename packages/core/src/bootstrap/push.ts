import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Client } from 'ssh2'
import { fingerprintFromBlob } from '../ssh/keys.js'
import { AGENT_SCRIPT_PATH, AGENT_STATE_DIR } from './index.js'
import type { InstallPlan } from './plan.js'
import { shellQuote } from './shell.js'

/**
 * Push-mode bootstrap: core connects outbound, delivers everything, and watches.
 *
 * Ported from the spike (`spike/src/push.ts`, rockysurf-d0no.5/.7), which ran this path on
 * real AWS and Hetzner instances. The behaviours below are not preferences — each one is a
 * conformance item from `docs/bootstrap-contract.md` and each was learned from something that
 * went wrong:
 *
 *  - #15 host-key verification is STRICT on the first connection, with no trust-on-first-use
 *    path, because the first connection is the one carrying the secrets file;
 *  - early AUTH failures are retried but a host-key MISMATCH never is — sshd accepts
 *    connections before cloud-init has written authorized_keys, so a healthy box legitimately
 *    refuses the first few attempts, while a mismatch is the one error that must stop;
 *  - #12 secrets.env is created 0600 in the same call that writes it, and callback.env is
 *    NEVER written in push mode: the box gets no core credential at all;
 *  - #10 the agent runs under a transient systemd unit so it survives the SSH session, with a
 *    nohup fallback for images without systemd;
 *  - #11 liveness is asked of the LAUNCHER through sudo, not inferred from file staleness,
 *    and two consecutive negatives are required before declaring the agent gone;
 *  - #4 state.json is filtered by runId, so a push to an already-bootstrapped box cannot read
 *    the previous run's terminal status as its own result.
 */

export interface PushTarget {
  host: string
  port?: number
  user?: string
  /** OpenSSH-format private key whose public half cloud-config authorized. */
  privateKey: string
  /** "SHA256:..." of the host key core minted. REQUIRED — there is no TOFU path here. */
  hostKeyFingerprint: string
}

export interface AgentStepState {
  id: string
  reports: string
  status: 'pending' | 'running' | 'done' | 'failed'
  startedAt?: string
  finishedAt?: string
  /** The step's own log tail, journalled by the agent when the step fails (ADR-0010). */
  logTail?: string
}

export interface AgentState {
  planVersion: number
  serverId: string
  runId?: string
  step: string
  status: 'running' | 'done' | 'failed'
  updatedAt: string
  failedStep?: string
  logTail?: string
  /**
   * One line on why the current step is taking longer than it looks — the agent's apt wait
   * (#129) is the first. Present only while the reason applies; the agent deletes it after.
   */
  notice?: string
  steps: AgentStepState[]
}

/**
 * How the agent was kept alive after the SSH session ended.
 *
 * `simulated` is not something this file ever returns: it is what a provider with no machine
 * reports (`simulated-bootstrap.ts`, ADR-0003 amendment E15), and it lives in this union so a
 * result can never claim a launcher that did not launch anything.
 */
export type Launcher = 'systemd-run' | 'nohup' | 'simulated'

export interface PushResult {
  launcher: Launcher
  state: AgentState
  durationMs: number
  runId: string
  /** Steps the agent skipped because the journal already had them done. */
  skipped: string[]
  /**
   * The logs of every step the journal says failed, read off the box before the connection
   * closed (ADR-0010). Keyed by step id; `complete` says whether the tail is the whole file.
   * Absent when nothing failed.
   */
  stepLogs?: Record<string, { log: string; complete: boolean }>
  /** The agent's own log, last lines — where the exit codes live. */
  agentLogTail?: string
}

export class HostKeyMismatchError extends Error {
  override readonly name = 'HostKeyMismatchError'
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`host key mismatch: expected ${expected}, host presented ${actual}`)
  }
}

export class BootstrapAgentGoneError extends Error {
  override readonly name = 'BootstrapAgentGoneError'
  constructor(launcher: Launcher, step: string) {
    super(`bootstrap agent is gone (launcher=${launcher}) with the plan unfinished at step '${step}'`)
  }
}

/**
 * The port to dial when nobody said otherwise — every image core provisions itself, because
 * core wrote its cloud-config. A provider that adopts a machine it did not create reports the
 * operator's choice instead (ADR-0003, E13), and that value reaches here on `PushTarget.port`.
 */
export const DEFAULT_SSH_PORT = 22

const DEFAULTS = { port: DEFAULT_SSH_PORT, user: 'rocky' }
const UNIT = 'rockysurf-bootstrap'

/* ------------------------------------------------------------------ state journal */

/**
 * Parse a journal, or return null.
 *
 * Returning null for garbage rather than throwing is what lets the poller treat a torn or
 * absent file as "no news yet". The agent renames its temp file into place, so a torn read is
 * rare — but "rare" over thousands of polls is "eventually".
 */
export function parseAgentState(raw: string): AgentState | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const s = parsed as Partial<AgentState>
  if (typeof s.status !== 'string' || typeof s.step !== 'string' || !Array.isArray(s.steps)) return null
  if (s.status !== 'running' && s.status !== 'done' && s.status !== 'failed') return null
  return {
    planVersion: typeof s.planVersion === 'number' ? s.planVersion : 0,
    serverId: typeof s.serverId === 'string' ? s.serverId : '',
    runId: typeof s.runId === 'string' && s.runId ? s.runId : undefined,
    step: s.step,
    status: s.status,
    updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : '',
    failedStep: typeof s.failedStep === 'string' ? s.failedStep : undefined,
    logTail: typeof s.logTail === 'string' ? s.logTail : undefined,
    notice: typeof s.notice === 'string' && s.notice ? s.notice : undefined,
    steps: s.steps.filter((x): x is AgentStepState => !!x && typeof x.id === 'string'),
  }
}

/** Conformance #4: a journal only counts when it belongs to the run core is waiting on. */
export function isCurrentRun(state: AgentState | null, runId: string): state is AgentState {
  return !!state && state.runId === runId
}

export function completedSteps(state: AgentState | null): string[] {
  return (state?.steps ?? []).filter((s) => s.status === 'done').map((s) => s.id)
}

/* ------------------------------------------------------------------ ssh plumbing */

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export function exec(client: Client, command: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err)
      let stdout = ''
      let stderr = ''
      stream.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
      stream.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
      stream.on('close', (code: number | null) => resolve({ code: code ?? -1, stdout, stderr }))
      stream.on('error', reject)
    })
  })
}

export async function execOk(client: Client, command: string): Promise<string> {
  const r = await exec(client, command)
  if (r.code !== 0) throw new Error(`remote command failed (${r.code}): ${command}\n${r.stderr || r.stdout}`)
  return r.stdout
}

function connectOnce(target: PushTarget, readyTimeout: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let mismatch: HostKeyMismatchError | undefined

    client
      .on('ready', () => resolve(client))
      .on('error', (err) => {
        client.end()
        // ssh2 reports a rejected host key as a generic handshake error, so the specific
        // failure is captured in the verifier and rethrown here: the caller has to be able to
        // tell "not up yet" (retry) from "wrong host" (stop).
        reject(mismatch ?? err)
      })
      .connect({
        host: target.host,
        port: target.port ?? DEFAULTS.port,
        username: target.user ?? DEFAULTS.user,
        privateKey: target.privateKey,
        readyTimeout,
        hostVerifier: (key: Buffer) => {
          const actual = fingerprintFromBlob(key)
          if (actual === target.hostKeyFingerprint) return true
          mismatch = new HostKeyMismatchError(target.hostKeyFingerprint, actual)
          return false
        },
      })
  })
}

export interface WaitOptions {
  timeoutMs?: number
  readyTimeoutMs?: number
  onAttempt?: (attempt: number, err: Error) => void
}

export async function waitForSsh(target: PushTarget, opts: WaitOptions = {}): Promise<Client> {
  const timeoutMs = opts.timeoutMs ?? 300_000
  const readyTimeout = opts.readyTimeoutMs ?? 10_000
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  let last: Error = new Error('no attempt made')

  while (Date.now() < deadline) {
    attempt++
    try {
      return await connectOnce(target, readyTimeout)
    } catch (err) {
      if (err instanceof HostKeyMismatchError) throw err
      last = err as Error
      opts.onAttempt?.(attempt, last)
      const backoff = Math.min(1000 * 1.5 ** (attempt - 1), 8000)
      await sleep(Math.min(backoff, Math.max(0, deadline - Date.now())))
    }
  }
  throw new Error(`SSH never became ready on ${target.host} after ${attempt} attempts: ${last.message}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/* ------------------------------------------------------------------ the push */

export interface PushOptions {
  target: PushTarget
  plan: InstallPlan
  /** Defaults to the packaged agent. Injected in tests. */
  agentScript?: string
  /**
   * KEY=value pairs written to `secrets.env` at 0600 — the git token and friends.
   *
   * These are the INSTALLED SOFTWARE's secrets. Core's own control-plane credentials never go
   * here, and in push mode there are none on the box at all: no callback.env is written,
   * because nothing on the box ever calls core.
   */
  secrets?: Record<string, string>
  stateDir?: string
  pollIntervalMs?: number
  /** Give up if the journal has not advanced for this long, with the agent still alive. */
  stallTimeoutMs?: number
  /** Live output for the UI. UX only — the journal is the truth. */
  onLog?: (line: string) => void
  onState?: (state: AgentState) => void
  /** Forces a launcher. Tests use it to exercise the fallback deliberately. */
  forceLauncher?: Launcher
  /** Overrides the generated run id. Tests only. */
  runId?: string
}

/**
 * The body of `secrets.env`: one `KEY='value'` line per entry, no trailing newline.
 *
 * EVERY VALUE IS SINGLE-QUOTED (issue #189, ADR-0013).
 *
 * `agent.sh` loads this file with `set -a; . secrets.env`, so each line is shell SOURCE, not
 * data. Unquoted, a value with a space (`FOO=a b`) runs `b` as a command with `FOO` set, and a
 * value containing `$(…)` or a backtick executes on the box as root. That was survivable while
 * every value was a shape core controlled — a GitHub PAT, a desktop password, a
 * `host/owner/repo` scope whose character class the config schema restricts precisely so this
 * file stays sourceable — and it stopped being survivable the moment a pack input started
 * carrying whatever a person typed into a form field.
 *
 * Single quotes are the only bash form with no escape sequences inside them, so this is a total
 * escape rather than a filter: `shellQuote` closes the quote, emits an escaped `'`, and reopens.
 * The one thing quoting cannot fix is a NEWLINE — the agent re-reads this file line by line to
 * learn the variable NAMES it forwards into unprivileged steps, so a second line would read as a
 * second name — which is why `packInputValueSchema` and the create route refuse one instead.
 *
 * Reading is unaffected: the name is still everything before the first `=`.
 *
 * Exported so a test can source the real output with a real bash rather than asserting on text.
 */
export function renderSecretsEnv(secrets: Record<string, string>): string {
  return Object.entries(secrets)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join('\n')
}

export async function pushBootstrap(client: Client, opts: PushOptions): Promise<PushResult> {
  const started = Date.now()
  const dir = opts.stateDir ?? AGENT_STATE_DIR
  const user = opts.target.user ?? DEFAULTS.user
  const agentScript = opts.agentScript ?? readFileSync(AGENT_SCRIPT_PATH, 'utf8')

  await execOk(client, `sudo mkdir -p ${q(dir)}/steps && sudo chown -R ${q(user)} ${q(dir)} && sudo chmod 755 ${q(dir)}`)

  const before = parseAgentState(await readRemote(client, `${dir}/state.json`))
  const alreadyDone = completedSteps(before)
  const running = await agentIsRunning(client, dir)
  const runId = opts.runId ?? adoptableRunId(before, running, opts.plan.serverId) ?? randomUUID()

  await writeRemote(client, `${dir}/agent.sh`, agentScript, 0o700)
  await writeRemote(client, `${dir}/plan.json`, `${JSON.stringify({ ...opts.plan, runId }, null, 2)}\n`, 0o644)
  if (opts.secrets && Object.keys(opts.secrets).length > 0) {
    // Mode is set in the call that CREATES the file: a secrets file that is briefly
    // world-readable before a chmod lands has already leaked.
    await writeRemote(client, `${dir}/secrets.env`, `${renderSecretsEnv(opts.secrets)}\n`, 0o600)
  }

  const launcher = await launchAgent(client, dir, running, opts.forceLauncher)
  const stopStreaming = opts.onLog ? streamLogs(client, dir, launcher, opts.onLog) : undefined
  try {
    const state = await pollState(client, dir, opts, launcher, runId)
    // The evidence, read while the connection is still open (ADR-0010). A failed tool install
    // terminates the box a tick after this returns, so whatever is not read here is gone; and
    // an optional step that failed — a repository that did not clone — has its reason only in
    // its own log file. The journal's 25-line tail was never enough to say why.
    const captured = await captureStepLogs(client, dir, state)
    return {
      launcher,
      state,
      durationMs: Date.now() - started,
      runId,
      skipped: alreadyDone,
      ...(Object.keys(captured.stepLogs).length > 0 ? { stepLogs: captured.stepLogs } : {}),
      ...(captured.agentLogTail ? { agentLogTail: captured.agentLogTail } : {}),
    }
  } finally {
    stopStreaming?.()
  }
}

/** How much of a step's log core keeps. A whole build log can run to megabytes; the verdict is at the end. */
export const STEP_LOG_CAPTURE_BYTES = 64 * 1024
const AGENT_LOG_TAIL_LINES = 200

/**
 * The tail of a remote file plus whether that tail IS the file. One round trip: the size on
 * the first line, the bytes after it, so `logComplete` is a fact core measured rather than a
 * guess from the tail's length.
 */
async function readRemoteTail(client: Client, path: string, bytes: number): Promise<{ log: string; complete: boolean } | undefined> {
  const r = await exec(client, `f=${q(path)}; [ -f "$f" ] || exit 3; wc -c <"$f"; tail -c ${bytes} "$f"`)
  if (r.code !== 0) return undefined
  const newline = r.stdout.indexOf('\n')
  if (newline < 0) return undefined
  const size = Number(r.stdout.slice(0, newline).trim())
  const log = r.stdout.slice(newline + 1)
  return { log, complete: Number.isFinite(size) ? size <= bytes : false }
}

async function captureStepLogs(
  client: Client,
  dir: string,
  state: AgentState,
): Promise<{ stepLogs: Record<string, { log: string; complete: boolean }>; agentLogTail?: string }> {
  const failed = state.steps.filter((s) => s.status === 'failed').map((s) => s.id)
  if (state.status === 'failed') {
    const id = state.failedStep ?? state.step
    if (id && !failed.includes(id)) failed.push(id)
  }
  if (failed.length === 0) return { stepLogs: {} }

  const stepLogs: Record<string, { log: string; complete: boolean }> = {}
  for (const id of failed) {
    try {
      const captured = await readRemoteTail(client, `${dir}/steps/${id}.log`, STEP_LOG_CAPTURE_BYTES)
      if (captured) stepLogs[id] = captured
    } catch {
      // Best effort: a log that cannot be read leaves the journal's own tail as the evidence.
    }
  }
  let agentLogTail: string | undefined
  try {
    const r = await exec(client, `tail -n ${AGENT_LOG_TAIL_LINES} ${q(`${dir}/agent.log`)} 2>/dev/null`)
    if (r.code === 0 && r.stdout.trim()) agentLogTail = r.stdout
  } catch {
    // Same.
  }
  return { stepLogs, ...(agentLogTail ? { agentLogTail } : {}) }
}

async function readRemote(client: Client, path: string): Promise<string> {
  const r = await exec(client, `cat ${q(path)} 2>/dev/null`)
  return r.code === 0 ? r.stdout : ''
}

function writeRemote(client: Client, path: string, contents: string, mode: number): Promise<void> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err)
      sftp.writeFile(path, contents, { mode }, (werr) => (werr ? reject(werr) : resolve()))
    })
  })
}

/** Conformance #10. The unit flags are the contract, not a preference. */
export function systemdRunCommand(dir: string): string {
  return [
    `sudo systemd-run --unit=${UNIT} --collect`,
    '--property=Type=exec',
    '--property=Restart=on-failure',
    '--property=RestartSec=10',
    '--property=StartLimitBurst=3',
    '--property=StartLimitIntervalSec=600',
    '--property=After=network-online.target',
    `/bin/bash ${q(`${dir}/agent.sh`)}`,
  ].join(' ')
}

/**
 * `[b]ash` so the pattern cannot match the shell carrying it — without the bracket, pgrep finds
 * this very command and every push decides the agent is already running.
 */
async function agentIsRunning(client: Client, dir: string): Promise<boolean> {
  const r = await exec(client, `pgrep -f ${q(`[b]ash ${dir}/agent.sh`)} >/dev/null`)
  return r.code === 0
}

/**
 * Join the run already in progress instead of minting an id it will never stamp.
 *
 * `init_state` in agent.sh reads the run id from plan.json ONCE, at launch. So a push that
 * finds a live agent — which is exactly what a re-push after a core restart finds — must not
 * mint a fresh id: nothing would relaunch the agent (correctly, it is working), the journal
 * would keep carrying the previous id, `isCurrentRun` would reject every update as a foreign
 * run, and the push would watch a healthy install in silence until the stall timeout fired
 * fifteen minutes later. Adopting the live run's id turns that into a resume.
 *
 * Conformance #4 is preserved, and the conditions are what preserve it: the agent must be
 * ALIVE and its journal must be `running` and for THIS server. A terminal journal from a
 * finished run is never adopted, so a re-push to an already-bootstrapped box still cannot read
 * the previous attempt's result as its own.
 */
export function adoptableRunId(before: AgentState | null, agentAlive: boolean, serverId: string): string | undefined {
  if (!agentAlive || !before?.runId) return undefined
  if (before.status !== 'running' || before.serverId !== serverId) return undefined
  return before.runId
}

async function launchAgent(client: Client, dir: string, alreadyRunning: boolean, forced?: Launcher): Promise<Launcher> {
  if (alreadyRunning) return (await hasSystemd(client)) ? 'systemd-run' : 'nohup'

  const useSystemd = forced ? forced === 'systemd-run' : await hasSystemd(client)
  if (useSystemd) {
    await exec(client, `sudo systemctl reset-failed ${UNIT} 2>/dev/null`)
    await execOk(client, systemdRunCommand(dir))
    return 'systemd-run'
  }

  // No systemd: setsid detaches from the session so closing the SSH channel cannot SIGHUP the
  // agent, and every fd is redirected so it never blocks on a pipe with no reader.
  await execOk(
    client,
    `setsid nohup sudo -n /bin/bash ${q(`${dir}/agent.sh`)} </dev/null >>${q(`${dir}/agent.log`)} 2>&1 & echo started`,
  )
  return 'nohup'
}

async function hasSystemd(client: Client): Promise<boolean> {
  const r = await exec(client, 'test -d /run/systemd/system && command -v systemd-run >/dev/null')
  return r.code === 0
}

function streamLogs(client: Client, dir: string, launcher: Launcher, onLog: (line: string) => void): () => void {
  const cmd =
    launcher === 'systemd-run'
      ? // sudo, because the login user is not in `adm`/`systemd-journal` on a stock image and
        // would otherwise silently stream its own empty user journal.
        `sudo journalctl -u ${UNIT} -f -n 100 --no-pager`
      : `touch ${q(`${dir}/agent.log`)}; tail -n 100 -F ${q(`${dir}/agent.log`)}`
  let closed = false
  let kill: (() => void) | undefined

  client.exec(cmd, (err, stream) => {
    if (err || closed) return
    kill = () => stream.close()
    let buf = ''
    stream.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) onLog(line)
    })
    stream.on('error', () => {})
  })

  return () => {
    closed = true
    kill?.()
  }
}

/** Conformance #11: ask the launcher, and ask it with privilege. */
async function isAgentAlive(client: Client, dir: string, launcher: Launcher): Promise<boolean> {
  if (launcher === 'systemd-run') {
    // Unprivileged `systemctl is-active` fails with "Failed to connect to bus" whenever dbus
    // is unreachable, which reads as "not running" to any caller checking the exit code —
    // that is how core declared a healthy bootstrap dead during the spike.
    const r = await exec(client, `sudo systemctl is-active ${UNIT}`)
    const s = r.stdout.trim()
    return s === 'active' || s === 'activating' || s === 'reloading'
  }
  const r = await exec(client, `pgrep -f ${q(`[b]ash ${dir}/agent.sh`)} >/dev/null`)
  return r.code === 0
}

async function pollState(
  client: Client,
  dir: string,
  opts: PushOptions,
  launcher: Launcher,
  runId: string,
): Promise<AgentState> {
  const interval = opts.pollIntervalMs ?? 5000
  const stallMs = opts.stallTimeoutMs ?? 900_000
  let lastSeenAt = Date.now()
  let lastSignature = ''
  let deadStrikes = 0

  for (;;) {
    const journal = parseAgentState(await readRemote(client, `${dir}/state.json`))
    // Until the agent stamps THIS run's id, whatever is on disk belongs to a previous push.
    const state = isCurrentRun(journal, runId) ? journal : null
    if (state) {
      const signature = `${state.step}:${state.status}:${state.updatedAt}`
      if (signature !== lastSignature) {
        lastSignature = signature
        lastSeenAt = Date.now()
        opts.onState?.(state)
      }
      if (state.status === 'done' || state.status === 'failed') return state
    }

    // Two strikes, not one: a just-launched agent can lose the race to the first poll, and a
    // restarting unit blinks through inactive.
    deadStrikes = (await isAgentAlive(client, dir, launcher)) ? 0 : deadStrikes + 1
    if (deadStrikes >= 2) throw new BootstrapAgentGoneError(launcher, state?.step ?? 'none')

    if (Date.now() - lastSeenAt > stallMs) {
      throw new Error(`bootstrap stalled: no journal progress for ${Math.round(stallMs / 1000)}s`)
    }
    await sleep(interval)
  }
}
