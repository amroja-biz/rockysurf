import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  defaultDatabasePath,
  issueSession,
  loadConfigLenientlyOrExit,
  openDatabase,
  runCli,
  type CliSubcommand,
  type OpenedDatabase,
  type RunCliOptions,
} from '@rockysurf/core'
import { composeRegistry } from './compose.js'
import { runMcpServer, MCP_BASE_URL_ENV, MCP_TOKEN_ENV } from './mcp/server.js'
import { createCoreClient } from './mcp/client.js'
import {
  createCommand,
  listCommand,
  offeringsCommand,
  rdpPasswordFlag,
  sshCommand,
  sshConfigCommand,
  stopCommand,
  type CliDeps,
} from './cli/commands.js'
import { runPackCommand } from './cli/pack.js'
import { ttySecretPrompt } from './cli/secret-prompt.js'

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

/**
 * ONE ROW PER SUBCOMMAND, and the row is both the dispatch and the help (rockysurf-3w2u).
 *
 * `--help` used to list none of these. The cause was structural rather than forgetfulness:
 * the help text lives in core's `runCli`, every command here is dispatched before `runCli` is
 * reached, and core may not import this package to find out what it missed. So an operator who
 * had not read `docs/self-hosting.md` could not discover a single command from the binary.
 *
 * Fixing it by writing the list into core's usage string would have made the two drift on the
 * next command added — which is exactly what happened when `pack` arrived and joined a help
 * text that already named none of its siblings. Instead the table below is the ONLY place a
 * command is declared, `runRockysurfCli` dispatches from it, and `summary` is what core prints.
 * Adding a command in one place and forgetting the other is no longer a thing that can be done.
 *
 * That property depends on nothing bypassing this table. A `if (command === 'x')` added above
 * the lookup would dispatch a command the help does not know about, and no test can see that;
 * put the row here instead.
 *
 * APPEND-ONLY (rockysurf-ftl9.2): `bin.js` and this table are shared with concurrent work, so
 * new commands go at the end and two agents touch different lines.
 */
interface Subcommand extends CliSubcommand {
  /** `pack` is synchronous — it never awaits a network or a database — so both are accepted. */
  run: (argv: string[]) => Promise<number> | number
}

const SUBCOMMANDS: readonly Subcommand[] = [
  { name: 'mcp', summary: 'serve the MCP tools over stdio, for an agent client', run: runMcpCommand },
  { name: 'token', summary: 'mint a token for an MCP client, printed once', run: runTokenCommand },
  { name: 'list', summary: 'list your servers, with status, address and cost', run: (a) => runClientCommand('list', a) },
  {
    name: 'create',
    // Says the floor, because nothing else does: `create` appears in no document in this
    // repository, so this line is the whole of its documentation (rockysurf-zaqs, and the
    // reason rockysurf-3w2u mattered). Same wording as the MCP tool's `size` description.
    summary: 'create a server — --size is a floor, or name --arch / --offering exactly',
    run: (a) => runClientCommand('create', a),
  },
  { name: 'stop', summary: 'stop a server, keeping its disk', run: (a) => runClientCommand('stop', a) },
  { name: 'ssh', summary: 'connect to a server over SSH', run: (a) => runClientCommand('ssh', a) },
  {
    name: 'ssh-config',
    summary: 'write an ssh config include, so plain `ssh <name>` works',
    run: (a) => runClientCommand('ssh-config', a),
  },
  {
    name: 'offerings',
    summary: 'list what each configured cloud sells, and what it costs',
    run: (a) => runClientCommand('offerings', a),
  },
  {
    name: 'pack',
    // `pack` opens no database and boots no core — it is a pure function of a directory of
    // files, which is what lets somebody else's CI run it (rockysurf-arym.2).
    summary: 'lint or smoke-test a directory of surge packs',
    run: (a) =>
      runPackCommand(a, {
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
      }),
  },
]

export async function runRockysurfCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const [command, ...rest] = argv

  const subcommand = command ? SUBCOMMANDS.find((c) => c.name === command) : undefined
  if (subcommand) return await subcommand.run(rest)

  // The seam wants a registry; compose also returns notes, which boot already logged. The
  // version is this package's, not core's — see readCliVersion. `subcommands` is what makes
  // `--help` able to name the table above. `options` still wins, so a test or an embedder can
  // override any of them.
  return runCli(argv, {
    version: readCliVersion(),
    providers: (context) => composeRegistry(context).registry,
    subcommands: SUBCOMMANDS.map(({ name, summary }) => ({ name, summary })),
    ...options,
  })
}

