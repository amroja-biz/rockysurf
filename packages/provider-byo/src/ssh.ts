import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ProviderError } from '@rockysurf/provider-sdk'
import { Client } from 'ssh2'

/**
 * The SSH surface BYO is built on, behind one injectable function.
 *
 * Every other provider talks to a REST API it can fake with `fetch`. This one's API is sshd, so
 * the seam has to be here instead: {@link Connector} is what `provider.test.ts` replaces with a
 * fake and what `sshd.test.ts` drives against a real in-process server.
 *
 * HOST-KEY VERIFICATION IS THE POINT OF THIS FILE, not a detail of it. `capabilities
 * .canInjectHostKeys` is `false` for BYO — there is no pre-boot hook, so core cannot mint the
 * key the box will present — and the SDK's answer to that is trust-on-first-use: record the key
 * seen on first contact, refuse any change afterwards. That decision lives HERE rather than in
 * core, and the distinction matters: core's push path pins strictly and has deliberately no TOFU
 * path (`docs/bootstrap-contract.md`, push #15), because the first connection it makes is the one
 * carrying the secrets file. The provider connects FIRST, does the trusting, and hands core a
 * fingerprint — so what reaches core is a pin, not a trust decision, and core's rule stays
 * literally true.
 */

/** `SHA256:…` over a raw public key blob — the value `ssh-keygen -lf` prints. */
export function fingerprintFromBlob(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}

/**
 * The host presented a key that is not the pinned one.
 *
 * A distinct class because it is the one SSH failure that must never be retried: a box answering
 * with a different identity is not the box the operator registered, and the next connection would
 * carry core's authorized key to it.
 */
export class HostKeyMismatchError extends Error {
  override readonly name = 'HostKeyMismatchError'
  constructor(
    readonly host: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`host ${host} presented host key ${actual}, but ${expected} is pinned`)
  }
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface HostConnection {
  /** The fingerprint the host actually presented on this connection. */
  fingerprint: string
  /**
   * The host key ITSELF, as an OpenSSH public-key line (rockysurf-ftl9.14).
   *
   * The handshake hands the verifier the raw key blob and this provider used to hash it and drop
   * the rest. Keeping it is what lets core serve a real `known_hosts` entry for a machine it did
   * not key, which is what lets every generated ssh config keep `StrictHostKeyChecking yes`
   * instead of one class of host being downgraded to a prompt.
   *
   * It is not a secret and not a credential — it is the value the box shouts at every client
   * that connects to it. The FINGERPRINT remains the pin; this key is only ever accepted when it
   * hashes to that pin.
   */
  publicKey: string
  exec(command: string): Promise<ExecResult>
  end(): void
}

/**
 * `ssh-ed25519 AAAA…` from the raw blob the handshake presents.
 *
 * The blob's own first field is its key type, so the line is assembled from the blob rather than
 * from anything the caller believes about it — a blob that disagrees with its own declared type
 * would produce a `known_hosts` line sshd rejects, which is worse than no line at all.
 */
/**
 * The `SHA256:…` of a public-key LINE, or undefined if it is not one.
 *
 * Exists so a key that arrives from storage can be checked against the pin before it is trusted
 * — the pin is the thing that was verified during a handshake, and a key is only ever the answer
 * to "which bytes hash to it".
 */
export function fingerprintFromPublicKeyLine(line: string): string | undefined {
  const b64 = line.trim().split(/\s+/)[1]
  if (!b64) return undefined
  try {
    return fingerprintFromBlob(Buffer.from(b64, 'base64'))
  } catch {
    return undefined
  }
}

export function publicKeyLineFromBlob(blob: Buffer): string {
  if (blob.length < 4) throw new Error('host key blob is too short to carry a type')
  const typeLength = blob.readUInt32BE(0)
  if (typeLength <= 0 || typeLength > 64 || blob.length < 4 + typeLength) {
    throw new Error('host key blob does not begin with a plausible key type')
  }
  const type = blob.subarray(4, 4 + typeLength).toString('utf8')
  if (!/^[a-z0-9@.-]+$/i.test(type)) throw new Error(`host key blob declares an implausible type: ${type}`)
  return `${type} ${blob.toString('base64')}`
}

export interface ConnectOptions {
  host: string
  port: number
  /** The ADMIN login the provider claims with, not the account core later uses. */
  user: string
  /**
   * `SHA256:…` the host must present, or `undefined` for trust-on-first-use.
   *
   * Absent means the caller is prepared to record whatever it sees — which is only ever true for
   * a host whose fingerprint the operator did not supply and which this provider has not yet met.
   */
  pinnedFingerprint?: string
  /** Path to a private key file. Read at connect time; never held beyond the handshake. */
  identityFile?: string
  /** `SSH_AUTH_SOCK`, when the operator's own agent is the credential. */
  agentSocket?: string
  timeoutMs?: number
}

