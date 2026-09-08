import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, Navigate, useNavigate } from 'react-router'
import { ConfirmModal } from '../components/ConfirmModal'
import { ProviderFailure } from '../components/ProviderErrorNotice'
import {
  asReferences,
  genericField,
  keyOf,
  listDraftValue,
  ListDraftForm,
  listItemFields,
  refuseListDraft,
  shapeProblems,
  valueAt,
  type Edits,
  type FieldConfirmRequest,
  type FieldsContext,
} from '../components/settingsFields'
import { useAuth } from '../contexts/AuthContext'
import {
  ApiError,
  checkProviderCredentials,
  getSettings,
  getSetupState,
  saveSettings,
  type CredentialCheckReport,
  type ProviderSetupState,
  type SettingsChange,
  type SettingsField,
  type SettingsView,
  type SetupState,
} from '../lib/api'

/**
 * The first-run wizard — the surface that SETS THINGS UP (rebuilt for issue #474).
 *
 * WHAT WAS WRONG WITH THE ONE BEFORE IT, in the owner's words after walking the published 0.1.0
 * as a first-time user: it described setup instead of performing it. It told the reader to edit
 * `rockysurf.config.yaml`, or to go to the Settings page, or to read `docs/providers/aws.md` — a
 * file that does not exist on an npm install. Its "Check again" button had no sentence saying
 * what it checked and showed no result when it found nothing. Its last step said to do what "the
 * previous step described", with no way back to that step and no way to find out whether it had
 * worked short of restarting and reopening the page.
 *
 * SO THE RULE THIS FILE NOW FOLLOWS: **anything that can be done in the browser is done here.**
 * When the user picks a cloud, this page draws that cloud's Settings fields — literally the same
 * controls, from `components/settingsFields.tsx`, over the same server-side inventory, with the
 * same labels, the same validation and the same `PUT /api/v1/settings` — and saving them switches
 * the Provider on in the same write. Nothing here names a config file or a repository path.
 *
 * WHAT GENUINELY CANNOT HAPPEN IN A BROWSER is exporting a credential into the shell Rocky Surf
 * runs in, signing in with a cloud's own CLI, and creating a resource group. Those are numbered
 * steps on the same screen, written for somebody who has never done them, with the commands
 * copyable — and then a **Check** button, which asks the cloud, in this process, right now, and
 * prints the answer in place: ready, or the cloud's own refusal, word for word.
 *
 * EVERY STEP AFTER THE FIRST HAS A BACK BUTTON, and the last step reports the real state of every
 * cloud that is switched on rather than referring to a screen the reader can no longer see.
 *
 * ROCKY SURF STILL STORES NO CLOUD CREDENTIAL (issue #280, unchanged). The credential boxes this
 * page can draw are the same ones Settings draws: a Provider's `secret` field takes the NAME of
 * an environment variable, never a token, and `asReferences` refuses anything else before a byte
 * is sent. The token itself lives in the user's environment and nowhere else.
 */

const DISMISSED_KEY = 'rockysurf.wizard.dismissed'

/**
 * The cloud the walkthrough is in the middle of, remembered across a restart.
 *
 * Local storage on purpose: which cloud this browser was working on is a fact about THIS
 * walkthrough, not about the installation. Its one job is that a user who was told to export a
 * variable and restart Rocky Surf comes back to the cloud they were setting up, with its steps
 * and its Check button in front of them, rather than to a fresh list.
 */
const PENDING_KEY = 'rockysurf.wizard.pending'

/** Skipping is remembered locally, so a skipped wizard does not nag on every navigation. */
function wasDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === '1'
  } catch {
    // Private mode, or storage disabled. Not remembering a skip is a nuisance, not a failure.
    return false
  }
}

function dismiss(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, '1')
  } catch {
    /* ignore */
  }
}

function pendingCloud(): string | null {
  try {
    return window.localStorage.getItem(PENDING_KEY)
  } catch {
    return null
  }
}

function setPendingCloud(id: string | null): void {
  try {
    if (id === null) window.localStorage.removeItem(PENDING_KEY)
    else window.localStorage.setItem(PENDING_KEY, id)
  } catch {
    /* ignore */
  }
}

