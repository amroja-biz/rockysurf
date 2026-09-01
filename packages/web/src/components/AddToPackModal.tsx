import { useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import {
  ApiError,
  createAdminSurgePack,
  updateAdminSurgePack,
  updateAdminTool,
  type AdminSurgePack,
  type AdminTool,
} from '../lib/api'
import { carryFromSource, forkNameFor, suggestNewPackId } from '../lib/derive-pack'

/**
 * "Add to a pack…" — putting one registered tool onto boxes (issue #295).
 *
 * A TOOL REACHES A BOX ONLY THROUGH A PACK (owner ruling, ADR-0018). Registering a tool deploys
 * nothing, so this is the step that was missing: the one place that answers "I have this tool,
 * now what". It offers exactly two ways to be installed, and they are different in kind.
 *
 * ADDING TO A PACK YOU OWN is an edit. Adding to one you do not — an official pack, or one from
 * a registry — is a FORK, because official packs are not editable here and never will be: the
 * boot reconcile rewrites file-backed rows from disk (ADR-0004), so an "edit" would vanish at
 * the next restart. Forking is not a workaround for that, it is the owner's own model of what
 * modifying an official pack means ("I think of it like a forked repo"). The fork keeps the
 * parent's artwork and wears a delta over it, and its parent's card gets the same delta back.
 *
 * "ADD TO ALL PACKS" IS NOT A LOOP OVER PACKS. Writing the tool into all ten official packs
 * would fork all ten, which is the outcome this whole issue exists to avoid; and a personal
 * pack made tomorrow would not have it. `alwaysInstall` is one flag that means "every box,
 * whichever pack" — so this modal names it as what it is rather than dressing it up as a bulk
 * edit, and asks before turning it on, because the blast radius is every server created from
 * now on and a tool that fails takes the whole box with it (ADR-0010).
 */
export function AddToPackModal({
  tool,
  packs,
  onSaved,
  onClose,
}: {
  tool: AdminTool
  packs: AdminSurgePack[]
  onSaved: () => void | Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingAlways, setConfirmingAlways] = useState(false)

  /** Editable in place, versus forked. The same predicate the packs page uses. */
  const editable = useMemo(() => packs.filter((p) => !p.sourceFile), [packs])
  const forkOnly = useMemo(() => packs.filter((p) => Boolean(p.sourceFile)), [packs])
  const taken = useMemo(() => new Set(packs.map((p) => p.packId)), [packs])

  const has = (pack: AdminSurgePack) => pack.tools.includes(tool.toolId)

  async function run(work: () => Promise<void>, done: string) {
    setSaving(true)
    setError(null)
    try {
      await work()
      toast.success(done)
      await onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'That did not work')
    } finally {
      setSaving(false)
    }
  }

  const addTo = (pack: AdminSurgePack) =>
    run(
      () => updateAdminSurgePack(pack.packId, { tools: [...pack.tools, tool.toolId] }).then(() => undefined),
      `${tool.name} added to ${pack.name}`,
    )

  /**
   * Fork the pack, with this tool added. The new pack is created outright rather than opening
   * the pack form: the operator asked to put one tool somewhere, and a form with twelve fields
   * is not an answer to that. It lands on the Personal tab, where it can be edited like any
   * other pack of theirs.
   */
  const fork = (pack: AdminSurgePack) =>
    run(
      () =>
        createAdminSurgePack({
          packId: suggestNewPackId(pack.packId, taken),
          name: forkNameFor(pack),
          tools: [...pack.tools, tool.toolId],
          displayOrder: pack.displayOrder,
          enabled: true,
          requiresRepos: pack.requiresRepos,
          requiresRdp: pack.requiresRdp,
          ...(pack.desktop ? { desktop: pack.desktop } : {}),
          ...(pack.webPort != null ? { webPort: pack.webPort } : {}),
          ...carryFromSource(pack),
        }).then(() => undefined),
      `Made your own copy of ${pack.name} with ${tool.name} in it`,
    )

  const setAlways = (next: boolean) =>
    run(
      () => updateAdminTool(tool.toolId, { alwaysInstall: next }).then(() => undefined),
      next
        ? `${tool.name} will be installed on every box you create`
        : `${tool.name} is no longer installed on every box`,
    )

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={`Add ${tool.name} to a pack`}>
      <div className="modal modal-wide">
        <h3>Add {tool.name} to a pack</h3>
        <p className="hint">
          A tool only reaches a box through a Surge Pack. Adding it to one of your own packs changes
          that pack; adding it to an official pack makes you your own copy of that pack, because the
          official ones are rewritten from their files every time Rocky Surf restarts.
        </p>

        {error && <p role="alert">{error}</p>}

        <section>
          <h4>Your packs</h4>
          {editable.length === 0 ? (
            <p className="hint">You have no packs of your own yet. Copy an official one below.</p>
          ) : (
            <ul className="add-to-pack-list">
              {editable.map((pack) => (
                <li key={pack.packId}>
                  <span>
                    {pack.name} <small>({pack.packId})</small>
                  </span>
                  {has(pack) ? (
                    <span className="hint" data-testid={`already-in-${pack.packId}`}>
                      already in this pack
                    </span>
                  ) : (
                    <button
                      data-testid={`add-to-${pack.packId}`}
                      disabled={saving}
                      onClick={() => void addTo(pack)}
                    >
                      Add
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h4>Official and community packs</h4>
          <p className="hint">
            These cannot be changed here. Copying one gives you a pack of your own that starts as an
            exact copy — it keeps following the official tools as they are updated, and only the list
            of what is in it is yours.
          </p>
          <ul className="add-to-pack-list">
            {forkOnly.map((pack) => (
              <li key={pack.packId}>
                <span>
                  {pack.name} <small>({pack.packId})</small>
                </span>
                <button data-testid={`fork-${pack.packId}`} disabled={saving} onClick={() => void fork(pack)}>
                  Copy it with {tool.name}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h4>Or put it on everything</h4>
          {tool.alwaysInstall ? (
            <>
              <p data-testid="always-install-on">
                {tool.name} is installed on <strong>every box you create</strong>, whichever pack you
                pick. Servers that already exist are not affected.
              </p>
              <button data-testid="always-install-off" disabled={saving} onClick={() => void setAlways(false)}>
                Stop installing it on every box
              </button>
            </>
          ) : confirmingAlways ? (
            <>
              <p role="alert" data-testid="always-install-confirm">
                Every server you create from now on will install {tool.name}, whichever pack you pick
                and even if you pick none. Make sure it does not depend on anything a pack might not
                have installed: <strong>a tool that fails to install terminates the box</strong>, so a
                tool that is wrong here breaks every new server, not one. Boxes that already exist do
                not change.
              </p>
              <button
                className="button primary"
                data-testid="always-install-yes"
                disabled={saving}
                onClick={() => void setAlways(true)}
              >
                Yes, install it on every box
              </button>
              <button className="button secondary" disabled={saving} onClick={() => setConfirmingAlways(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button data-testid="always-install-on-start" disabled={saving} onClick={() => setConfirmingAlways(true)}>
              Install it on every box I create from now on
            </button>
          )}
        </section>

        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
