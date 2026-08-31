import { useCallback, useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { useAuth } from '../contexts/AuthContext'
import { ApiError, enableProvider, getSetupState, type ProviderSetupState, type SetupState } from '../lib/api'

/**
 * The first-run wizard (rockysurf-hzi7.2, reshaped by issue #280).
 *
 * This is the surface the stranger test grades, so every step says what it is for in plain
 * words and every step can be skipped. Someone who configured everything in
 * `rockysurf.config.yaml` should never meet it at all — that is what `SetupGate` below is for.
 *
 * WHAT THE WIZARD DOES NOT DO, by owner ruling (issue #280): it never collects a credential.
 * There is no password field, no token box, nothing to paste anywhere on this page. The
 * provider step asks WHICH clouds you want and switches them on — the same config edit
 * Settings makes — and each cloud's credentials come from your own auth path: an environment
 * variable for Hetzner (never stored; Rocky Surf only ever detects that it is set), and the
 * standard chains for AWS, Azure and GCP, where there is nothing to type at all.
 *
 * THE SET-VARIABLE-AND-RESTART LOOP. Enabling a token cloud cannot finish in one sitting: an
 * environment variable cannot appear inside a process that is already running, so the wizard
 * says exactly what to export, remembers that it is waiting (`PENDING_KEY`), and when the user
 * restarts and comes back it detects the loaded provider and continues the flow — rather than
 * stranding them on a dashboard that fails at the first create.
 */

const DISMISSED_KEY = 'rockysurf.wizard.dismissed'

/**
 * The cloud the wizard is waiting on across a restart. Local storage on purpose: the wait is a
 * fact about THIS browser's walkthrough, not about the installation — core already reports the
 * real state, and this key only decides whether to bring the user back to it.
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
 *
 * The PENDING half is the return leg of the set-variable-and-restart loop (issue #280): a user
 * who enabled a token cloud, exported the variable and restarted lands here first, and the
 * wizard — not the dashboard — is where "it worked" or "not detected yet" is said out loud.
 */
export function SetupGate({ children }: { children: React.ReactNode }) {
  const { setup, loading } = useSetupState()

  if (loading) return <p>Loading…</p>
  if (setup && (setup.needsProvider || pendingCloud() !== null) && !wasDismissed()) {
    return <Navigate to="/setup" replace />
  }
  return <>{children}</>
}

type StepId = 'welcome' | 'account' | 'provider' | 'done'

const STEPS: { id: StepId; title: string }[] = [
  { id: 'welcome', title: 'Welcome' },
  { id: 'account', title: 'Your account' },
  { id: 'provider', title: 'Choose your clouds' },
  { id: 'done', title: 'Done' },
]

export function WizardPage() {
  const { user, isAuthenticated, isLoading } = useAuth()
  const navigate = useNavigate()
  const { setup, loading, refresh } = useSetupState()
  // A walkthrough that is waiting on a restart re-opens on the step that is waiting.
  const [step, setStep] = useState<StepId>(() => (pendingCloud() !== null ? 'provider' : 'welcome'))

  if (isLoading || loading) return <p>Loading…</p>
  // The wizard runs AFTER sign-in, which is what makes "the password printed at boot works"
  // a fact the user has already proven rather than a claim this page has to make.
  if (!isAuthenticated) return <Navigate to="/login" replace />

  const index = STEPS.findIndex((s) => s.id === step)

  function skipAll() {
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
        <ProviderStep setup={setup} refresh={refresh} onContinue={() => setStep('done')} />
      )}

      {step === 'done' && <DoneStep setup={setup} onFinish={skipAll} />}
    </main>
  )
}

