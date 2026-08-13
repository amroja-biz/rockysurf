import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { useAuth } from '../contexts/AuthContext'
import {
  ApiError,
  getSetupState,
  saveProviderCredential,
  type ProviderSetupState,
  type SetupState,
} from '../lib/api'

/**
 * The first-run wizard (rockysurf-hzi7.2).
 *
 * This is the surface the stranger test grades, so every step says what it is for in plain
 * words and every step can be skipped. Someone who configured everything in
 * `rockysurf.config.yaml` should never meet it at all — that is what `SetupGate` below is for.
 *
 * WHAT THE WIZARD DOES NOT DO. It never claims success it cannot verify. Core validates a
 * pasted credential against the provider before storing it, and reports back whether the
 * installation is actually able to create a server; when it is not, the last step says so and
 * says what remains, rather than dropping a stranger onto a dashboard that will fail at their
 * first click.
 */

const DISMISSED_KEY = 'rockysurf.wizard.dismissed'

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

export function useSetupState(): { setup: SetupState | null; loading: boolean; refresh: () => Promise<void> } {
  const [setup, setSetup] = useState<SetupState | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      setSetup(await getSetupState())
    } catch {
      // An unreachable or unauthenticated core is not the wizard's problem to report; the
      // route guards already handle it. Treat it as "nothing to prompt about".
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
 * Wraps the dashboard rather than every route: the redirect should happen where a user lands,
 * not fight them if they deliberately navigate elsewhere.
 */
export function SetupGate({ children }: { children: React.ReactNode }) {
  const { setup, loading } = useSetupState()

  if (loading) return <p>Loading…</p>
  if (setup && setup.needsProvider && !wasDismissed()) return <Navigate to="/setup" replace />
  return <>{children}</>
}

type StepId = 'welcome' | 'account' | 'provider' | 'done'

const STEPS: { id: StepId; title: string }[] = [
  { id: 'welcome', title: 'Welcome' },
  { id: 'account', title: 'Your account' },
  { id: 'provider', title: 'Add a cloud' },
  { id: 'done', title: 'Done' },
]

export function WizardPage() {
  const { user, isAuthenticated, isLoading } = useAuth()
  const navigate = useNavigate()
  const { setup, loading, refresh } = useSetupState()
  const [step, setStep] = useState<StepId>('welcome')

  if (isLoading || loading) return <p>Loading…</p>
  // The wizard runs AFTER sign-in, which is what makes "the password printed at boot works"
  // a fact the user has already proven rather than a claim this page has to make.
  if (!isAuthenticated) return <Navigate to="/login" replace />

  const index = STEPS.findIndex((s) => s.id === step)

  function skipAll() {
    dismiss()
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
            Rocky Surf gives you a persistent dev box on your own cloud, with your coding agents
            already installed. Three short steps and you are done — you can skip any of them and
            finish later from Settings.
          </p>
          <button type="button" onClick={() => setStep('account')} data-testid="next">
            Get started
          </button>
        </section>
      )}

      {step === 'account' && (
        <section>
          <h2>Your account</h2>
          <p>
            You are signed in as <strong>{user?.username}</strong>, so the password printed in
            your terminal on first boot is working. That password is the only way in — it was
            shown once and is not recoverable, so keep it somewhere safe.
          </p>
          <p className="hint">
            To change it, set <code>ROCKYSURF_ADMIN_PASSWORD</code> and restart.
          </p>
          <button type="button" onClick={() => setStep('provider')} data-testid="next">
            Next
          </button>
        </section>
      )}

      {step === 'provider' && (
        <ProviderStep
          setup={setup}
          onSaved={async () => {
            await refresh()
            setStep('done')
          }}
          onSkip={() => setStep('done')}
        />
      )}

      {step === 'done' && <DoneStep setup={setup} onFinish={skipAll} />}
    </main>
  )
}

function ProviderStep({
  setup,
  onSaved,
  onSkip,
}: {
  setup: SetupState | null
  onSaved: () => Promise<void>
  onSkip: () => void
}) {
  const providers = setup?.providers ?? []
  const editable = providers.filter((p) => !p.readOnlyReason)
  // No hardcoded fallback: defaulting to a named provider would invent one that core never
  // reported, and it is the kind of literal that quietly reintroduces provider knowledge into
  // the logic. An empty selection is rendered as "nothing to configure" below.
  const [selected, setSelected] = useState<string>(editable[0]?.id ?? providers[0]?.id ?? '')
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const current = providers.find((p) => p.id === selected)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setSaving(true)
    try {
      await saveProviderCredential(selected, token)
      await onSaved()
    } catch (err) {
      // VERBATIM. Core passes the provider's own message through, and it is the one string
      // that distinguishes a read-only token from a wrong one, or a sold-out region from a
      // typo. Rewriting it into house prose would throw that away.
      setError(err instanceof ApiError ? err.detail : 'Could not save that credential')
    } finally {
      setSaving(false)
    }
  }

  if (providers.length === 0) {
    return (
      <section>
        <h2>Add a cloud</h2>
        <p data-testid="no-providers">
          This installation reports no configurable providers, so there is nothing to fill in
          here. Add one in <code>rockysurf.config.yaml</code> and restart.
        </p>
        <button type="button" onClick={onSkip} data-testid="skip-step">
          Continue
        </button>
      </section>
    )
  }

  return (
    <section>
      <h2>Add a cloud</h2>
      <p>
        Rocky Surf creates servers on your cloud account, so it needs one set of credentials.
        Nothing is created until you ask for a server.
      </p>

      <form onSubmit={onSubmit}>
        <label htmlFor="provider">Provider</label>
        <select
          id="provider"
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value)
            setError(null)
          }}
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>

        {current?.readOnlyReason ? (
          <p className="read-only" data-testid="read-only">
            <strong>Already configured.</strong> {current.readOnlyReason}
          </p>
        ) : (
          <>
            <label htmlFor="token">{tokenLabel(selected)}</label>
            <input
              id="token"
              name="token"
              type="password"
              autoComplete="off"
              autoFocus
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={tokenPlaceholder(selected)}
            />
            <p className="hint">{tokenHint(selected)}</p>
            <button type="submit" disabled={saving || token.trim() === ''} data-testid="save-credential">
              {saving ? 'Checking…' : 'Check and save'}
            </button>
          </>
        )}
      </form>

      {error && (
        <p role="alert" className="error" data-testid="provider-error">
          {error}
        </p>
      )}

      <button type="button" onClick={onSkip} data-testid="skip-step">
        Skip for now
      </button>
    </section>
  )
}