export function useSetupState(): { setup: SetupState | null; loading: boolean; refresh: () => Promise<void> } {
  const [setup, setSetup] = useState<SetupState | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      setSetup(await getSetupState())
    } catch {
      // An unreachable or unauthenticated core is not the wizard's problem to report; the route
      // guards already handle it. Treat it as "nothing to prompt about".
      setSetup(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { setup, loading, refresh }
}

/**
 * Sends a first-time user to the wizard, and nobody else.
 *
 * Wraps the dashboard rather than every route: the redirect should happen where a user lands, not
 * fight them if they deliberately navigate elsewhere.
 *
 * The PENDING half is the return leg of the export-and-restart loop: a user who was told to set a
 * variable and restart lands here first, and the wizard — not the dashboard — is where "it worked"
 * or "here is what the cloud said" gets said out loud.
 */
export function SetupGate({ children }: { children: React.ReactNode }) {
  const { setup, loading } = useSetupState()

  if (loading) return <p>Loading…</p>
  if (setup && (setup.needsProvider || pendingCloud() !== null) && !wasDismissed()) {
    return <Navigate to="/setup" replace />
  }
  return <>{children}</>
}

type StepId = 'welcome' | 'account' | 'sshKey' | 'clouds' | 'done'

const STEPS: { id: StepId; title: string }[] = [
  { id: 'welcome', title: 'Welcome' },
  { id: 'account', title: 'Your account' },
  { id: 'sshKey', title: 'Your SSH key' },
  { id: 'clouds', title: 'Choose your clouds' },
  { id: 'done', title: 'Done' },
]

export function WizardPage() {
  const { user, isAuthenticated, isLoading } = useAuth()
  const navigate = useNavigate()
  const { setup, loading, refresh } = useSetupState()
  /**
   * The configuration file as the Settings editor sees it — the inventory this page draws a
   * cloud's fields from, and the `mtimeMs` a save is guarded by.
   *
   * ADVISORY IN ONE DIRECTION ONLY: without it there are no fields to draw, so the cloud step
   * says what it cannot do rather than pretending. Every other step is unaffected.
   */
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  // A walkthrough that was in the middle of a cloud re-opens on that cloud's step.
  const [step, setStep] = useState<StepId>(() => (pendingCloud() !== null ? 'clouds' : 'welcome'))

  const loadSettings = useCallback(async () => {
    try {
      setSettings(await getSettings())
      setSettingsError(null)
    } catch (err) {
      setSettings(null)
      setSettingsError(err instanceof ApiError ? err.detail : 'Could not read this installation’s settings')
    }
  }, [])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  if (isLoading || loading) return <p>Loading…</p>
  // The wizard runs AFTER sign-in, which is what makes "the password printed at boot works" a
  // fact the user has already proven rather than a claim this page has to make.
  if (!isAuthenticated) return <Navigate to="/login" replace />

  const index = STEPS.findIndex((s) => s.id === step)

  function skipAll() {
    dismiss()
    setPendingCloud(null)
    void navigate('/', { replace: true })
  }

  function finish() {
    dismiss()
    setPendingCloud(null)
    void navigate('/', { replace: true })
  }

  return (
    <main className="wizard">
      <header>
        <h1>Set up Rocky Surf</h1>
        <ol data-testid="wizard-steps">
          {STEPS.map((s, i) => (
            <li key={s.id} aria-current={s.id === step ? 'step' : undefined} data-done={i < index || undefined}>
              {s.title}
            </li>
          ))}
        </ol>
        <button type="button" onClick={skipAll} data-testid="skip-all">
          Skip setup
        </button>
      </header>

      {step === 'welcome' && (
        <section>
          <h2>Welcome</h2>
          <p>
            Rocky Surf is a lightweight layer for managing Linux VMs running on your own cloud
            accounts, pre-installed with your favorite AI coding agent harnesses and GitHub repos.
            Follow this short wizard to get working.
          </p>
          <div className="wizard-actions">
            <button type="button" onClick={() => setStep('account')} data-testid="next">
              Get started
            </button>
          </div>
        </section>
      )}

      {step === 'account' && (
        <section>
          <h2>Your account</h2>
          <p>
            You are signed in as <strong>{user?.username}</strong>, so the password printed in your
            terminal on first boot is working. That password is the only way in — it was shown once
            and is not recoverable, so keep it somewhere safe.
          </p>
          <p className="hint">
            To change it, set <code>ROCKYSURF_ADMIN_PASSWORD</code> and restart.
          </p>
          <div className="wizard-actions">
            <button type="button" className="btn-secondary" onClick={() => setStep('welcome')} data-testid="back">
              Back
            </button>
            <button type="button" onClick={() => setStep('sshKey')} data-testid="next">
              Next
            </button>
          </div>
        </section>
      )}

      {step === 'sshKey' && (
        <SshKeyStep
          settings={settings}
          settingsError={settingsError}
          onSettings={setSettings}
          onBack={() => setStep('account')}
          onContinue={() => setStep('clouds')}
        />
      )}

      {step === 'clouds' && (
        <CloudsStep
          setup={setup}
          settings={settings}
          settingsError={settingsError}
          onSettings={setSettings}
          refreshSetup={refresh}
          onBack={() => setStep('sshKey')}
          onContinue={() => setStep('done')}
        />
      )}

      {step === 'done' && (
        <DoneStep setup={setup} refreshSetup={refresh} onBack={() => setStep('clouds')} onFinish={finish} />
      )}
    </main>
  )
}

/* --------------------------------------------------------------------- your SSH key */

/**
 * "DO YOU ALREADY HAVE AN SSH KEY?" — asked once, here, instead of at every create.
 *
 * WHAT IT IS FOR. Logging in to a Server means a keypair, and there are exactly two honest
 * answers: the person has a key they already use, or they do not and Rocky Surf should make one.
 * Both answers already worked — the New Server page has offered "generate one for me" and "use a
 * key I provide" since ADR-0008, and Settings has saved public keys by name since ADR-0019 — and
 * neither was ever ASKED. So the first-time user met the question for the first time on the form
 * that creates a billable machine, which is the worst moment to go looking for `~/.ssh`.
 *
 * IT IS ONE QUESTION AND IT IS SKIPPABLE. Nothing here is required to finish setup: a person who
 * picks neither answer, or who skips, gets exactly what they got before — a key generated per
 * Server, offered on the create form.
 *
 * THE FORM IS THE SETTINGS PAGE'S OWN, NOT A SECOND ONE. `ListDraftForm` draws it from core's
 * `ssh.keys` list declaration and the same field inventory, and the save is the same
 * `PUT /api/v1/settings` writing the same `ssh.keys` entry. ADR-0019's first amendment exists
 * because a key editor was claimed to be shared and was not; a second key form written for this
 * step would be that mistake again — a second idea of what a key box takes, and a second place
 * for the private-key refusal to go missing. The refusal below is core's, verbatim: the schema
 * runs the create path's own parser, which names the private half before it checks anything else.
 */
function SshKeyStep({
  settings,
  settingsError,
  onSettings,
  onBack,
  onContinue,
}: {
  settings: SettingsView | null
  settingsError: string | null
  onSettings: (view: SettingsView) => void
  onBack: () => void
  onContinue: () => void
}) {
  const [answer, setAnswer] = useState<'paste' | 'generate' | null>(null)
  const [draft, setDraft] = useState<Record<string, string> | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState<string | null>(null)

  const specs = useMemo(() => {
    const map = new Map<string, SettingsField>()
    for (const field of settings?.fields ?? []) map.set(field.path, field)
    return map
  }, [settings])

  const list = (settings?.lists ?? []).find((entry) => entry.path === 'ssh.keys')
  const keys = ((valueAt(settings?.values ?? {}, ['ssh', 'keys']) as { name?: unknown }[] | undefined) ?? []).map(
    (entry, index) => String(entry?.name ?? `key ${index + 1}`),
  )
  const fields = list ? listItemFields(list, specs) : []
  const add = list?.add

  async function saveDraft(values: Record<string, string>) {
    if (!settings || !list || !add) return
    setFormError(null)
    const local = refuseListDraft(fields, add, values, keys, list.labelField ?? fields[0]?.name)
    if (local) return setRefusal(local)

    setRefusal(null)
    setFieldErrors({})
    setSaving(true)
    try {
      const result = await saveSettings(settings.file.mtimeMs, [
        { path: ['ssh', 'keys', keys.length], value: listDraftValue(fields, values) },
      ])
      onSettings(result)
      // The form closes on success, so what is left on screen is the key that was saved and an
      // offer to add another — rather than a second blank form nobody asked for, which reads as
      // though the first one had not worked.
      setDraft(null)
      setAnswer(null)
      setJustSaved((values[list.labelField ?? 'name'] ?? '').trim())
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.data as { issues?: { path: string; message: string }[] } | undefined
        // Keyed to the slot this form wrote to, which is where the form draws them — so core's
        // "that is a PRIVATE key" lands under the box the private key was pasted into.
        setFieldErrors(Object.fromEntries((body?.issues ?? []).map((issue) => [issue.path, issue.message])))
        if ((body?.issues ?? []).length === 0) setFormError(err.detail)
      } else {
        setFormError('Could not save this key')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <section>
      <h2>Your SSH key</h2>
      <p>
        You log in to the Servers Rocky Surf creates with an SSH key. Do you already have one you
        want to use?
      </p>

      {keys.length > 0 && (
        <div data-testid="saved-keys">
          <p>
            {keys.length === 1 ? 'One key is saved' : `${keys.length} keys are saved`} on this
            installation, and the New Server page will offer{' '}
            {keys.length === 1 ? 'it' : 'them'}:
          </p>
          <ul className="wizard-summary">
            {keys.map((name) => (
              <li key={name} data-saved-key={name}>
                <strong>{name}</strong>
                {justSaved === name && <span className="wizard-ready"> — saved</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="wizard-clouds">
        <button
          type="button"
          className={answer === 'paste' ? 'wizard-cloud-choice selected' : 'wizard-cloud-choice'}
          aria-pressed={answer === 'paste'}
          data-testid="key-paste"
          onClick={() => {
            setAnswer('paste')
            setDraft((current) => current ?? {})
          }}
        >
          <strong>{keys.length > 0 ? 'Add another key' : 'Yes, I’ll paste my public key'}</strong>
          <span className="hint">Rocky Surf saves it by name and offers it on every new Server.</span>
        </button>
        <button
          type="button"
          className={answer === 'generate' ? 'wizard-cloud-choice selected' : 'wizard-cloud-choice'}
          aria-pressed={answer === 'generate'}
          data-testid="key-generate"
          onClick={() => {
            setAnswer('generate')
            setDraft(null)
          }}
        >
          <strong>No, make one for me</strong>
          <span className="hint">Nothing to do now.</span>
        </button>
      </div>

      {answer === 'generate' && (
        <div data-testid="key-generate-explainer">
          <p>
            Rocky Surf creates a fresh key for each Server it builds, so there is nothing to set up
            here.
          </p>
          <p>
            You download the private half from that Server’s own page once it has been created, and
            keep it somewhere safe — Rocky Surf shows it there and nowhere else.
          </p>
        </div>
      )}

      {answer === 'paste' && (
        <div data-testid="key-paste-form">
          <p>
            A public key is usually at <code>~/.ssh/id_ed25519.pub</code> — the file ending in{' '}
            <code>.pub</code>, never the one without it. Print it and paste the single line it
            gives you:
          </p>
          <CopyableCommand command="cat ~/.ssh/id_ed25519.pub" />
          {settingsError !== null && (
            <p className="error" data-testid="settings-error">
              {settingsError}
            </p>
          )}
          {list === undefined || add === undefined ? (
            <p className="hint" data-testid="no-key-form">
              This installation does not offer saved keys yet. You can still paste a key on the New
              Server page whenever you create one.
            </p>
          ) : (
            <ListDraftForm
              listKey="ssh.keys"
              draftPrefix={`ssh.keys.${keys.length}`}
              add={add}
              fields={fields}
              specs={specs}
              values={draft ?? {}}
              refusal={refusal}
              fieldErrors={fieldErrors}
              saving={saving}
              onChange={(name, value) => {
                setRefusal(null)
                setFieldErrors({})
                setDraft((current) => ({ ...(current ?? {}), [name]: value }))
              }}
              onSubmit={() => void saveDraft(draft ?? {})}
              onCancel={() => {
                setDraft(null)
                setAnswer(null)
                setRefusal(null)
                setFieldErrors({})
              }}
            />
          )}
          {formError && (
            <p role="alert" className="error" data-testid="key-save-error">
              {formError}
            </p>
          )}
        </div>
      )}

      {/* Skippable, and said so rather than left to be inferred from a button that is not
          disabled: neither answer is needed to finish setting up, and the person who has not
          decided yet should not think they are stuck. */}
      <p className="hint" data-testid="key-optional">
        Nothing here is required. Go on without answering and Rocky Surf will make a key for each
        Server, which you can change at any time on Settings.
      </p>

      <div className="wizard-actions">
        <button type="button" className="btn-secondary" onClick={onBack} data-testid="back">
          Back
        </button>
        <button type="button" onClick={onContinue} data-testid="next">
          Next
        </button>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ choose your clouds */

function CloudsStep({
  setup,
  settings,
  settingsError,
  onSettings,
  refreshSetup,
  onBack,
  onContinue,
}: {
  setup: SetupState | null
  settings: SettingsView | null
  settingsError: string | null
  onSettings: (view: SettingsView) => void
  refreshSetup: () => Promise<void>
  onBack: () => void
  onContinue: () => void
}) {
  const providers = setup?.providers ?? []
  const [selected, setSelected] = useState<string | null>(() => pendingCloud())
  const current = providers.find((p) => p.id === selected)

  // A remembered cloud that this installation no longer has is not an error worth a sentence: the
  // list is the honest fallback, and the memory is cleared so it cannot come back.
  useEffect(() => {
    if (selected !== null && !providers.some((p) => p.id === selected)) {
      setPendingCloud(null)
      setSelected(null)
    }
  }, [selected, providers])

  function choose(id: string) {
    setPendingCloud(id)
    setSelected(id)
  }

  if (providers.length === 0) {
    return (
      <section>
        <h2>Choose your clouds</h2>
        <p data-testid="no-providers">
          This installation reports no clouds it can create Servers on. Providers Rocky Surf does not
          ship are installed from the <Link to="/shop">Rocky Surf Shop</Link>, and appear here once
          they load.
        </p>
        <div className="wizard-actions">
          <button type="button" className="btn-secondary" onClick={onBack} data-testid="back">
            Back
          </button>
          <button type="button" onClick={onContinue} data-testid="continue">
            Continue
          </button>
        </div>
      </section>
    )
  }

  return (
    <section>
      <h2>Choose your clouds</h2>
      <p>
        Pick the cloud you want Rocky Surf to create Servers on. Everything it needs is on this
        screen: the few things you do in a terminal, the settings this page saves for you, and a
        Check that asks the cloud whether it all works. Nothing is created and nothing is billed
        until you ask for a Server.
      </p>
      <p className="hint">
        You can set up more than one — finish this one, then come back to the list. Rocky Surf never
        stores a cloud credential; it uses the ones your own machine already has.
      </p>

      <ul className="wizard-clouds" data-testid="cloud-list">
        {providers.map((provider) => (
          <li key={provider.id}>
            <button
              type="button"
              className={provider.id === selected ? 'wizard-cloud-choice selected' : 'wizard-cloud-choice'}
              aria-pressed={provider.id === selected}
              data-cloud={provider.id}
              onClick={() => choose(provider.id)}
            >
              <strong>{provider.displayName}</strong>
              <span className="hint" data-cloud-state={provider.id}>
                {stateLine(provider)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {current && (
        <CloudPanel
          key={current.id}
          provider={current}
          settings={settings}
          settingsError={settingsError}
          onSettings={onSettings}
          refreshSetup={refreshSetup}
        />
      )}

      <div className="wizard-actions">
        <button type="button" className="btn-secondary" onClick={onBack} data-testid="back">
          Back
        </button>
        <button type="button" onClick={onContinue} data-testid="continue">
          Continue
        </button>
      </div>
    </section>
  )
}

/**
 * One cloud's current state, in a phrase.
 *
 * "Switched on" rather than "ready", deliberately. `loaded` means this process BUILT the Provider —
 * which for a chain-auth cloud says nothing at all about whether the credentials work, because AWS,
 * Azure and Google Cloud all resolve theirs on the first call. The word that means the credentials
 * work is the Check's, and only the Check has earned it.
 */
function stateLine(provider: ProviderSetupState): string {
  if (!provider.enabled) return 'Not set up yet'
  if (provider.loaded) return 'Switched on'
  return 'Switched on, not working yet'
}

/**
 * ONE CLOUD, SET UP IN PLACE.
 *
 * Three blocks, in the order the user meets them: what to do in a terminal, the settings this page
 * writes, and the Check that says whether it worked. Nothing sends them anywhere else.
 */
function CloudPanel({
  provider,
  settings,
  settingsError,
  onSettings,
  refreshSetup,
}: {
  provider: ProviderSetupState
  settings: SettingsView | null
  settingsError: string | null
  onSettings: (view: SettingsView) => void
  refreshSetup: () => Promise<void>
}) {
  const [edits, setEdits] = useState<Edits>({})
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [cidrDrafts, setCidrDrafts] = useState<Record<string, string>>({})
  const [pendingConfirm, setPendingConfirm] = useState<FieldConfirmRequest | null>(null)
  const [report, setReport] = useState<CheckOutcome | null>(null)
  const [checking, setChecking] = useState(false)

  const specs = useMemo(() => {
    const map = new Map<string, SettingsField>()
    for (const field of settings?.fields ?? []) map.set(field.path, field)
    return map
  }, [settings])

  const prefix = `providers.${provider.id}.`
  /**
   * The cloud's own settings, as the server's inventory describes them (ADR-0027).
   *
   * `enabled` is left out because SAVING is what turns the cloud on — one checkbox saying the same
   * thing as the button under it is one of them being ignored. `allowAllCidr` is left out when the
   * cloud has an SSH whitelist, because that control draws it itself, as its second act, and only
   * once `0.0.0.0/0` is actually in the list. A `*` path describes the SHAPE of a list entry
   * rather than a setting, so it has nothing to draw either.
   */
  const fields = (settings?.fields ?? []).filter((field) => {
    if (!field.path.startsWith(prefix) || field.hidden || field.path.includes('*')) return false
    // A field this page cannot write is not part of setting a cloud up. The Settings page shows
    // read-only values because an operator wants to READ them; a first run does not, and every one
    // of them arrives with a sentence about where the edit really happens — which is the sending
    // somewhere else this wizard exists to stop doing.
    if (!field.writable) return false
    if (field.path === `${prefix}enabled`) return false
    if (field.path === `${prefix}allowAllCidr`) {
      return !(settings?.fields ?? []).some((f) => f.path === `${prefix}sshAllowedCidr`)
    }
    return true
  })

  /** Lists this Provider declared, which stay on the Settings page — see the note at their use. */
  const sectionLists = (settings?.lists ?? []).filter((list) => list.path.startsWith(prefix))

  const warnings = Object.fromEntries((settings?.warnings ?? []).map((w) => [w.path, w.message]))

  function setEdit(path: (string | number)[], change: SettingsChange | null): void {
    const key = keyOf(path)
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
    setEdits((prev) => {
      const next = { ...prev }
      if (change === null) delete next[key]
      else next[key] = change
      return next
    })
  }

  const context: FieldsContext | null =
    settings === null
      ? null
      : {
          values: settings.values,
          defaults: settings.defaults,
          specs,
          edits,
          fieldErrors,
          warnings,
          setEdit,
          // No saved-type catalogue here: the wizard draws one cloud's own section, which has no
          // `preferences.tiers.*` field in it. An empty list is what that control expects.
          providers: [],
          cidrDrafts,
          setCidrDrafts,
          confirm: setPendingConfirm,
          // The leftovers ledger belongs to the Settings page, which draws a whole file. This
          // panel draws a list it chose, so there is nothing left over to account for.
          draw: () => {},
          hoistedWarnings: new Set<string>(),
          // Every Provider credential box takes the NAME of a variable and is therefore plain
          // text; only the two GitHub PATs are masked, and neither is a cloud.
          passwordFormOwners: [],
        }

  /**
   * SAVE THE FIELDS AND TURN THE CLOUD ON, in one write.
   *
   * `providers.<id>.enabled: true` travels with the fields rather than through a second call,
   * because they are one decision: a cloud switched on with no region set is a cloud that fails at
   * the first create, and a region saved on a cloud nobody switched on does nothing at all. Core
   * validates the whole section as it now stands, adopts the file before it answers, and names the
   * Providers worth proving at their cloud — so the check below is what a save's last line already
   * asked for.
   */
  async function save() {
    if (!settings) return
    setFormError(null)
    setFieldErrors({})

    const enable: SettingsChange = { path: ['providers', provider.id, 'enabled'], value: true }
    const { sent, refused } = asReferences(specs, [...Object.values(edits), enable])
    if (refused.length > 0) {
      setFormError(
        `Nothing was saved: ${refused.join(', ')} must name an environment variable rather than hold a token.`,
      )
      return
    }

    setSaving(true)
    try {
      const result = await saveSettings(settings.file.mtimeMs, sent)
      onSettings(result)
      setEdits({})
      await refreshSetup()
      // And then ask the cloud, without being asked to. The user pressed the one button on this
      // panel; making them press a second one to find out whether it worked is the "come back
      // later" this rebuild exists to delete.
      await runCheck()
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.data as { issues?: { path: string; message: string }[] } | undefined
        setFieldErrors(Object.fromEntries((body?.issues ?? []).map((i) => [i.path, i.message])))
        // VERBATIM. Core's message names the field it refused, and rewriting it into house prose
        // would throw that away.
        setFormError(err.detail)
      } else {
        setFormError('Could not save these settings')
      }
    } finally {
      setSaving(false)
    }
  }

  /** Ask this cloud whether it is ready, now, and keep what it said. */
  async function runCheck() {
    setChecking(true)
    try {
      const { checked } = await checkProviderCredentials([provider.id])
      const row = checked.find((entry) => entry.provider === provider.id)
      setReport(row ? { kind: 'report', report: row } : { kind: 'not-enabled' })
    } catch (err) {
      setReport({
        kind: 'unreachable',
        detail: err instanceof ApiError ? err.detail : 'Rocky Surf could not run the check',
      })
    } finally {
      setChecking(false)
      await refreshSetup()
    }
  }

  const guide = cloudGuide(provider.id)
  /** Boxes whose contents do not look like what the Provider declared they are for. */
  const shaping = shapeProblems(specs, edits)

  return (
    <div className="wizard-cloud" data-testid="cloud-panel" data-cloud-panel={provider.id}>
      <h3>Set up {provider.displayName}</h3>

      <h4>1. In a terminal, on the machine running Rocky Surf</h4>
      <ol className="wizard-instructions" data-testid="cloud-instructions">
        {guide.steps.map((entry, i) => (
          <li key={i}>
            {entry.text}
            {entry.command && <CopyableCommand command={entry.command} />}
          </li>
        ))}
      </ol>
      {guide.recommended && (
        <p className="hint" data-testid="cloud-recommended">
          <strong>Recommended, and not required to start:</strong> {guide.recommended.text} For
          reduced blast radius, the exact steps are in{' '}
          <Link to={guide.recommended.anchor}>Help → Cloud Providers</Link>.
        </p>
      )}

      <h4>2. Settings Rocky Surf saves for you</h4>
      {settingsError !== null && (
        <p className="error" data-testid="settings-error">
          {settingsError}
        </p>
      )}
      {context !== null && fields.length === 0 && (
        <p className="hint" data-testid="no-fields">
          {provider.displayName} has no settings to fill in — the terminal steps above are all of it.
        </p>
      )}
      {context !== null && fields.map((field) => genericField(context, field))}

      {/*
        THE ONE CONTROL THIS PANEL DOES NOT DRAW, said out loud rather than left out.

        A Provider may declare a LIST as well as fields (ADR-0027) — a set of hosts, a set of
        machines — and adding, editing and removing entries is a bigger flow than a first run
        needs, so it stays on the Settings page. No shipped cloud declares one, so this line is
        for a Provider installed from the Rocky Surf Shop. It points at a page in this app,
        which is the whole difference from what it replaced.
      */}
      {sectionLists.map((list) => (
        <p className="hint" key={list.path} data-testid="list-elsewhere">
          {provider.displayName} also keeps a list of{' '}
          {(settings?.sections.find((s) => s.id === list.path)?.title ?? 'entries').toLowerCase()}. Add
          and edit those on{' '}
          <Link to={`/settings?section=providers.${provider.id}`}>Settings → {provider.displayName}</Link>{' '}
          once you have finished here.
        </p>
      ))}

      {formError && (
        <p role="alert" className="error" data-testid="save-error">
          {formError}
        </p>
      )}

      {/*
        WHY THE BUTTON IS OFF, said out loud. A Save that is greyed for a reason the reader cannot
        see is indistinguishable from one that is broken; the box itself already carries the
        Provider's own sentence about the shape it wanted.
      */}
      {shaping.length > 0 && (
        <p className="error" data-testid="shape-problems" role="alert">
          Saving is off until {shaping.map((problem) => problem.label).join(' and ')}{' '}
          {shaping.length === 1 ? 'looks' : 'look'} right. The box says what is expected.
        </p>
      )}

      <div className="wizard-actions">
        <button
          type="button"
          className="btn-primary"
          disabled={saving || settings === null || shaping.length > 0}
          onClick={() => void save()}
          data-testid="save-cloud"
        >
          {saving ? 'Saving…' : `Save and turn on ${provider.displayName}`}
        </button>
      </div>

      <h4>3. Check it works</h4>
      <p className="hint">
        Check asks {provider.displayName} whether the credentials this Rocky Surf can see actually
        work, using the settings above. It creates nothing and costs nothing.
      </p>
      <CheckControl
        displayName={provider.displayName}
        checking={checking}
        outcome={report}
        onCheck={() => void runCheck()}
        testId={provider.id}
      />

      {pendingConfirm && (
        <ConfirmModal
          title={pendingConfirm.title ?? 'Are you sure?'}
          message={pendingConfirm.message ?? `${pendingConfirm.label} will be changed.`}
          confirmLabel={pendingConfirm.confirmLabel ?? 'Confirm'}
          isDestructive
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => {
            const { confirm } = pendingConfirm
            setPendingConfirm(null)
            void confirm()
          }}
        />
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- the check */

/**
 * What a Check found.
 *
 * Three outcomes rather than two, because "the cloud refused" and "there was nobody to ask" are
 * different news and the second one used to be reported as the first. `not-enabled` is core
 * declining to check a Provider that is switched off — the honest reading of an empty report.
 */
type CheckOutcome =
  | { kind: 'report'; report: CredentialCheckReport }
  | { kind: 'not-enabled' }
  | { kind: 'unreachable'; detail: string }

/**
 * The Check, and — once it has said yes — the small link that repeats it.
 *
 * WHY THE BIG BUTTON GOES AWAY WHEN THE ANSWER IS YES. "Save and turn on <cloud>" runs the check
 * itself and prints "<cloud> is ready" underneath. Leaving a full-sized "Check <cloud>" button
 * below that green line reads as "did I not just do this?" — a first-contact test pressed it
 * again to find out, which is the question a screen should not be asking. So a successful check
 * folds the control into a "Check again" text link beside its own result, which is the size of
 * the job it is still there for: proving the cloud again after something has changed.
 *
 * NOT READY, AND THE BUTTON STAYS. That is when it is the thing the reader most needs: they have
 * fixed the credential in a terminal and want to ask again. The same control serves the Done
 * step, so the two screens cannot disagree about this.
 */
function CheckControl({
  displayName,
  checking,
  outcome,
  onCheck,
  testId,
}: {
  displayName: string
  checking: boolean
  outcome: CheckOutcome | null
  onCheck: () => void
  testId: string
}) {
  const verified = outcome?.kind === 'report' && outcome.report.status === 'verified'
  return (
    <div className="wizard-check" data-check={testId}>
      {!verified && (
        <button type="button" className="btn-secondary" disabled={checking} onClick={onCheck} data-testid={`check-${testId}`}>
          {checking ? 'Checking…' : `Check ${displayName}`}
        </button>
      )}
      {checking && (
        <p className="hint" role="status">
          Asking {displayName}…
        </p>
      )}
      {!checking && outcome && (
        <div data-testid={`check-result-${testId}`} data-check-status={statusOf(outcome)}>
          {outcome.kind === 'report' && outcome.report.status === 'verified' && (
            <p className="wizard-ready" role="status">
              <strong>{displayName} is ready.</strong> Rocky Surf can create Servers on it.{' '}
              <button type="button" className="link-button" onClick={onCheck} data-testid={`check-${testId}`}>
                Check again
              </button>
            </p>
          )}
          {outcome.kind === 'report' && outcome.report.status === 'failed' && (
            <>
              <p>
                <strong>{displayName} is not ready yet.</strong>
              </p>
              {/* The cloud's own words, in the component the New Server page prints them with, so
                  a rejected credential reads the same wherever the reader meets it. */}
              <ProviderFailure
                {...(outcome.report.code ? { code: outcome.report.code } : {})}
                {...(outcome.report.providerCode ? { providerCode: outcome.report.providerCode } : {})}
                detail={outcome.report.detail}
              />
            </>
          )}
          {outcome.kind === 'not-enabled' && (
            <p>
              <strong>{displayName} is not switched on yet.</strong> Save the settings above and it
              will be.
            </p>
          )}
          {outcome.kind === 'unreachable' && <p className="error">{outcome.detail}</p>}
        </div>
      )}
    </div>
  )
}

function statusOf(outcome: CheckOutcome): string {
  if (outcome.kind === 'report') return outcome.report.status
  return outcome.kind
}

/** A command the reader types, with a button that puts it on their clipboard. */
function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="wizard-command">
      <code>{command}</code>
      <button
        type="button"
        className="link-button"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(command)
            .then(() => setCopied(true))
            .catch(() => setCopied(false))
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  )
}

/* ------------------------------------------------------------------------------- done */

/**
 * WHAT IS ACTUALLY SET UP, cloud by cloud.
 *
 * The step that used to say "put the credentials in place the way the previous step described",
 * on a screen with no way back to that step. It now reports the real state of every cloud that is
 * switched on, offers the Check that proves it, and has a Back button to the screen where it is
 * fixed. Nothing here refers to a previous screen.
 *
 * IT ASKS THE CLOUDS ON ARRIVAL rather than waiting to be asked. What it replaced said "this page
 * will say ready the next time you open it" — it made the reader leave, restart Rocky Surf and
 * come back to find out whether they had succeeded. `validateCredentials()` is the cheapest
 * authenticated call each Provider has, so the wizard spends one per cloud and answers the
 * question itself. The button on each row is for after a fix, which no first render can cover.
 *
 * AND THE HEADING IS THE SAME VERDICT AS THE ROWS. `setup.complete` is core's answer to "did a
 * Provider BUILD", which for a chain-auth cloud is true before anybody has proved a credential —
 * so using it here would have put "You are ready" directly above a row saying AWS is not.
 */
function DoneStep({
  setup,
  refreshSetup,
  onBack,
  onFinish,
}: {
  setup: SetupState | null
  refreshSetup: () => Promise<void>
  onBack: () => void
  onFinish: () => void
}) {
  const enabled = setup?.providers.filter((p) => p.enabled) ?? []
  const [outcomes, setOutcomes] = useState<Record<string, CheckOutcome>>({})
  const [checking, setChecking] = useState<Record<string, boolean>>({})

  const runCheck = useCallback(
    async (id: string) => {
      setChecking((prev) => ({ ...prev, [id]: true }))
      try {
        const { checked } = await checkProviderCredentials([id])
        const row = checked.find((entry) => entry.provider === id)
        setOutcomes((prev) => ({ ...prev, [id]: row ? { kind: 'report', report: row } : { kind: 'not-enabled' } }))
      } catch (err) {
        setOutcomes((prev) => ({
          ...prev,
          [id]: {
            kind: 'unreachable',
            detail: err instanceof ApiError ? err.detail : 'Rocky Surf could not run the check',
          },
        }))
      } finally {
        setChecking((prev) => ({ ...prev, [id]: false }))
        await refreshSetup()
      }
    },
    [refreshSetup],
  )

  /* One pass when this step opens. Keyed on the JOINED ids rather than on the array, which is a
     new object after every refresh — and a refresh is what each check ends with. */
  const ids = enabled.map((p) => p.id).join(',')
  useEffect(() => {
    for (const id of ids.split(',').filter(Boolean)) void runCheck(id)
  }, [ids, runCheck])

  const verified = (id: string) => {
    const outcome = outcomes[id]
    return outcome?.kind === 'report' && outcome.report.status === 'verified'
  }
  const anyVerified = enabled.some((p) => verified(p.id))
  const stillAsking = enabled.some((p) => checking[p.id] || outcomes[p.id] === undefined)
  const heading = anyVerified
    ? 'You are ready'
    : stillAsking && enabled.length > 0
      ? 'Checking your clouds'
      : 'Not ready yet'

  return (
    <section>
      <h2>{heading}</h2>

      {enabled.length === 0 ? (
        <p data-testid="none-on">
          No cloud is switched on, so Rocky Surf cannot create a Server yet. Go back a step to set
          one up — it takes a few minutes and nothing is billed until you create something.
        </p>
      ) : (
        <>
          <p>
            {anyVerified
              ? 'Here is where each cloud you turned on stands. Create your first Server whenever you like.'
              : 'Here is where each cloud you turned on stands, as the cloud itself has just answered it.'}
          </p>
          <ul className="wizard-summary" data-testid="cloud-summary">
            {enabled.map((provider) => (
              <li
                key={provider.id}
                data-summary-cloud={provider.id}
                data-summary-ready={verified(provider.id) || undefined}
              >
                <p>
                  <strong>{provider.displayName}</strong> —{' '}
                  {verdict(provider, outcomes[provider.id] ?? null, checking[provider.id] ?? false)}
                </p>
                {/* The composition root's own sentence about why it did not load: it names the
                    variable or the field to fix, which no paraphrase of it would. */}
                {!provider.loaded && provider.unavailableReason && (
                  <p className="hint" data-summary-reason={provider.id}>
                    {provider.unavailableReason}
                  </p>
                )}
                <CheckControl
                  displayName={provider.displayName}
                  checking={checking[provider.id] ?? false}
                  outcome={outcomes[provider.id] ?? null}
                  onCheck={() => void runCheck(provider.id)}
                  testId={`done-${provider.id}`}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="wizard-actions">
        <button type="button" className="btn-secondary" onClick={onBack} data-testid="back">
          Back
        </button>
        <button type="button" className="btn-primary" onClick={onFinish} data-testid="finish">
          Go to the dashboard
        </button>
      </div>
    </section>
  )
}

/**
 * One word for where a cloud stands, preferring what the cloud itself said.
 *
 * `loaded` is what this process managed to BUILD, which for a chain-auth cloud is true long before
 * anybody has proved a credential. So the Check's answer wins whenever there is one, and `loaded`
 * is the fallback until it arrives.
 */
function verdict(provider: ProviderSetupState, outcome: CheckOutcome | null, checking: boolean): string {
  if (outcome?.kind === 'report') return outcome.report.status === 'verified' ? 'ready' : 'not ready'
  if (outcome?.kind === 'not-enabled') return 'not switched on'
  if (checking) return 'checking…'
  return provider.loaded ? 'switched on' : 'not ready'
}

/*
 * PROVIDER-ID LITERALS BELOW ARE SANCTIONED — and ONLY here.
 *
 * The zero-conditionals rule stands everywhere else in the SPA, and there is a grep test that
 * enforces it (`CreateServerPage.test.tsx`, "acceptance criteria a reviewer can grep for"). This
 * file is the documented exception, by ruling on rockysurf-hzi7.2 and unchanged by the #474
 * rebuild:
 *
 *  - **Onboarding is inherently provider-specific.** "How do I sign in to my cloud from a
 *    terminal?" has a different answer per cloud, and the honest version of that sentence names
 *    the cloud and its own command. A capability flag cannot carry `gcloud auth
 *    application-default login`.
 *  - **Core's own config schema already names these clouds** — the same friction recorded in
 *    `packages/core/src/config/schema.ts`.
 *
 * WHAT THE REBUILD REMOVED FROM THIS HELPER, and why the exception is narrower than it was: the
 * old version also wrote per-cloud sentences about which SETTINGS to fill in and where. Those are
 * gone, because the fields are now drawn from the server's inventory with the Provider's own
 * labels, so nothing here has to name a field or risk naming a stale one. What is left is only
 * what happens outside the browser, which is the part no declaration can carry.
 *
 * THE LONG-TERM FIX is still the one sketched in that schema.ts comment: a Provider declaring its
 * own auth-path prose alongside its settings, so even this helper dies. `WizardPage.test.tsx`
 * pins the boundary meanwhile, so the exception cannot quietly widen.
 */

interface GuideStep {
  text: ReactNode
  /** A literal the reader types or copies, rendered monospace per the product's type rule. */
  command?: string
}

interface CloudGuide {
  steps: GuideStep[]
  /**
   * A narrower grant than the one that already works.
   *
   * NEVER A PREREQUISITE, and worded so it cannot be read as one: the minimum working credential
   * is always step 1, and this is an improvement on it for reduced blast radius.
   */
  recommended?: { text: string; anchor: string }
}

function cloudGuide(id: string): CloudGuide {
  if (id === 'hetzner') {
    return {
      steps: [
        {
          text: 'In the Hetzner Cloud console, open your project, then Security, then API tokens, then Generate API token. Give it Read & Write and copy the token — Hetzner shows it once.',
        },
        {
          text: 'Stop Rocky Surf with Ctrl-C in the terminal it is running in. Then set the token in that terminal, putting your own token after the = sign:',
          command: 'export HETZNER_TOKEN=your-token-here',
        },
        {
          text: 'Start Rocky Surf again in the same terminal, and open this page again. The token stays in your terminal — Rocky Surf reads it and never writes it down.',
        },
      ],
    }
  }
  if (id === 'digitalocean') {
    return {
      steps: [
        {
          text: 'At cloud.digitalocean.com, open API, then Tokens, then Generate New Token, with Write scope. Copy it — DigitalOcean shows it once.',
        },
        {
          text: 'Stop Rocky Surf with Ctrl-C in the terminal it is running in. Then set the token in that terminal, putting your own token after the = sign:',
          command: 'export DIGITALOCEAN_TOKEN=your-token-here',
        },
        {
          text: 'Start Rocky Surf again in the same terminal, and open this page again. The token stays in your terminal — Rocky Surf reads it and never writes it down.',
        },
      ],
    }
  }
  if (id === 'aws') {
    return {
      steps: [
        {
          text: 'Sign in to AWS in the terminal, the way you normally would. If you use IAM Identity Center, that is one command; if you use an access key, aws configure asks for it.',
          command: 'aws sso login',
        },
        {
          text: 'Check it worked. This prints the account you are signed in as; if it does, Rocky Surf can use exactly the same credentials, and there is nothing to paste anywhere.',
          command: 'aws sts get-caller-identity',
        },
        {
          text: 'If that only works with a named profile — if you have to say --profile something — put that name in the Profile box below. Leave the box empty otherwise.',
        },
      ],
      recommended: {
        text:
          'Any AWS identity that can manage EC2 works, and an administrator profile is the quickest way to try it. A dedicated role that Rocky Surf assumes limits what it can touch in your AWS account.',
        anchor: '/help#aws',
      },
    }
  }
  if (id === 'azure') {
    return {
      steps: [
        {
          text: 'Sign in to Azure in the terminal. Signing in as an Owner or Contributor of the subscription works with no further setup.',
          command: 'az login',
        },
        {
          text: 'Register the two resource provider namespaces, if this subscription has never used them. A new subscription has not, and it takes a minute or two. Running it again when they are already registered does nothing.',
          command: 'az provider register --namespace Microsoft.Compute && az provider register --namespace Microsoft.Network',
        },
        {
          text: 'Create a resource group for Rocky Surf to put its virtual machines in. Rocky Surf never creates one itself. Put the name and the Azure region you choose here into the Resource group and Location boxes below.',
          command: 'az group create --name rocky-surf-rg --location eastus',
        },
        {
          text: 'Print your subscription id, and paste it into the Subscription id box below.',
          command: 'az account show --query id --output tsv',
        },
      ],
      recommended: {
        text:
          'A dedicated Azure service principal with the two roles it needs, instead of your own sign-in, limits what Rocky Surf can touch in the subscription.',
        anchor: '/help#azure',
      },
    }
  }
  if (id === 'gcp') {
    return {
      steps: [
        {
          text: 'Sign in for applications on this machine. This is not the same command as gcloud auth login: it stores the credentials that programs like Rocky Surf read.',
          command: 'gcloud auth application-default login',
        },
        {
          text: 'Print the project you are working in, and paste it into the Project id box below. Rocky Surf never guesses a project.',
          command: 'gcloud config get-value project',
        },
        {
          text: 'Make sure the Compute Engine API is switched on for that project. Running this once is enough, and it is a no-op if it already is.',
          command: 'gcloud services enable compute.googleapis.com',
        },
      ],
      recommended: {
        text:
          'A dedicated Google Cloud service account with the Compute Instance Admin and Service Account User roles, instead of your own sign-in, limits what Rocky Surf can touch in the project.',
        anchor: '/help#gcp',
      },
    }
  }
  return {
    steps: [
      {
        text: 'This cloud signs in with credentials your own machine holds, outside Rocky Surf. Fill in its settings below, save, and press Check — it will say what it is still missing.',
      },
    ],
  }
}
