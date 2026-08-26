import { Link } from 'react-router'
import type { ServerSummary } from '../lib/api'

/**
 * Recent activity, derived from timestamps already on the server rows rather than fetched.
 *
 * Ported unchanged in substance. Worth keeping the derivation as-is: there is no events
 * endpoint for the SPA, and inventing one for a ten-line list would be the wrong trade.
 *
 * Every entry carries the SERVER ID as well as the name (issue #125), and the derivation is
 * what makes that link possible: these entries are rows, not log lines, so the row behind a
 * "Terminated dev-box" from three weeks ago is still there to open. Nothing prunes a terminated
 * server — `db/repositories/servers.ts` has no delete at all — so the link is never dead.
 */

interface ActivityEvent {
  type: 'created' | 'started' | 'stopped' | 'terminated'
  serverId: string
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
    const at = (type: ActivityEvent['type'], timestamp: string): ActivityEvent => ({
      type,
      serverId: server.serverId,
      serverName: server.name,
      timestamp,
    })
    events.push(at('created', server.createdAt))
    if (server.startedAt) events.push(at('started', server.startedAt))
    if (server.stoppedAt) events.push(at('stopped', server.stoppedAt))
    if (server.terminatedAt) events.push(at('terminated', server.terminatedAt))
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
          <li key={`${event.serverId}-${event.type}-${index}`}>
            <span className="activity-icon" aria-hidden="true">
              {EVENT_LABELS[event.type].icon}
            </span>
            <span className="activity-label">{EVENT_LABELS[event.type].label}</span>
            <span className="activity-server">
              <Link to={`/servers/${event.serverId}`}>{event.serverName}</Link>
            </span>
            <time dateTime={event.timestamp}>{relativeTime(event.timestamp)}</time>
          </li>
        ))}
      </ul>
    </section>
  )
}