/**
 * NEITHER `mcp` NOR `token` MAY BOOT CORE (rockysurf-o2t5).
 *
 * Both used to call `boot({ listen: false })` to reach one value, and `listen: false` was
 * understood to make that harmless — it suppresses the listener and the job timers. It does
 * not suppress the STARTUP RECOVERY PASS, which `boot()` runs unconditionally and by design:
 * "a test or a CLI command that opens the database is still core waking up" (server.ts).
 *
 * That reasoning is sound for a CLI command run while core is STOPPED. It is exactly wrong for
 * these two, which are run precisely when core is RUNNING — an MCP client and a token are
 * useful at no other time. So a second core woke up on a live data directory and passed
 * judgement on the first one's in-flight servers: every row in `requested`/`provisioning` was
 * synced against a provider registry THIS process had just built, and settled. With the fake
 * provider, which has never heard of those instances, a healthy provisioning fleet was marked
 * `terminated` by a command whose entire job was to print a token. With a real provider the row
 * is re-attached instead — into a process that exits a moment later, so the watch it just took
 * on dies with it — and when the provider cannot be built at all (credential unreadable from
 * this process, API down) the row is failed with "recovery failed: …".
 *
 * The fix is not an option on `boot()` that turns recovery off. Recovery running unconditionally
 * is what makes a stuck row impossible after a crash, and a `recover: false` switch is a thing
 * for the next caller to reach for wrongly. These two commands simply do not need core: `mcp`
 * needs one config value and `token` needs one table. So they read what they need and nothing
 * opens a control plane.
 */

/**
 * `rockysurf mcp` — serve the MCP tools over stdio (rockysurf-ftl9.1).
 *
 * Reads scopes from the config file rather than from a flag, because a permission an agent's
 * launch command can set is a permission the agent can eventually talk someone into setting.
 * Config is where an operator reviews it.
 *
 * A CONFIG PARSE AND NOTHING ELSE. This command never touches the data directory — no database
 * file is opened, so there is nothing for it to race the running control plane over. `argv` is
 * passed explicitly rather than left to `process.argv`, so `--config` works when the CLI is
 * called in-process as well as from a shell.
 *
 * AND IT PARSES THE CONFIG IN SOMEBODY ELSE'S ENVIRONMENT (rockysurf-dd9q). A `.mcp.json` runs
 * `rockysurf mcp` with the variables that file sets and no others, so the operator's shell
 * exports are simply not there — and boot's rule, that every `${VAR}` the file names must be
 * set, made an installation with one repository token in its config unable to serve MCP at all
 * until every unrelated secret was duplicated into the client's environment. `scopes` is the
 * one value this command reads, so `scopes` is the one it demands.
 */
async function runMcpCommand(argv: string[]): Promise<number> {
  const config = loadConfigLenientlyOrExit({ argv, requires: (c) => ({ 'mcp.scopes': c.mcp.scopes }) })
  return runMcpServer({ scopes: config.mcp.scopes })
}

/**
 * `rockysurf token` — mint a token for an MCP client, printed once.
 *
 * A SESSION, not a new kind of credential. Sessions are already opaque, hashed at rest,
 * revocable by logout and covered by tests; inventing a second credential system for this
 * would mean a second thing to get wrong. The cost is stated in the output: revoking it means
 * signing out everywhere, which is the honest trade at v0.1 and the thing to improve when
 * per-token scopes arrive.
 *
 * ONE TABLE AND ONE INSERT, against a database core is very probably serving right now. See the
 * note above on why it may not boot core to get there.
 *
 * Two settings, and therefore two demands (rockysurf-dd9q): the data directory it opens the
 * database under, and the port it prints in the `.mcp.json` it tells the operator to paste. A
 * `${ACME_PAT}` this command never reads is somebody else's problem, and refusing to mint a
 * token over one was how an operator ended up exporting dummy values to get past it.
 */
