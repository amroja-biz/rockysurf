import type { ReactNode } from 'react'

/**
 * "Could not refresh … — showing the last known state", as a warning-tone notice.
 *
 * Core relays the provider's own message verbatim (`syncError`), because the cloud wrote the
 * remedy into it — `aws sso login`, `gcloud auth application-default login`, the config key to
 * set. That prose arrives as one string with the technical bits inline and, apart from the one
 * command GCP's auth wrapper backticks itself, unmarked. Reading it as a paragraph of yellow
 * text, the resource id, the command to type and the JSON the library threw all run together
 * with the sentence around them. This sets the technical fragments in monospace so the eye can
 * pick the thing to copy out of the thing to read; the text content is unchanged.
 *
 * Yellow, not red: the cards are still there and still right as of the last refresh. A warning
 * that is not yet a failure.
 */

/** Fragments to set in `<code>`, tried in order at each position; first match wins. */
const TECHNICAL: RegExp[] = [
  /`[^`]+`/, // a span the message author already marked
  /\{"[^\n]*\}/, // a JSON blob a library threw, quoted whole
  /\b[a-z0-9]+:[A-Z][A-Za-z]+(?: [a-z]+-[0-9a-f]{8,})?/, // `ec2:DescribeInstances i-0df0f2ab3d619671d`
  /\b(?:aws|gcloud|az|hcloud|doctl) (?:[a-z][a-z0-9-]* ){0,3}(?:login|auth|configure|init)\b/, // a CLI command up to its verb
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/, // GOOGLE_APPLICATION_CREDENTIALS
  /\b[a-z]+(?:\.[A-Za-z]+){2,}\b/, // providers.gcp.keyFile
  /\bi-[0-9a-f]{8,}\b/, // a bare instance id
]

const ANY = new RegExp(TECHNICAL.map((r) => `(?:${r.source})`).join('|'), 'g')

export function technicalProse(message: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of message.matchAll(ANY)) {
    const at = m.index ?? 0
    if (at > last) out.push(message.slice(last, at))
    const raw = m[0]
    const text = raw.startsWith('`') && raw.endsWith('`') ? raw.slice(1, -1) : raw
    out.push(<code key={at}>{text}</code>)
    last = at + raw.length
  }
  if (last < message.length) out.push(message.slice(last))
  return out
}

export function SyncErrorNotice({
  lead,
  message,
  testId,
}: {
  /** The sentence that says what could not be refreshed. */
  lead: string
  /** Core's `syncError`, verbatim. */
  message: string
  testId: string
}) {
  return (
    <p role="alert" className="warning sync-error" data-testid={testId}>
      {lead} {technicalProse(message)}
    </p>
  )
}
