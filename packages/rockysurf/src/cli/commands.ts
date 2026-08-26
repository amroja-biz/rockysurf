import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreApiError, type CoreClient } from '../mcp/client.js'
import type { ProviderCatalogue } from '../mcp/tools.js'
import { packRequiresRdp, RDP_MIN_LENGTH, RDP_PASSWORD_ENV } from '../rdp.js'
import { SecretPromptCancelled, type SecretPrompt } from './secret-prompt.js'
import {
  defaultPaths,
  planIncludeEdit,
  readIfPresent,
  renderInclude,
  renderKnownHostsLine,
  writePrivate,
  type SshConfigPaths,
  type SshConfigServer,
} from './ssh-config.js'

/**
 * The thin CLI: the commands people touch ten times a day (rockysurf-ftl9.2).
 *
 * Everything here goes over core's HTTP API with a bearer token, exactly as the MCP server
 * does — so there is one authorization story, one set of limits, and nothing for a second code
 * path to drift from.
 */

export interface CliDeps {
  client: CoreClient
  out: (line: string) => void
  err: (line: string) => void
  paths?: SshConfigPaths
  /** Injected in tests so no real ssh is launched. */
  spawn?: typeof spawnSync
  /**
   * The environment, and the terminal, PASSED IN rather than read from `process` here.
   *
   * Both are ambient state, and a command that reaches for them itself is a command whose
   * tests behave differently depending on who runs them — a developer with
   * `ROCKYSURF_RDP_PASSWORD` exported, or a terminal attached, would silently take a different
   * branch. `cli.ts` is the single place that touches `process`. Absent here means absent.
   */
  env?: NodeJS.ProcessEnv
  /** Undefined when no terminal is attached, which is a case with its own message. */
  promptSecret?: SecretPrompt
}

interface ServerSummary {
  serverId: string
  name: string
  status: string
  publicIp?: string
  sshUser?: string
  /** Present only when sshd is not on 22 (ADR-0003, E13). */
  sshPort?: number
  size?: string
  hourlyCost?: { amount: number; currency: string } | undefined
}

const unwrap = <T>(body: unknown, key: string): T =>
  ((body as Record<string, unknown>)[key] ?? body) as T

/* ------------------------------------------------------------------------------- list */

export async function listCommand(deps: CliDeps): Promise<number> {
  const servers = unwrap<ServerSummary[]>(await deps.client.get('/api/v1/servers'), 'servers')

  if (servers.length === 0) {
    deps.out('No servers. Create one with `rockysurf create`.')
    return 0
  }

  const width = Math.max(...servers.map((s) => s.name.length), 4)
  deps.out(`${'NAME'.padEnd(width)}  ${'STATUS'.padEnd(12)}  ${'ADDRESS'.padEnd(15)}  COST/HR`)
  for (const server of servers) {
    const cost = server.hourlyCost ? `${server.hourlyCost.amount} ${server.hourlyCost.currency}` : '—'
    deps.out(
      `${server.name.padEnd(width)}  ${server.status.padEnd(12)}  ${(server.publicIp ?? '—').padEnd(15)}  ${cost}`,
    )
  }
  return 0
}

/* -------------------------------------------------------------------------- offerings */

/**
 * `rockysurf offerings` — what each configured cloud can actually sell you (rockysurf-oeay).
 *
 * THE CLI NEEDED THIS FOR THE SAME REASON MCP DID, and shipping `--offering` without it would
 * have recreated the bug on the surface being fixed in the same change: an id-shaped flag with
 * nowhere to learn an id. `--provider` gets away with it because omitting it on a multi-cloud
 * installation produces a refusal that names the configured clouds; there is no such prompt for
 * an offering.
 *
 * Reads the same route the SPA's create page reads, so the catalogue is already narrowed by the
 * operator's `providers.<cloud>.sizes` (rockysurf-j10e). Nothing here can advertise a machine
 * `rockysurf create` would refuse.
 */
