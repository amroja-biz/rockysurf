/**
 * Live server events, over SSE.
 *
 * Ported from the legacy SPA's WebSocket client. The transport changed and almost nothing else
 * did: the old client opened a WebSocket against API Gateway with the token in the query
 * string and hand-rolled exponential-backoff reconnection. `EventSource` reconnects by itself,
 * so that machinery is gone — which is most of why this file is a third of the size of the one
 * it replaces.
 *
 * The message vocabulary is the server's, not ours. Every type below is one core actually
 * emits today; the `spot-*` messages from the old client are absent because spot instances
 * were cut from v0.1.
 */

export type ServerStatus = 'requested' | 'provisioning' | 'running' | 'stopped' | 'terminated' | 'failed'

export type ProvisioningStep =
  | 'requested'
  | 'instance_launching'
  | 'instance_running'
  | 'installing_tools'
  | 'tools_installed'
  | 'cloning_repos'
  /** The script the user supplied at create time, running on the box (issue #184). */
  | 'running_user_script'
  | 'ready'

/** A server changed state. Emitted by the lifecycle service and the provision ticker. */
export interface ServerStatusMessage {
  type: 'server-status'
  serverId: string
  status: ServerStatus
  publicIp?: string
  error?: string
}

/** One bootstrap step moved. Emitted by both bootstrap modes with the same shape. */
export interface BootstrapProgressMessage {
  type: 'bootstrap-progress'
  serverId: string
  step: ProvisioningStep | string
  /** The plan step id. Labels are lossy — several steps share one — so this disambiguates. */
  stepId?: string
  status?: string
  /**
   * Why the active step is taking longer than it looks, in one line. Absent means nothing is
   * unusual — and clears whatever was showing, so a notice never outlives its cause.
   */
  notice?: string
}

/** A line of install output, for the live log view. */
export interface BootstrapLogMessage {
  type: 'bootstrap-log'
  serverId: string
  line?: string
}

/**
 * The address moved across a stop/start. Carries both halves because the UI shows
 * "update your SSH config" rather than just the new value.
 */
export interface IpChangedMessage {
  type: 'ip-changed'
  serverId: string
  previousIp: string
  newIp: string
}

/** Spending reached the configured cap; core is refusing new servers. */
export interface SpendCapReachedMessage {
  type: 'spend-cap-reached'
  [key: string]: unknown
}

export type ServerEvent =
  | ServerStatusMessage
  | BootstrapProgressMessage
  | BootstrapLogMessage
  | IpChangedMessage
  | SpendCapReachedMessage

/** Every message that names a single server, which is what page components filter on. */
export type ServerScopedEvent =
  | ServerStatusMessage
  | BootstrapProgressMessage
  | BootstrapLogMessage
  | IpChangedMessage

export const SERVER_SCOPED_TYPES = ['server-status', 'bootstrap-progress', 'bootstrap-log', 'ip-changed'] as const

export function isServerScoped(event: ServerEvent): event is ServerScopedEvent {
  return (SERVER_SCOPED_TYPES as readonly string[]).includes(event.type)
}

/**
 * `connecting` before the stream opens, `connected` once core has greeted us, `disconnected`
 * when nobody is subscribed. There is no `reconnecting`: EventSource retries on its own and
 * reports the attempt as an error followed by a fresh open, so a separate state would be a
 * lie about who is doing the work.
 */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

export type EventListener = (event: ServerEvent) => void
export type StatusListener = (status: ConnectionStatus) => void

/**
 * A thin subscriber registry over one `EventSource`.
 *
 * Same external shape as the old `WebSocketManager` — `connect`, `disconnect`, `onMessage`,
 * `onStatusChange` — so `useServerUpdates` and every page component port without edits.
 */
export class EventsManager {
  private source: EventSource | null = null
  private readonly listeners = new Set<EventListener>()
  private readonly statusListeners = new Set<StatusListener>()
  private status: ConnectionStatus = 'disconnected'

  constructor(private readonly url: string) {}

  connect(): void {
    if (this.source) return
    this.setStatus('connecting')

    // `withCredentials` so the session cookie rides along: core serves the SPA from its own
    // origin, and EventSource cannot set an Authorization header.
    const source = new EventSource(this.url, { withCredentials: true })
    this.source = source

    source.addEventListener('connected', () => this.setStatus('connected'))

    source.addEventListener('message', (event) => {
      const parsed = parseEvent((event as MessageEvent<string>).data)
      if (parsed) this.listeners.forEach((listener) => listener(parsed))
    })

    source.onerror = () => {
      // EventSource reconnects itself unless the stream was closed outright. Report the gap
      // and let it retry rather than tearing down a source that is about to recover.
      if (source.readyState === EventSource.CLOSED) this.setStatus('disconnected')
      else this.setStatus('connecting')
    }
  }

  disconnect(): void {
    this.source?.close()
    this.source = null
    this.setStatus('disconnected')
  }

  onMessage(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener) as unknown as void
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    listener(this.status) // current value immediately, as the old manager did
    return () => this.statusListeners.delete(listener) as unknown as void
  }

  getStatus(): ConnectionStatus {
    return this.status
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return
    this.status = status
    this.statusListeners.forEach((listener) => listener(status))
  }
}

/** A malformed frame is dropped, never thrown: one bad message must not kill the stream. */
export function parseEvent(data: string): ServerEvent | null {
  try {
    const parsed = JSON.parse(data) as unknown
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as ServerEvent).type !== 'string') return null
    return parsed as ServerEvent
  } catch {
    console.warn('dropping unparseable event', data)
    return null
  }
}
