import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import toast from 'react-hot-toast'
import { AppShell } from '../components/AppShell'
import { Shore } from '../components/etched'
import { PackDisclosurePanel } from '../components/PackDisclosure'
import { ProviderShop } from '../components/ProviderShop'
import { TrustBadge } from '../components/TrustBadge'
import { useAuth } from '../contexts/AuthContext'
import {
  ApiError,
  getPackRegistry,
  getRegistryPack,
  installRegistryPack,
  type PackRegistry,
  type RegistryPack,
  type RegistryPackDetail,
} from '../lib/api'
import { SHOP_URL } from '../lib/links'

/**
 * THE ROCKY SURF SHOP TAB (issue #426, ADR-0028 second amendment).
 *
 * ONE PAGE FOR BOTH THINGS THE SHOP DISTRIBUTES. A registry (`registry.sources` in the config
 * file — `amroja-biz/rockysurf-shop` by default) publishes community Surge Packs in `index.json`
 * and providers in `providers.json`. This page lists both and installs either, and it is a tab
 * of its OWN rather than a fourth tab on Surge Packs, by the owner's ruling: the Surge Packs page
 * stays about the packs this installation HAS (its Community sub-tab links here), Settings stays
 * where a provider is CONFIGURED, and this is where things are found and installed.
 *
 * THE PACK HALF IS THE COMMUNITY SUB-TAB'S FLOW, UNCHANGED. Same read (`getPackRegistry`), same
 * disclosure before consent (`PackDisclosurePanel` — every script verbatim, which run as root,
 * every URL — ADR-0006), same install by ADDRESS so that core refetches and re-verifies the bytes
 * rather than trusting what the browser holds. What differs is the reading: here every listed
 * pack is shown, installed or not, so the page answers "what is in the shop and what do I have"
 * in one place.
 *
 * THE PROVIDER HALF IS `ProviderShop`, restored from #380 (see its docblock for what a card must
 * say before anyone consents, and why the trust sentence arrives from core rather than from the
 * registry). Installing a provider ends at a restart the operator performs; the card says so.
 *
 * NOTHING IS FETCHED UNTIL THIS PAGE IS OPENED, and nothing at boot — the rule `docs/self-hosting.md`
 * states for the pack shelves, kept here without an exception. Both reads are admin-only routes;
 * a member sees who installs things, and the page asks the control plane nothing on their behalf.
 */

type Shelf = PackRegistry['shelves'][number]

