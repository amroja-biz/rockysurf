import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useAuth } from './AuthContext'
import { EventsManager, type ConnectionStatus, type EventListener } from '../lib/events'

/**
 * The live event stream, replacing `WebSocketContext`.
 *
 * The consumer API is unchanged on purpose — `{ connectionStatus, subscribe }` — so
 * `useServerUpdates` and every page component that calls it port without edits. Only the
 * transport underneath is different.
 *
 * One stream per signed-in session, opened when authentication lands and closed when it goes
 * away. Subscribers come and go against that one connection rather than each opening their
 * own, because a dashboard with eight server cards should not hold eight streams.
 */

interface EventsContextValue {
  connectionStatus: ConnectionStatus
  subscribe: (listener: EventListener) => () => void
}

const EventsContext = createContext<EventsContextValue | null>(null)

/** Same-origin by default; the dev override matches the one in `lib/api.ts`. */
const ENV_BASE = import.meta.env['VITE_API_BASE_URL'] as string | undefined
const EVENTS_URL = `${(ENV_BASE ?? '/api/v1').replace(/\/$/, '')}/events`

export function EventsProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth()
  const managerRef = useRef<EventsManager | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  // Subscribers that arrived before the stream opened, so no early listener is dropped.
  const pendingRef = useRef(new Set<EventListener>())

  useEffect(() => {
    if (!isAuthenticated) {
      managerRef.current?.disconnect()
      managerRef.current = null
      setConnectionStatus('disconnected')
      return
    }

    const manager = new EventsManager(EVENTS_URL)
    managerRef.current = manager

    const unsubscribers = [...pendingRef.current].map((listener) => manager.onMessage(listener))
    const unsubStatus = manager.onStatusChange(setConnectionStatus)
    manager.connect()

    return () => {
      unsubscribers.forEach((off) => off())
      unsubStatus()
      manager.disconnect()
      managerRef.current = null
    }
  }, [isAuthenticated])

  /**
   * Stable across renders, and safe to call before the stream exists: the listener is held
   * and attached when the manager appears. The old implementation returned a no-op unsubscribe
   * in that window, which silently dropped any component that mounted before the socket did.
   */
  const subscribe = useRef((listener: EventListener): (() => void) => {
    pendingRef.current.add(listener)
    const off = managerRef.current?.onMessage(listener)
    return () => {
      pendingRef.current.delete(listener)
      off?.()
    }
  }).current

  return <EventsContext.Provider value={{ connectionStatus, subscribe }}>{children}</EventsContext.Provider>
}

export function useEvents(): EventsContextValue {
  const context = useContext(EventsContext)
  if (!context) throw new Error('useEvents must be used within an EventsProvider')
  return context
}
