#!/usr/bin/env node
/**
 * "The control plane refuses the agent", as a real MCP client (rockysurf-o45s.1).
 *
 * It speaks JSON-RPC over stdio to `rockysurf mcp`, which speaks HTTP to a running control
 * plane. NOTHING HERE IS STAGED: every line printed below is rendered from a response that
 * came back over the wire, and the refusal — the point of the whole clip — is printed from the
 * verbatim payload the MCP server returned.
 *
 * WHICH LIMIT DOES THE REFUSING IS THE CONFIG'S BUSINESS, not this script's. It lists the
 * fleet, then creates servers until something says no, and renders whatever core said. Point
 * it at an installation with a small `limits.maxServers` and it films that; point it at one
 * with a spend cap in force and it waits for the uptime ticker to carry the month past the cap
 * and films that instead. Nothing here decides the outcome, which is the property that makes
 * the clip worth recording at all.
 *
 * Hand-rolled rather than built on the MCP SDK, deliberately. The protocol traffic this clip
 * is about should be readable in the file someone opens afterwards, and a demo that needs an
 * install first is a demo nobody re-runs. Stdio framing is newline-delimited JSON; that is the
 * whole of it.
 *
 * Environment:
 *   ROCKYSURF_URL      control plane to drive       (default http://127.0.0.1:3000)
 *   ROCKYSURF_TOKEN    session token from `rockysurf token`   (required)
 *   ROCKYSURF_MCP_CMD  command serving MCP on stdio (default `npx -y rockysurf mcp`)
 *
 * `docs/media/mcp-refusal.sh` sets all three up against a throwaway control plane and records
 * the result; see that script for the full reproduction.
 */

import { spawn } from 'node:child_process'

const BASE_URL = process.env['ROCKYSURF_URL'] ?? 'http://127.0.0.1:3000'
const TOKEN = process.env['ROCKYSURF_TOKEN']
const MCP_CMD = process.env['ROCKYSURF_MCP_CMD'] ?? 'npx -y rockysurf mcp'
/** How long to wait for a spend cap to be crossed before giving up. */
const WAIT_TIMEOUT_MS = 15 * 60 * 1000
/**
 * How many servers to try to create before concluding that nothing is going to refuse.
 *
 * A guard, not a script: the clip is over when core says no, and an installation whose limits
 * never say no is a failed recording rather than a long one.
 */
const MAX_CREATES = 6
/**
 * When recording a SPEND CAP refusal: how long after the run starts to attempt the refused
 * create, in milliseconds.
 *
 * A spend cap is crossed by a ticker that runs once a minute, so the moment it happens is only
 * predictable to within a tick — and a screen recording needs to know when to start looking
 * again. Holding the last act until a fixed point past the crossing makes the tape's timings
 * reproducible. Ignored entirely when no cap is configured, because then there is nothing to
 * wait for.
 */
const ACT2_AT_MS = Number(process.env['ROCKYSURF_DEMO_ACT2_AT_MS'] ?? 0)

if (!TOKEN) {
  process.stderr.write('ROCKYSURF_TOKEN is not set — mint one with `rockysurf token`.\n')
  process.exit(1)
}

/* ----------------------------------------------------------------------------- rendering */

const c = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[38;2;125;133;144m',
  fg: '\u001b[38;2;230;237;243m',
  blue: '\u001b[38;2;88;166;255m',
  green: '\u001b[38;2;63;185;80m',
  red: '\u001b[38;2;248;81;73m',
  amber: '\u001b[38;2;210;153;34m',
}