function PackShelf({
  shelf,
  busyKey,
  onSelect,
}: {
  shelf: Shelf
  busyKey: string | null
  onSelect: (pack: RegistryPack) => void
}): React.JSX.Element {
  return (
    <div data-testid={`shop-shelf-${shelf.source.name}`}>
      <div className="shop-section-head">
        <h3>
          {shelf.source.name} <TrustBadge label={shelf.source.trust} />
        </h3>
      </div>

      {shelf.failure ? (
        <p className="warning" data-testid={`shop-shelf-failure-${shelf.source.name}`}>
          {shelf.failure.reason}
        </p>
      ) : shelf.packs.length === 0 ? (
        <Shore>This registry lists no packs.</Shore>
      ) : (
        <ul className="pack-grid">
          {shelf.packs.map((pack) => {
            const key = `${pack.sourceName}/${pack.packId}`
            return (
              <li key={pack.packId} className="pack-card" data-testid={`shop-pack-${pack.packId}`}>
                <div className="pack-card-head">
                  <h3>{pack.name}</h3>
                  <TrustBadge label="registry" text="community" />
                </div>
                <p className="muted">{pack.description}</p>
                {pack.installed ? (
                  <p className="hint" data-testid={`shop-pack-installed-${pack.packId}`}>
                    Installed. It is listed under{' '}
                    <Link to="/packs?tab=community">Surge Packs &rarr; Community</Link>.
                  </p>
                ) : (
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => onSelect(pack)}
                    disabled={busyKey === key}
                  >
                    {busyKey === key ? 'Reading…' : 'Review'}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function ShopPage(): React.JSX.Element {
  const { user } = useAuth()
  const isAdmin = user?.isAdmin ?? false

  const [registry, setRegistry] = useState<PackRegistry | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [selectingKey, setSelectingKey] = useState<string | null>(null)
  const [selected, setSelected] = useState<RegistryPackDetail | null>(null)
  const [installing, setInstalling] = useState(false)

  const load = useCallback(async (options: { refresh?: boolean } = {}) => {
    if (options.refresh) setRefreshing(true)
    try {
      setRegistry(await getPackRegistry(options))
      setProblem(null)
    } catch (err) {
      setRegistry(null)
      setProblem(err instanceof ApiError ? err.detail : 'Could not read the pack listing.')
    } finally {
      setRefreshing(false)
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    if (!isAdmin || loaded) return
    void load()
  }, [isAdmin, loaded, load])

  async function openDisclosure(pack: RegistryPack) {
    const key = `${pack.sourceName}/${pack.packId}`
    setSelectingKey(key)
    setSelected(null)
    try {
      setSelected(await getRegistryPack(pack.sourceName, pack.packId))
    } catch (err) {
      toast.error(err instanceof ApiError ? err.detail : 'Could not read that pack')
    } finally {
      setSelectingKey(null)
    }
  }

  async function install(detail: RegistryPackDetail) {
    setInstalling(true)
    try {
      // Only the address goes over the wire. Core refetches and re-verifies, so nothing the
      // browser holds can decide what actually runs as root.
      const installed = await installRegistryPack(detail.entry.sourceName, detail.entry.packId)
      toast.success(`Installed ${installed.name}. It is available when creating a server now.`)
      setSelected(null)
      await load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.detail : 'Install failed')
    } finally {
      setInstalling(false)
    }
  }

  return (
    <AppShell title="Rocky Surf Shop">
      <p className="hint" data-testid="shop-caption">
        Community Surge Packs and providers from{' '}
        <a href={SHOP_URL} target="_blank" rel="noreferrer">
          Rocky Surf Shop
        </a>
        , and any other registry named in the config file. Everything here carries the trust label
        you gave its registry; no registry can call itself official.
      </p>

      <section className="shop-section" aria-labelledby="shop-packs-heading" data-testid="shop-packs">
        <div className="shop-section-head">
          <h2 id="shop-packs-heading">Surge Packs</h2>
          {isAdmin && (
            <button
              type="button"
              className="button secondary"
              onClick={() => void load({ refresh: true })}
              disabled={refreshing}
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          )}
        </div>
        <p className="hint">
          A Surge Pack is the software a server is created with. Before one is installed, the page
          shows every script it will run, which of them run as root, and every URL they download
          from. Installing a pack takes effect immediately; packs already on this installation are
          on the <Link to="/packs?tab=community">Surge Packs</Link> page.
        </p>

        {!isAdmin && <Shore>Surge Packs are installed by an administrator.</Shore>}

        {problem && (
          <p className="warning" data-testid="shop-packs-problem">
            {problem}
          </p>
        )}

        {registry && !registry.enabled && (
          <p className="hint" data-testid="shop-registry-disabled">
            The registry is switched off (<code>registry.enabled: false</code>). Packs already
            installed are unaffected.
          </p>
        )}

        {registry?.shelves.length === 0 && registry.enabled && <Shore>No registry is configured.</Shore>}

        {(registry?.shelves ?? []).map((shelf) => (
          <PackShelf
            key={shelf.source.name}
            shelf={shelf}
            busyKey={selectingKey}
            onSelect={(pack) => void openDisclosure(pack)}
          />
        ))}
      </section>

      <section className="shop-section" aria-labelledby="shop-providers-heading" data-testid="shop-providers">
        <div className="shop-section-head">
          <h2 id="shop-providers-heading">Providers</h2>
        </div>
        <ProviderShop active isAdmin={isAdmin} />
      </section>

      {selected && (
        <PackDisclosurePanel
          detail={selected}
          installing={installing}
          onCancel={() => setSelected(null)}
          onInstall={() => void install(selected)}
        />
      )}
    </AppShell>
  )
}
