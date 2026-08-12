import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createJob } from './run-job.js'

/**
 * The runner, under fake timers. Every property here is a bug the naive
 * `setInterval(async () => …)` has.
 */

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Let queued microtasks settle without advancing fake time. */
const settle = () => vi.advanceTimersByTimeAsync(0)

describe('scheduling', () => {
  it('does not run before the first interval elapses', async () => {
    const tick = vi.fn()
    const job = createJob({ name: 'j', intervalMs: 100, tick })
    job.start()

    await vi.advanceTimersByTimeAsync(99)
    expect(tick).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(tick).toHaveBeenCalledOnce()

    await job.stop()
  })

  it('runs immediately when asked to', async () => {
    const tick = vi.fn()
    const job = createJob({ name: 'j', intervalMs: 100, tick, runOnStart: true })
    job.start()
    await settle()
    expect(tick).toHaveBeenCalledOnce()
    await job.stop()
  })

  it('keeps ticking on schedule', async () => {
    const tick = vi.fn()
    const job = createJob({ name: 'j', intervalMs: 100, tick })
    job.start()

    await vi.advanceTimersByTimeAsync(350)
    expect(tick).toHaveBeenCalledTimes(3)
    expect(job.runs).toBe(3)

    await job.stop()
  })

  it('start() is idempotent, so a double-start does not double the rate', async () => {
    const tick = vi.fn()
    const job = createJob({ name: 'j', intervalMs: 100, tick })
    job.start()
    job.start()

    await vi.advanceTimersByTimeAsync(200)
    expect(tick).toHaveBeenCalledTimes(2)
    await job.stop()
  })

  it('jitters only the first delay, so jobs started together do not stay in lockstep', async () => {
    const delays: number[] = []
    const job = createJob({
      name: 'j',
      intervalMs: 1000,
      tick: () => {},
      jitter: 0.5,
      random: () => 1, // maximum jitter
      setTimer: ((fn: () => void, ms?: number) => {
        delays.push(ms ?? 0)
        return setTimeout(fn, ms)
      }) as typeof setTimeout,
    })
    job.start()
    await vi.advanceTimersByTimeAsync(3000)
    // First tick pushed out to 1500ms; the cadence after it is the plain interval.
    expect(delays[0]).toBe(1500)
    await job.stop()
  })
})

describe('overlap guard', () => {
  it('drops a tick rather than running it beside a slow predecessor', async () => {
    let running = 0
    let maxConcurrent = 0
    const job = createJob({
      name: 'slow',
      intervalMs: 100,
      // Three intervals long: the naive implementation would have three running at once.
      tick: async () => {
        running++
        maxConcurrent = Math.max(maxConcurrent, running)
        await new Promise((resolve) => setTimeout(resolve, 300))
        running--
      },
    })
    job.start()

    await vi.advanceTimersByTimeAsync(1000)

    expect(maxConcurrent).toBe(1)
    expect(job.skipped).toBeGreaterThan(0)

    // stop() awaits the tick in flight, which needs fake time to finish — so let it run.
    const stopped = job.stop()
    await vi.advanceTimersByTimeAsync(500)
    await stopped
  })

  it('drops rather than queues, so a slow dependency cannot build a backlog', async () => {
    let started = 0
    const job = createJob({
      name: 'slow',
      intervalMs: 10,
      tick: async () => {
        started++
        await new Promise((resolve) => setTimeout(resolve, 1000))
      },
    })
    job.start()

    await vi.advanceTimersByTimeAsync(500)
    // A queueing implementation would have ~50 pending. Only one ever started.
    expect(started).toBe(1)
    expect(job.skipped).toBeGreaterThan(0)

    const stopped = job.stop()
    await vi.advanceTimersByTimeAsync(1000)
    await stopped
  })

  it('resumes normally once the slow tick finishes', async () => {
    let slow = true
    const tick = vi.fn(async () => {
      if (slow) await new Promise((resolve) => setTimeout(resolve, 250))
    })
    const job = createJob({ name: 'j', intervalMs: 100, tick })
    job.start()

    await vi.advanceTimersByTimeAsync(400)
    slow = false
    const before = job.runs

    await vi.advanceTimersByTimeAsync(300)
    expect(job.runs).toBeGreaterThan(before)
    await job.stop()
  })
})

describe('error isolation', () => {
  it('a throwing tick does not stop the schedule', async () => {
    const onError = vi.fn()
    let calls = 0
    const job = createJob({
      name: 'boom',
      intervalMs: 100,
      tick: () => {
        calls++
        throw new Error('nope')
      },
      onError,
    })
    job.start()

    await vi.advanceTimersByTimeAsync(300)

    expect(calls).toBe(3)
    expect(job.errors).toBe(3)
    expect(job.runs).toBe(0)
    expect(onError).toHaveBeenCalledTimes(3)
    expect(onError.mock.calls[0]?.[1]).toBe('boom')

    await job.stop()
  })

  it('an async rejection is caught rather than becoming an uncaught exception', async () => {
    const onError = vi.fn()
    const job = createJob({
      name: 'reject',
      intervalMs: 100,
      tick: async () => {
        await Promise.reject(new Error('async nope'))
      },
      onError,
    })
    job.start()

    await vi.advanceTimersByTimeAsync(100)
    expect(onError).toHaveBeenCalledOnce()
    await job.stop()
  })

  it('a failing tick releases the guard, so the next one still runs', async () => {
    let calls = 0
    const job = createJob({
      name: 'j',
      intervalMs: 100,
      tick: () => {
        calls++
        throw new Error('nope')
      },
      onError: () => {},
    })
    job.start()
    await vi.advanceTimersByTimeAsync(250)
    expect(calls).toBe(2)
    expect(job.skipped).toBe(0)
    await job.stop()
  })
})

describe('shutdown', () => {
  it('stops scheduling', async () => {
    const tick = vi.fn()
    const job = createJob({ name: 'j', intervalMs: 100, tick })
    job.start()
    await vi.advanceTimersByTimeAsync(100)
    await job.stop()

    await vi.advanceTimersByTimeAsync(1000)
    expect(tick).toHaveBeenCalledOnce()
    expect(job.running).toBe(false)
  })

  it('awaits the tick already in flight, so SIGTERM cannot cut a write in half', async () => {
    let finished = false
    const job = createJob({
      name: 'j',
      intervalMs: 100,
      tick: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200))
        finished = true
      },
    })
    job.start()

    await vi.advanceTimersByTimeAsync(100) // tick starts, will not finish for 200ms
    expect(finished).toBe(false)

    const stopped = job.stop()
    await vi.advanceTimersByTimeAsync(200)
    await stopped

    expect(finished).toBe(true)
  })

  it('stop() is safe to call twice', async () => {
    const job = createJob({ name: 'j', intervalMs: 100, tick: () => {} })
    job.start()
    await job.stop()
    await expect(job.stop()).resolves.toBeUndefined()
  })

  it('stop() before start() is harmless', async () => {
    const job = createJob({ name: 'j', intervalMs: 100, tick: () => {} })
    await expect(job.stop()).resolves.toBeUndefined()
  })
})

describe('runNow', () => {
  it('runs a tick on demand and honours the guard', async () => {
    const tick = vi.fn()
    const job = createJob({ name: 'j', intervalMs: 100_000, tick })
    await job.runNow()
    expect(tick).toHaveBeenCalledOnce()
    expect(job.runs).toBe(1)
  })
})