function DoneStep({ setup, onFinish }: { setup: SetupState | null; onFinish: () => void }) {
  const ready = setup?.complete ?? false
  const stored = setup?.providers.filter((p) => p.configured) ?? []
  const pending = stored.filter((p) => !p.loaded || !p.enabled)

  return (
    <section>
      <h2>{ready ? 'You are ready' : 'Almost there'}</h2>

      {ready ? (
        <p>A cloud is configured and loaded. Create your first server whenever you like.</p>
      ) : pending.length > 0 ? (
        <>
          <p data-testid="pending-note">
            Your credential is saved and encrypted. To finish, enable{' '}
            <strong>{pending.map((p) => p.displayName).join(', ')}</strong> in{' '}
            <code>rockysurf.config.yaml</code> and restart Rocky Surf — providers are loaded at
            startup.
          </p>
          <p className="hint">
            Restarting is not a workaround for a missing feature so much as the current shape:
            core never imports a cloud SDK itself, so a provider becomes usable when the process
            that owns it starts.
          </p>
        </>
      ) : (
        <p data-testid="no-provider-note">
          No cloud is configured yet. You can still look around; adding one from Settings, or in{' '}
          <code>rockysurf.config.yaml</code>, is what makes creating a server possible.
        </p>
      )}

      <button type="button" onClick={onFinish} data-testid="finish">
        Go to the dashboard
      </button>
    </section>
  )
}

/*
 * PROVIDER-ID LITERALS BELOW ARE SANCTIONED — and ONLY here.
 *
 * The zero-conditionals rule stands everywhere else in the SPA, and there is a grep test that
 * enforces it (`CreateServerPage.test.tsx`, "acceptance criteria a reviewer can grep for").
 * This file is the documented exception, by ruling on rockysurf-hzi7.2:
 *
 *  - **Onboarding is inherently provider-specific UI.** "Where do I find my token?" has a
 *    different answer per cloud, and the honest version of that sentence names the cloud. A
 *    capability flag cannot carry "Hetzner Cloud console → Security → API tokens".
 *  - **Core's own config schema already names these providers** — the same friction recorded
 *    in `packages/core/src/config/schema.ts`: the dependency lint forbids core importing a
 *    provider package, and the types-only SDK cannot export a zod schema, so core describes
 *    the provider sections itself.
 *
 * The literals are confined to the three copy helpers below. Nothing above them branches on a
 * provider id: the step flow, the read-only rule and the done-state all read `SetupState` from
 * core. `WizardPage.test.tsx` pins that boundary so the exception cannot quietly widen.
 *
 * THE LONG-TERM FIX, already sketched in that schema.ts comment: a registration-time handoff
 * where each provider package exports its own config schema and field metadata (label,
 * placeholder, help text, secret-ness), core validates the raw section with it at the point it
 * constructs the provider, and this wizard renders the form FROM that metadata. When that
 * lands, every literal below dies and this exception can be withdrawn rather than grandfathered.
 */

function tokenLabel(id: string): string {
  if (id === 'aws') return 'AWS credentials'
  if (id === 'azure') return 'Azure credentials'
  return 'API token'
}

function tokenPlaceholder(id: string): string {
  if (id === 'hetzner') return 'e.g. LRK9c…'
  if (id === 'aws') return 'AWS profile name'
  if (id === 'azure') return 'set in your environment, not here'
  return ''
}

function tokenHint(id: string): string {
  if (id === 'hetzner') {
    return 'Hetzner Cloud console → your project → Security → API tokens. It needs Read & Write.'
  }
  if (id === 'aws') {
    return 'Rocky Surf reads AWS credentials from the standard chain (AWS_PROFILE, environment, instance role). Set the profile and region in rockysurf.config.yaml — see docs/providers/aws.md for the minimal IAM policy.'
  }
  if (id === 'azure') {
    return 'Rocky Surf reads Azure credentials from AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET, from a managed identity, or from `az login` — never from a file. Set subscriptionId, resourceGroup and sshAllowedCidr in rockysurf.config.yaml, and create the resource group first with `az group create`. See docs/providers/azure.md for the least-privilege role.'
  }
  return 'The credential this provider uses. It is encrypted before it is stored.'
}
