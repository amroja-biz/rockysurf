import { describe, expect, it } from 'vitest'
import { generateSshKeyPair, makeHostKeyVerifier } from '../ssh/keys.js'
import { CallbackUnavailableError, selectBootstrapMode } from './push-runner.js'
import { adoptableRunId, completedSteps, isCurrentRun, parseAgentState, systemdRunCommand } from './push.js'

const RUN = 'c4bbcc78-bd3d-4040-a3f7-6eb32f3799f9'

const journal = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    planVersion: 1,
    serverId: 'srv-abc',
    runId: RUN,
    step: 'tool:node',
    status: 'running',
    updatedAt: '2026-08-12T02:48:47Z',
    steps: [
      { id: 'tool:apt', reports: 'installing_tools', status: 'done', finishedAt: '2026-08-12T02:48:31Z' },
      { id: 'tool:node', reports: 'installing_tools', status: 'running' },
    ],
    ...over,
  })

describe('parseAgentState', () => {
  it('reads a well-formed journal', () => {
    const state = parseAgentState(journal())
    expect(state?.runId).toBe(RUN)
    expect(state?.status).toBe('running')
    expect(completedSteps(state)).toEqual(['tool:apt'])
  })

  it('treats absent, torn or non-JSON content as "no news yet"', () => {
    // The poller reads this file while the agent renames a new one into place. A throw here
    // would turn a routine race into a failed bootstrap.
    expect(parseAgentState('')).toBeNull()
    expect(parseAgentState('{"planVersion":1,"serverId":"srv-abc","ste')).toBeNull()
    expect(parseAgentState('null')).toBeNull()
    expect(parseAgentState('[]')).toBeNull()
    expect(parseAgentState(JSON.stringify({ step: 'x', status: 'finished', steps: [] }))).toBeNull()
  })

  it('carries the failure detail the agent journalled', () => {
    const state = parseAgentState(
      journal({ status: 'failed', failedStep: 'tool:node', logTail: 'curl: (6) Could not resolve host' }),
    )
    expect(state?.status).toBe('failed')
    expect(state?.failedStep).toBe('tool:node')
    expect(state?.logTail).toContain('Could not resolve host')
  })

  it('carries the notice the agent journalled while a step waits, and nothing when it did not', () => {
    // The apt wait (#129) is the first reason a step deliberately stalls; the journal says so
    // in one line while it lasts. An empty string is "no notice", not a blank line to show.
    const waiting = parseAgentState(journal({ notice: "Ubuntu's package archive is out of sync — waiting 2 min" }))
    expect(waiting?.notice).toBe("Ubuntu's package archive is out of sync — waiting 2 min")
    expect(parseAgentState(journal())?.notice).toBeUndefined()
    expect(parseAgentState(journal({ notice: '' }))?.notice).toBeUndefined()
  })
})

describe('runId filtering (conformance #4)', () => {
  it('accepts only the journal belonging to this run', () => {
    const state = parseAgentState(journal())
    expect(isCurrentRun(state, RUN)).toBe(true)
    expect(isCurrentRun(state, 'a-different-run')).toBe(false)
  })

  it('rejects a journal from before run ids existed', () => {
    // Without this, a push to an already-bootstrapped box reads the PREVIOUS run's terminal
    // status as its own result — and a retry of a FAILED bootstrap reports the old failure.
    const legacy = parseAgentState(journal({ runId: undefined }))
    expect(legacy).not.toBeNull()
    expect(isCurrentRun(legacy, RUN)).toBe(false)
  })

  it('rejects a terminal journal from a previous run, which is the bug this prevents', () => {
    const previous = parseAgentState(journal({ runId: 'previous-run', status: 'done' }))
    expect(isCurrentRun(previous, RUN)).toBe(false)
  })
})

/**
 * Rejoining a run already in progress (rockysurf-55fx.13).
 *
 * `init_state` in agent.sh reads the run id from plan.json ONCE, at launch, so a push that
 * finds a LIVE agent and mints a fresh id watches a healthy install in silence: nothing
 * relaunches the agent, the journal keeps carrying the old id, and every update is discarded as
 * a foreign run until the stall timeout fires fifteen minutes later. That is the shape of every
 * re-push after a core restart, which is exactly when resume matters most.
 */
