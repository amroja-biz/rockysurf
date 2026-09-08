import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { MachineTypePicker } from './MachineTypePicker'
import type { ProviderInfo, SecretView, SettingsChange, SettingsField } from '../lib/api'
import { ENV_VAR_ONLY, envVarDisplay, envVarReference } from '../lib/envRef'

/**
 * THE CONTROLS THAT DRAW ONE SETTING, shared by the Settings page and the setup wizard (#474).
 *
 * These functions lived inside `SettingsPage.tsx` until the wizard needed them. The wizard's job
 * is to SET THINGS UP rather than to describe setting them up, and "the same fields the Settings
 * page shows, with the same labels and the same validation, saved through the same
 * `PUT /api/v1/settings`" is only true if it is literally the same code drawing them. A second
 * implementation would have been a second set of labels to drift, a second idea of what a
 * credential box accepts, and a second place for the SSH whitelist's two-act guard to be got
 * wrong.
 *
 * ── WHY THEY ARE FUNCTIONS AND NOT COMPONENTS ─────────────────────────────────────────
 * `textField(ctx, …)` is CALLED; it is not `<TextField/>`. That is the rule `SettingsPage.tsx`
 * has always followed and the reason is unchanged: a component declared inside a render function
 * is a new component type on every render, so React unmounts and remounts its subtree and an
 * input loses focus after every keystroke. Hoisting them to this module would let them be real
 * components — but making them components in the same change that moved them would have altered
 * the tree the Settings page renders, and the point of this move is that the Settings page's
 * output is byte-for-byte what it was. They stay functions, and the closure they used to have
 * over the page's state arrives as `ctx` instead.
 * ──────────────────────────────────────────────────────────────────────────────────────
 *
 * WHAT THEY WILL NOT DO. Nothing here decides what a field IS: `kind`, `writable`, `hidden`,
 * `label`, `help`, `warning`, `accepts` and `appliesAt` all come from the server's inventory,
 * which since ADR-0027 is built from each Provider's own declaration. So a cloud that is not in
 * this repository draws the same panel here, in the wizard and in Settings alike, with no edit
 * to this file.
 */

/** Pending edits, keyed by dotted path. */
export type Edits = Record<string, SettingsChange>

/** `['github','tokens',0,'pat']` → `'github.tokens.0.pat'`, the key edits and issues are held by. */
export const keyOf = (path: (string | number)[]) => path.join('.')

/** The same path with list indices generalised, which is how the server names a field spec. */
export const patternOf = (path: (string | number)[]) => path.map((s) => (typeof s === 'number' ? '*' : s)).join('.')

/**
 * `sshAllowedCidr` → `Ssh Allowed Cidr`.
 *
 * ONLY EVER A FALLBACK. Every field a hand-written block draws has a hand-written label and every
 * field a Provider declares carries the label the Provider wrote; this is what a field core added
 * after this build shipped gets, so that it renders with a readable name instead of not at all.
 */
