import type { RegistryPackDetail, ToolDisclosure } from '../lib/api'

/**
 * What a pack will do to a box, shown before an operator agrees to it.
 *
 * THIS COMPONENT IS THE SECURITY CONTROL, which is an unusual thing to say about a modal, so it
 * is worth saying plainly. Issue #9 asked that packs be "scanned to ensure they are secure".
 * `rockysurf pack lint` checks the file format and the mechanical author rules; `pack check`
 * proves a pack survives being resumed. Neither can decide whether an `installScript` is benign,
 * because it is arbitrary shell executed as **root** on the operator's machine and no static
 * analysis of shell settles that. An operator who believed a pack had been security-scanned
 * would read nothing — so nothing in this UI says scanned, and the scripts are put in front of
 * them instead.
 *
 * THREE RULES THIS FILE MUST KEEP:
 *
 * 1. **Scripts render as text, never as markup.** `<pre>{script}</pre>` and nothing else. React
 *    escapes by default, which is why this is a rule about not reaching for
 *    `dangerouslySetInnerHTML` rather than a sanitiser. The same posture `ServerDetailPage` takes
 *    with `pack.guide`, applied to content that is less trusted than that one.
 * 2. **The derived summary says it is incomplete.** `summaryIsComplete` is `false` from the API
 *    by construction: the URL list is a pattern match over shell, so a script that builds a URL
 *    from a variable contributes nothing to it. Presenting the summary without that sentence
 *    tells the operator they have seen everything.
 * 3. **Install is not reachable without this panel.** The shop page has no install button of its
 *    own; the only one is below the scripts.
 */

export function PackDisclosurePanel({
  detail,
  installing,
  onCancel,
  onInstall,
}: {
  detail: RegistryPackDetail
  installing: boolean
  onCancel: () => void
  onInstall: () => void
}): React.JSX.Element {
  const { disclosure, entry } = detail
  // A pack whose references this installation cannot satisfy would half-install: the tools it
  // names are not here, so the create-time plan would be missing steps the author assumed.
  const unresolved = disclosure.referencesTools

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={`Review ${disclosure.name}`}>
      <div className="modal modal-wide disclosure">
        <h2>{disclosure.name}</h2>
        <p className="muted">
          from <strong>{entry.sourceName}</strong> · labelled <strong>{entry.trust}</strong> in your config
        </p>

        <section className="disclosure-summary">
          <h3>What this pack does</h3>
          <ul>
            <li>
              Runs <strong>{disclosure.tools.length}</strong> install step(s), of which{' '}
              <strong data-testid="root-step-count">{disclosure.rootStepCount}</strong> run as{' '}
              <strong>root</strong>.
            </li>
            <li>
              {disclosure.fetchesUrls.length === 0 ? (
                'No download URL appears literally in its scripts.'
              ) : (
                <>
                  Downloads from:
                  <ul className="disclosure-urls">
                    {disclosure.fetchesUrls.map((url) => (
                      <li key={url}>
                        <code>{url}</code>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </li>
            {disclosure.requiresRdp && <li>Asks you for a remote-desktop password when you create a server.</li>}
            {disclosure.requiresRepos && <li>Expects at least one repository; you are asked to confirm if you name none.</li>}
            {/* WHAT IT WILL ASK YOU FOR (issue #189). Part of the disclosure because a pack that
                wants an API key is asking you to put a credential on a box, and that belongs in
                the same list as "how many steps run as root" — before consent, not on the create
                form afterwards. Names and labels only; a value never appears here. */}
            {disclosure.inputs?.length ? (
              <li>
                Asks you for {disclosure.inputs.length} setting{disclosure.inputs.length === 1 ? '' : 's'} when you
                create a server, delivered to its install scripts as environment variables:
                <ul className="disclosure-urls">
                  {disclosure.inputs.map((input) => (
                    <li key={input.name}>
                      <code>${input.name}</code> — {input.label}
                      {input.required ? ' (required)' : ''}
                      {input.secret ? ', stored encrypted and never shown again' : ''}
                    </li>
                  ))}
                </ul>
              </li>
            ) : null}
          </ul>

          {/* Rule 2. Rendered from the field rather than hardcoded, so a future API that could
              honestly claim completeness would change this sentence rather than leave it lying. */}
          {!disclosure.summaryIsComplete && (
            <p className="warning" data-testid="summary-incomplete">
              This summary is derived by reading the scripts, and it cannot be complete — a script
              that builds a URL from a variable will not appear above. The scripts below are what
              actually runs. Read them.
            </p>
          )}
        </section>

        {unresolved.length > 0 && (
          <p className="error" data-testid="unresolved-tools">
            This pack references tools this installation does not have: {unresolved.join(', ')}. Installing
            it would leave those steps out.
          </p>
        )}

        <section>
          <h3>Every script, exactly as it will run</h3>
          <p className="hint">
            These run as <code>root</code> or as <code>rocky</code> on each box created with this pack.
            Nobody has audited them — this registry&rsquo;s checks prove a pack is well-formed and
            survives being resumed, not that it is safe.
          </p>
          {disclosure.tools.map((tool) => (
            <ToolScripts key={tool.toolId} tool={tool} />
          ))}
        </section>

        {disclosure.guide && (
          <section>
            <h3>What you will have to do yourself</h3>
            <p className="hint">Written by the pack author. Shown to you on the server page; never executed.</p>
            <pre className="pack-guide-text">{disclosure.guide}</pre>
          </section>
        )}

        <details className="disclosure-raw">
          <summary>The pack file, as fetched and verified ({entry.sha256.slice(0, 12)}…)</summary>
          <pre>{detail.yaml}</pre>
        </details>

        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onCancel} disabled={installing}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={onInstall} disabled={installing}>
            {installing ? 'Installing…' : `Install ${disclosure.name}`}
          </button>
        </div>
      </div>
    </div>
  )
}

function ToolScripts({ tool }: { tool: ToolDisclosure }): React.JSX.Element {
  return (
    <div className="disclosure-tool" data-testid={`disclosure-tool-${tool.toolId}`}>
      <h4>
        {tool.name}{' '}
        <span className={`badge run-as-${tool.runAs}`} data-testid={`run-as-${tool.toolId}`}>
          {tool.runAs}
        </span>
      </h4>
      <p className="muted">{tool.description}</p>
      <p className="size-detail">
        <a href={tool.url} target="_blank" rel="noreferrer noopener">
          {tool.url}
        </a>
      </p>
      {/* Rule 1: text, never markup. */}
      <pre className="disclosure-script">{tool.installScript}</pre>
      {tool.setupScript && (
        <>
          <p className="size-detail">setup, after any repositories are cloned:</p>
          <pre className="disclosure-script">{tool.setupScript}</pre>
        </>
      )}
    </div>
  )
}
