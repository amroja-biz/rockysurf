import { useEffect, useRef, useState } from 'react'
import { useServerUpdates } from '../hooks/useServerUpdates'
import type { ProvisioningStep } from '../lib/api'

/**
 * The live feed a user watches while their server comes up.
 *
 * Fed by SSE through `useServerUpdates`, which is the port of the old WebSocket hook and keeps
 * the same signature. Two event types matter here: `bootstrap-progress` moves the step list,
 * and `bootstrap-log` streams the box's own output for anyone who wants to watch the install
 * rather than a progress bar.
 *
 * The steps are shown as a fixed list rather than appearing one at a time, because a user
 * waiting on a machine wants to know how much is left, not just what is happening now.
 */

const STEP_LABELS: Record<ProvisioningStep, string> = {
  requested: 'Requested',
  instance_launching: 'Launching the machine',
  instance_running: 'Machine running, waiting for SSH',
  installing_tools: 'Installing tools',
  tools_installed: 'Tools installed',
  cloning_repos: 'Cloning repositories',
  ready: 'Ready',
}

const STEP_ORDER: ProvisioningStep[] = [
  'requested',
  'instance_launching',
  'instance_running',
  'installing_tools',
  'tools_installed',
  'cloning_repos',
  'ready',
]

const isKnownStep = (step: string): step is ProvisioningStep =>
  (STEP_ORDER as readonly string[]).includes(step)

/** Keep the log bounded: a long install can emit thousands of lines. */
const MAX_LOG_LINES = 200

export interface ProvisioningFeedProps {
  serverId: string
  /** Called once, when the server reports ready. */
  onReady?: () => void
}

export function ProvisioningFeed({ serverId, onReady }: ProvisioningFeedProps) {
  const [step, setStep] = useState<ProvisioningStep>('requested')
  const [status, setStatus] = useState<string>('requested')
  const [failure, setFailure] = useState<string | null>(null)
  const [logLines, setLogLines] = useState<string[]>([])
  const notifiedReady = useRef(false)

  useServerUpdates((event) => {
    switch (event.type) {
      case 'bootstrap-progress':
        // `step` is typed loosely because both bootstrap modes emit it and a plan can name a
        // step this UI does not know. An unrecognised value leaves the list where it is
        // rather than resetting it to the start, which would look like going backwards.
        if (isKnownStep(event.step)) setStep(event.step)
        break
      case 'bootstrap-log':
        if (event.line) setLogLines((previous) => [...previous, event.line!].slice(-MAX_LOG_LINES))
        break
      case 'server-status':
        setStatus(event.status)
        if (event.status === 'failed') setFailure(event.error ?? 'Provisioning failed')
        if (event.status === 'running' && !notifiedReady.current) {
          notifiedReady.current = true
          onReady?.()
        }
        break
      default:
        break
    }
  }, serverId)

  const currentIndex = STEP_ORDER.indexOf(step)

  return (
    <section className="provisioning-feed">
      <ol className="step-list">
        {STEP_ORDER.map((candidate, index) => {
          const state = failure && index === currentIndex ? 'failed' : index < currentIndex ? 'done' : index === currentIndex ? 'active' : 'pending'
          return (
            <li key={candidate} className={`step step-${state}`} aria-current={state === 'active' ? 'step' : undefined}>
              {STEP_LABELS[candidate]}
            </li>
          )
        })}
      </ol>

      {failure && <p className="error">{failure}</p>}

      {status === 'running' && !failure && <p className="success">Your server is ready.</p>}

      {logLines.length > 0 && (
        <details className="log">
          <summary>Setup log ({logLines.length} lines)</summary>
          {/* aria-live is deliberately off: a screen reader should not read every build line. */}
          <pre>{logLines.join('\n')}</pre>
        </details>
      )}
    </section>
  )
}
