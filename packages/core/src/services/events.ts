import { EventEmitter } from 'node:events'

/**
 * In-process event bus behind the SSE endpoint, replacing the API Gateway WebSocket API.
 *
 * The old `broadcastToUser(userId, payload)` queried a DynamoDB connections table, opened an
 * `ApiGatewayManagementApiClient`, and posted to every stale connection id it found. In one
 * process the same job is an `EventEmitter` channel per user — which is why the WebSocket was
 * always overkill: it was only ever used to push server-to-client, never to receive, so SSE
 * covers it exactly (ADR-0001).
 *
 * THE SIGNATURE IS LOAD-BEARING. `broadcastToUser(userId: string, payload: object):
 * Promise<void>` is copied from `backend/src/websocket/broadcast.ts` and must not drift:
 * ported handler bodies call it unchanged, which is most of what "~80% of handler bodies
 * survive" means in practice. It stays `async` even though nothing awaits inside, because
 * every existing call site writes `await broadcastToUser(...)`.
 *
 * No history buffer in v0.1: a client that reconnects re-fetches state over the REST API,
 * which it must be able to do anyway after a laptop sleeps. `Last-Event-ID` replay is a real
 * feature, and it needs the durable `events` table rather than an in-memory ring — deliberately
 * out of scope here.
 */

export type EventPayload = object

export interface EventsService {
  /**
   * Deliver a payload to every stream this user has open. Legacy signature — do not change.
   * A user with no listeners is a no-op, exactly as the WebSocket version was for a user
   * with no live connections.
   */
  broadcastToUser(userId: string, payload: EventPayload): Promise<void>
  /** Subscribe a stream. Returns its unsubscribe; callers MUST call it when the stream ends. */
  subscribe(userId: string, listener: (payload: EventPayload) => void): () => void
  /** Open streams for one user. Test and diagnostic use. */
  listenerCount(userId: string): number
  /** Total open streams. Test and diagnostic use. */
  readonly totalListeners: number
}

export function createEventsService(): EventsService {
  // Node warns at 10 listeners on one channel, which is a sensible default for a leak but a
  // normal number of browser tabs. Raised deliberately rather than silenced at the call site.
  const emitter = new EventEmitter()
  emitter.setMaxListeners(100)

  const channel = (userId: string) => `user:${userId}`
  let total = 0

  return {
    async broadcastToUser(userId, payload) {
      emitter.emit(channel(userId), payload)
    },

    subscribe(userId, listener) {
      const name = channel(userId)
      emitter.on(name, listener)
      total++
      let removed = false
      return () => {
        // Idempotent: a stream that both aborts and finalizes must not double-decrement.
        if (removed) return
        removed = true
        emitter.off(name, listener)
        total--
      }
    },

    listenerCount(userId) {
      return emitter.listenerCount(channel(userId))
    },

    get totalListeners() {
      return total
    },
  }
}