export async function offeringsCommand(deps: CliDeps, args: { provider?: string } = {}): Promise<number> {
  const providers = unwrap<ProviderCatalogue[]>(await deps.client.get('/api/v1/providers'), 'providers')
  const matching = args.provider ? providers.filter((p) => p.id === args.provider) : providers

  if (args.provider && matching.length === 0) {
    deps.err(
      `No configured cloud called "${args.provider}". ` +
        (providers.length ? `You have: ${providers.map((p) => p.id).join(', ')}.` : 'None is configured.'),
    )
    return 1
  }
  if (matching.length === 0) {
    deps.err('No cloud is configured. Add one in Settings, or see docs/self-hosting.md.')
    return 1
  }

  for (const provider of matching) {
    deps.out(`${provider.id}  (${provider.displayName})`)
    // A cloud whose catalogue could not be read says so instead of looking like a cloud with
    // nothing to sell — the same distinction the route draws with `offeringsError`.
    if (provider.offeringsError) {
      deps.out(`  could not read the catalogue: ${provider.offeringsError}`)
      continue
    }
    if (provider.offerings.length === 0) {
      deps.out('  no machine types this installation allows')
      continue
    }

    const width = Math.max(...provider.offerings.map((o) => o.id.length), 4)
    deps.out(`  ${'TYPE'.padEnd(width)}  ${'ARCH'.padEnd(5)}  ${'CPU'.padStart(3)}  ${'RAM'.padStart(6)}  COST/HR`)
    for (const offering of provider.offerings) {
      // `null` is "the provider quotes no price", which must never be rendered as free.
      const cost = offering.hourly ? `${offering.hourly.amount} ${offering.hourly.currency}` : '—'
      // Said in the row rather than by omitting it: a sold-out type and a type this cloud does
      // not have need different answers, which is why the SDK carries `available` at all.
      const soldOut = offering.available ? '' : `   (${offering.unavailableReason ?? 'sold out right now'})`
      deps.out(
        `  ${offering.id.padEnd(width)}  ${offering.arch.padEnd(5)}  ${String(offering.cpu).padStart(3)}  ` +
          `${`${offering.memoryGb} GB`.padStart(6)}  ${cost}${soldOut}`,
      )
    }
    deps.out('')
  }
  deps.err('Create one with `rockysurf create --offering <type>`, or let --size and --arch choose.')
  return 0
}

/* ----------------------------------------------------------------------------- create */

/**
 * The two architectures, which are the SDK's frozen list rather than anything an operator
 * configures — so unlike `--provider` and `--offering` this one is a CLOSED choice, checked
 * here before a request is made (rockysurf-zaqs).
 */
export const ARCHITECTURES = ['amd64', 'arm64'] as const
export type CliArchitecture = (typeof ARCHITECTURES)[number]

export interface CreateArgs {
  name?: string
  size?: string
  packId?: string
  provider?: string
  /**
   * Which CPU architecture, when the caller cares (rockysurf-zaqs).
   *
   * `rockysurf-clf2` made size and arch resolution real in core and `rockysurf-0t2h` gave the
   * MCP tool an `arch`; the CLI — the surface a human is most likely to be holding — was left
   * with `size` alone, so asking for an ARM box meant falling back to curl against the HTTP
   * API. Passed through as `arch`, which the create route already validates.
   */
  arch?: string
  /**
   * A concrete machine type from the cloud's own catalogue, overriding `size`.
   *
   * Un-enumerated, on the same discipline as `--provider`: the ids belong to the operator's
   * cloud and are narrowed further by their `providers.<cloud>.sizes`, so no list compiled into
   * this binary could be right for two installations. `rockysurf offerings` is how a caller
   * learns them (rockysurf-oeay).
   */
  offeringId?: string
  /**
   * Repository URLs to clone onto the box, from repeated `--repo` flags (rockysurf-81wo).
   *
   * They are not decoration. The create route preflights each one before a machine is launched
   * (rockysurf-k6xp), and they decide which of the installation's git tokens this box is built
   * with (rockysurf-18lq) — a box that declares none receives no repository-scoped token, which
   * is correct and is also why a CLI that could not name them was a real gap rather than a
   * missing convenience.
   */
  repositories?: string[]
  /** Create even though a repository URL failed that preflight. The SPA's checkbox, as a flag. */
  createAnyway?: boolean
  /**
   * What `--rdp-password` was, NOT what it said.
   *
   * `'literal'` means a value followed it on the command line, and the value is deliberately
   * not carried here: the command refuses it (see `resolveRdpPassword`), and passing a
   * password around to reject it later only widens the number of places it has been.
   */
  rdpPassword?: 'absent' | 'prompt' | 'literal'
}

/**
 * How `--rdp-password` was used, which is all `createCommand` is allowed to know
 * (rockysurf-kvkr).
 *
 * Parsed by hand rather than through `cli.ts`'s `flagValue`, because the two interesting cases
 * are exactly the ones that helper flattens: a bare `--rdp-password` — "ask me at the prompt" —
 * reads as "no value", and `--rdp-password --size small` would hand back `--size` as if it were
 * the password. A value that IS present is reported as `'literal'` and never returned: the
 * command refuses it, and there is nothing to gain by carrying a leaked secret one call deeper.
 */
