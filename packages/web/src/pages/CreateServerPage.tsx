import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { useNavigate } from 'react-router'
import {
  createServer,
  listProviders,
  listSurgePacks,
  type CreateServerRequest,
  type ProviderInfo,
  type SurgePack,
} from '../lib/api'
import {
  archLabel,
  availableArchitectures,
  formatHourly,
  formatMonthly,
  formatPricesAsOf,
  resolveOffering,
  SIZE_REQUIREMENTS,
  SIZES,
  type Architecture,
  type ServerSize,
} from '../lib/requirements'
import { ProvisioningFeed } from '../components/ProvisioningFeed'

/**
 * Create a server.
 *
 * Ported from `frontend/src/pages/CreateServerPage.tsx`, minus three things that no longer
 * exist and one that was never right:
 *
 *  - the **billing gate** — self-hosted, so the operator pays their own cloud bill;
 *  - the **spot radio** — spot is cut from v0.1 (an interrupted box with an agent mid-task
 *    undercuts the whole point of a persistent dev box);
 *  - the **GitHub App repo picker** — v0.1 has no GitHub App, so repositories are a free-text
 *    list;
 *  - the **`open-claw` hardcode**. The old page decided which fields to show by comparing the
 *    selected pack id against a literal: `requiresRdp = selectedPackId === 'open-claw'`. Packs
 *    now declare `requiresRepos` and `requiresRdp` themselves (ADR-0004), so a new pack gets
 *    the right form without anyone editing this file.
 *
 * The same rule applies to providers. Nothing here compares `provider.id` against a literal —
 * provider-specific controls are driven by `capabilities.*`, which is what lets one form serve
 * clouds that work very differently.
 */
