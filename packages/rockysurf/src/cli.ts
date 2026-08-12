import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { boot, issueSession, runCli, type RunCliOptions } from '@rockysurf/core'
import { composeRegistry } from './compose.js'
import { runMcpServer, MCP_BASE_URL_ENV, MCP_TOKEN_ENV } from './mcp/server.js'
import { createCoreClient } from './mcp/client.js'
import {
  createCommand,
  listCommand,
  sshCommand,
  sshConfigCommand,
  stopCommand,
  type CliDeps,
} from './cli/commands.js'

/**
 * The CLI, with the providers wired in.
 *
 * Core owns every command, every flag and all the boot sequencing; this adds the seam that
 * supplies the provider registry and the two subcommands that only make sense from the
 * composed package. Keeping argument parsing in core rather than duplicating it here is what
 * stops the published package and the package under test from drifting apart.
 */

/** A year. Long enough that an agent's connection outlives the human's browser session. */
const MCP_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000

/**
 * Commands that talk to a RUNNING control plane over HTTP rather than opening its database
 * (rockysurf-ftl9.2). They need a token, exactly as the MCP server does — one authorization
 * story, one set of limits, nothing for a second code path to drift from.
 */
const CLIENT_COMMANDS = new Set(['list', 'create', 'stop', 'ssh', 'ssh-config'])

/**
 * THIS package's version — the one `npx rockysurf --version` has to print (rockysurf-aor6).
 *
 * `../package.json` resolves to the same manifest from `src/` and from `dist/`, because both sit
 * one level below the package root. Core has the identical helper for its own manifest, and that
 * was the bug: `--version` went through core's, so the CLI answered with the version of a
 * dependency rather than of the package somebody installed. Invisible while the two are published
 * in lockstep at 0.1.0, wrong the first time they are not.
 *
 * Never throws. A version that cannot be read must not stop the control plane from starting.
 */
export function readCliVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version?: string }
    return manifest.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export async function runRockysurfCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const [command, ...rest] = argv

  if (command === 'mcp') return runMcpCommand(rest)
  if (command === 'token') return runTokenCommand(rest)
  // APPEND-ONLY subcommand table (rockysurf-ftl9.2). `bin.js` and this dispatch are shared
  // with concurrent work; new commands go at the end so two agents touch different lines.
  if (command && CLIENT_COMMANDS.has(command)) return runClientCommand(command, rest)

  // The seam wants a registry; compose also returns notes, which boot already logged. The
  // version is this package's, not core's — see readCliVersion. `options` still wins, so a
  // test or an embedder can override either.
  return runCli(argv, {
    version: readCliVersion(),
    providers: (context) => composeRegistry(context).registry,
    ...options,
  })
}

/**
 * `rockysurf mcp` — serve the MCP tools over stdio (rockysurf-ftl9.1).
 *
 * Reads scopes from the config file rather than from a flag, because a permission an agent's
 * launch command can set is a permission the agent can eventually talk someone into setting.
 * Config is where an operator reviews it.
 */
async function runMcpCommand(argv: string[]): Promise<number> {
  const configPath = flagValue(argv, '--config')
  // `listen: false` and closed immediately: this only needs the parsed config, and leaving a
  // control plane running inside the MCP process would mean two of them on one data directory.
  const booted = await boot({
    ...(configPath ? { configPath } : {}),
    listen: false,
    announce: () => {},
    log: () => {},
  })
  const scopes = booted.config.mcp.scopes
  await booted.close()

  return runMcpServer({ scopes })
}

/**
 * `rockysurf token` — mint a token for an MCP client, printed once.
 *
 * A SESSION, not a new kind of credential. Sessions are already opaque, hashed at rest,
 * revocable by logout and covered by tests; inventing a second credential system for this
 * would mean a second thing to get wrong. The cost is stated in the output: revoking it means
 * signing out everywhere, which is the honest trade at v0.1 and the thing to improve when
 * per-token scopes arrive.
 */
