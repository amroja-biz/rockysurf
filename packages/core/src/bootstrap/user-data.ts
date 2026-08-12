import { gzipSync } from 'node:zlib'

/**
 * Pre-boot configuration — BOTH topologies, one module.
 *
 * `renderPushUserData` is the default path (ADR-0002): an inert document that creates the
 * unprivileged user, authorizes core's key, and pins the host key core minted. Nothing else.
 * `renderCallbackUserData` is the fallback for boxes core cannot reach, and it is the one that
 * has to carry the agent in-band.
 *
 * They live together because they share the thing that actually matters — ONE size check
 * against the provider's own ceiling, raising ONE error type, and ONE host-key block. They
 * were briefly separate (rockysurf-55fx.1 wrote the push renderer while this file was in
 * flight), which is exactly how two documents that boot real machines drift apart.
 *
 * SECURITY POSTURE IS NOW THE SAME IN BOTH (rockysurf-55fx.11). The merge deliberately kept
 * two divergences byte-identical rather than changing boot behaviour on the way past; both
 * were then decided on their merits:
 *
 *  - **`lock_passwd: true` in callback documents — ALIGNED.** Password login is disabled in
 *    both, which is what an SSH-key-only design should say out loud. This is not a behaviour
 *    change: cloud-init's own default for `lock_passwd` is already `true`, so the callback
 *    document was locking the account implicitly and the two documents only *looked*
 *    different. Verified safe for the remote-desktop flow, which is the one thing a locked
 *    password could plausibly break: a pack with `requiresRdp` gets a resolver-injected step
 *    (`bootstrap/resolver.ts`) that pipes the password into `chpasswd`, and `chpasswd`
 *    OVERWRITES the shadow field rather than preserving a lock the way `usermod -L` would.
 *    So the account is unusable for password login until that step runs, and usable
 *    afterwards — identical before and after this change.
 *
 *  - **Host-key pinning in callback documents — ALIGNED.** Callback mode needs it exactly as
 *    much as push: core still opens an SSH connection to the box afterwards, and without a
 *    pinned key the first connection has nothing to verify against and falls back to
 *    trust-on-first-use. The spike's d0no.6 renderer already accepted `hostKeys`; production
 *    had quietly dropped it. Emitted only when the caller supplies them, which core does only
 *    when `capabilities.canInjectHostKeys` is true.
 *
 * COMPRESSION IS A RULE, NOT AN OPTIMISATION (ADR-0002 Decision 4, amendment E5). Embedding
 * the agent verbatim measured 19,130 bytes against EC2's 16,384-byte ceiling: callback mode
 * is simply impossible on AWS in its obvious form, and the failure arrives as a provider-side
 * 400 at provision time — on AWS only, invisible to unit tests and to Hetzner's 32KB limit.
 * cloud-init decodes `gz+b64` natively, which brings the same document comfortably inside.
 *
 * So the size check lives HERE, in the renderer, where it fails at render time with a message
 * naming the ceiling, rather than at the provider with a vendor-specific 400. A growing agent
 * is a signal to move work out of user-data, not to raise the limit.
 *
 * Push mode does not use any of this: its pre-boot document is inert and constant at ~2.1KB
 * no matter how much software the plan installs.
 */

export interface RenderResult {
  userData: string
  bytes: number
  /** True when the agent was written with cloud-init's native `gz+b64` encoding. */
  compressed: boolean
}

export class UserDataTooLargeError extends Error {
  override readonly name = 'UserDataTooLargeError'
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(
      `rendered user-data is ${bytes}B against this provider's ${limit}B ceiling. ` +
        'Move work out of user-data rather than raising the limit.',
    )
  }
}

export const DEFAULT_SSH_USER = 'rocky'

/** cloud-init's `ssh_authorized_keys` list, indented for a `users:` entry. */
function authorizedKeysBlock(keys: string[]): string {
  if (keys.length === 0) {
    throw new Error('refusing to render user-data with no authorized keys: the box would be unreachable')
  }
  return keys.map((key) => `      - ${key.trim()}`).join('\n')
}

/** Core-minted host keypair, when the provider can carry one. */
export interface HostKeys {
  ed25519Private: string
  ed25519Public: string
}

