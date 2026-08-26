import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerScopedEvent } from '../lib/events'

/**
 * The reason a step is waiting shows under that step, and only while it lasts (#129).
 *
 * The agent's bounded apt wait is two minutes under "Installing tools" with nothing moving —
 * indistinguishable from a hang unless the feed says why. Each progress event either carries
 * a `notice` or clears the one before it, so the feed never has to guess when the wait ended.
 *
 * `useServerUpdates` is replaced with a stub that hands back its callback: the SSE plumbing
 * has its own tests, and what matters here is what the feed does with an event once it has one.
 */

let deliver: ((event: ServerScopedEvent) => void) | undefined

vi.mock('../hooks/useServerUpdates', () => ({
  useServerUpdates: (callback: (event: ServerScopedEvent) => void) => {
    deliver = callback
  },
}))

const { ProvisioningFeed } = await import('./ProvisioningFeed')

const NOTICE = "Ubuntu's package archive is out of sync — waiting 2 min before retrying. Nothing is stuck."

function progress(notice?: string): ServerScopedEvent {
  return { type: 'bootstrap-progress', serverId: 'srv-1', step: 'installing_tools', ...(notice ? { notice } : {}) }
}

afterEach(() => {
  deliver = undefined
})

describe('a progress event with a notice', () => {
  it('shows it under the active step', () => {
    render(<ProvisioningFeed serverId="srv-1" />)
    act(() => deliver!(progress(NOTICE)))

    const active = screen.getByRole('listitem', { current: 'step' })
    expect(active.textContent).toContain('Installing tools')
    expect(active.textContent).toContain(NOTICE)
    expect(screen.getByRole('status').textContent).toBe(NOTICE)
  })
})

describe('the next progress event without one', () => {
  it('clears it, so a notice never outlives its cause', () => {
    render(<ProvisioningFeed serverId="srv-1" />)
    act(() => deliver!(progress(NOTICE)))
    expect(screen.queryByRole('status')).not.toBeNull()

    act(() => deliver!(progress()))
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('listitem', { current: 'step' }).textContent).toBe('Installing tools')
  })
})
