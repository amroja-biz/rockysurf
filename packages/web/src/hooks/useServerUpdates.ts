import { useEffect, useRef } from 'react'
import toast from 'react-hot-toast'
import { useEvents } from '../contexts/EventsContext'
import { isServerScoped, type ServerEvent, type ServerScopedEvent } from '../lib/events'

/**
 * Subscribe to live updates for every server, or for one.
 *
 * Ported from the WebSocket version with the same signature, so page components need no
 * changes. Two things carried over deliberately:
 *
 *  - the callback is held in a ref and read at call time, so a page can pass an inline arrow
 *    function without re-subscribing on every render;
 *  - an IP change raises a toast here rather than in each page, because the user needs to know
 *    their SSH config is stale wherever they happen to be looking.
 *
 * The `spot-*` branches are gone with spot instances.
 */
export function useServerUpdates(callback: (event: ServerScopedEvent) => void, serverId?: string): void {
  const { subscribe } = useEvents()
  const callbackRef = useRef(callback)
  callbackRef.current = callback

  useEffect(() => {
    return subscribe((event: ServerEvent) => {
      if (!isServerScoped(event)) return
      if (serverId && event.serverId !== serverId) return

      if (event.type === 'ip-changed') {
        toast(`Server IP changed: ${event.previousIp} → ${event.newIp}`, { icon: '⚠️', duration: 5000 })
      }

      callbackRef.current(event)
    })
  }, [subscribe, serverId])
}
