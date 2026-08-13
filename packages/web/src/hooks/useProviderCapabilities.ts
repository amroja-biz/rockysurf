import { useEffect, useState } from 'react'
import { listProviders, type ProviderCapabilities, type ProviderInfo } from '../lib/api'

/**
 * Provider capabilities, keyed by provider id.
 *
 * THIS IS WHY THERE ARE NO PROVIDER CONDITIONALS IN THE UI. The old dashboard decided whether
 * to show a Stop button with `!server.spotInstance` — a fact about one cloud's billing model,
 * baked into a component. Core's whole design says behaviour differences travel as capability
 * flags (ADR-0003), so the button asks "can this provider stop an instance?" and gets an
 * answer that is true for Hetzner, true for AWS and false for a bring-your-own box, without
 * the component learning any of their names.
 *
 * Fetched once per mount and shared through props rather than context: it is a handful of
 * rows that change only when the operator edits their config.
 */
export function useProviderCapabilities(): {
  byId: Map<string, ProviderCapabilities>
  providers: ProviderInfo[]
  loading: boolean
} {
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await listProviders()
        if (!cancelled) setProviders(list)
      } catch {
        // A failed lookup must not blank the page. Capabilities default to absent, which
        // hides the optional actions rather than offering ones that would fail.
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return { byId: new Map(providers.map((p) => [p.id, p.capabilities])), providers, loading }
}

/** `false` when the provider is unknown or still loading: never offer an action that cannot work. */
export function canStop(capabilities: Map<string, ProviderCapabilities>, provider: string): boolean {
  return capabilities.get(provider)?.stop ?? false
}
