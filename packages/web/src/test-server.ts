import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { useStubOrigin } from './test-setup'

/**
 * The stub HTTP server these page tests render against (rockysurf-t215, rockysurf-qokr).
 *
 * FIVE TEST FILES USED TO HARDCODE PORT 34567, and that is what made the web suite flaky under
 * a root-level `pnpm run check`. The failure was not where it looked:
 *
 *  1. a file's `beforeEach` called `listen(34567)` and got `EADDRINUSE`, because
 *     `fileParallelism: false` serialises the FILES but `server.close()` returning does not
 *     mean the socket is released — the `EventsProvider` holds an SSE connection open;
 *  2. that listen was awaited as `new Promise((resolve) => server.listen(port, host, resolve))`
 *     with no `error` handler, so the promise never settled and the hook hung to its 10-second
 *     limit, reporting `Hook timed out in 10000ms`;
 *  3. the NEXT file then ran against a port nobody was serving. Every fetch failed, its pages
 *     never left `Loading…`, and each async query died at testing-library's own 1000 ms budget
 *     with `Unable to find role="row"` — seven mystery failures in a file that was fine.
 *
 * Raising a timeout would have made that suite slower and still red. The shared port is the
 * disease, so this asks the OS for a free one instead: nothing to collide over, no retry, no
 * waiting. `useStubOrigin` then points the relative-URL shims at whatever was assigned.
 *
 * It also rejects on `error` rather than hanging. Ports are not the only reason a listen can
 * fail, and a hook that hangs turns a one-line diagnosis into a ten-second timeout in one file
 * and a cascade of unrelated-looking failures in another.
 */
export interface StubServer {
  /** The port the OS assigned. Rarely needed — relative URLs already resolve here. */
  readonly port: number
  readonly origin: string
  /** Close it and stop resolving relative URLs here. Safe to call twice. */
  close(): Promise<void>
}

export async function startStubServer(handler: RequestListener): Promise<StubServer> {
  const server: Server = createServer(handler)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // Port 0 is "any free port": the OS picks, so two files can never want the same one.
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const { port } = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${port}`
  useStubOrigin(origin)

  let closed = false
  return {
    port,
    origin,
    async close() {
      if (closed) return
      closed = true
      // Cleared BEFORE the close completes: a relative URL resolved after this point belongs
      // to nothing, and pointing it at a dying server is how a test gets a confusing error
      // instead of an obvious one.
      useStubOrigin(undefined)
      await new Promise<void>((resolve) => {
        // The SSE connection the EventsProvider opens will otherwise hold this open, which is
        // exactly what used to delay the port's release into the next file's `beforeEach`.
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
    },
  }
}