export function rdpPasswordFlag(argv: string[]): NonNullable<CreateArgs['rdpPassword']> {
  if (argv.some((a) => a.startsWith('--rdp-password='))) return 'literal'
  const index = argv.indexOf('--rdp-password')
  if (index < 0) return 'absent'
  const next = argv[index + 1]
  return next !== undefined && !next.startsWith('-') ? 'literal' : 'prompt'
}

export async function createCommand(deps: CliDeps, args: CreateArgs): Promise<number> {
  // Before anything is sent, because a closed choice mistyped is a typo and the round trip
  // teaches nothing the local check cannot (rockysurf-zaqs). The message names both values
  // rather than only rejecting the one given.
  if (args.arch !== undefined && !(ARCHITECTURES as readonly string[]).includes(args.arch)) {
    deps.err(`--arch must be one of: ${ARCHITECTURES.join(', ')} — got "${args.arch}"`)
    return 1
  }

  // BEFORE the POST, always. A `requiresRdp` pack created without a password provisions
  // perfectly and then fails its last bootstrap step — an instance that costs money and
  // teaches nothing (rockysurf-kvkr).
  const rdp = await resolveRdpPassword(deps, args)
  if (rdp.refusal) {
    deps.err(rdp.refusal)
    return 1
  }

  let body: unknown
  try {
    body = await deps.client.post('/api/v1/servers', {
      ...(args.name ? { name: args.name } : {}),
      /**
       * `small` is the default ONLY when nothing else names a machine (rockysurf-kh3u).
       *
       * This used to send `size: 'small'` unconditionally, so `--offering t4g.large` still
       * carried a `size` core would derive `'custom'` for anyway (harmless) but which made
       * `'custom'` unreachable from this surface — the CLI could never exercise the branch
       * `rockysurf offerings` exists to feed. `--size` explicitly given still wins outright.
       */
      ...(args.size ? { size: args.size } : args.offeringId ? {} : { size: 'small' }),
      ...(args.packId ? { packId: args.packId } : {}),
      ...(args.provider ? { provider: args.provider } : {}),
      ...(args.arch ? { arch: args.arch } : {}),
      ...(args.offeringId ? { offeringId: args.offeringId } : {}),
      ...(args.repositories?.length ? { repositories: args.repositories } : {}),
      ...(args.createAnyway ? { createAnyway: true } : {}),
      ...(rdp.password ? { rdpPassword: rdp.password } : {}),
    })
  } catch (error) {
    /*
     * THE FIELD-LEVEL ISSUES, not only the summary (rockysurf-81wo).
     *
     * `CoreApiError.message` is the summary sentence — "2 of the repositories could not be
     * opened" — and `issues` is the part that says WHICH. `cli.ts`'s catch prints the message
     * and nothing else, so a create naming four repositories would report that some of them
     * were wrong and leave the user to work out which, which is precisely the guessing the
     * preflight exists to end. Printed here rather than in `cli.ts` because this is the one
     * command whose refusals carry them.
     */
    if (error instanceof CoreApiError && error.body.issues?.length) {
      deps.err(error.message)
      for (const issue of error.body.issues) deps.err(`  ${issue.message}`)
      if (!args.createAnyway) deps.err('  Pass --create-anyway if you are sure these URLs are right.')
      return 1
    }
    throw error
  }
  const server = unwrap<ServerSummary>(body, 'server')

  deps.out(server.name)
  deps.err(
    `Creating ${server.name} (${server.serverId}). Watch it come up with \`rockysurf list\`, ` +
      `then connect with \`rockysurf ssh ${server.name}\`.` +
      // Says THAT there is a password, never what it is.
      (rdp.password
        ? ` It installs a desktop: sign in over RDP as rocky with the password you just set, ` +
          `tunnelled over SSH (\`rockysurf ssh ${server.name} -- -L 3389:localhost:3389\`).`
        : ''),
  )
  return 0
}

/**
 * Where the desktop password comes from, and what happens when it cannot come from anywhere.
 *
 * THE ORDER IS THE DESIGN. A literal on the command line is refused outright rather than
 * warned about, because by the time a warning could print, the value is already in the shell's
 * history file and has already been visible in `ps` to every process on the machine — a
 * warning would only tell the user about a leak it did nothing to prevent. What is left are
 * the two ways a secret reaches a program without being written down: the environment, which
 * is how `ROCKYSURF_TOKEN` already arrives and is what scripts and CI use, and a terminal
 * prompt that echoes nothing, which is what a person at a keyboard gets.
 */
