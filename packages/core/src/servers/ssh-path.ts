import { connect, type Socket } from 'node:net'
import { DEFAULT_SSH_PORT } from '../bootstrap/push.js'
import type { ServerRow } from '../db/schema.js'

/**
 * Is the SSH path to one box open, and if it is not, is the whitelist the reason?
 *
 * ISSUE #304, the half the issue itself calls the point of the exercise: "the diagnosis is".
 * A laptop that moves — home to office, office to a cafe, a fresh ISP lease — loses SSH to
 * every box on a cloud that enforces `sshAllowedCidr`, and until now the product said nothing.
 * The operator got a hanging `ssh` with no output, no error and no timeout worth reading, and
 * had to reach "my address changed and the security group still names the old one" entirely on
 * their own. `network/routes.ts` can now push the corrected list at the clouds without a server
 * launch; this file is what tells someone that pushing it is the thing to do.
 *
 * TWO RULES SHAPE EVERY LINE BELOW.
 *
 * 1. NEVER CLAIM TO KNOW THE OPERATOR'S ADDRESS (owner ruling, binding). There is no "what is
 *    my IP" call here, no socket-peer sniffing, no `X-Forwarded-For`. The earlier prototype
 *    that discovered the address at runtime was removed on purpose (`docs/providers/aws.md`):
 *    it broke silently when the network changed, it made a third party's availability decide a
 *    firewall rule, and it hid a security decision inside runtime behaviour where no reviewer
 *    saw it. `provider-aws/src/provider.test.ts` greps provider source for exactly that and
 *    SECURITY.md promises it. So the strongest claim anything here makes is the one the owner
 *    wrote down: *the path from this machine to the box appears filtered*. What goes in the
 *    whitelist stays the operator's decision, typed by them, diffable in the config file.
 *
 * 2. AN ADVISORY THAT CRIES WOLF IS WORSE THAN NO ADVISORY. "Check your firewall" said to
 *    someone whose real problem is a wrong key or a changed host key is not merely unhelpful,
 *    it sends them to edit a security setting that was correct — and the setting they would be
 *    widening is the one thing standing between the internet and a box that runs agent-authored
 *    code and holds a git token. So the whole design is a set of ways NOT to say it:
 *    `classifyRecordedSshFailure` returns `'none'` for anything it cannot place, an auth
 *    failure and a host-key mismatch are recorded as PROOF THE PATH IS FINE (packets arrived,
 *    the far end answered, it just did not like us), a refusal is reported as its own thing
 *    rather than folded into "filtered", and `assessSshPath` refuses to point at the CIDR
 *    setting on a cloud whose provider does not manage one.
 *
 * WHAT THIS FILE DOES NOT DO: prose. Every sentence the operator reads is written in
 * `ServerDetailPage.tsx`, which is also the only place the `curl -4 ifconfig.me` suggestion may
 * live — it is something the OPERATOR runs, never something the product calls, and keeping the
 * string out of every non-UI package is what keeps that distinction impossible to blur. Here
 * there are only facts and a verdict.
 */

/* ------------------------------------------------------------------ the record */

/**
 * What the last SSH failure core wrote down was, as far as it can honestly be classified.
 *
 *  - `no-answer`   nothing came back at all: a connect that timed out, a handshake that never
 *                  started, a route that does not exist. THE ONLY CLASS THAT SUGGESTS A
 *                  WHITELIST PROBLEM — a dropped packet is what a firewall rule that does not
 *                  name you looks like from the outside.
 *  - `refused`     the far end sent a reset. Packets are arriving and being answered, so the
 *                  path is open and sshd is simply not listening.
 *  - `auth`        the far end completed a TCP connection and a key exchange and then rejected
 *                  the credential. The path is open.
 *  - `host-key`    the far end presented a key that is not the pinned one. The path is open,
 *                  and this is the one SSH error that must never be retried or explained away.
 *  - `none`        nothing to classify, or nothing classifiable. The default, deliberately.
 */