function ProviderStep({
  setup,
  refresh,
  onContinue,
}: {
  setup: SetupState | null
  refresh: () => Promise<void>
  onContinue: () => void
}) {
  const providers = setup?.providers ?? []
  const pending = pendingCloud()
  // No hardcoded fallback: defaulting to a named provider would invent one that core never
  // reported, and it is the kind of literal that quietly reintroduces provider knowledge into
  // the logic. An empty selection is rendered as "nothing to configure" below.
  const [selected, setSelected] = useState<string>(pending ?? providers[0]?.id ?? '')
  const [error, setError] = useState<string | null>(null)
  const [enabling, setEnabling] = useState(false)

  const current = providers.find((p) => p.id === selected)
  const awaited = providers.find((p) => p.id === pending)

  // THE RETURN LEG (issue #280): the user exported the variable, restarted, and came back. If
  // the cloud we were waiting on is loaded now, say so and stop waiting; the flow continues
  // instead of stranding them.
  const detected = awaited !== undefined && awaited.loaded
  useEffect(() => {
    if (detected) setPendingCloud(null)
  }, [detected])

  async function turnOn(id: string) {
    setError(null)
    setEnabling(true)
    try {
      const next = await enableProvider(id)
      const enabledNow = next.providers.find((p) => p.id === id)
      // Not loaded yet means the auth path still has to happen outside this page — remember
      // that this walkthrough is waiting, so a restart brings the user back here.
      if (enabledNow && !enabledNow.loaded) setPendingCloud(id)
      await refresh()
    } catch (err) {
      // VERBATIM. Core's message names the field or the file, and rewriting it into house
      // prose would throw that away.
      setError(err instanceof ApiError ? err.detail : 'Could not switch that cloud on')
    } finally {
      setEnabling(false)
    }
  }

  if (providers.length === 0) {
    return (
      <section>
        <h2>Choose your clouds</h2>
        <p data-testid="no-providers">
          This installation reports no configurable providers, so there is nothing to choose
          here. Add one in <code>rockysurf.config.yaml</code> and restart.
        </p>
        <button type="button" onClick={onContinue} data-testid="skip-step">
          Continue
        </button>
      </section>
    )
  }

  return (
    <section>
      <h2>Choose your clouds</h2>
      <p>
        Pick the clouds Rocky Surf may create servers on, and switch them on. Your credentials
        stay yours: each cloud authenticates through its own path, described below, and{' '}
        <strong>Rocky Surf stores no cloud credentials</strong> — there is nothing to paste on
        this page. Nothing is created until you ask for a server.
      </p>

      {detected && (
        <p className="wizard-detected" data-testid="detected">
          <strong>{awaited.displayName} is on and ready.</strong>
          {awaited.envVar ? ` ${awaited.envVar} was detected in the environment.` : ''} Continue
          whenever you like.
        </p>
      )}

      <label htmlFor="provider">Cloud</label>
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
            {p.enabled ? (p.loaded ? ' — on and ready' : ' — on, one step left') : ''}
          </option>
        ))}
      </select>

      {current && <CloudPanel provider={current} enabling={enabling} onTurnOn={() => void turnOn(current.id)} onCheckAgain={() => void refresh()} />}

      {error && (
        <p role="alert" className="error" data-testid="provider-error">
          {error}
        </p>
      )}

      <button type="button" onClick={onContinue} data-testid="skip-step">
        Continue
      </button>
    </section>
  )
}

/**
 * One cloud's status and its inline setup instructions.
 *
 * The LOGIC here is generic — enabled/loaded/unavailableReason all come from core — and only
 * the words are per-cloud, from the sanctioned copy helpers at the bottom of this file.
 */
function CloudPanel({
  provider,
  enabling,
  onTurnOn,
  onCheckAgain,
}: {
  provider: ProviderSetupState
  enabling: boolean
  onTurnOn: () => void
  onCheckAgain: () => void
}) {
  const ready = provider.enabled && provider.loaded

  return (
    <div className="wizard-cloud" data-testid="cloud-panel">
      {ready ? (
        <p data-testid="cloud-ready">
          <strong>{provider.displayName} is on and ready.</strong>
          {provider.envVar ? ` Its credential comes from ${provider.envVar} in the environment.` : ''}
        </p>
      ) : (
        <>
          <Instructions id={provider.id} />
          {provider.enabled ? (
            <>
              <p data-testid="cloud-waiting">
                <strong>{provider.displayName} is switched on</strong> — it will be ready once
                its credentials are in place, as described above.
              </p>
              {provider.unavailableReason && (
                // The composition root's own words: they name the variable or field to fix.
                <p className="hint" data-testid="cloud-reason">
                  {provider.unavailableReason}
                </p>
              )}
              <button type="button" onClick={onCheckAgain} data-testid="check-again">
                Check again
              </button>
            </>
          ) : (
            <button type="button" onClick={onTurnOn} disabled={enabling} data-testid="turn-on">
              {enabling ? 'Switching on…' : `Turn on ${provider.displayName}`}
            </button>
          )}
        </>
      )}
    </div>
  )
}

/** Renders one cloud's setup instructions from the copy helpers below. */
function Instructions({ id }: { id: string }) {
  const steps = cloudSetupSteps(id)
  return (
    <ol className="wizard-instructions" data-testid="cloud-instructions">
      {steps.map((step, i) => (
        <li key={i}>
          {step.text}
          {step.command && (
            <>
              {' '}
              <code>{step.command}</code>
            </>
          )}
        </li>
      ))}
    </ol>
  )
}