const out = (text = '') => process.stdout.write(`${text}\n`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** A beat between lines, so the clip reads at human speed rather than dumping all at once. */
const beat = (ms = 700) => sleep(ms)
const pad = (n) => ' '.repeat(n)

/** Wrap `text` to `width` columns, indenting every line by `indent` spaces. */
function wrap(text, width, indent) {
  const lines = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(pad(indent) + line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(pad(indent) + line)
  return lines
}

const money = (amount) => amount.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0')

const clock = (ms) => {
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`
}

/* ------------------------------------------------------------------ the MCP stdio client */

function connect() {
  const child = spawn(MCP_CMD, {
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ROCKYSURF_URL: BASE_URL, ROCKYSURF_TOKEN: TOKEN },
  })

  const pending = new Map()
  let buffered = ''
  let stderrText = ''

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffered += chunk
    let newline
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline).trim()
      buffered = buffered.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line)
      const waiter = pending.get(message.id)
      if (!waiter) continue
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result)
    }
  })

  // The server's own operator banner. stdout is the protocol channel, so everything it says to
  // a human arrives here — including which scopes this installation granted.
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderrText += chunk
  })

  let nextId = 1
  const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)

  return {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        write({ jsonrpc: '2.0', id, method, params })
      }),
    notify: (method, params) => write({ jsonrpc: '2.0', method, params }),
    banner: () => stderrText.trim(),
    close: () => child.kill(),
  }
}

/** One `tools/call`, with the result text handed back exactly as it arrived. */
async function callTool(rpc, name, args) {
  const result = await rpc.request('tools/call', { name, arguments: args })
  const text = (result.content ?? []).map((part) => part.text ?? '').join('\n')
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = undefined
  }
  return { isError: Boolean(result.isError), text, data }
}

/* -------------------------------------------------------------------------------- the run */

const AGENT = `${c.green}agent${c.reset}`
const CORE = `${c.blue}core ${c.reset}`
const GUTTER = 8

/**
 * A server's quoted hourly price, as the control plane reported it (real since
 * rockysurf-dec8 — before that fix no row was ever priced).
 *
 * A provider that quotes nothing gives `undefined`, which the SDK defines as UNKNOWN rather
 * than free, so it renders as `unpriced` rather than as a zero.
 */
const rate = (server) =>
  server.hourlyCost ? `${server.hourlyCost.amount} ${server.hourlyCost.currency}/hr` : 'unpriced'

function printCall(name, args) {
  const rendered = Object.keys(args).length === 0 ? '{}' : JSON.stringify(args)
  out(`  ${AGENT} ${c.dim}→${c.reset} ${c.bold}${name}${c.reset} ${c.dim}${rendered}${c.reset}`)
}

/**
 * The spend line, printed only when a cap is actually configured.
 *
 * An installation with no cap reports zeroes here, and a zero that means "not measured" beside
 * a zero that means "nothing spent" is exactly the kind of number a clip should not show.
 */
function printSpend(spend) {
  if (!spend?.cap) return
  const spent = spend.monthToDateByCurrency?.[spend.cap.currency] ?? 0
  const percent = Math.round(spend.cap.fractionUsed * 100)
  const tone = spend.cap.overCap ? c.red : percent >= 75 ? c.amber : c.dim
  out(
    `${pad(GUTTER)}${c.dim}month-to-date${c.reset} ${tone}${money(spent)} of ${spend.cap.amount} ` +
      `${spend.cap.currency} cap (${percent}%)${c.reset}`,
  )
}

/**
 * Wait for the control plane's uptime ticker to carry month-to-date spend past the cap,
 * narrating the wait in place on one line.
 *
 * Only reached on an installation that HAS a spend cap. It polls with `list_servers` — a read,
 * the same tool the agent already used — because the cap state an agent can see is the cap
 * state that matters here.
 */
async function waitForCap(rpc, initial) {
  const startedWaiting = Date.now()
  let spend = initial
  let crossedAfter
  while (crossedAfter === undefined || Date.now() - startedWaiting < ACT2_AT_MS) {
    const elapsed = Date.now() - startedWaiting
    if (elapsed > WAIT_TIMEOUT_MS) {
      out(`\n  ${c.red}gave up waiting for the spend cap to be crossed${c.reset}`)
      rpc.close()
      process.exit(1)
    }
    const spent = spend.monthToDateByCurrency?.[spend.cap.currency] ?? 0
    process.stdout.write(
      crossedAfter === undefined
        ? `\r  ${c.dim}⟳ the fleet keeps billing · ${clock(elapsed)} · ` +
            `${money(spent)} of ${spend.cap.amount} ${spend.cap.currency}${c.reset}   `
        : `\r  ${c.amber}⟳ the spend ticker crossed the cap after ${clock(crossedAfter)} · ` +
            `${money(spent)} ${spend.cap.currency}${c.reset}   `,
    )
    await sleep(5000)
    spend = (await callTool(rpc, 'list_servers', {})).data?.spend ?? spend
    if (crossedAfter === undefined && spend.cap?.overCap) crossedAfter = Date.now() - startedWaiting
  }
  const spentNow = spend.monthToDateByCurrency?.[spend.cap.currency] ?? 0
  process.stdout.write(
    `\r  ${c.amber}⟳ the spend ticker crossed the cap after ${clock(crossedAfter)} · ` +
      `${money(spentNow)} ${spend.cap.currency}${c.reset}   \n`,
  )
  out()
  await beat()
}

/** What to say after the refusal, per limit. Core names the limit; this only reads it back. */
const CLOSING = {
  max_servers: [
    'The refusal is the control plane\'s, not the agent\'s good judgement.',
    'And the way out it names — terminate one — is a scope it lacks.',
  ],
  spend_cap: [
    'The refusal is the control plane\'s, not the agent\'s good judgement.',
    'Server-side limits are what make an agent\'s cloud budget a budget.',
  ],
  create_rate: [
    'The refusal is the control plane\'s, not the agent\'s good judgement.',
    'A terminate-and-recreate loop stops here, whatever the agent believes.',
  ],
}

async function main() {
  const rpc = connect()
  await rpc.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'rockysurf-refusal-demo', version: '0.1.0' },
  })
  rpc.notify('notifications/initialized', {})
  const { tools } = await rpc.request('tools/list', {})

  out()
  for (const bannerLine of rpc.banner().split('\n')) out(`  ${c.dim}${bannerLine}${c.reset}`)
  const names = tools.map((tool) => tool.name)
  if (!names.includes('terminate_server')) {
    await beat(400)
    out(
      `  ${c.dim}${names.length} tools offered · ${c.reset}${c.amber}no terminate_server${c.reset}` +
        `${c.dim} — that scope was not granted${c.reset}`,
    )
  }
  out()
  await beat(1400)

  /* ---- 1. the fleet the agent already has ---- */

  printCall('list_servers', {})
  const listed = await callTool(rpc, 'list_servers', {})
  await beat(500)
  const servers = listed.data?.servers ?? []
  out(`  ${CORE} ${c.dim}←${c.reset} ${servers.length} servers`)
  const shown = servers.slice(0, 4)
  for (const server of shown) {
    out(
      `${pad(GUTTER)}${c.dim}${server.serverId}${c.reset}  ${server.name.padEnd(8)}  ` +
        `${c.dim}${server.status.padEnd(12)}  ${rate(server)}${c.reset}`,
    )
  }
  if (servers.length > shown.length) {
    out(`${pad(GUTTER)}${c.dim}… and ${servers.length - shown.length} more${c.reset}`)
  }
  printSpend(listed.data?.spend)
  out()
  await beat(1400)

  /* ---- 2. create until something says no ---- */

  let refused
  for (let attempt = 1; attempt <= MAX_CREATES && !refused; attempt++) {
    const args = { name: `agent-box-${attempt}`, size: 'small' }
    printCall('create_server', args)
    const result = await callTool(rpc, 'create_server', args)
    await beat(600)

    if (result.isError) {
      refused = result
      break
    }

    const server = result.data?.server ?? {}
    out(
      `  ${CORE} ${c.dim}←${c.reset} ${c.green}created${c.reset} ${c.dim}${server.serverId}${c.reset}  ` +
        `${c.dim}${server.status}  ${rate(server)}${c.reset}`,
    )
    printSpend(result.data?.spend)
    out()
    await beat(1300)

    // When a SPEND CAP is the limit in force, the next create is refused only once the uptime
    // ticker has carried the month past it — so wait for that rather than hammering create.
    const spend = result.data?.spend
    if (spend?.cap && !spend.cap.overCap) await waitForCap(rpc, spend)
  }

  if (!refused) {
    out(`  ${CORE} ${c.red}${MAX_CREATES} creates and nothing refused any of them${c.reset}`)
    rpc.close()
    process.exit(1)
  }

  out(`  ${CORE} ${c.red}${c.bold}✖ REFUSED${c.reset} ${c.dim}— MCP result, isError: true${c.reset}`)
  await beat(500)
  const body = refused.data ?? {}
  const field = async (key, tone = c.fg) => {
    out(`${pad(GUTTER)}${c.dim}"${key}":${c.reset} ${tone}${JSON.stringify(body[key])}${c.reset}`)
    await beat(280)
  }
  await field('refused', c.red)
  await field('status', c.red)
  await field('code', c.red)
  await field('reason', `${c.bold}${c.red}`)
  out(`${pad(GUTTER)}${c.dim}"message":${c.reset}`)
  for (const line of wrap(String(body.message ?? refused.text), 58, GUTTER + 2)) {
    out(`${c.fg}${line}${c.reset}`)
    await beat(300)
  }
  out()
  await beat(1500)

  for (const line of CLOSING[body.reason] ?? CLOSING.max_servers) {
    out(`  ${c.dim}${line}${c.reset}`)
    await beat(900)
  }
  out()

  rpc.close()
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(1)
})
