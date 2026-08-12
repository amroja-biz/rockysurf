import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoreClient } from '../mcp/client.js'
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

/* ----------------------------------------------------------------------------- create */

export interface CreateArgs {
  name?: string
  size?: string
  packId?: string
  provider?: string
}

export async function createCommand(deps: CliDeps, args: CreateArgs): Promise<number> {
  const server = unwrap<ServerSummary>(
    await deps.client.post('/api/v1/servers', {
      ...(args.name ? { name: args.name } : {}),
      size: args.size ?? 'small',
      ...(args.packId ? { packId: args.packId } : {}),
      ...(args.provider ? { provider: args.provider } : {}),
    }),
    'server',
  )

  deps.out(server.name)
  deps.err(
    `Creating ${server.name} (${server.serverId}). Watch it come up with \`rockysurf list\`, ` +
      `then connect with \`rockysurf ssh ${server.name}\`.`,
  )
  return 0
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
