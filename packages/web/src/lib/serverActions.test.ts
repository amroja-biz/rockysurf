import { describe, expect, it } from 'vitest'
import type { Server } from './api'
import { destructiveAction, machineIsGone } from './serverActions'

/**
 * The rule two pages ask (issue #154), on its own.
 *
 * The wiring tests prove each page ASKS it; this proves what the answer is, including for the
 * row shape that made the bug possible — a `failed` row that still has a machine.
 */
const row = (over: Partial<Server>): Pick<Server, 'status' | 'billing' | 'name'> =>
  ({ name: 'dev-box', status: 'failed', ...over }) as Server

const BILLING = { live: true as const, providerState: 'running', since: '2026-08-26T11:42:42.509Z' }

describe('machineIsGone', () => {
  it('is true for a failed row core released, which has no billing block', () => {
    expect(machineIsGone(row({ billing: undefined }))).toBe(true)
  })

  it('is false for a failed row whose machine was KEPT and is still metering', () => {
    // The #138 guard: `failed` alone must never mean "gone", or Dismiss would hide a live bill.
    expect(machineIsGone(row({ billing: BILLING }))).toBe(false)
  })

  it('is false for every row that is not failed at all', () => {
    for (const status of ['requested', 'provisioning', 'running', 'stopped', 'terminated'] as const) {
      expect(machineIsGone(row({ status, billing: undefined })), status).toBe(false)
    }
  })
})

describe('destructiveAction', () => {
  it('offers Dismiss, and warns only that the row is cleared', () => {
    const action = destructiveAction(row({ billing: undefined }))
    expect(action.label).toBe('Dismiss')
    expect(action.confirmTitle).toBe('Dismiss dev-box?')
    expect(action.confirmMessage).toContain('already gone')
    expect(action.confirmMessage).not.toContain('disk')
  })

  it('offers Terminate, and warns that it destroys a disk, when there is a machine', () => {
    const action = destructiveAction(row({ billing: BILLING }))
    expect(action.label).toBe('Terminate')
    expect(action.confirmTitle).toBe('Terminate dev-box?')
    expect(action.confirmMessage).toContain('cannot be undone')
  })
})