async function resolveRdpPassword(
  deps: CliDeps,
  args: CreateArgs,
): Promise<{ password?: string; refusal?: string }> {
  if (args.rdpPassword === 'literal') {
    return {
      refusal:
        'A password given on the command line is recorded in your shell history and is readable ' +
        `in \`ps\` by every process on this machine, so \`rockysurf create\` will not accept one ` +
        'that way. Supply it as an environment variable, or let it be typed at a prompt:\n\n' +
        `  ${RDP_PASSWORD_ENV}=... rockysurf create --pack <id>   # scripts, CI\n` +
        '  rockysurf create --pack <id> --rdp-password               # no value: typed, not echoed\n\n' +
        'Choose a different password from the one you just typed — that one is already on disk ' +
        'in your history file.',
    }
  }

  const needed =
    args.rdpPassword === 'prompt' ||
    (args.packId !== undefined && (await packRequiresRdp(deps.client, args.packId)))
  if (!needed) return {}

  // Named where it can be, because "which pack needs this?" is the first question the message
  // raises. `--rdp-password` with no pack is the escape hatch and has nothing to name.
  const pack = args.packId ? `"${args.packId}"` : 'This pack'

  const fromEnv = deps.env?.[RDP_PASSWORD_ENV]
  if (fromEnv) {
    return fromEnv.length >= RDP_MIN_LENGTH
      ? { password: fromEnv }
      : { refusal: `${RDP_PASSWORD_ENV} is shorter than ${RDP_MIN_LENGTH} characters, which core refuses.` }
  }

  if (!deps.promptSecret) {
    return {
      refusal:
        `${pack} installs a remote desktop, so the box needs a password for its rocky account — ` +
        'without one it would build completely and then fail its last bootstrap step. No ' +
        `terminal is attached here to type one at, so pass it in the environment:\n\n` +
        `  ${RDP_PASSWORD_ENV}=... rockysurf create --pack ${args.packId ?? '<id>'}\n\n` +
        'Not as a flag: an argument is visible in `ps` and lands in your shell history.',
    }
  }

  deps.err(
    `${pack} installs a remote desktop. Choose the password you will sign in to it with as ` +
      `rocky — at least ${RDP_MIN_LENGTH} characters. It is not echoed, and core never shows it ` +
      'back to you afterwards.',
  )

  let first: string
  let second: string
  try {
    first = await deps.promptSecret('Remote desktop password: ')
    // Twice, as the web form asks, because a password nobody can read back is a password a
    // typo makes permanently wrong: the recovery is an SSH session and `sudo passwd rocky`.
    second = await deps.promptSecret('Confirm: ')
  } catch (error) {
    if (error instanceof SecretPromptCancelled) return { refusal: 'Cancelled. Nothing was created.' }
    throw error
  }

  if (first !== second) return { refusal: 'Those did not match. Nothing was created — try again.' }
  if (first.length < RDP_MIN_LENGTH) {
    return { refusal: `That is shorter than ${RDP_MIN_LENGTH} characters, which core refuses.` }
  }
  return { password: first }
}

/* ------------------------------------------------------------------------------- stop */

export async function stopCommand(deps: CliDeps, name: string): Promise<number> {
  const server = await resolve(deps, name)
  if (!server) return 1

  await deps.client.post(`/api/v1/servers/${server.serverId}/stop`)
  deps.err(`Stopping ${server.name}. Its disk is kept — start it again from the web UI.`)
  return 0
}

/* -------------------------------------------------------------------------------- ssh */

/**
 * Connect, WITHOUT leaving a private key behind.
 *
 * The key is fetched, used for this one connection from a directory only this user can enter,
 * and removed when ssh exits — so the everyday path creates no second copy of anything. The
 * durable-key path exists only behind `rockysurf ssh-config --write`, where a user has asked
 * for plain `ssh <name>` and been told the trade. See `ssh-config.ts` for the full reasoning.
 */
