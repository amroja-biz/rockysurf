import type { ServerSummary } from '../lib/api'

/**
 * Recent activity, derived from timestamps already on the server rows rather than fetched.
 *
 * Ported unchanged in substance. Worth keeping the derivation as-is: there is no events
 * endpoint for the SPA, and inventing one for a ten-line list would be the wrong trade.
 */

interface ActivityEvent {
  type: 'created' | 'started' | 'stopped' | 'terminated'
  serverName: string
  timestamp: string
}

const EVENT_LABELS: Record<ActivityEvent['type'], { label: string; icon: string }> = {
  created: { label: 'Created', icon: '+' },
  started: { label: 'Started', icon: '▶' },
  stopped: { label: 'Stopped', icon: '■' },
  terminated: { label: 'Terminated', icon: '×' },
}

function relativeTime(isoString: string): string {
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

function deriveEvents(servers: ServerSummary[]): ActivityEvent[] {
  const events: ActivityEvent[] = []
  for (const server of servers) {
    events.push({ type: 'created', serverName: server.name, timestamp: server.createdAt })
    if (server.startedAt) events.push({ type: 'started', serverName: server.name, timestamp: server.startedAt })
    if (server.stoppedAt) events.push({ type: 'stopped', serverName: server.name, timestamp: server.stoppedAt })
    if (server.terminatedAt) {
      events.push({ type: 'terminated', serverName: server.name, timestamp: server.terminatedAt })
    }
  }
  return events
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 10)
}

export function ActivityFeed({ servers }: { servers: ServerSummary[] }) {
  const events = deriveEvents(servers)
  if (events.length === 0) return null

  return (
    <section className="activity-feed">
      <h2>Recent activity</h2>
      <ul>
        {events.map((event, index) => (
          <li key={`${event.serverName}-${event.type}-${index}`}>
            <span className="activity-icon" aria-hidden="true">
              {EVENT_LABELS[event.type].icon}
            </span>
            <span className="activity-label">{EVENT_LABELS[event.type].label}</span>
            <span className="activity-server">{event.serverName}</span>
            <time dateTime={event.timestamp}>{relativeTime(event.timestamp)}</time>
          </li>
        ))}
      </ul>
    </section>
  )
}