describe('adopting a live run (restart resume)', () => {
  it('adopts the id of an agent that is still working on this server', () => {
    expect(adoptableRunId(parseAgentState(journal()), true, 'srv-abc')).toBe(RUN)
  })

  it('mints a fresh id when nothing is running, however recent the journal', () => {
    // No live agent means no one to disagree with: this push owns the next run.
    expect(adoptableRunId(parseAgentState(journal()), false, 'srv-abc')).toBeUndefined()
  })

  it('never adopts a TERMINAL journal, which is what keeps conformance #4 intact', () => {
    // A re-push to a finished box must not read the previous attempt's result as its own,
    // even if something is still alive on the machine.
    expect(adoptableRunId(parseAgentState(journal({ status: 'done' })), true, 'srv-abc')).toBeUndefined()
    expect(adoptableRunId(parseAgentState(journal({ status: 'failed' })), true, 'srv-abc')).toBeUndefined()
  })

  it('never adopts a journal belonging to a different server', () => {
    expect(adoptableRunId(parseAgentState(journal()), true, 'srv-someone-else')).toBeUndefined()
  })

  it('mints a fresh id when there is no journal, or it predates run ids', () => {
    expect(adoptableRunId(null, true, 'srv-abc')).toBeUndefined()
    expect(adoptableRunId(parseAgentState(journal({ runId: undefined })), true, 'srv-abc')).toBeUndefined()
  })
})

describe('the systemd unit (conformance #10)', () => {
  const cmd = systemdRunCommand('/var/lib/rockysurf')

  it('carries every flag the bootstrap contract requires', () => {
    expect(cmd).toContain('--unit=rockysurf-bootstrap')
    expect(cmd).toContain('--collect')
    expect(cmd).toContain('--property=Type=exec')
    expect(cmd).toContain('--property=Restart=on-failure')
    expect(cmd).toContain('--property=After=network-online.target')
    // Bounded restarts: Restart=on-failure without a limit loops forever on a broken plan.
    expect(cmd).toContain('--property=StartLimitBurst=3')
  })

  it('runs through sudo and quotes the path', () => {
    expect(cmd.startsWith('sudo systemd-run')).toBe(true)
    expect(cmd).toContain("'/var/lib/rockysurf/agent.sh'")
  })
})

describe('host-key verification (conformance #15)', () => {
  const blobOf = (line: string) => Buffer.from(line.split(/\s+/)[1]!, 'base64')

  it('accepts the pinned key and rejects any other', () => {
    const box = generateSshKeyPair('rockysurf-host@srv-abc')
    const impostor = generateSshKeyPair('rockysurf-host@srv-evil')
    const verify = makeHostKeyVerifier(box.fingerprint)

    expect(verify(blobOf(box.publicKey))).toBe(true)
    expect(verify(blobOf(impostor.publicKey))).toBe(false)
  })
})

describe('bootstrap mode selection', () => {
  it('defaults to push, which needs nothing inbound', () => {
    expect(selectBootstrapMode({ server: {} })).toBe('push')
    expect(selectBootstrapMode({ server: { publicUrl: 'https://core.example' } })).toBe('push')
    expect(selectBootstrapMode({ server: { publicUrl: 'https://core.example' }, }, 'push')).toBe('push')
  })

  it('allows callback only when core has a public URL for the box to call', () => {
    expect(selectBootstrapMode({ server: { publicUrl: 'https://core.example' } }, 'callback')).toBe('callback')
  })

  it('refuses callback without a public URL rather than silently downgrading', () => {
    // A silent downgrade produces a server that provisions and then never bootstraps, with
    // nothing in the logs explaining why.
    expect(() => selectBootstrapMode({ server: {} }, 'callback')).toThrow(CallbackUnavailableError)
    expect(() => selectBootstrapMode({ server: {} }, 'callback')).toThrow(/needs a core the box can reach/)
  })
})
