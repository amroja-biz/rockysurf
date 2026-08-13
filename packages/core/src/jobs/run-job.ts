/**
 * The in-process job runner: `setInterval` with an overlap guard.
 *
 * This is the whole scheduler (ADR-0001). There is no queue, no worker pool, and no cron
 * daemon, because core is one process on someone's laptop and every job here is idempotent
 * bookkeeping that can miss a tick without consequence.
 *
 * Four properties, each of which is a bug the naive version has:
 *
 *  1. **Overlap guard.** A tick that outlives its interval must not run beside its successor.
 *     Two provision ticks racing on the same row would both call the provider and both write
 *     a status. The guard drops the overlapping tick rather than queueing it — a skipped tick
 *     is invisible, a queued one turns a slow provider into an unbounded backlog.
 *  2. **Error isolation.** A throwing job must not take the process down, and must not stop
 *     its own interval. An unhandled rejection inside `setInterval` is an uncaught exception
 *     in Node, so this is the difference between "the reconciler logged an error" and "the
 *     control plane exited at 3am".
 *  3. **Clean shutdown.** `stop()` clears the interval AND awaits the tick already in flight,
 *     so SIGTERM does not kill a job midway through writing a row.
 *  4. **Optional jitter.** Several jobs started in the same millisecond otherwise stay in
 *     lockstep forever, so every Nth tick does all the work at once.
 */

export interface JobOptions {
  /** Appears in logs and in `JobHandle.name`. */
  name: string
  intervalMs: number
  /**
   * The work. Rejections are caught, logged through `onError`, and swallowed.
   *
   * Any return value is allowed and ignored — the ticks return result objects so that tests
   * and the startup pass can call them directly and assert on what happened.
   */
  tick: () => unknown
  /** Run once immediately on `start()` rather than waiting a whole interval. Default false. */
  runOnStart?: boolean
  /**
   * Randomize the FIRST delay by up to this fraction of the interval (0.1 = up to +10%), so
   * jobs started in the same millisecond do not converge and do all their work on the same
   * tick forever after. The cadence itself stays fixed. Default 0.
   */
  jitter?: number
  /** Defaults to `console.error`. */
  onError?: (error: unknown, job: string) => void
  /** Injected in tests. */
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  setRepeating?: typeof setInterval
  clearRepeating?: typeof clearInterval
  random?: () => number
}

export interface JobHandle {
  readonly name: string
  readonly intervalMs: number
  /** Ticks that actually ran to completion. */
  readonly runs: number
  /** Ticks dropped because the previous one was still running. */
  readonly skipped: number
  /** Ticks that threw. */
  readonly errors: number
  readonly running: boolean
  start(): void
  /** Clear the timer and await any tick already in flight. Safe to call twice. */
  stop(): Promise<void>
  /** Run one tick now, honouring the overlap guard. Returns when it settles. */
  runNow(): Promise<void>
}

export function createJob(options: JobOptions): JobHandle {
  const onError = options.onError ?? ((error: unknown, job: string) => console.error(`[job:${job}]`, error))
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  const setRepeating = options.setRepeating ?? setInterval
  const clearRepeating = options.clearRepeating ?? clearInterval
  const random = options.random ?? Math.random
  const jitter = options.jitter ?? 0

  let startTimer: ReturnType<typeof setTimeout> | undefined
  let interval: ReturnType<typeof setInterval> | undefined
  let inFlight: Promise<void> | undefined
  let started = false
  let runs = 0
  let skipped = 0
  let errors = 0

  /** Only the first delay is randomized; the cadence after it is fixed. */
  function firstDelay(): number {
    if (jitter <= 0) return options.intervalMs
    return Math.max(1, Math.round(options.intervalMs * (1 + random() * jitter)))
  }

  async function runTick(): Promise<void> {
    // The guard. A tick still running means this one is dropped, not queued: queueing turns a
    // slow dependency into a backlog that never drains.
    if (inFlight) {
      skipped++
      return
    }

    const promise = (async () => {
      try {
        await options.tick()
        runs++
      } catch (error) {
        errors++
        onError(error, options.name)
      }
    })()

    inFlight = promise
    try {
      await promise
    } finally {
      inFlight = undefined
    }
  }

  /**
   * A FIXED cadence, which is what makes the overlap guard load-bearing.
   *
   * The obvious alternative — re-arming a `setTimeout` when each tick finishes — cannot
   * overlap by construction, so the guard would be dead code and a slow tick would silently
   * push every later tick back (drift). With a fixed interval, a tick that outlives its
   * interval is DROPPED by the guard and the cadence recovers on the next one.
   */
  function beginCadence(): void {
    if (!started) return
    interval = setRepeating(() => {
      void runTick()
    }, options.intervalMs)
  }

  return {
    name: options.name,
    intervalMs: options.intervalMs,
    get runs() {
      return runs
    },
    get skipped() {
      return skipped
    },
    get errors() {
      return errors
    },
    get running() {
      return started
    },

    start() {
      if (started) return
      started = true
      if (options.runOnStart) void runTick()
      startTimer = setTimer(() => {
        startTimer = undefined
        void runTick()
        beginCadence()
      }, firstDelay())
    },

    async stop() {
      started = false
      if (startTimer !== undefined) {
        clearTimer(startTimer)
        startTimer = undefined
      }
      if (interval !== undefined) {
        clearRepeating(interval)
        interval = undefined
      }
      // Let the tick in flight finish writing whatever row it is holding.
      await inFlight
    },

    async runNow() {
      await runTick()
    },
  }
}