export function humanize(segment: string): string {
  const spaced = segment.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export function valueAt(tree: unknown, path: (string | number)[]): unknown {
  let node: unknown = tree
  for (const segment of path) {
    if (node === null || node === undefined || typeof node !== 'object') return undefined
    node = (node as Record<string | number, unknown>)[segment]
  }
  return node
}

/** A secret field's state, tolerating a file where the key is simply absent. */
export function secretAt(tree: unknown, path: (string | number)[]): SecretView {
  const found = valueAt(tree, path)
  if (found && typeof found === 'object' && 'secret' in found) return found as SecretView
  return { secret: true, state: 'unset' }
}

/**
 * `preferences.tiers.aws.small` → `aws`, and anything else → undefined (issue #212).
 *
 * THE SHAPE, NOT A LIST OF CLOUDS. Core generates these fields from one table, so a cloud added
 * there is recognised here with no edit — a hand-written case per cloud would give that property
 * straight back.
 */
export function tierCloudOf(path: string): string | undefined {
  const parts = path.split('.')
  return parts.length === 4 && parts[0] === 'preferences' && parts[1] === 'tiers' ? parts[2] : undefined
}

/** What a caller has to hand these controls in place of the closure they used to have. */
export interface FieldsContext {
  /** The file's own tree, secrets masked. */
  values: Record<string, unknown>
  /** What the loader uses for anything the file does not say. */
  defaults: Record<string, unknown>
  /** The server's inventory, by pattern. */
  specs: Map<string, SettingsField>
  edits: Edits
  /** Field path → message, from the last rejected save. */
  fieldErrors: Record<string, string>
  /** The server's `${VAR}`-is-unset warnings, by the same dotted key the errors use. */
  warnings: Record<string, string>
  setEdit: (path: (string | number)[], change: SettingsChange | null) => void
  /**
   * The catalogues behind the saved-type pickers (issue #212). ADVISORY: with none, a saved-type
   * field is the free-text box it has always been, which is why the wizard can pass an empty list.
   */
  providers: readonly ProviderInfo[]
  /** The half-typed CIDR in each cloud's Add box, keyed by field path (issue #304). */
  cidrDrafts: Record<string, string>
  setCidrDrafts: Dispatch<SetStateAction<Record<string, string>>>
  /** Opens the caller's one confirmation dialogue. The CIDR control is the only user. */
  confirm: (request: FieldConfirmRequest) => void
  /**
   * Records that a pattern has been drawn — the Settings page's leftovers ledger (issue #122).
   * The wizard draws a fixed set and passes a no-op.
   */
  draw: (pattern: string) => void
  /** Patterns whose `warning` a list has already said once at its own head (rsui-9sc). */
  hoistedWarnings: Set<string>
  /** Form owners for masked credential boxes — see `passwordFormOwners` in `SettingsPage.tsx`. */
  passwordFormOwners: string[]
}

/** What the CIDR control asks its caller to confirm before it changes a firewall rule. */
export interface FieldConfirmRequest {
  title?: string
  label: string
  message?: string
  confirmLabel?: string
  confirm: () => void | Promise<void>
}

/**
 * The note under a control that a running Rocky Surf cannot honour yet (issue #264).
 *
 * PER FIELD, AT THE CONTROL, and the wording is core's. Rendered for the writable and the
 * read-only alike: `server.dataDir` is not editable and an operator still has to know that moving
 * it is a stop-and-start, not an edit.
 */
export function RestartNote({ spec }: { spec: SettingsField | undefined }) {
  if (spec?.appliesAt !== 'restart' || !spec.restartReason) return null
  return (
    <p className="hint settings-restart-note" data-restart-required={spec.path}>
      <strong>Takes effect after a restart.</strong> {spec.restartReason}
    </p>
  )
}

/**
 * The help line, under the label and above the control (rockysurf-5qzg, directive 3).
 *
 * ONE MECHANISM, EVERYWHERE, and deliberately not a tooltip: a `title` attribute is invisible on a
 * touch screen, invisible to a keyboard, and not reliably announced by a screen reader — so on a
 * surface whose whole job is explaining a setting to somebody who has not read the file, the
 * explanation would be missing for exactly the readers most in need of it.
 */
export function helpFor(ctx: FieldsContext, specPath: string, id: string): ReactNode {
  const help = ctx.specs.get(specPath)?.help
  return help ? (
    <p className="field-help" id={`${id}-help`}>
      {help}
    </p>
  ) : null
}

export const helpId = (ctx: FieldsContext, specPath: string, id: string) =>
  ctx.specs.get(specPath)?.help ? `${id}-help` : undefined

/** Label, help, control, the server's warning for the field, and any error from a save. */
export function wrap(
  ctx: FieldsContext,
  path: (string | number)[],
  label: string,
  control: ReactNode,
): ReactNode {
  const pattern = patternOf(path)
  const spec = ctx.specs.get(pattern)
  ctx.draw(pattern)
  // A hidden field is not drawn even when a call site asks for it: the inventory decides.
  if (spec?.hidden) return null
  const key = keyOf(path)
  const error = ctx.fieldErrors[key]
  return (
    <div className="form-group" data-field={key} key={key}>
      <label htmlFor={key}>{label}</label>
      {helpFor(ctx, pattern, key)}
      {control}
      {spec?.warning && !ctx.hoistedWarnings.has(pattern) && <p className="hint settings-warning">{spec.warning}</p>}
      <RestartNote spec={spec} />
      {ctx.warnings[key] && <p className="warning settings-field-warning">{ctx.warnings[key]}</p>}
      {error && <p className="error settings-field-error">{error}</p>}
    </div>
  )
}

/** A field the editor shows and will not write, with the server's reason for that. */
export function readOnlyField(ctx: FieldsContext, path: (string | number)[], label: string): ReactNode {
  const pattern = patternOf(path)
  const spec = ctx.specs.get(pattern)
  ctx.draw(pattern)
  if (spec?.hidden) return null
  const key = keyOf(path)
  const current = valueAt(ctx.values, path) ?? valueAt(ctx.defaults, path)
  const shown = current === undefined ? 'not set' : Array.isArray(current) ? current.join(', ') : String(current)
  return (
    <div className="form-group" data-field={key} key={key}>
      <label>{label}</label>
      {helpFor(ctx, pattern, key)}
      <p className="settings-value">{shown}</p>
      <p className="read-only">{spec?.reason}</p>
      <RestartNote spec={spec} />
    </div>
  )
}

/** What a text box for this path is showing right now: the pending edit, else the file. */
export function shownText(ctx: FieldsContext, path: (string | number)[]): string {
  const edit = ctx.edits[keyOf(path)]
  const current = valueAt(ctx.values, path)
  if (edit) return edit.unset ? '' : String(edit.value ?? '')
  return current === undefined || current === null ? '' : String(current)
}

/**
 * `extra` is drawn under the box, inside the same form group.
 *
 * The one caller that passes anything is the saved-type field (issue #212), whose catalogue picker
 * belongs to its box rather than beside it: the two controls edit the same setting.
 */
export function textField(
  ctx: FieldsContext,
  path: (string | number)[],
  label: string,
  type: 'text' | 'number' = 'text',
  extra?: ReactNode,
): ReactNode {
  const key = keyOf(path)
  const fallback = valueAt(ctx.defaults, path)
  const shown = shownText(ctx, path)

  return wrap(
    ctx,
    path,
    label,
    <>
      <input
        id={key}
        type={type}
        value={shown}
        aria-describedby={helpId(ctx, patternOf(path), key)}
        placeholder={fallback === undefined ? '' : `default: ${String(fallback)}`}
        onChange={(e) => {
          const raw = e.target.value
          // An emptied box says nothing about the field, which is how the file gets back to the
          // default rather than to an empty string.
          if (raw === '') return ctx.setEdit(path, { path, unset: true })
          const asNumber = Number(raw)
          ctx.setEdit(path, {
            path,
            value: type === 'number' && Number.isFinite(asNumber) ? asNumber : raw,
          })
        }}
      />
      {extra}
    </>,
  )
}

/**
 * A saved type for one (cloud, size), with that cloud's own catalogue under it (issue #212).
 *
 * NO CATALOGUE, NO PICKER — and no apology for one either. A cloud switched off in the file loads
 * no Provider, `/providers` is advisory here, and either way the answer is the box this field has
 * always had, which can still hold a type this installation cannot offer today.
 */
export function tierField(
  ctx: FieldsContext,
  path: (string | number)[],
  label: string,
  cloud: string,
): ReactNode {
  const catalogue = ctx.providers.find((p) => p.id === cloud)
  const offerings = catalogue?.offerings ?? []
  if (!catalogue || offerings.length === 0) return textField(ctx, path, label)

  const saved = shownText(ctx, path)
  const known = offerings.some((o) => o.id === saved)
  return textField(
    ctx,
    path,
    label,
    'text',
    <>
      <MachineTypePicker
        instanceId={keyOf(path)}
        offerings={offerings}
        selectedId={saved === '' ? null : saved}
        onSelect={(offering) => ctx.setEdit(path, { path, value: offering.id })}
        onClear={() => ctx.setEdit(path, { path, unset: true })}
        // The saved type is never hidden by "Available only": it is the row this operator came to
        // look at, and its own unavailable reason is why they came.
        preferredIds={new Set(saved === '' ? [] : [saved])}
        summary={`Choose from ${catalogue.displayName}`}
        hint={
          'The catalogue the New Server page resolves against, narrowed by this installation’s own ' +
          'allowlist. Selecting a type fills the box above; selecting it again empties the box, which ' +
          'is the default — the cheapest type that meets this size’s floor.'
        }
      />
      {/* Not an error, and not a refusal: the file may name a type from another region, one
          outside `providers.<cloud>.sizes`, or one no longer sold. Core falls back to the floor
          and says so on the New Server page (issue #124). */}
      {saved !== '' && !known && (
        <p className="hint" data-tier-unlisted={keyOf(path)}>
          {catalogue.displayName} is not currently offering {saved} to this installation, so it is not
          in the list above. It is kept as written — a Server asking for this size falls back to the
          cheapest type that meets the floor until it can be bought again.
        </p>
      )}
    </>,
  )
}

export function boolField(ctx: FieldsContext, path: (string | number)[], label: string): ReactNode {
  const key = keyOf(path)
  const edit = ctx.edits[key]
  const current = valueAt(ctx.values, path) ?? valueAt(ctx.defaults, path) ?? false
  return wrap(
    ctx,
    path,
    label,
    <input
      id={key}
      type="checkbox"
      aria-describedby={helpId(ctx, patternOf(path), key)}
      checked={edit ? Boolean(edit.value) : Boolean(current)}
      onChange={(e) => ctx.setEdit(path, { path, value: e.target.checked })}
    />,
  )
}

/** True when this field's box takes a pasted token rather than a variable name. */
export const acceptsLiteral = (ctx: FieldsContext, specPath: string) =>
  ctx.specs.get(specPath)?.accepts === 'literal'

const passwordFormOwner = (key: string) => `password-form-${key}`

/**
 * A credential box, in one of the two shapes `FieldSpec.accepts` allows.
 *
 * `'envVarName'` — the default, rockysurf-4o3o, and what every Provider credential gets. PLAIN
 * TEXT, DELIBERATELY: `type=password` over a variable name is theatre, the content is not key
 * material, masking it stops the operator proof-reading the one thing they have to get right, and
 * hiding it would suggest that pasting a token here is what the box is for. The policy is enforced
 * instead of implied — `envVarReference` refuses anything that is not a name, in words.
 *
 * `'literal'` — the two GitHub PATs, since rockysurf-7fyf.2. `type=password`, and that INVERTS the
 * sentence above rather than contradicting it: masking a variable name is theatre, masking key
 * material is not.
 *
 * THE PREFILL TRAP is why the `reference` case splits: an env-var box prefills a `${VAR}` state
 * with the bare name, as editable text; doing the same in a PASTE box would put `GITHUB_PAT` in a
 * box that now takes tokens, where the first keystroke turns a working reference into a literal
 * nobody meant to write. So a paste box renders a state line and an EMPTY input.
 */
export function secretInput(
  ctx: FieldsContext,
  path: (string | number)[],
  specPath: string,
  example: string,
): { input: ReactNode; state: SecretView; cleared: boolean; refusal: string | null } {
  const key = keyOf(path)
  const state = secretAt(ctx.values, path)
  const edit = ctx.edits[key]
  const cleared = edit?.unset === true
  const literal = acceptsLiteral(ctx, specPath)
  ctx.draw(specPath)

  // Masked boxes get a form owner of their own. Only masked ones: an env-var-name box is plain
  // text, holds no key material, and is part of the bulk save.
  const owner = literal ? passwordFormOwner(key) : undefined
  if (owner) ctx.passwordFormOwners.push(owner)

  const typed = edit && !cleared ? String(edit.value ?? '') : undefined
  const fromFile =
    !cleared && typed === undefined && !literal && state.state === 'reference' ? envVarDisplay(state.reference) : ''
  const shown = cleared ? '' : (typed ?? fromFile)
  // Live, because a refusal that waited for the Save button would let an operator type a whole
  // token before being told the box never wanted one. An empty box is not a refusal: blank means
  // keep. A paste box refuses nothing.
  const refusal =
    !literal && typed !== undefined && typed.trim() !== '' && envVarReference(typed) === null ? ENV_VAR_ONLY : null

  const input = (
    <input
      id={key}
      type={literal ? 'password' : 'text'}
      spellCheck={false}
      // `off` and not `new-password`: this is a personal access token for a forge, not a password
      // for this site, and the hint that would invite a browser to remember it is also the hint
      // that makes Chrome ask for a username field to file it under.
      autoComplete="off"
      {...(owner ? { form: owner } : {})}
      disabled={cleared}
      value={shown}
      aria-describedby={helpId(ctx, specPath, key)}
      placeholder={placeholderFor(state, { cleared, literal, example })}
      onChange={(e) => {
        // Blank means KEEP — the one kind of field where it does. Removing a credential is a
        // labelled button, so a half-finished edit can never delete one.
        const raw = e.target.value
        ctx.setEdit(path, raw === '' ? null : { path, value: raw })
      }}
    />
  )
  return { input, state, cleared, refusal }
}

/**
 * What the file currently says about a credential, in a sentence.
 *
 * The `literal` half is not the same sentence with a word changed: for a paste box a stored token
 * is the NORMAL state rather than something to migrate out of, and a `${VAR}` reference is a
 * working configuration nothing here must talk anyone out of.
 */
export function secretStateHint(state: SecretView, literal: boolean): string {
  if (state.state === 'set') {
    return literal
      ? 'A token is stored in the configuration file and cannot be displayed here. Paste a new one ' +
          'to replace it. '
      : 'A literal token is stored in the configuration file, and cannot be displayed here. Move it ' +
          'into an environment variable and name that variable here; the file will then hold only the ' +
          'reference. '
  }
  if (state.state === 'reference') {
    return literal
      ? 'This entry names an environment variable, which Rocky Surf reads at startup — that still ' +
          'works and the file is unchanged. Leave the box empty to keep it, or paste a token to ' +
          'replace it. '
      : 'Read from this environment variable at startup. The file holds the reference — never what it expands to. '
  }
  return 'Not set in the configuration file. '
}

/** The greyed text in a credential box, which differs by state and by what the box takes. */
export function placeholderFor(
  state: SecretView,
  { cleared, literal, example }: { cleared: boolean; literal: boolean; example: string },
): string {
  if (cleared) return 'Will be removed when you save'
  if (literal) {
    if (state.state === 'set') return 'A token is stored in the file — paste a new one to replace it'
    if (state.state === 'reference') return 'Leave empty to keep the environment variable this names'
    return example
  }
  if (state.state === 'set') return 'A token is stored in the file — name a variable to replace it'
  return example
}

/** The live refusal under a token box, when what is in it is not a variable name. */
export function refusalLine(key: string, refusal: string | null): ReactNode {
  return refusal ? (
    <p className="error settings-field-error" data-refusal={key}>
      {refusal}
    </p>
  ) : null
}

export function secretField(
  ctx: FieldsContext,
  path: (string | number)[],
  label: string,
  example: string,
): ReactNode {
  const key = keyOf(path)
  const pattern = patternOf(path)
  const spec = ctx.specs.get(pattern)
  if (spec?.hidden) return null
  const { input, state, cleared, refusal } = secretInput(ctx, path, pattern, example)

  return (
    <div className="form-group" data-field={key} key={key}>
      <label htmlFor={key}>{label}</label>
      {helpFor(ctx, pattern, key)}
      {input}
      {refusalLine(key, refusal)}
      <p className="hint">
        {secretStateHint(state, acceptsLiteral(ctx, pattern))}
        Leave this blank to keep it as it is.
      </p>
      {spec?.warning && !ctx.hoistedWarnings.has(pattern) && <p className="hint settings-warning">{spec.warning}</p>}
      {ctx.fieldErrors[key] && <p className="error settings-field-error">{ctx.fieldErrors[key]}</p>}
      {(state.state !== 'unset' || cleared) && (
        <button
          type="button"
          className="btn-secondary settings-clear"
          onClick={() => ctx.setEdit(path, cleared ? null : { path, unset: true })}
        >
          {cleared ? 'Keep it after all' : 'Remove this credential'}
        </button>
      )}
    </div>
  )
}

/**
 * The networks allowed to reach SSH on one cloud (issue #304).
 *
 * A hand-written control rather than the generic `stringList` fallback, because this list is the
 * one setting where REMOVING an entry is itself a request to change a firewall: the operator is
 * not editing a preference, they are ending SSH from a network.
 *
 * ONE function taking a cloud, not three blocks. Every Provider that maintains a whitelist gets
 * the same control, for the same reason the field inventory drives the rest of the page.
 *
 * Two rules are enforced here rather than left to the save to reject:
 * - the LAST entry cannot be removed, because an empty list means SSH reachable from nowhere and
 *   the operator almost certainly meant to add the replacement first;
 * - `0.0.0.0/0` is confirmed before it is added, and then needs `allowAllCidr` as well — the
 *   two-act guard the Providers have always had.
 */
export function cidrListField(ctx: FieldsContext, cloud: string, label: string): ReactNode {
  const path = ['providers', cloud, 'sshAllowedCidr']
  const key = path.join('.')
  const spec = ctx.specs.get(key)
  if (!spec) return null

  const savedRaw = valueAt(ctx.values, path) ?? valueAt(ctx.defaults, path)
  // Tolerates the pre-#304 scalar in an operator's file: one CIDR is a list of one.
  const saved = savedRaw === undefined ? [] : Array.isArray(savedRaw) ? (savedRaw as string[]) : [String(savedRaw)]
  const pending = (ctx.edits[key]?.value as string[] | undefined) ?? saved
  const draft = ctx.cidrDrafts[key] ?? ''
  const setList = (next: string[]) => ctx.setEdit(path, { path, value: next })

  function addDraft() {
    const value = draft.trim()
    if (value === '' || pending.includes(value)) return
    const commit = () => {
      setList([...pending, value])
      ctx.setCidrDrafts((drafts) => ({ ...drafts, [key]: '' }))
    }
    if (value === '0.0.0.0/0') {
      ctx.confirm({
        title: 'Open SSH to the whole internet?',
        label: value,
        message:
          '0.0.0.0/0 means every address on the internet may reach SSH on every box this cloud ' +
          'creates. These boxes run agent-authored code and hold your git token. You will also ' +
          'have to tick "Allow all CIDR" below before this can be saved.',
        confirmLabel: 'Add 0.0.0.0/0',
        confirm: commit,
      })
      return
    }
    commit()
  }

  const lastOne = pending.length === 1

  return (
    <div className="form-group" data-field={key} key={key}>
      <fieldset aria-describedby={helpId(ctx, key, key)}>
        <legend>{label}</legend>
        {helpFor(ctx, key, key)}
        {pending.length === 0 ? (
          <p className="hint">None set. SSH would be unreachable from anywhere — add the network you connect from.</p>
        ) : (
          <ul className="settings-cidr-list">
            {pending.map((cidr) => (
              <li key={cidr}>
                <code>{cidr}</code>
                <button
                  type="button"
                  className="link-button"
                  disabled={lastOne}
                  title={lastOne ? 'SSH would be unreachable from anywhere — add the replacement first.' : undefined}
                  onClick={() =>
                    ctx.confirm({
                      title: 'Remove this network?',
                      label: cidr,
                      message:
                        `Removing ${cidr} immediately ends new SSH connections from that ` +
                        'network; existing sessions survive. It is pushed to the cloud when you save.',
                      confirm: () => setList(pending.filter((entry) => entry !== cidr)),
                    })
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="settings-cidr-add">
          <input
            type="text"
            aria-label={`Add a network for ${cloud}`}
            placeholder="203.0.113.7/32"
            value={draft}
            onChange={(e) => {
              const typed = e.target.value
              ctx.setCidrDrafts((drafts) => ({ ...drafts, [key]: typed }))
            }}
          />
          <button type="button" onClick={addDraft} disabled={draft.trim() === ''}>
            Add
          </button>
        </div>
      </fieldset>
      {spec.warning && <p className="hint settings-warning">{spec.warning}</p>}
      {ctx.fieldErrors[key] && <p className="error">{ctx.fieldErrors[key]}</p>}
      {/*
        The second act, shown only once the dangerous value is actually in the list — a permanent
        checkbox offering to open SSH to the internet is an invitation, and this is not one. It is
        an ordinary boolean field, so its help and warning come from core.
      */}
      {pending.includes('0.0.0.0/0') && boolField(ctx, ['providers', cloud, 'allowAllCidr'], 'Allow all CIDR')}
    </div>
  )
}

/** The value, and the honest sentence that this build has no control for a field of this shape. */
export function uneditableFallback(ctx: FieldsContext, spec: SettingsField, label: string): ReactNode {
  const path = spec.path.split('.')
  const current = valueAt(ctx.values, path) ?? valueAt(ctx.defaults, path)
  const shown =
    current === undefined ? 'not set' : Array.isArray(current) ? current.join(', ') : JSON.stringify(current)
  return (
    <div className="form-group" data-field={spec.path} key={spec.path}>
      <label>{label}</label>
      {helpFor(ctx, spec.path, spec.path)}
      <p className="settings-value">{shown}</p>
      <p className="read-only">
        This page has no editor for a setting of this shape yet. Change <code>{spec.path}</code> in the
        configuration file itself.
      </p>
    </div>
  )
}

/**
 * A control for one field of the inventory, chosen by its `kind`.
 *
 * IT IS NOT A FORM GENERATOR. It cannot invent a control the inventory did not describe — it reads
 * `kind`, `writable` and `hidden` off the same spec every other control obeys, and its label is
 * the field's own last path segment when the spec carries none. On the Settings page it draws
 * whatever the hand-written blocks did not; in the wizard it draws a Provider's whole panel,
 * because since ADR-0027 a Provider's panel is exactly a list of these.
 */
export function genericField(ctx: FieldsContext, spec: SettingsField): ReactNode {
  if (spec.hidden) return null
  const path = spec.path.split('.')
  // A row from a Provider's declared settings carries its own label (ADR-0027); a core row no
  // block drew falls back to its path.
  const label = spec.label ?? humanize(path[path.length - 1] ?? spec.path)
  if (!spec.writable) return readOnlyField(ctx, path, label)
  // A saved type is a string field with a catalogue behind it (issue #212), recognised by the
  // SHAPE of its path rather than named cloud by cloud.
  const cloud = spec.kind === 'string' ? tierCloudOf(spec.path) : undefined
  if (cloud !== undefined) return tierField(ctx, path, label, cloud)
  switch (spec.kind) {
    case 'boolean':
      return boolField(ctx, path, label)
    case 'number':
      return textField(ctx, path, label, 'number')
    case 'secret':
      return secretField(ctx, path, label, spec.example ?? 'A_VARIABLE_NAME')
    // The two-act SSH whitelist a Provider DECLARED (ADR-0027), keyed on the id in the path.
    case 'sshCidrList':
      return cidrListField(ctx, String(path[1]), label)
    // A list and a whole optional block are the two shapes a generic control would have to guess
    // at — how many entries, and what half a block means.
    case 'stringList':
    case 'group':
      return uneditableFallback(ctx, spec, label)
    default:
      return textField(ctx, path, label)
  }
}

/**
 * Every credential change, with the box's text turned into the file's reference — or the keys that
 * cannot be, because what is in them is not a variable name (rockysurf-4o3o).
 *
 * ONE SEAM, so no caller can bypass it: the Settings page's bulk save, a token card's own save, a
 * removal, and the wizard's save all reach the file through this. `specs` decides what is a
 * credential — the same server inventory that decides everything else about a field — rather than
 * the caller guessing from the path.
 *
 * IT DESCENDS INTO A CHANGE'S VALUE, because two of them are whole blocks rather than scalars: a
 * new token entry is written as one `github.tokens.<n>` change carrying `{ repo, pat }`, and a
 * spend cap as `{ amount, currency }`.
 */
export function asReferences(
  specs: Map<string, SettingsField>,
  changes: SettingsChange[],
): { sent: SettingsChange[]; refused: string[] } {
  const refused: string[] = []

  const convert = (path: (string | number)[], value: unknown): unknown => {
    const spec = specs.get(patternOf(path))
    // A paste box sends what was pasted, verbatim (rockysurf-7fyf.2). Converting it would write
    // `${ghp_…}` into the file — a reference to a variable named after a token.
    if (spec?.kind === 'secret' && spec.accepts === 'literal') return value
    if (spec?.kind === 'secret') {
      const reference = envVarReference(String(value ?? ''))
      if (reference !== null) return reference
      refused.push(keyOf(path))
      return value
    }
    // Objects only: a list arriving as a whole value is a shape nothing writes, and walking one
    // would invent index paths no spec could answer for.
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, convert([...path, key], item)]))
    }
    return value
  }

  const sent = changes.map((change) => (change.unset ? change : { ...change, value: convert(change.path, change.value) }))
  return { sent, refused }
}