export async function sshCommand(deps: CliDeps, name: string, passthrough: string[] = []): Promise<number> {
  const server = await resolve(deps, name)
  if (!server) return 1

  if (!server.publicIp) {
    deps.err(`${server.name} has no address yet (status: ${server.status}). Try again once it is running.`)
    return 1
  }

  const paths = deps.paths ?? defaultPaths()
  const spawn = deps.spawn ?? spawnSync

  // 0700 by mkdtemp's own contract, and inside the OS temp dir rather than anywhere shared.
  const scratch = mkdtempSync(join(tmpdir(), 'rockysurf-ssh-'))
  try {
    const keyPath = join(scratch, 'id')
    const knownHostsPath = join(scratch, 'known_hosts')

    const pem = await fetchPrivateKey(deps, server.serverId)
    writePrivate(keyPath, pem)

    const host = await fetchHostKey(deps, server.serverId)

    const args = ['-i', keyPath, '-o', 'IdentitiesOnly=yes']
    if (server.sshPort) args.push('-p', String(server.sshPort))
    if (host.hostPublicKey) {
      // Verified against a key core minted before the box existed: no trust-on-first-use
      // window, which matters because the first connection is the one carrying secrets.
      writePrivate(
        knownHostsPath,
        renderKnownHostsLine({ ...toConfigServer(server), publicIp: server.publicIp }, host.hostPublicKey),
      )
      args.push('-o', `UserKnownHostsFile=${knownHostsPath}`, '-o', 'StrictHostKeyChecking=yes')
    } else {
      // No key to pin against — say so rather than silently downgrading, and NEVER write an
      // entry anyway (rockysurf-ftl9.13): a fabricated known_hosts line fails verification on
      // every connection, and host-key failure is the one alarm that must stay meaningful.
      // When core holds the fingerprint its provider observed, that is a check the human can
      // actually perform at ssh's prompt, so it goes on the screen.
      deps.err(
        host.reportedFingerprint
          ? `${server.name} presents its own host key, which core did not mint. Core recorded ` +
              `${host.reportedFingerprint} — ssh will show you a fingerprint; connect only if they match.`
          : `No pinned host key is stored for ${server.name}, so this connection cannot be verified ` +
              'against one. Continuing with ssh’s own prompt.',
      )
    }

    args.push(`${server.sshUser ?? 'rocky'}@${server.publicIp}`, ...passthrough)
    const result = spawn('ssh', args, { stdio: 'inherit' })
    return result.status ?? 1
  } finally {
    // The whole point of the ephemeral path. `force` so a failure before the write does not
    // turn into a second error on the way out.
    rmSync(scratch, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------------- ssh-config */

export interface SshConfigArgs {
  /** Without it, nothing is written and the plan is printed. */
  write: boolean
}

/**
 * Generate the include, and — only with `--write` — the durable keys and the one line in the
 * user's own `~/.ssh/config`.
 *
 * DRY BY DEFAULT. This is the only command that touches a file the user owns and did not ask
 * us to touch, so the default is to show exactly what it would do and change nothing.
 */
export async function sshConfigCommand(deps: CliDeps, args: SshConfigArgs): Promise<number> {
  const paths = deps.paths ?? defaultPaths()
  const servers = unwrap<ServerSummary[]>(await deps.client.get('/api/v1/servers'), 'servers')

  // The host key is fetched BEFORE the config is rendered, not after, because it decides what
  // the block says: a host core can pin gets `StrictHostKeyChecking yes`, and one it cannot
  // gets `ask` plus the fingerprint to compare. Rendering first and discovering second is how
  // the old order produced blocks that demanded a pin nothing would ever write.
  const connectable: SshConfigServer[] = []
  for (const server of servers.filter((s) => s.publicIp)) {
    const host = await fetchHostKey(deps, server.serverId)
    connectable.push({ ...toConfigServer(server), ...host })
  }

  const unpinned = connectable.filter((s) => !s.hostPublicKey)
  const include = renderInclude(connectable, paths)
  const edit = planIncludeEdit(readIfPresent(paths.userConfig))

  if (!args.write) {
    deps.out(include)
    deps.err(
      [
        '',
        `Nothing was written. With --write this would:`,
        `  • write ${paths.include}`,
        `  • write ${connectable.length} private key(s) to ${paths.keyDir} (mode 0600)`,
        `  • write ${connectable.length - unpinned.length} pinned host key(s) to ${paths.knownHosts}`,
        ...(unpinned.length > 0
          ? [
              `  • leave ${unpinned.length} host(s) unpinned — ${unpinned
                .map((s) => s.name)
                .join(', ')} present their own host keys, which core did not mint and cannot`,
              `    hand out. Those blocks ask on first connect, with the fingerprint core recorded in a comment.`,
            ]
          : []),
        edit.alreadyPresent
          ? `  • leave ${paths.userConfig} alone — the Include line is already there`
          : `  • add one Include line to ${paths.userConfig}, at the top`,
        '',
        'Those private keys are a second copy outside the encrypted store. `rockysurf ssh <name>`',
        'needs none of it — it fetches a key per connection and removes it afterwards.',
        '',
      ].join('\n'),
    )
    return 0
  }

  for (const server of connectable) {
    const pem = await fetchPrivateKey(deps, server.id)
    writePrivate(join(paths.keyDir, `${server.id}.pem`), pem)
  }

  const knownHosts = connectable
    .filter((server) => server.hostPublicKey)
    .map((server) => renderKnownHostsLine(server, server.hostPublicKey ?? ''))
  writePrivate(paths.knownHosts, knownHosts.join(''))
  writePrivate(paths.include, include)

  if (!edit.alreadyPresent) writePrivate(paths.userConfig, edit.contents)

  deps.err(
    [
      `Wrote ${paths.include} (${connectable.length} host${connectable.length === 1 ? '' : 's'}).`,
      `Wrote ${connectable.length} private key(s) to ${paths.keyDir} at mode 0600.`,
      `Wrote ${knownHosts.length} pinned host key(s) to ${paths.knownHosts}.`,
      ...(unpinned.length > 0
        ? [
            `${unpinned.length} host(s) present their own host key and are not pinned: ` +
              `${unpinned.map((s) => s.name).join(', ')}. Their blocks ask on first connect; the ` +
              'fingerprint core recorded is in a comment beside each one.',
          ]
        : []),
      edit.alreadyPresent
        ? `${paths.userConfig} already had the Include line — left alone.`
        : `Added one Include line to the top of ${paths.userConfig}.`,
      '',
      `Try it: ssh ${connectable[0]?.name ?? '<name>'}`,
    ].join('\n'),
  )
  return 0
}

/* ------------------------------------------------------------------------------ shared */

function toConfigServer(server: ServerSummary): SshConfigServer {
  return {
    id: server.serverId,
    name: server.name,
    publicIp: server.publicIp ?? '',
    sshUser: server.sshUser ?? 'rocky',
    ...(server.sshPort ? { sshPort: server.sshPort } : {}),
  }
}

/**
 * What core can prove about one server's host key.
 *
 * The route has three answers and each one means something different (rockysurf-ftl9.13): the
 * minted public key, which can be pinned; a 409 carrying the fingerprint a provider observed on
 * a box core did not key, which a human can compare but ssh cannot check; or nothing at all.
 * Collapsing the middle case into "no key" would throw away the only verification available on
 * a BYO fleet, so it is carried through and shown.
 */
async function fetchHostKey(
  deps: CliDeps,
  serverId: string,
): Promise<{ hostPublicKey?: string; reportedFingerprint?: string }> {
  try {
    const body = await deps.client.get<{ hostPublicKey?: string; fingerprint?: string }>(
      `/api/v1/servers/${serverId}/ssh-host-key`,
    )
    return body.hostPublicKey ? { hostPublicKey: body.hostPublicKey } : {}
  } catch (error) {
    const pin = (error as { body?: { fingerprint?: unknown } }).body?.fingerprint
    return typeof pin === 'string' ? { reportedFingerprint: pin } : {}
  }
}

/**
 * The private key, as a PEM. Never logged, never written anywhere but a 0600 file.
 *
 * `getText`, not `get`: the route serves a PEM attachment, and JSON-parsing it yields an empty
 * object. That bug shipped past a mocked test once — the mock returned a string where the real
 * client would have returned `{}` — which is why the client now makes the caller say which
 * kind of body it expects.
 */
async function fetchPrivateKey(deps: CliDeps, serverId: string): Promise<string> {
  return deps.client.getText(`/api/v1/servers/${serverId}/ssh-key`)
}

/** Find a server by name, then by id — people type names, scripts pass ids. */
async function resolve(deps: CliDeps, nameOrId: string): Promise<ServerSummary | undefined> {
  const servers = unwrap<ServerSummary[]>(await deps.client.get('/api/v1/servers'), 'servers')
  const found =
    servers.find((s) => s.name === nameOrId) ?? servers.find((s) => s.serverId === nameOrId)

  if (!found) {
    deps.err(
      `No server called "${nameOrId}". ` +
        (servers.length ? `You have: ${servers.map((s) => s.name).join(', ')}.` : 'You have none yet.'),
    )
  }
  return found
}
