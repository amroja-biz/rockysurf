import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_SCRIPT_PATH } from './index.js'
import { serializeInstallPlan, type InstallPlan, type InstallStep } from './plan.js'

/**
 * Issue #168, run against the real `agent.sh`: the TERMINAL failure report carries the last
 * lines of the agent's own log as `agentLog`, so a user troubleshooting a failed launch gets
 * the whole install's narrative, not just the one failed step's tail.
 *
 * Why this matters in callback mode specifically: a failed TOOL install releases the machine
 * (ADR-0010), core never opens SSH, and `agent.log` — the only file that holds every step's
 * output in order — dies with the box. The failure POST is the one channel it can leave by.
 * Push mode is covered separately: core reads the same file over SSH (`AGENT_LOG_TAIL_LINES`
 * in `push.ts`) and `supervisor.test.ts` pins that it lands on the report.
 *
 * Same harness as `apt-retry.test.ts`: the real shell, a temp state dir, and a fake `curl`
 * first on PATH that records every body the agent posts. Skipped, loudly, where jq is absent —
 * every CI runner this repository uses has it.
 */

const hasJq = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0

let stateDir: string | null = null
let binDir: string | null = null

afterEach(() => {
  for (const dir of [stateDir, binDir]) if (dir) rmSync(dir, { recursive: true, force: true })
  stateDir = null
  binDir = null
})

const step = (id: string, run: string, extra: Partial<InstallStep> = {}): InstallStep => ({
  id,
  reports: 'installing_tools',
  runAs: 'root',
  run,
  ...extra,
})

function runAgent(steps: InstallStep[]) {
  stateDir = mkdtempSync(join(tmpdir(), 'rockysurf-agent-log-'))
  binDir = mkdtempSync(join(tmpdir(), 'rockysurf-agent-log-bin-'))

  // Every `report_progress` body arrives on the fake curl's stdin (`--data @-`); one JSON
  // document per line, appended in order.
  const fakeCurl = join(binDir, 'curl')
  writeFileSync(fakeCurl, '#!/bin/bash\ncat >> "$ROCKYSURF_STATE_DIR/posts.jsonl"\nexit 0\n')
  chmodSync(fakeCurl, 0o755)

  const callbackUrl = 'http://core.invalid/internal/servers/srv-agent-log/status'
  const plan: InstallPlan = {
    version: 1,
    serverId: 'srv-agent-log',
    mode: 'callback',
    runId: 'run-1',
    callbackUrl,
    steps,
  }
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'plan.json'), serializeInstallPlan(plan))
  writeFileSync(
    join(stateDir, 'callback.env'),
    `ROCKYSURF_CALLBACK_URL='${callbackUrl}'\nROCKYSURF_TOKEN='cb-token'\n`,
  )

  const run = spawnSync('bash', [AGENT_SCRIPT_PATH, join(stateDir, 'plan.json')], {
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      PATH: `${binDir}:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
      ROCKYSURF_STATE_DIR: stateDir,
      ROCKYSURF_APT_RETRY_WAIT_S: '0',
    },
  })
  const posts = readFileSync(join(stateDir, 'posts.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  return { status: run.status, output: `${run.stdout}${run.stderr}`, posts }
}

describe.skipIf(!hasJq)('the terminal failure report carries the whole install log (#168)', () => {
  it('sends agent.log’s last lines as agentLog on the failed report, and only there', () => {
    const { status, output, posts } = runAgent([
      step('tool:first', 'echo "MARKER: first tool installed fine"'),
      step('tool:doomed', 'echo "the last thing the install said"; exit 1'),
    ])
    expect(status, output).toBe(1)

    const failed = posts.filter((p) => p['status'] === 'failed')
    expect(failed.length, output).toBeGreaterThan(0)
    const report = failed.at(-1)!
    expect(report['stepId']).toBe('tool:doomed')

    // The whole install's narrative, not just the failed step: a step that succeeded EARLIER
    // is in it, and so is the agent's own account of what it was starting when it broke.
    const agentLog = report['agentLog']
    expect(typeof agentLog, output).toBe('string')
    expect(agentLog).toContain('MARKER: first tool installed fine')
    expect(agentLog).toContain('==> tool:doomed')

    // Progress reports stay lean: nothing before the terminal failure carries the agent log.
    for (const post of posts) {
      if (post === report) continue
      expect(post['agentLog'], `unexpected agentLog on ${JSON.stringify(post['stepId'])}/${JSON.stringify(post['status'])}`).toBeUndefined()
    }
  })
})