export type RecordedSshFailure = 'no-answer' | 'refused' | 'auth' | 'host-key' | 'none'

/**
 * The strings core actually stores, in the order they must be tested.
 *
 * These are not invented vocabulary: they are what ends up in `servers.error_message` after
 * `supervisor.ts` stringifies a failed drive and `provision-ticker.ts` writes it onto the row.
 * A drive that could not connect fails as
 *
 *   bootstrap failed after 3 attempts: Error: SSH never became ready on 203.0.113.7 after
 *   12 attempts: connect ETIMEDOUT 203.0.113.7:22
 *
 * and THAT SENTENCE IS THE TRAP THIS ORDERING EXISTS FOR. "SSH never became ready" is not
 * evidence of anything: `waitForSsh` retries authentication failures on purpose — sshd accepts
 * connections before cloud-init has written `authorized_keys`, so a healthy box legitimately
 * refuses the first few attempts — which means a box with the wrong key ALSO ends its life with
 * "SSH never became ready", carrying `All configured authentication methods failed` as the
 * cause. Matching the outer sentence would call that a network problem and send its owner to
 * widen a firewall rule. Only the innermost cause is read, and the specific classes are tested
 * before the vague one.
 */
const RECORDED_PATTERNS: ReadonlyArray<readonly [RecordedSshFailure, RegExp]> = [
  // First, because `HostKeyMismatchError` is the one failure that stops a drive dead and the one
  // an operator must never be told to solve with a firewall edit.
  ['host-key', /host key mismatch/i],
  // ssh2's own wording, plus the two OpenSSH phrasings a message may have been copied from.
  ['auth', /All configured authentication methods failed|Authentication failure|Permission denied \(publickey/i],
  ['refused', /ECONNREFUSED/],
  // Last: a timeout is what remains once nothing more specific matched. `Timed out while waiting
  // for handshake` is ssh2's `readyTimeout` firing, which on a dropped SYN is what happens long
  // before the kernel's own connect timeout does — so it is the COMMON symptom of a filtered
  // path, not the rare one.
  ['no-answer', /ETIMEDOUT|Timed out while waiting for handshake|EHOSTUNREACH|ENETUNREACH/i],
]

/** Rows whose stored failure is worth reading at all. */
type ClassifiableRow = Pick<ServerRow, 'status' | 'errorMessage' | 'bootstrapMode' | 'bootstrapReport'>

/**
 * Classify the last SSH outcome core recorded for a server, from what is ALREADY STORED.
 *
 * No new network traffic, no poller, no column: the answer is derived from `errorMessage` and
 * `bootstrapReport`, both of which have been written by the bootstrap path since ADR-0010. That
 * is the whole point — a diagnosis that costs nothing is one that can be offered on every page
 * load without anyone having to decide whether it is worth the round trip.
 *
 * TWO GUARDS RETURN `'none'` BEFORE ANY PATTERN IS TESTED.
 *
 * A row that is `stopped` or `terminated` has no machine listening, so its last failure explains
 * nothing about the network — and "the path appears filtered" said about a box that is switched
 * off is exactly the false alarm rule 2 forbids. `requested` is the same: nothing has dialled
 * anything yet.
 *
 * A PUSH-MODE row with a bootstrap report is proof of the opposite fact: core reached the box,
 * authenticated, and read the journal off it over SSH before that step failed. Whatever went
 * wrong there, the SSH path was open at the time, and the report is better evidence of that than
 * any string in `errorMessage`. The guard is limited to push mode deliberately: a callback-mode
 * report arrived over HTTP from the box outbound, which says nothing at all about whether
 * anyone can reach it inbound.
 */
export function classifyRecordedSshFailure(row: ClassifiableRow): RecordedSshFailure {
  if (row.status === 'stopped' || row.status === 'terminated' || row.status === 'requested') return 'none'
  if (row.bootstrapMode === 'push' && row.bootstrapReport) return 'none'

  const message = row.errorMessage
  if (!message) return 'none'
  for (const [kind, pattern] of RECORDED_PATTERNS) {
    if (pattern.test(message)) return kind
  }
  return 'none'
}

/* ------------------------------------------------------------------ the probe */

/**
 * What one TCP connection to the box's SSH port did.
 *
 * `filtered` and `unreachable` are kept apart even though they advise the same thing, because
 * they are different observations: silence for the whole budget versus the network stack
 * refusing to even try. Reporting one as the other would put a claim in the record that nobody
 * made.
 */
export type ProbeResult = 'open' | 'refused' | 'filtered' | 'unreachable' | 'error' | 'not-attempted'

export interface ProbeOutcome {
  result: ProbeResult
  /** The port dialled — or the port that would have been dialled, for `not-attempted`. */
  port: number
  elapsedMs: number
  /** The system error code or the reason nothing was attempted. Never an address. */
  detail?: string
}

/**
 * How long to wait for silence to mean something. Four seconds is a page-load budget, not a
 * network one: a box that has not completed a TCP handshake from a cloud host in four seconds
 * is not going to finish it while somebody watches a spinner, and the probe is re-runnable from
 * the page by hand.
 */
export const PROBE_TIMEOUT_MS = 4000

/** Injected in tests. The real one is `node:net`'s. */
export type Dialer = (options: { host: string; port: number }) => Socket

/**
 * One TCP connection to `host:port`, opened and immediately dropped.
 *
 * A BARE TCP CONNECT AND NOTHING MORE. No SSH banner is read, no key exchange is started, no
 * credential is offered — this asks the single question the diagnosis needs ("do packets reach
 * this port and come back") and asks nothing it would then have to be trusted with. It is also
 * why the result cannot be confused with a working login: `open` means the path is open, which
 * is precisely the claim being made.
 *
 * The three outcomes that matter are the three ways a packet can end:
 *
 *  - the handshake completes            → `open`      the path is fine, look elsewhere
 *  - a reset comes back (ECONNREFUSED)  → `refused`   the path is fine, sshd is not listening
 *  - nothing comes back at all          → `filtered`  something is dropping packets
 *
 * That middle case is the one that earns this probe its place. A whitelist DROPS; it does not
 * refuse. So a refusal is positive proof that the whitelist is not the problem, and saying so is
 * worth as much as saying the opposite.
 */
export async function probeSshPath(
  target: { host: string; port?: number; timeoutMs?: number },
  dial: Dialer = connect,
): Promise<ProbeOutcome> {
  const port = target.port ?? DEFAULT_SSH_PORT
  const timeoutMs = target.timeoutMs ?? PROBE_TIMEOUT_MS
  const started = Date.now()

  return new Promise<ProbeOutcome>((resolve) => {
    let settled = false
    const socket = dial({ host: target.host, port })

    const done = (result: ProbeResult, detail?: string) => {
      if (settled) return
      settled = true
      // Destroy before resolving, always: a probe that leaves a socket open on every page load
      // would leak one file descriptor per mount, and the connection has already told us
      // everything it is ever going to.
      socket.destroy()
      resolve({ result, port, elapsedMs: Date.now() - started, ...(detail ? { detail } : {}) })
    }

    socket.setTimeout(timeoutMs)
    socket.on('connect', () => done('open'))
    socket.on('timeout', () => done('filtered', `no answer within ${timeoutMs}ms`))
    socket.on('error', (err: NodeJS.ErrnoException) => {
      const code = err.code ?? 'error'
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return done('refused', code)
      if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return done('unreachable', code)
      if (code === 'ETIMEDOUT') return done('filtered', code)
      // A name that does not resolve, a socket the OS would not open: real failures, but not
      // failures of the PATH, and reporting them as filtered would be a guess.
      done('error', code)
    })
  })
}

/* ------------------------------------------------------------------ the verdict */

export type SshPathAdvisoryKind = 'filtered' | 'refused'

export interface SshPathAdvisory {
  kind: SshPathAdvisoryKind
  /** `probe` is what a connection did just now; `record` is what core wrote down earlier. */
  source: 'probe' | 'record'
  /**
   * Whether THIS cloud has an SSH whitelist Rocky Surf maintains — `capabilities.managesSshAccess`,
   * never a provider id (ADR-0021, and `scripts/check-core-deps.mjs` makes the alternative
   * impossible anyway). Hetzner creates no firewall object at all, so a filtered path on a
   * Hetzner box is a fact about somebody else's network and must not be answered with "edit
   * `sshAllowedCidr`" — there is nothing there to edit.
   */
  whitelistManaged: boolean
}

export interface SshPathAssessment {
  probe: ProbeOutcome
  recorded: RecordedSshFailure
  whitelistManaged: boolean
  /** Null means say nothing, which is the answer whenever the evidence does not support a claim. */
  advisory: SshPathAdvisory | null
}

export interface AssessSshPathInput {
  probe: ProbeOutcome
  recorded: RecordedSshFailure
  whitelistManaged: boolean
}

/**
 * Turn one probe and one recorded failure into either an advisory or silence.
 *
 * PRECEDENCE: THE LIVE PROBE WINS, INCLUDING WHEN IT WINS BY SAYING NOTHING IS WRONG. A box
 * whose bootstrap died on a bad key months ago and whose port answers now has an open path, and
 * the record is stale history. The record is consulted only where the probe has nothing to say —
 * a box that is not running, so nothing was dialled — which is also where it is most valuable:
 * a `failed` row whose bootstrap could never connect is the case the operator most needs
 * explained, and it is the one case where there is no live connection to make.
 *
 * The silences are the design:
 *
 *  - `open` says nothing. The path works; whatever the operator's problem is, it is not this.
 *  - `error` says nothing. A name that will not resolve is a real problem and not this one.
 *  - a recorded `auth` or `host-key` says nothing, ever. Those are proof the packets ARRIVED.
 *  - `whitelistManaged` narrows the advice but never suppresses it: a filtered path is still
 *    worth reporting on a cloud with no whitelist, it just must not be blamed on one.
 */
export function assessSshPath(input: AssessSshPathInput): SshPathAssessment {
  const base = { probe: input.probe, recorded: input.recorded, whitelistManaged: input.whitelistManaged }
  const advise = (kind: SshPathAdvisoryKind, source: 'probe' | 'record'): SshPathAssessment => ({
    ...base,
    advisory: { kind, source, whitelistManaged: input.whitelistManaged },
  })

  switch (input.probe.result) {
    case 'open':
    case 'error':
      return { ...base, advisory: null }
    case 'refused':
      return advise('refused', 'probe')
    case 'filtered':
    case 'unreachable':
      return advise('filtered', 'probe')
    case 'not-attempted':
      break
  }

  if (input.recorded === 'no-answer') return advise('filtered', 'record')
  if (input.recorded === 'refused') return advise('refused', 'record')
  return { ...base, advisory: null }
}

/**
 * Whether it is honest to dial this row at all.
 *
 * ONLY A RUNNING BOX. A stopped or terminated machine is not listening by definition, and a
 * provisioning one may not have finished booting sshd — probing either would manufacture a
 * `filtered` result out of a machine that is simply off, which is the false alarm this whole
 * file is arranged to avoid. Those rows fall through to the recorded classification, which knows
 * their statuses and stays quiet for them too.
 */
export function probeReason(row: Pick<ServerRow, 'status' | 'publicIp'>): string | undefined {
  if (row.status !== 'running') return `not probed: this server is ${row.status}, so nothing should be listening`
  if (!row.publicIp) return 'not probed: core has no address for this server'
  return undefined
}