export function CreateServerPage() {
  const navigate = useNavigate()

  /* ---------------------------------------------------------------- catalogue */
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [packs, setPacks] = useState<SurgePack[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  /* ---------------------------------------------------------------- form */
  const [name, setName] = useState('')
  const [providerId, setProviderId] = useState('')
  const [size, setSize] = useState<ServerSize>('small')
  const [arch, setArch] = useState<Architecture | undefined>(undefined)
  const [packId, setPackId] = useState('')
  const [repoInput, setRepoInput] = useState('')
  const [sshKeyOption, setSshKeyOption] = useState<'generate' | 'provide'>('generate')
  const [sshPublicKey, setSshPublicKey] = useState('')
  const [rdpPassword, setRdpPassword] = useState('')
  const [rdpPasswordConfirm, setRdpPasswordConfirm] = useState('')

  /* ---------------------------------------------------------------- submission */
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [createdServerId, setCreatedServerId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [providerList, packList] = await Promise.all([listProviders(), listSurgePacks()])
        if (cancelled) return

        setProviders(providerList)
        if (providerList[0]) setProviderId(providerList[0].id)

        const enabled = packList.filter((p) => p.enabled).sort((a, b) => a.displayOrder - b.displayOrder)
        setPacks(enabled)
        if (enabled[0]) setPackId(enabled[0].packId)
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load options')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const provider = useMemo(() => providers.find((p) => p.id === providerId), [providers, providerId])
  const pack = useMemo(() => packs.find((p) => p.packId === packId), [packs, packId])

  const architectures = useMemo(() => availableArchitectures(provider?.offerings ?? []), [provider])

  // Resolve the t-shirt size to a CONCRETE offering, before submit, so the price shown is the
  // price of the machine that will actually be created.
  const resolution = useMemo(() => {
    if (!provider) return null
    return resolveOffering(provider.offerings, { ...SIZE_REQUIREMENTS[size], ...(arch ? { arch } : {}) })
  }, [provider, size, arch])

  const resolved = resolution?.ok ? resolution.offering : null
  const pricesAsOf = formatPricesAsOf(resolved?.hourly?.fetchedAt)

  // Pack metadata, not pack identity, decides which fields exist.
  const requiresRepos = pack?.requiresRepos ?? false
  const requiresRdp = pack?.requiresRdp ?? false

  const repositories = useMemo(
    () =>
      repoInput
        .split(/[\n,]/)
        .map((line) => line.trim())
        .filter(Boolean),
    [repoInput],
  )

  function validate(): string | null {
    if (!providerId) return 'Choose a provider'
    if (!packId) return 'Choose a pack'
    if (!resolution) return 'Choose a provider'
    if (!resolution.ok) return resolution.reason
    if (requiresRepos && repositories.length === 0) return 'This pack needs at least one repository'
    if (requiresRdp) {
      if (rdpPassword.length < 8) return 'Remote desktop password must be at least 8 characters'
      if (rdpPassword !== rdpPasswordConfirm) return 'Remote desktop passwords do not match'
    }
    if (sshKeyOption === 'provide' && !sshPublicKey.trim()) return 'Paste your SSH public key, or let Rocky Surf generate one'
    return null
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const problem = validate()
    if (problem) {
      setSubmitError(problem)
      return
    }
    setSubmitError(null)
    setSubmitting(true)

    try {
      const request: CreateServerRequest = {
        size,
        packId,
        provider: providerId,
        ...(name.trim() ? { name: name.trim() } : {}),
        // The offering the user was shown a price for — not whatever core would pick now.
        ...(resolved ? { offeringId: resolved.id, arch: resolved.arch } : {}),
        ...(requiresRepos ? { repositories } : {}),
        ...(sshKeyOption === 'provide' ? { sshPublicKey: sshPublicKey.trim() } : {}),
        ...(requiresRdp ? { rdpPassword } : {}),
      }

      const created = await createServer(request)
      toast.success('Server created')
      // Stay on the page and show the live feed rather than navigating away mid-provision:
      // the interesting part happens over the next minute, and it happens here.
      setCreatedServerId(created.serverId)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to create server')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <main className="page"><p>Loading options…</p></main>

  if (loadError) {
    return (
      <main className="page">
        <h1>New server</h1>
        <p className="error">{loadError}</p>
      </main>
    )
  }

  // Once created, the form is done and the feed takes over.
  if (createdServerId) {
    return (
      <main className="page">
        <h1>Setting up {name.trim() || 'your server'}</h1>
        <ProvisioningFeed serverId={createdServerId} onReady={() => navigate(`/servers/${createdServerId}`)} />
        <button type="button" className="btn-secondary" onClick={() => navigate(`/servers/${createdServerId}`)}>
          Go to server
        </button>
      </main>
    )
  }

  return (
    <main className="page">
      <h1>New server</h1>

      <form onSubmit={handleSubmit}>
        <label className="form-label" htmlFor="name">
          Name <span className="hint">optional</span>
        </label>
        <input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="dev-box" />

        {/* Provider — only rendered when there is a choice to make. */}
        {providers.length > 1 && (
          <fieldset>
            <legend>Provider</legend>
            {providers.map((p) => (
              <label key={p.id} className={`radio-option ${p.id === providerId ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="provider"
                  value={p.id}
                  checked={p.id === providerId}
                  onChange={() => {
                    setProviderId(p.id)
                    setArch(undefined) // catalogues differ; do not carry an arch across
                  }}
                />
                <span>{p.displayName}</span>
              </label>
            ))}
          </fieldset>
        )}

        {provider?.offeringsError && (
          <p className="warning">Could not read {provider.displayName}&apos;s catalogue: {provider.offeringsError}</p>
        )}

        <fieldset>
          <legend>Size</legend>
          {SIZES.map((option) => {
            const requirements = SIZE_REQUIREMENTS[option]
            return (
              <label key={option} className={`radio-option ${option === size ? 'selected' : ''}`}>
                <input type="radio" name="size" value={option} checked={option === size} onChange={() => setSize(option)} />
                <span className="size-name">{option}</span>
                <span className="size-detail">
                  at least {requirements.vcpu} vCPU · {requirements.memGb} GB RAM
                </span>
              </label>
            )
          })}
        </fieldset>

        {/* Architecture, offered only where the provider actually sells more than one. */}
        {architectures.length > 1 && (
          <fieldset>
            <legend>Architecture</legend>
            <label className={`radio-option ${arch === undefined ? 'selected' : ''}`}>
              <input type="radio" name="arch" checked={arch === undefined} onChange={() => setArch(undefined)} />
              <span>Any</span>
              <span className="size-detail">cheapest that fits</span>
            </label>
            {architectures.map((option) => (
              <label key={option} className={`radio-option ${option === arch ? 'selected' : ''}`}>
                <input type="radio" name="arch" value={option} checked={option === arch} onChange={() => setArch(option)} />
                <span>{archLabel(option)}</span>
                {option === 'arm64' && <span className="size-detail">usually cheaper</span>}
              </label>
            ))}
          </fieldset>
        )}

        {/* The resolved machine — shown BEFORE submit, with its price and the date of that price. */}
        <section className="resolved-offering" aria-live="polite">
          {resolution?.ok ? (
            <>
              <h2>
                {resolved!.id} <span className="arch-badge">{archLabel(resolved!.arch)}</span>
              </h2>
              <p>
                {resolved!.cpu} vCPU · {resolved!.memoryGb} GB RAM
                {resolved!.diskGb ? ` · ${resolved!.diskGb} GB disk` : ''} · {resolved!.region}
              </p>
              <p className="price">
                <strong>{formatHourly(resolved!.hourly)}</strong>
                {formatMonthly(resolved!.hourly) && <> · about {formatMonthly(resolved!.hourly)}/month if left running</>}
              </p>
              {pricesAsOf ? (
                <p className="price-note">
                  Estimate, {pricesAsOf}. You are billed by {provider?.displayName}, not by Rocky Surf.
                </p>
              ) : (
                <p className="price-note">
                  This provider quoted no price. You are billed by {provider?.displayName}, not by Rocky Surf.
                </p>
              )}
            </>
          ) : (
            <p className={resolution?.soldOut ? 'warning' : 'error'}>{resolution?.reason ?? 'Choose a provider'}</p>
          )}
        </section>

        <fieldset>
          <legend>Pack</legend>
          {/*
            A fresh install has no packs until someone adds a YAML file or creates one in the
            admin UI. Saying so beats an empty box above a button that refuses to submit —
            which is exactly what browser verification caught here.
          */}
          {packs.length === 0 && (
            <p className="hint">
              No packs are available yet. Add a pack file to <code>packs/</code> or create one in
              Admin → Surge packs, then reload.
            </p>
          )}
          {packs.map((option) => (
            <label key={option.packId} className={`radio-option ${option.packId === packId ? 'selected' : ''}`}>
              <input
                type="radio"
                name="pack"
                value={option.packId}
                checked={option.packId === packId}
                onChange={() => setPackId(option.packId)}
              />
              <span>{option.name}</span>
              <span className="size-detail">{option.tools.map((t) => t.name).join(', ')}</span>
            </label>
          ))}
        </fieldset>

        {/* Conditional on what the PACK declares, never on which pack it is. */}
        {requiresRepos && (
          <div className="form-group">
            <label className="form-label" htmlFor="repositories">
              Repositories
            </label>
            <p className="hint">One git URL per line. They are cloned onto the box during setup.</p>
            <textarea
              id="repositories"
              rows={4}
              value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)}
              placeholder={'https://github.com/you/project.git\ngit@github.com:you/other.git'}
            />
          </div>
        )}

        {requiresRdp && (
          <div className="form-group">
            <label className="form-label" htmlFor="rdpPassword">
              Remote desktop password
            </label>
            <p className="hint">This pack installs a graphical desktop. At least 8 characters.</p>
            <input
              id="rdpPassword"
              type="password"
              value={rdpPassword}
              onChange={(e) => setRdpPassword(e.target.value)}
              autoComplete="new-password"
            />
            <label className="form-label" htmlFor="rdpPasswordConfirm">
              Confirm password
            </label>
            <input
              id="rdpPasswordConfirm"
              type="password"
              value={rdpPasswordConfirm}
              onChange={(e) => setRdpPasswordConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </div>
        )}

        <fieldset>
          <legend>SSH access</legend>
          <label className={`radio-option ${sshKeyOption === 'generate' ? 'selected' : ''}`}>
            <input
              type="radio"
              name="sshKey"
              checked={sshKeyOption === 'generate'}
              onChange={() => setSshKeyOption('generate')}
            />
            <span>Generate a key for me</span>
            <span className="size-detail">downloadable once the server is ready</span>
          </label>
          <label className={`radio-option ${sshKeyOption === 'provide' ? 'selected' : ''}`}>
            <input
              type="radio"
              name="sshKey"
              checked={sshKeyOption === 'provide'}
              onChange={() => setSshKeyOption('provide')}
            />
            <span>Use my own public key</span>
          </label>
          {sshKeyOption === 'provide' && (
            <textarea
              aria-label="SSH public key"
              rows={3}
              value={sshPublicKey}
              onChange={(e) => setSshPublicKey(e.target.value)}
              placeholder="ssh-ed25519 AAAA… you@laptop"
            />
          )}
          {/*
            Capability-driven, not provider-driven. A provider that cannot carry a host key
            leaves core on trust-on-first-use, and the user deserves to know that before they
            connect — not to discover it from an SSH warning later.
          */}
          {provider && !provider.capabilities.canInjectHostKeys && (
            <p className="hint">
              {provider.displayName} cannot pre-install a host key, so the first connection is trusted on sight and
              pinned from then on.
            </p>
          )}
        </fieldset>

        {provider && !provider.capabilities.stop && (
          <p className="hint">{provider.displayName} servers cannot be stopped and restarted — only terminated.</p>
        )}

        {submitError && <p className="error">{submitError}</p>}

        <button type="submit" className="btn-primary" disabled={submitting || !resolution?.ok}>
          {submitting ? 'Creating…' : 'Create server'}
        </button>
      </form>
    </main>
  )
}