async function runTokenCommand(argv: string[]): Promise<number> {
  const configPath = flagValue(argv, '--config')
  const booted = await boot({
    ...(configPath ? { configPath } : {}),
    listen: false,
    announce: () => {},
    log: () => {},
  })

  try {
    const user = findAdmin(booted)
    if (!user) {
      process.stderr.write('no admin account exists yet — start Rocky Surf once first.\n')
      return 1
    }

    const { token } = issueSession(booted.db.db, user.id, MCP_TOKEN_TTL_MS)
    const port = booted.config.server.port

    // stdout carries ONLY the token, so `ROCKYSURF_TOKEN=$(rockysurf token)` works. Everything
    // a human reads goes to stderr.
    process.stdout.write(`${token}\n`)
    process.stderr.write(
      [
        '',
        'Token minted. It is shown once and stored only as a hash.',
        '',
        '  Add to your MCP client (Claude Code: .mcp.json):',
        '',
        '    {',
        '      "mcpServers": {',
        '        "rockysurf": {',
        '          "command": "npx",',
        '          "args": ["-y", "rockysurf", "mcp"],',
        '          "env": {',
        `            "${MCP_TOKEN_ENV}": "<the token above>",`,
        `            "${MCP_BASE_URL_ENV}": "http://127.0.0.1:${port}"`,
        '          }',
        '        }',
        '      }',
        '    }',
        '',
        '  Revoking it means signing out of the web UI, which drops every session. Scopes come',
        '  from mcp.scopes in your config file, not from this token.',
        '',
      ].join('\n'),
    )
    return 0
  } finally {
    await booted.close()
  }
}

/** The single-admin account, which is who an MCP client acts as. */
function findAdmin(booted: Awaited<ReturnType<typeof boot>>): { id: string } | undefined {
  const rows = booted.db.sqlite
    .prepare('SELECT id FROM users WHERE is_admin = 1 ORDER BY created_at LIMIT 1')
    .all() as { id: string }[]
  return rows[0]
}

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  if (index >= 0 && argv[index + 1]) return argv[index + 1]
  const inline = argv.find((a) => a.startsWith(`${flag}=`))
  return inline?.slice(flag.length + 1)
}

/**
 * The thin CLI commands.
 *
 * Deliberately does NOT open the database: these run against a control plane someone else is
 * serving, from a laptop that may not be the one running it.
 */
async function runClientCommand(command: string, argv: string[]): Promise<number> {
  const token = process.env[MCP_TOKEN_ENV]
  if (!token) {
    process.stderr.write(
      `${MCP_TOKEN_ENV} is not set.\n\n  rockysurf token          # mint one, printed once\n\n` +
        `Then export it, or put it in your shell profile.\n`,
    )
    return 1
  }

  const client = createCoreClient({
    baseUrl: process.env[MCP_BASE_URL_ENV] ?? 'http://127.0.0.1:3000',
    token,
  })
  const deps: CliDeps = {
    client,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  }

  try {
    switch (command) {
      case 'list':
        return await listCommand(deps)
      case 'create':
        return await createCommand(deps, {
          ...(flagValue(argv, '--name') ? { name: flagValue(argv, '--name')! } : {}),
          ...(flagValue(argv, '--size') ? { size: flagValue(argv, '--size')! } : {}),
          ...(flagValue(argv, '--pack') ? { packId: flagValue(argv, '--pack')! } : {}),
          ...(flagValue(argv, '--provider') ? { provider: flagValue(argv, '--provider')! } : {}),
        })
      case 'stop':
        return argv[0] ? await stopCommand(deps, argv[0]) : usage('stop <name>')
      case 'ssh': {
        // Everything after `--` goes to ssh, so `rockysurf ssh box -- -L 8080:localhost:80` works.
        const separator = argv.indexOf('--')
        const name = argv[0]
        const passthrough = separator >= 0 ? argv.slice(separator + 1) : []
        return name ? await sshCommand(deps, name, passthrough) : usage('ssh <name> [-- ssh args]')
      }
      case 'ssh-config':
        return await sshConfigCommand(deps, { write: argv.includes('--write') })
      default:
        return usage(command)
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

function usage(what: string): number {
  process.stderr.write(`usage: rockysurf ${what}\n`)
  return 1
}