async function runTokenCommand(argv: string[]): Promise<number> {
  const config = loadConfigLenientlyOrExit({
    argv,
    requires: (c) => ({ 'server.dataDir': c.server.dataDir, 'server.port': c.server.port }),
  })
  const databasePath = defaultDatabasePath(config.server.dataDir)
  // No database file means core has never run here, which is the same answer as no admin row.
  // Checked before opening, because better-sqlite3 CREATES the file it is pointed at, and
  // leaving an empty rockysurf.db behind after a failed command is a trap for the next boot.
  if (!existsSync(databasePath)) return noAdminYet()

  // A GUEST in a database core owns, and the two options say so:
  //   - `migrate: false` — a CLI must never migrate a schema out from under a control plane
  //     that is running on it. `npx rockysurf token` can easily be a NEWER build than the core
  //     someone started last week; applying its migrations to that live database is how a
  //     running process ends up querying tables that changed shape underneath it. Core migrates
  //     on its own boot, which is the only moment it is safe.
  //   - no provider registry, no app, no jobs, no recovery pass — a session insert needs none
  //     of them, and each is a way for this process to act on servers it does not own.
  // Two processes on one SQLite file is otherwise fine here: WAL plus one short indexed read
  // and one insert is what the database is already doing for every web login.
  const opened = openDatabase({ url: databasePath, migrate: false })

  try {
    const user = findAdmin(opened)
    if (!user) return noAdminYet()

    const { token } = issueSession(opened.db, user.id, MCP_TOKEN_TTL_MS)
    const port = config.server.port

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
    opened.close()
  }
}

/** The one thing a token cannot be minted without, said the same way wherever it is missing. */
function noAdminYet(): number {
  process.stderr.write('no admin account exists yet — start Rocky Surf once first.\n')
  return 1
}

/**
 * The single-admin account, which is who an MCP client acts as.
 *
 * The `sqlite_master` check is what stands in for the migration this command deliberately does
 * not run: a database file that exists but has no `users` table is a core that never finished
 * its first boot, and the honest answer is the same "start Rocky Surf once first" rather than
 * `SqliteError: no such table`.
 */
function findAdmin(opened: OpenedDatabase): { id: string } | undefined {
  const migrated = opened.sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'`)
    .get()
  if (!migrated) return undefined

  const rows = opened.sqlite
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
 * Every occurrence of a repeatable flag, in the order they were written (rockysurf-81wo).
 *
 * `--repo` is repeatable rather than comma-separated because a repository URL may not contain a
 * comma but a shell user should not have to know that, and because the order matters more than
 * it looks: it is what the create route preflights, and what decides which of the installation's
 * git tokens the box is built with (rockysurf-18lq). `flagValue` cannot do this — it takes the
 * first match and stops.
 */
function flagValues(argv: string[], flag: string): string[] {
  const values: string[] = []
  argv.forEach((arg, index) => {
    if (arg === flag) {
      const next = argv[index + 1]
      // A bare `--repo --size small` would otherwise record `--size` as a repository URL, and
      // the preflight would refuse it with a sentence about a URL nobody typed.
      if (next !== undefined && !next.startsWith('-')) values.push(next)
    } else if (arg.startsWith(`${flag}=`)) {
      values.push(arg.slice(flag.length + 1))
    }
  })
  return values
}

/**
 * The thin CLI commands: the ones that talk to a RUNNING control plane over HTTP rather than
 * opening its database (rockysurf-ftl9.2).
 *
 * They need a token, exactly as the MCP server does — one authorization story, one set of
 * limits, nothing for a second code path to drift from. Deliberately does NOT open the
 * database: these run against a control plane someone else is serving, from a laptop that may
 * not be the one running it.
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
  // The one place ambient state enters the commands: the environment a secret may arrive in,
  // and the terminal one may be typed at. `ttySecretPrompt` is undefined when there is no
  // terminal, and the create path has a different message for that case.
  const promptSecret = ttySecretPrompt()
  const deps: CliDeps = {
    client,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    ...(promptSecret ? { promptSecret } : {}),
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
          // `--arch` is a closed choice and `--offering` is not, for the reason on `CreateArgs`:
          // the architectures are the SDK's frozen list, the offering ids are the operator's
          // cloud's (rockysurf-zaqs). Validation of the first lives in `createCommand`, beside
          // the message, rather than here beside the parsing.
          ...(flagValue(argv, '--arch') ? { arch: flagValue(argv, '--arch')! } : {}),
          ...(flagValue(argv, '--offering') ? { offeringId: flagValue(argv, '--offering')! } : {}),
          // Repeatable: `rockysurf create --pack p --repo <url> --repo <url>` (rockysurf-81wo).
          // Until this existed the CLI could not name a repository at all, so a `requiresRepos`
          // pack provisioned an empty box and the create route's preflight — which lives in the
          // route precisely so all three front ends get it — could never fire for a CLI create.
          repositories: flagValues(argv, '--repo'),
          createAnyway: argv.includes('--create-anyway'),
          rdpPassword: rdpPasswordFlag(argv),
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
      case 'offerings':
        return await offeringsCommand(deps, {
          ...(flagValue(argv, '--provider') ? { provider: flagValue(argv, '--provider')! } : {}),
        })
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
