import type { BootstrapFailure, BootstrapReport as Report, StepReport } from '../lib/api'

/**
 * The complete account of a bootstrap that went wrong (ADR-0010).
 *
 * This replaces the one-line `errorMessage` as the thing a user reads after a failure, and it
 * has to be complete, because for a failed tool install the machine is gone: core terminated
 * it, deliberately, so there is nothing left to SSH into. Three questions, in the order a
 * person asks them — what failed, why, and what happened to the machine — with the decisive
 * lines pulled out of the log and the whole log underneath for whoever wants it.
 *
 * Warnings are the other case: the box came up, but a repository did not clone. Those get a
 * card each, because "your server is ready" beside a repository that is not on it is the
 * contradiction the owner asked never to see again.
 */

const PHASE_NOUN: Record<StepReport['phase'], string> = {
  tool: 'Tool install',
  repo: 'Repository clone',
  setup: 'Setup script',
  finishing: 'Finishing step',
}

function LogDetails({ step, title }: { step: StepReport; title: string }) {
  if (!step.log.trim()) return null
  return (
    <details className="log">
      <summary>
        {title} ({step.logComplete ? 'complete' : 'last lines only'})
      </summary>
      {/* aria-live off on purpose: a screen reader should not read a build log. */}
      <pre>{step.log}</pre>
    </details>
  )
}

function FailureCard({ failure }: { failure: BootstrapFailure }) {
  return (
    <div className="bootstrap-failure" role="alert" data-testid="bootstrap-failure">
      <h3>Setup failed: {failure.label}</h3>
      <dl>
        <dt>What failed</dt>
        <dd>
          {PHASE_NOUN[failure.phase]} — <code>{failure.stepId}</code>
          {failure.exitCode !== undefined && <> (exited with code {failure.exitCode})</>}
        </dd>
        <dt>Why</dt>
        <dd>
          <p className="summary">{failure.summary}</p>
          {failure.keyLines.length > 0 && <pre className="key-lines">{failure.keyLines.join('\n')}</pre>}
        </dd>
        <dt>The machine</dt>
        <dd className="instance-note" data-instance={failure.instance}>
          {failure.instanceNote}
        </dd>
      </dl>
      <LogDetails step={failure} title="Full install log for this step" />
    </div>
  )
}

function WarningCard({ warning }: { warning: StepReport }) {
  const headline =
    warning.phase === 'repo'
      ? `Not on this box: ${warning.label}`
      : `${PHASE_NOUN[warning.phase]} did not finish: ${warning.label}`
  return (
    <div className="bootstrap-warning" role="status" data-testid="bootstrap-warning">
      <h3>{headline}</h3>
      <p className="summary">{warning.summary}</p>
      {warning.keyLines.length > 0 && <pre className="key-lines">{warning.keyLines.join('\n')}</pre>}
      {warning.phase === 'repo' && (
        <p className="hint">
          The rest of the box is fine. Once you have connected, <code>git clone {warning.label}</code> will
          tell you the same thing git told the installer, with any token you have since added.
        </p>
      )}
      <LogDetails step={warning} title="Log for this step" />
    </div>
  )
}

export function BootstrapReport({ report }: { report: Report }) {
  if (!report.failure && report.warnings.length === 0) return null
  return (
    <div className="bootstrap-report">
      {report.failure && <FailureCard failure={report.failure} />}
      {report.warnings.map((warning) => (
        <WarningCard key={warning.stepId} warning={warning} />
      ))}
    </div>
  )
}

/** One line for a card that has no room for the report: how many things are not on the box. */
export function warningsSummary(report: Report | undefined): string | null {
  if (!report || report.warnings.length === 0) return null
  const repos = report.warnings.filter((w) => w.phase === 'repo').length
  const other = report.warnings.length - repos
  const parts: string[] = []
  if (repos > 0) parts.push(`${repos} ${repos === 1 ? 'repository' : 'repositories'} did not clone`)
  if (other > 0) parts.push(`${other} optional ${other === 1 ? 'step' : 'steps'} did not finish`)
  return parts.join('; ')
}