/**
 * The `ssh_keys:` block that pins a host key, shared by both renderers.
 *
 * `ssh_deletekeys` throws away the keys the image generated for itself, so the only host
 * identity the box has is the one core is pinning. Without it the box keeps a second, unknown
 * keypair and may present either — which would defeat the strict verification on first
 * contact that this whole mechanism exists to enable.
 *
 * Shared rather than written twice, for the reason 55fx.10 merged these renderers in the
 * first place: two copies of a security-relevant block is how they drift.
 */
function hostKeysBlock(hostKeys: HostKeys | undefined): string {
  if (!hostKeys) return ''
  return [
    'ssh_deletekeys: true',
    'ssh_genkeytypes: [ed25519]',
    'ssh_keys:',
    '  ed25519_private: |',
    ...hostKeys.ed25519Private.trimEnd().split('\n').map((line) => `    ${line}`),
    `  ed25519_public: ${hostKeys.ed25519Public.trim()}`,
    '',
  ].join('\n')
}

/**
 * The one size check, shared by both renderers.
 *
 * It lives at render time, naming the ceiling, rather than arriving as a vendor-specific 400
 * from the provider — a failure that would show up on AWS only, because its 16KB limit is half
 * of Hetzner's, and therefore stay invisible to every test that used the other provider.
 */
function checkSize(document: string, userDataMaxBytes: number): number {
  const bytes = Buffer.byteLength(document, 'utf8')
  if (bytes > userDataMaxBytes) throw new UserDataTooLargeError(bytes, userDataMaxBytes)
  return bytes
}

export interface PushUserDataSpec {
  /** Becomes the box's hostname. Server ids and names are hostname-safe by construction (C2). */
  hostname: string
  /** Authorized keys for the unprivileged user. Core's own key is always among them. */
  sshPublicKeys: string[]
  /**
   * The host keypair core generated before the server existed.
   *
   * Supplied only when the provider's `canInjectHostKeys` is true. Its presence is what lets
   * core verify the very FIRST connection — the one carrying the secrets file — against a key
   * it minted itself, with no trust-on-first-use window. Without it core must record the key
   * seen on first contact and refuse any change afterwards, which is strictly weaker.
   */
  hostKeys?: HostKeys
  /** The unprivileged user. Matches `servers.ssh_user`. */
  sshUser?: string
}

/**
 * Render the PUSH-mode document: the default topology.
 *
 * It creates the user, authorizes core's key, and pins the host key. There is no `runcmd`, no
 * shell, and no agent in here — everything else arrives over the outbound SSH connection core
 * opens once the box answers. That is why this document is ~2.1KB regardless of how much
 * software the install plan adds: 2130B on AWS and 2138B on Hetzner in the spike capstone,
 * from the template this mirrors.
 */
export function renderPushUserData(spec: PushUserDataSpec, userDataMaxBytes: number): RenderResult {
  const user = spec.sshUser ?? DEFAULT_SSH_USER
  const keyBlock = authorizedKeysBlock(spec.sshPublicKeys)

  const hostKeyBlock = hostKeysBlock(spec.hostKeys)

  const document = `#cloud-config
hostname: ${spec.hostname}
preserve_hostname: false

users:
  - name: ${user}
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: true
    ssh_authorized_keys:
${keyBlock}

ssh_pwauth: false
disable_root: true
${hostKeyBlock}`

  const bytes = checkSize(document, userDataMaxBytes)

  // The acceptance criterion, asserted rather than trusted: nothing executable is in here.
  // Push mode exists to delete the pre-boot shell, and a future edit that reintroduces one
  // should fail a test rather than quietly ship.
  if (/^\s*(runcmd|bootcmd):/m.test(document)) {
    throw new Error('push-mode user-data must stay inert: no runcmd/bootcmd')
  }

  // Nothing is written as a file, so nothing is ever compressed on this path.
  return { userData: document, bytes, compressed: false }
}

export interface CallbackUserDataSpec {
  /** Absolute, box-reachable plan endpoint. The plan token rides as a query parameter. */
  planUrl: string
  /** Absolute, box-reachable status endpoint. */
  callbackUrl: string
  /** Recurring status token. NOT the plan token. */
  callbackToken: string
  /** Contents of `bootstrap/agent.sh`. */
  agentScript: string
  /** Authorized keys for the unprivileged user. Core's own key is always among them. */
  sshPublicKeys: string[]
  /**
   * Core-minted host keypair, when the provider's `canInjectHostKeys` is true.
   *
   * Callback mode needs this exactly as much as push does: core still opens an SSH connection
   * to the box afterwards, and without a pinned key that first connection has nothing to
   * verify against. The spike's d0no.6 renderer already took it; production had dropped it.
   */
  hostKeys?: HostKeys
  stateDir?: string
}

