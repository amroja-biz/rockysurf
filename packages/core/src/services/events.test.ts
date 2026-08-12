import { describe, expect, it, vi } from 'vitest'
import { createEventsService } from './events.js'

describe('events service', () => {
  it('keeps the legacy broadcastToUser signature: (userId, payload) => Promise<void>', async () => {
    const events = createEventsService()
    // Ported handler bodies call it exactly like this. If this stops compiling or stops
    // returning a promise, those ports break.
    await expect(events.broadcastToUser('usr-1', { type: 'update', data: 'hello' })).resolves.toBeUndefined()
  })

  it('delivers to every stream a user has open', async () => {
    const events = createEventsService()
    const a = vi.fn()
    const b = vi.fn()
    events.subscribe('usr-1', a)
    events.subscribe('usr-1', b)

    await events.broadcastToUser('usr-1', { type: 'update' })

    expect(a).toHaveBeenCalledWith({ type: 'update' })
    expect(b).toHaveBeenCalledWith({ type: 'update' })
  })

  it('does not cross users', async () => {
    const events = createEventsService()
    const mine = vi.fn()
    const theirs = vi.fn()
    events.subscribe('usr-1', mine)
    events.subscribe('usr-2', theirs)

    await events.broadcastToUser('usr-1', { type: 'update' })

    expect(mine).toHaveBeenCalledOnce()
    expect(theirs).not.toHaveBeenCalled()
  })

  it('is a no-op for a user with nothing open, exactly like the WebSocket version', async () => {
    const events = createEventsService()
    await expect(events.broadcastToUser('usr-nobody', { type: 'update' })).resolves.toBeUndefined()
  })

  it('stops delivering after unsubscribe', async () => {
    const events = createEventsService()
    const listener = vi.fn()
    const unsubscribe = events.subscribe('usr-1', listener)

    unsubscribe()
    await events.broadcastToUser('usr-1', { type: 'update' })

    expect(listener).not.toHaveBeenCalled()
    expect(events.listenerCount('usr-1')).toBe(0)
  })

  it('tolerates a double unsubscribe without corrupting the count', async () => {
    // The SSE handler can both abort and finalize, so this really does happen.
    const events = createEventsService()
    const unsubscribe = events.subscribe('usr-1', vi.fn())
    events.subscribe('usr-2', vi.fn())

    unsubscribe()
    unsubscribe()

    expect(events.totalListeners).toBe(1)
    expect(events.listenerCount('usr-1')).toBe(0)
  })

  it('counts open streams', () => {
    const events = createEventsService()
    expect(events.totalListeners).toBe(0)
    events.subscribe('usr-1', vi.fn())
    events.subscribe('usr-1', vi.fn())
    events.subscribe('usr-2', vi.fn())
    expect(events.listenerCount('usr-1')).toBe(2)
    expect(events.totalListeners).toBe(3)
  })
})