function DoneStep({ setup, onFinish }: { setup: SetupState | null; onFinish: () => void }) {
  const ready = setup?.complete ?? false
  const waiting = setup?.providers.filter((p) => p.enabled && !p.loaded) ?? []

  return (
    <section>
      <h2>{ready ? 'You are ready' : 'Almost there'}</h2>

      {ready ? (
        <p>A cloud is on and ready. Create your first server whenever you like.</p>
      ) : waiting.length > 0 ? (
        <>
          <p data-testid="pending-note">
            You switched on <strong>{waiting.map((p) => p.displayName).join(', ')}</strong>. To
            finish, put its credentials in place the way the previous step described — for a
            token cloud that means exporting the environment variable and restarting Rocky Surf.
            This page will say ready the next time you open it.
          </p>
          <p className="hint">
            Rocky Surf never holds these credentials itself: a provider becomes usable when the
            process that owns it starts with them in reach.
          </p>
        </>
      ) : (
        <p data-testid="no-provider-note">
          No cloud is switched on yet. You can still look around; turning one on from Settings,
          or in <code>rockysurf.config.yaml</code>, is what makes creating a server possible.
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
 *  - **Onboarding is inherently provider-specific UI.** "How does my cloud authenticate?" has
 *    a different answer per cloud, and the honest version of that sentence names the cloud. A
 *    capability flag cannot carry "export HETZNER_TOKEN and restart".
 *  - **Core's own config schema already names these providers** — the same friction recorded
 *    in `packages/core/src/config/schema.ts`: the dependency lint forbids core importing a
 *    provider package, and the types-only SDK cannot export a zod schema, so core describes
 *    the provider sections itself.
 *
 * The literals are confined to the copy helper below. Nothing above it branches on a provider
 * id: the step flow, the enable action, the waiting/detected states and the done-state all
 * read `SetupState` from core. `WizardPage.test.tsx` pins that boundary so the exception
 * cannot quietly widen.
 *
 * THE LONG-TERM FIX, already sketched in that schema.ts comment: a registration-time handoff
 * where each provider package exports its own config schema and field metadata (labels, help
 * text, auth-path prose), core validates the raw section with it at the point it constructs
 * the provider, and this wizard renders the instructions FROM that metadata. When that lands,
 * every literal below dies and this exception can be withdrawn rather than grandfathered.
 */

interface SetupStep {
  text: string
  /** A literal the user types or copies, rendered monospace per the product's type rule. */
  command?: string
}

function cloudSetupSteps(id: string): SetupStep[] {
  if (id === 'hetzner') {
    return [
      {
        text: 'Create an API token in the Hetzner Cloud console — your project → Security → API tokens. It needs Read & Write.',
      },
      {
        text: 'Stop Rocky Surf (Ctrl-C) and start it again with the token in its environment. It stays in your environment — Rocky Surf never stores it:',
        command: 'export HETZNER_TOKEN=<your token>  # then start Rocky Surf again',
      },
      {
        text: 'Come back to this page. Rocky Surf detects the variable and this step finishes itself.',
      },
    ]
  }
  if (id === 'aws') {
    return [
      {
        text: 'Rocky Surf reads AWS credentials from the standard chain — AWS_PROFILE, environment variables, or an instance role. There is nothing to type here.',
      },
      {
        text: 'Set the region and sshAllowedCidr in rockysurf.config.yaml or on the Settings page — see docs/providers/aws.md for the minimal IAM policy.',
      },
    ]
  }
  if (id === 'azure') {
    return [
      {
        text: 'Rocky Surf reads Azure credentials from AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET, from a managed identity, or from az login. There is nothing to type here.',
      },
      {
        text: 'Set subscriptionId, resourceGroup and sshAllowedCidr in rockysurf.config.yaml or on the Settings page, and create the resource group first with az group create — see docs/providers/azure.md for the least-privilege role.',
      },
    ]
  }
  if (id === 'gcp') {
    return [
      {
        text: 'Rocky Surf reads Google Cloud credentials from Application Default Credentials — gcloud auth application-default login, GOOGLE_APPLICATION_CREDENTIALS, or the metadata server. There is nothing to type here.',
      },
      {
        text: 'Set projectId, zone and sshAllowedCidr in rockysurf.config.yaml or on the Settings page; projectId is required and never inferred — see docs/providers/gcp.md for the least-privilege role.',
      },
    ]
  }
  if (id === 'byo') {
    return [
      {
        text: 'Bring-your-own hosts connect over SSH with your own key — a path in providers.byo.identityFile, or the key your SSH agent already holds. There is nothing to type here.',
      },
      {
        text: 'List your hosts under providers.byo.hosts in rockysurf.config.yaml or on the Settings page.',
      },
    ]
  }
  return [
    {
      text: 'This cloud authenticates with your own credentials, outside Rocky Surf. Its options are on the Settings page.',
    },
  ]
}
