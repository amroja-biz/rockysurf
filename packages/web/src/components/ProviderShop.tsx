import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Shore } from './etched'
import { TrustBadge } from './TrustBadge'
import {
  ApiError,
  getProviderRegistry,
  installRegistryProvider,
  removePersonalProvider,
  type ProviderCapabilityAnswers,
  type ProviderRegistryView,
  type ProviderSettingSummary,
  type RegistryProvider,
} from '../lib/api'
import { SHOP_URL } from '../lib/links'

/**
 * THE PROVIDER SHELVES (ADR-0028, issue #374).
 *
 * The shop has distributed Surge Packs since ADR-0006. A provider is the other thing it can
 * distribute, and it is a heavier thing: a pack is a YAML file describing shell that runs on a
 * box you create, and a provider is a package that runs INSIDE the control plane, with its
 * database, its master key and every cloud credential in its environment. So this panel shows
 * more before anybody clicks Install, and it shows one sentence that never varies.
 *
 * THE SENTENCE COMES FROM ROCKY SURF, NOT FROM THE SHOP. `registry.trustSentence` is a constant
 * core puts on the response; there is no field for it in a registry's own document and the
 * schema refuses one. That is ADR-0006's rule about trust labels applied to a bigger payload: a
 * shop that could write this sentence could also soften it.
 *
 * WHAT THE CARD ANSWERS BEFORE AN INSTALL. What the provider is, what version, which package
 * would land on this machine, what it will ask to be configured with, and its capability
 * answers — whether machines can be stopped, whether a stopped one still bills, whether it
 * manages the SSH whitelist. Those are the facts that decide whether a provider is usable here
 * at all, and finding them out after installing would be finding them out too late.
 *
 * NOTHING IS FETCHED UNTIL THE TAB IS OPENED. `active` gates the first load, so opening the Shop
 * page for packs costs no provider fetch, and an installation off the internet renders this tab
 * with a reason rather than hanging on it.
 */

/** How a capability answer reads on the card. Facts, not adjectives (the #359 copy ruling). */
function capabilityRows(capabilities: ProviderCapabilityAnswers): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Stop and start', value: capabilities.stop ? 'Supported' : 'Not supported' },
  ]
  if (capabilities.stop) {
    rows.push({
      label: 'While stopped',
      value: capabilities.billsWhileStopped ? 'Still billed at the running rate' : 'Not billed for compute',
    })
    rows.push({
      label: 'Address after stop',
      value: capabilities.ipStableAcrossStop ? 'Kept' : 'Changes',
    })
  }
  rows.push({
    label: 'Host key',
    value: capabilities.canInjectHostKeys ? 'Placed at create time' : 'Recorded on first connection',
  })
  rows.push({
    label: 'SSH whitelist',
    value: capabilities.managesSshAccess ? 'Pushed to the cloud on save' : 'Not managed by Rocky Surf',
  })
  rows.push({
    label: 'Start-up script',
    value:
      capabilities.userDataMaxBytes > 0
        ? `Accepted, up to ${capabilities.userDataMaxBytes.toLocaleString()} bytes`
        : 'Not accepted — servers are set up over SSH',
  })
  if (capabilities.simulatedInstances) {
    rows.push({ label: 'Machines', value: 'Simulated — nothing is created at a cloud' })
  }
  return rows
}

/** The panel a provider will get in Settings, named before it exists. */
function settingsSummary(settings: ProviderSettingSummary[]): string {
  if (settings.length === 0) return 'Nothing — it takes no configuration of its own.'
  return settings.map((field) => `${field.label}${field.kind === 'secret' ? ' (a credential)' : ''}`).join(', ')
}