const DEFAULT_STATE_DIR = '/var/lib/rockysurf'

/**
 * Above this, a file is written `gz+b64` rather than as a plain block scalar. The agent is
 * always over it; the stub and the config files never are, and leaving them readable makes a
 * rendered document reviewable by a human debugging a boot.
 */
const COMPRESS_THRESHOLD_BYTES = 2048

/** cloud-init's `write_files` entry, either plain or compressed. */
function writeFileBlock(path: string, permissions: string, content: string): string {
  const raw = Buffer.from(content, 'utf8')
  if (raw.byteLength <= COMPRESS_THRESHOLD_BYTES) {
    const indented = content
      .split('\n')
      .map((line) => `      ${line}`)
      .join('\n')
    return [`  - path: ${path}`, `    permissions: '${permissions}'`, '    content: |', indented].join('\n')
  }
  return [
    `  - path: ${path}`,
    `    permissions: '${permissions}'`,
    '    encoding: gz+b64',
    `    content: ${gzipSync(raw).toString('base64')}`,
  ].join('\n')
}

/**
 * The stub cloud-init runs. Deliberately small: fetch the plan, hand off to the agent, and
 * get out of the way. Everything hard lives in the agent, which is the same executor push
 * mode uses — one plan, one agent, one journal.
 */
function stubScript(spec: CallbackUserDataSpec, stateDir: string): string {
  return `#!/usr/bin/env bash
set -uo pipefail
STATE_DIR='${stateDir}'
mkdir -p "$STATE_DIR"

# Fetch ONLY when the box has no plan. A systemd restart must not re-spend the token, and a
# 4xx must never be retried — a refused fetch is an answer, not a hiccup.
if [ ! -s "$STATE_DIR/plan.json" ]; then
  curl -fsS --max-time 30 --retry 5 --retry-delay 3 --retry-connrefused \\
    -o "$STATE_DIR/plan.json.tmp" '${spec.planUrl}' &&
    mv -f "$STATE_DIR/plan.json.tmp" "$STATE_DIR/plan.json"
fi

if [ ! -s "$STATE_DIR/plan.json" ]; then
  echo "rockysurf: no plan could be fetched; nothing to do" >&2
  exit 1
fi

chmod 0600 "$STATE_DIR/plan.json"
exec bash "$STATE_DIR/agent.sh" "$STATE_DIR/plan.json"
`
}

export function renderCallbackUserData(
  spec: CallbackUserDataSpec,
  /** The provider's own ceiling, from `capabilities.userDataMaxBytes`. */
  userDataMaxBytes: number,
): RenderResult {
  const stateDir = spec.stateDir ?? DEFAULT_STATE_DIR
  const keyBlock = authorizedKeysBlock(spec.sshPublicKeys)

  // The callback configuration is a SEPARATE file from secrets.env and is never exported into
  // a step's environment: no install script has any business seeing core's control-plane
  // token (amendment E9).
  const callbackEnv = `ROCKYSURF_CALLBACK_URL='${spec.callbackUrl}'\nROCKYSURF_TOKEN='${spec.callbackToken}'\n`

  const document = `#cloud-config
users:
  - name: rocky
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: true
    ssh_authorized_keys:
${keyBlock}
${hostKeysBlock(spec.hostKeys)}
write_files:
${writeFileBlock(`${stateDir}/agent.sh`, '0755', spec.agentScript)}
${writeFileBlock(`${stateDir}/callback.env`, '0600', callbackEnv)}
${writeFileBlock(`${stateDir}/stub.sh`, '0755', stubScript(spec, stateDir))}

runcmd:
  - [ bash, ${stateDir}/stub.sh ]
`

  const bytes = checkSize(document, userDataMaxBytes)

  return { userData: document, bytes, compressed: Buffer.byteLength(spec.agentScript, 'utf8') > COMPRESS_THRESHOLD_BYTES }
}
