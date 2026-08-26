import { useEffect, useRef, useState } from 'react'
import { useServerUpdates } from '../hooks/useServerUpdates'
import { getServer, type BootstrapReport as Report, type ProvisioningStep } from '../lib/api'
import { isProvisioningStep, STEP_ORDER } from '../lib/format'
import { BootstrapReport } from './BootstrapReport'

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

/**
 * Wordier than the detail page's labels on purpose: this is the first thing a user sees after
 * clicking Create, when "Machine running, waiting for SSH" is the difference between a wait
 * that makes sense and one that looks stuck. The ORDER is `lib/format`'s, and the vocabulary
 * with it — three copies of that list is how a page ends up disagreeing with core about what
 * a step is called.
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
  const [report, setReport] = useState<Report | null>(null)
  /** Under the active step while it lasts: "waiting 2 min for the package archive", not silence. */
  const [notice, setNotice] = useState<string | null>(null)
  const notifiedReady = useRef(false)

  /**
   * The report is on the ROW, not in the event (ADR-0010): it carries whole logs, which do not
   * belong on a broadcast every open tab receives. A terminal status is the cue to fetch it —
   * for a failure, the account of what went wrong; for a box that came up, whatever did not
   * make it onto it. A fetch that fails leaves the one-line reason from the event in place.
   */
  function loadReport() {
    void getServer(serverId)
      .then((server) => setReport(server.bootstrapReport ?? null))
      .catch(() => undefined)
  }

  useServerUpdates((event) => {
    switch (event.type) {
      case 'bootstrap-progress':
        // `step` is typed loosely because both bootstrap modes emit it and a plan can name a
        // step this UI does not know. An unrecognised value leaves the list where it is
        // rather than resetting it to the start, which would look like going backwards.
        if (isProvisioningStep(event.step)) setStep(event.step)
        // Every progress event either carries a reason or clears the last one. A two-minute
        // apt wait that said nothing looked like a hang (#129); a notice left on screen after
        // the wait would be the opposite lie.
        setNotice(event.notice ?? null)
        break
      case 'bootstrap-log':
        if (event.line) setLogLines((previous) => [...previous, event.line!].slice(-MAX_LOG_LINES))
        break
      case 'server-status':
        setStatus(event.status)
        if (event.status === 'failed') {
          setFailure(event.error ?? 'Provisioning failed')
          loadReport()
        }
        if (event.status === 'running' && !notifiedReady.current) {
          notifiedReady.current = true
          loadReport()
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
              {state === 'active' && notice && (
                <span className="step-notice" role="status">
                  {notice}
                </span>
              )}
            </li>
          )
        })}
      </ol>

      {/* The one-line reason from the event, until the report — which says the same and much
          more — has arrived to replace it. */}
      {failure && !report?.failure && <p className="error">{failure}</p>}

      {status === 'running' && !failure && (
        <p className="success">
          {report && report.warnings.length > 0 ? 'Your server is ready — with something missing, below.' : 'Your server is ready.'}
        </p>
      )}

      {report && <BootstrapReport report={report} />}

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
