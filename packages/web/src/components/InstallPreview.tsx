import { useMemo } from 'react'
import type { AdminSurgePack, AdminTool } from '../lib/api'

/**
 * The order a pack's tools will actually install in.
 *
 * Rendered client-side from the tool list, deliberately: core's resolver builds the real plan
 * at create time from a server's pack and repositories, and there is no endpoint that will
 * resolve a hypothetical one. Duplicating the ORDERING rule is a small, honest duplication —
 * and it is pinned by a test asserting this component agrees with the documented rule.
 *
 * The rule, from the bootstrap contract: `bootstrap: true` tools first, then everything else
 * by `installOrder` ascending, ties broken by `toolId` ascending. The tie-break exists so a
 * snapshotted plan renders identically twice; it is a determinism guarantee, not a scheduling
 * tool, and the preview marks ties so nobody mistakes it for one.
 */

export interface PreviewStep {
  tool: AdminTool
  /** True when another tool shares this installOrder — i.e. order came from the tie-break. */
  tied: boolean
}

export function resolvePreview(pack: AdminSurgePack, tools: AdminTool[]): PreviewStep[] {
  const byId = new Map(tools.map((t) => [t.toolId, t]))
  const selected = pack.tools.flatMap((id) => {
    const tool = byId.get(id)
    return tool && tool.enabled ? [tool] : []
  })

  const ordered = [...selected].sort(
    (a, b) =>
      Number(b.bootstrap) - Number(a.bootstrap) ||
      a.installOrder - b.installOrder ||
      a.toolId.localeCompare(b.toolId),
  )

  const counts = new Map<number, number>()
  for (const tool of ordered) counts.set(tool.installOrder, (counts.get(tool.installOrder) ?? 0) + 1)

  return ordered.map((tool) => ({ tool, tied: (counts.get(tool.installOrder) ?? 0) > 1 }))
}

export function InstallPreview({ pack, tools }: { pack: AdminSurgePack; tools: AdminTool[] }) {
  const steps = useMemo(() => resolvePreview(pack, tools), [pack, tools])
  const missing = pack.tools.filter((id) => !tools.some((t) => t.toolId === id))
  const disabled = pack.tools.filter((id) => tools.some((t) => t.toolId === id && !t.enabled))

  return (
    <section className="install-preview">
      <h3>Install order for {pack.name}</h3>

      {steps.length === 0 ? (
        <p>Nothing to install.</p>
      ) : (
        <ol data-testid="install-preview">
          {steps.map(({ tool, tied }) => (
            <li key={tool.toolId}>
              <span className="order">{tool.installOrder}</span>
              <code>{tool.toolId}</code>
              <span className="run-as">as {tool.runAs}</span>
              {tool.setupScript && <span className="badge">+ setup</span>}
              {tied && (
                <span className="badge tie" title="Shares an install order; ordered by tool id for determinism">
                  tie-break
                </span>
              )}
            </li>
          ))}
        </ol>
      )}

      {disabled.length > 0 && (
        <p className="hint">Skipped because they are disabled: {disabled.join(', ')}</p>
      )}
      {missing.length > 0 && (
        <p role="alert">
          This pack references tools that do not exist: {missing.join(', ')}. Core will refuse to load a
          pack file in that state.
        </p>
      )}
    </section>
  )
}