export type Connector = (options: ConnectOptions) => Promise<HostConnection>

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Map an ssh2 failure onto the nine frozen codes, carrying the original text verbatim in
 * `providerCode` (ADR-0003, F1) so an operator can still see what OpenSSH actually said.
 *
 * The mapping that matters is `HostKeyMismatchError` → `auth`, NOT `network`: `auth` is not
 * retryable, and a mismatch retried is a mismatch eventually connected to.
 */
export function toProviderError(err: unknown, host: string): ProviderError {
  if (err instanceof HostKeyMismatchError) {
    return new ProviderError('auth', err.message, { providerCode: 'host_key_mismatch', cause: err })
  }
  const message = err instanceof Error ? err.message : String(err)
  if (/all configured authentication methods failed|no supported authentication/i.test(message)) {
    return new ProviderError('auth', `ssh authentication to ${host} failed: ${message}`, {
      providerCode: 'auth_failed',
      cause: err,
    })
  }
  return new ProviderError('network', `ssh connection to ${host} failed: ${message}`, {
    providerCode: 'ssh_error',
    cause: err,
  })
}

/**
 * The real client.
 *
 * `hostVerifier` is where trust is decided, and it is decided BEFORE authentication: ssh2 calls
 * it during the handshake, so a mismatched host never sees a credential. ssh2 reports a rejected
 * key as a generic handshake failure, so the specific error is captured in the verifier and
 * rethrown from the `error` handler — the caller has to be able to tell "unreachable" from
 * "wrong host", because only one of those is worth retrying.
 */
export const connectOverSsh: Connector = (options) =>
  new Promise<HostConnection>((resolve, reject) => {
    const client = new Client()
    let presented = ''
    let presentedKey = ''
    let mismatch: HostKeyMismatchError | undefined

    const identity = options.identityFile ? readIdentity(options.identityFile) : undefined

    client
      .on('ready', () => {
        resolve({
          fingerprint: presented,
          publicKey: presentedKey,
          exec: (command) => execOn(client, command),
          end: () => client.end(),
        })
      })
      .on('error', (err) => {
        client.end()
        reject(mismatch ?? err)
      })
      .connect({
        host: options.host,
        port: options.port,
        username: options.user,
        ...(identity ? { privateKey: identity } : {}),
        ...(options.agentSocket ? { agent: options.agentSocket } : {}),
        readyTimeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        hostVerifier: (key: Buffer) => {
          presented = fingerprintFromBlob(key)
          // Recorded beside the fingerprint, never instead of it: the pin is still what decides
          // this handshake, two lines below (rockysurf-ftl9.14).
          presentedKey = publicKeyLineFromBlob(key)
          if (!options.pinnedFingerprint) return true // trust-on-first-use; the caller records it
          if (presented === options.pinnedFingerprint) return true
          mismatch = new HostKeyMismatchError(options.host, options.pinnedFingerprint, presented)
          return false
        },
      })
  })

/**
 * Read a key file, expanding a leading `~`.
 *
 * The expansion is here rather than in the config schema because `~` is a SHELL convention that
 * nothing in Node honours, and an operator who writes the same path their `ssh -i` takes should
 * not get "no such file or directory" for a file that plainly exists.
 */
function readIdentity(path: string): Buffer {
  const resolved = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
  try {
    return readFileSync(resolved)
  } catch (err) {
    throw new ProviderError('invalid_spec', `cannot read identityFile '${resolved}': ${String(err)}`, { cause: err })
  }
}

function execOn(client: Client, command: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err)
      let stdout = ''
      let stderr = ''
      stream.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
      stream.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
      stream.on('close', (code: number | null) => resolve({ code: code ?? -1, stdout, stderr }))
      stream.on('error', reject)
    })
  })
}

/** Single-quote a value for `/bin/sh`. The only quoting this package needs. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Run a script on the host, through base64 so nothing in it needs escaping.
 *
 * The scripts below embed operator-supplied names and core-supplied key material. Piping a
 * base64 blob into `sh -s` means the only thing the outer shell ever parses is
 * `[A-Za-z0-9+/=]`, which removes the entire class of quoting bugs rather than trying to be
 * careful about them one string at a time.
 */
export function scriptCommand(script: string, sudo: boolean): string {
  const encoded = Buffer.from(script, 'utf8').toString('base64')
  const shell = sudo ? 'sudo -n /bin/sh -s' : '/bin/sh -s'
  return `printf %s ${shellQuote(encoded)} | base64 -d | ${shell}`
}