function ProviderCard({
  provider,
  trustSentence,
  busy,
  onInstall,
  onRemove,
}: {
  provider: RegistryProvider
  trustSentence: string
  busy: boolean
  onInstall: (provider: RegistryProvider) => void
  onRemove: (provider: RegistryProvider) => void
}): React.JSX.Element {
  const updatable = provider.installed && provider.installedVersion !== provider.version
  const installLabel = updatable
    ? `Update to ${provider.version}`
    : provider.installed
      ? 'Reinstall'
      : `Install ${provider.version}`

  return (
    <li className="provider-card" data-testid={`provider-${provider.providerId}`}>
      <div className="provider-card-head">
        <h3>{provider.name}</h3>
        <code className="provider-package">{provider.package}</code>
      </div>
      <p className="provider-description">{provider.description}</p>

      <dl className="provider-capabilities" data-testid={`provider-capabilities-${provider.providerId}`}>
        {capabilityRows(provider.capabilities).map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>

      <p className="provider-settings" data-testid={`provider-settings-${provider.providerId}`}>
        <strong>It will ask you to configure:</strong> {settingsSummary(provider.settings)}
      </p>

      {/* VERBATIM, on every listing. One string, from core, rendered as it arrives. */}
      <p className="warning provider-trust" data-testid={`provider-trust-${provider.providerId}`}>
        {trustSentence}
      </p>

      {provider.installed && (
        <p className="hint" data-testid={`provider-installed-${provider.providerId}`}>
          Installed{provider.installedVersion ? `, version ${provider.installedVersion}` : ''}.
        </p>
      )}

      <div className="provider-card-actions">
        <button type="button" className="button" disabled={busy} onClick={() => onInstall(provider)}>
          {busy ? 'Working…' : installLabel}
        </button>
        {provider.installed && (
          <button type="button" className="button secondary" disabled={busy} onClick={() => onRemove(provider)}>
            Remove
          </button>
        )}
      </div>
    </li>
  )
}

export function ProviderShop({ active, isAdmin }: { active: boolean; isAdmin: boolean }): React.JSX.Element {
  const [registry, setRegistry] = useState<ProviderRegistryView | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  /** What the last install or removal said has to happen next. Survives until the next action. */
  const [restartNotice, setRestartNotice] = useState<string | null>(null)

  const load = useCallback(
    async (options: { refresh?: boolean } = {}) => {
      setLoading(true)
      try {
        setRegistry(await getProviderRegistry(options))
        setProblem(null)
      } catch (err) {
        setRegistry(null)
        setProblem(err instanceof ApiError ? err.detail : 'Could not read the provider listing.')
      } finally {
        setLoading(false)
        setLoaded(true)
      }
    },
    [],
  )

  useEffect(() => {
    if (!active || loaded || !isAdmin) return
    void load()
  }, [active, loaded, isAdmin, load])

  async function install(provider: RegistryProvider) {
    setBusyId(provider.providerId)
    try {
      const result = await installRegistryProvider(provider.sourceName, provider.providerId)
      setRestartNotice(result.restartReason)
      toast.success(`Installed ${result.package} ${result.version}.`)
      await load({ refresh: true })
    } catch (err) {
      toast.error(err instanceof ApiError ? err.detail : 'Could not install the provider.')
    } finally {
      setBusyId(null)
    }
  }

  async function remove(provider: RegistryProvider) {
    /* The confirmation names both halves, because they are two different losses: the package
       comes off the disk, and the section that configured it goes out of the config file. */
    const confirmed = confirm(
      `Remove ${provider.name}?\n\nThis deletes ${provider.package} from the providers directory and removes the ` +
        `providers.${provider.providerId} section from the config file, including anything you configured there.`,
    )
    if (!confirmed) return
    setBusyId(provider.providerId)
    try {
      const result = await removePersonalProvider(provider.providerId)
      setRestartNotice(result.restartReason)
      toast.success(`Removed ${provider.providerId}.`)
      await load({ refresh: true })
    } catch (err) {
      toast.error(err instanceof ApiError ? err.detail : 'Could not remove the provider.')
    } finally {
      setBusyId(null)
    }
  }

  if (!isAdmin) {
    return <Shore>Providers are installed by an administrator.</Shore>
  }

  return (
    <>
      <div className="shop-section-head">
        <button
          type="button"
          className="button secondary"
          onClick={() => void load({ refresh: true })}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <p className="hint" data-testid="providers-caption">
        Providers from{' '}
        <a href={SHOP_URL} target="_blank" rel="noreferrer">
          Rocky Surf Shop
        </a>
        . A provider adds a cloud Rocky Surf can create servers on. Installing one puts a package
        under the data directory and adds a section to the config file; it is loaded at the next
        restart.
      </p>

      {registry && (
        <p className="warning" data-testid="providers-trust-sentence">
          {registry.trustSentence}
        </p>
      )}

      {restartNotice && (
        <p className="warning" data-testid="providers-restart-notice">
          {restartNotice}
        </p>
      )}

      {problem && (
        <p className="warning" data-testid="providers-problem">
          {problem}
        </p>
      )}

      {registry && !registry.enabled && (
        <p className="hint" data-testid="providers-registry-disabled">
          The registry is switched off (<code>registry.enabled: false</code>). Providers already
          installed are unaffected.
        </p>
      )}

      {registry?.shelves.length === 0 && registry.enabled && <Shore>No registry is configured.</Shore>}

      {(registry?.shelves ?? []).map((shelf) => (
        <div key={shelf.source.name} data-testid={`provider-shelf-${shelf.source.name}`}>
          <div className="shop-section-head">
            <h3>
              {shelf.source.name} <TrustBadge label={shelf.source.trust} />
            </h3>
          </div>
          {shelf.failure ? (
            <p className="warning" data-testid={`provider-shelf-failure-${shelf.source.name}`}>
              {shelf.failure.reason}
            </p>
          ) : shelf.providers.length === 0 ? (
            <Shore>This registry lists no providers.</Shore>
          ) : (
            <ul className="provider-grid">
              {shelf.providers.map((provider) => (
                <ProviderCard
                  key={`${shelf.source.name}/${provider.providerId}`}
                  provider={provider}
                  trustSentence={registry?.trustSentence ?? ''}
                  busy={busyId === provider.providerId}
                  onInstall={(p) => void install(p)}
                  onRemove={(p) => void remove(p)}
                />
              ))}
            </ul>
          )}
        </div>
      ))}
    </>
  )
}
