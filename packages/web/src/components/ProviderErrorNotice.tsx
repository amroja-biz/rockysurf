import { type ApiError, type ProviderErrorCode } from '../lib/api'

/**
 * A cloud provider's own failure, read as a headline plus detail rather than as one raw dump
 * (issue #127).
 *
 * The screen this fixed: a create-server request whose VM PUT was refused by Azure landed as a
 * single unstyled paragraph holding core's whole diagnostic string verbatim — the REST method
 * and path (with the subscription id), Azure's own code, and Azure's own paragraph of prose,
 * URLs included — squeezed through a one-line `<p className="error">` with no `white-space`
 * rule. Nothing was wrong with the data; core's `fail()` (`servers/routes.ts`) already
 * classifies every provider failure onto the nine-code taxonomy (ADR-0003, F1) and forwards the
 * cloud's own code verbatim as `providerCode` (F1's whole reason for existing) — the web side
 * just wasn't reading either field.
 *
 * `error.detail` — core's `err.message` — stays genuinely useful and is kept, but as DETAIL: a
 * monospace, line-preserving block, because it is machine output (a REST path, a code, the
 * cloud's own paragraph) rather than a sentence. The HEADLINE above it is derived from the
 * taxonomy code alone, so it reads the same regardless of which cloud produced it.
 *
 * Falls back to a plain `.error` paragraph for anything that isn't a classified provider
 * failure (a validation refusal, a limit, a conflict) — those are already sentences core wrote
 * for a human, and don't need a second element to say so.
 */
const PROVIDER_ERROR_HEADLINE: Record<ProviderErrorCode, string> = {
  auth: 'Cloud credential rejected',
  quota: 'Cloud quota exceeded',
  capacity: 'No capacity available right now',
  invalid_spec: 'Cloud rejected the request',
  not_found: 'Cloud resource not found',
  rate_limited: 'Rate limited by the cloud',
  conflict: 'Conflicts with another operation on the cloud',
  network: 'Could not reach the cloud',
  unknown: 'The cloud provider reported an error',
}

export function ProviderErrorNotice({ error }: { error: ApiError }) {
  const code = error.providerErrorCode
  if (!code) return <p className="error">{error.detail}</p>

  return (
    <div className="error provider-error" role="alert" data-testid="provider-error-notice">
      <p className="provider-error-headline">
        {PROVIDER_ERROR_HEADLINE[code]}
        {error.providerCode && <span className="provider-error-code"> ({error.providerCode})</span>}
      </p>
      <pre className="provider-error-detail">{error.detail}</pre>
    </div>
  )
}
