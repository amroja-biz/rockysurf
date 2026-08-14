import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { AppShell } from '../components/AppShell'
import { PackDisclosurePanel } from '../components/PackDisclosure'
import {
  ApiError,
  getPackRegistry,
  getRegistryPack,
  installRegistryPack,
  listAdminSurgePacks,
  type AdminSurgePack,
  type PackRegistry,
  type RegistryPack,
  type RegistryPackDetail,
} from '../lib/api'

/**
 * The pack shop — everything this installation can offer, and where each of it came from.
 *
 * NOT A REGISTRY BROWSER. The owner's ruling on issue #9 made this the unified surface: the
 * packs bundled in the release sit alongside the ones a registry publishes, and each is labelled
 * with its provenance. Showing only the registry would leave an operator with no single place to
 * answer "what have I got, and who wrote it" — which is the question the labels exist for.
 *
 * WHERE THE LABEL COMES FROM, since it is the whole trust model (ADR-0006):
 *
 *  - `official` means the pack arrived in the Rocky Surf release. In the API that is a non-null
 *    `sourceFile` — a file-backed row — and it is not a claim any registry can make.
 *  - anything else carries the label the OPERATOR wrote next to that registry in their own
 *    config file. Nothing a registry publishes says how far it should be trusted.
 *
 * INSTALLING IS CONSENTING TO ROOT SHELL, so the button is not reachable without the disclosure.
 * Selecting a pack fetches it, verifies its digest server-side, and shows every script verbatim
 * plus what the scripts do that is hard to see by eye. `docs/adr/0006` and
 * `packages/core/src/packs/disclosure.ts` carry the argument for why that is the control rather
 * than a scan.
 */

type Shelf = PackRegistry['shelves'][number]

/** A pack the operator already has, from wherever it came. */
interface InstalledEntry {
  pack: AdminSurgePack
  label: string
  detail: string
}

/**
 * How an installed pack is described, which is a statement about provenance and nothing else.
 *
 * The order matters: file-backed is checked FIRST, because a pack can in principle carry both a
 * `sourceFile` and stale registry columns, and what is on disk is what the boot sync will
 * enforce on the next start. Describing such a row by its registry would name a source that no
 * longer decides anything.
 */
function describeInstalled(pack: AdminSurgePack): InstalledEntry {
  if (pack.sourceFile) {
    return { pack, label: 'official', detail: `shipped with this release · ${pack.sourceFile}` }
  }
  if (pack.registry?.source) {
    const trust = pack.registry.trust ?? 'community'
    return { pack, label: trust, detail: `installed from ${pack.registry.source}` }
  }
  return { pack, label: 'local', detail: 'created here, in this installation' }
}

export function AdminPackShopPage(): React.JSX.Element {
  const [registry, setRegistry] = useState<PackRegistry | null>(null)
  const [installed, setInstalled] = useState<AdminSurgePack[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<RegistryPackDetail | null>(null)
  const [selecting, setSelecting] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)

  const load = useCallback(async (refresh = false) => {
    setLoading(true)
    setError(null)
    try {
      const [shop, packs] = await Promise.all([getPackRegistry({ refresh }), listAdminSurgePacks()])
      setRegistry(shop)
      setInstalled(packs)
    } catch (err) {
      // A whole-page error is for "the control plane would not answer", not for a registry being
      // down — that arrives as a per-shelf failure and renders beside the shelf it belongs to.
      setError(err instanceof ApiError ? err.detail : 'Could not load the pack shop')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function openDisclosure(pack: RegistryPack): Promise<void> {
    setSelecting(`${pack.sourceName}/${pack.packId}`)
    setSelected(null)
    try {
      setSelected(await getRegistryPack(pack.sourceName, pack.packId))
    } catch (err) {
      toast.error(err instanceof ApiError ? err.detail : 'Could not read that pack')
    } finally {
      setSelecting(null)
    }
  }

  async function install(detail: RegistryPackDetail): Promise<void> {
    setInstalling(true)
    try {
      // Only the address goes over the wire. Core refetches and re-verifies, so nothing the
      // browser holds can decide what actually runs as root.
      const pack = await installRegistryPack(detail.entry.sourceName, detail.entry.packId)
      toast.success(`Installed ${pack.name}. It is available when creating a server now.`)
      setSelected(null)
      await load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.detail : 'Install failed')
    } finally {
      setInstalling(false)
    }
  }

  const entries = installed.map(describeInstalled)
  const official = entries.filter((e) => e.label === 'official')
  const others = entries.filter((e) => e.label !== 'official')

  return (
    <AppShell title="Pack Shop">
      <p className="hint">
        Every Surge Pack this installation can offer, and where each one came from. Packs marked{' '}
        <strong>official</strong> shipped with the Rocky Surf release you are running; everything else
        carries the label you gave its source in your config file.
      </p>

      {error && <p className="error">{error}</p>}

      <section className="shop-section">
        <div className="shop-section-head">
          <h2>Installed</h2>
          <button type="button" className="button secondary" onClick={() => void load(true)} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {entries.length === 0 && !loading ? (
          <p className="empty">No packs yet. Install one from a registry below.</p>
        ) : (
          <ul className="pack-grid">
            {[...official, ...others].map((entry) => (
              <li key={entry.pack.packId} className="pack-card" data-testid={`installed-${entry.pack.packId}`}>
                <div className="pack-card-head">
                  <h3>{entry.pack.name}</h3>
                  <TrustBadge label={entry.label} />
                </div>
                <p className="muted">{entry.detail}</p>
                <p className="size-detail">{entry.pack.tools.length} tool(s)</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {registry && !registry.enabled && (
        <p className="hint" data-testid="registry-disabled">
          The pack registry is switched off (<code>registry.enabled: false</code>). Packs already
          installed are unaffected, and you can still create packs in Admin → Surge Packs.
        </p>
      )}

      {registry?.shelves.map((shelf) => (
        <ShelfSection
          key={shelf.source.name}
          shelf={shelf}
          busyKey={selecting}
          onSelect={(pack) => void openDisclosure(pack)}
        />
      ))}

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

/**
 * The label, rendered the same way everywhere it appears.
 *
 * `official` is visually distinct from the rest because it is the only one meaning "this came
 * from us". Everything else is styled alike on purpose: a design that made `internal` look
 * safer than `community` would be inventing a ranking the trust model does not have — both are
 * just what the operator called a registry.
 */
function TrustBadge({ label }: { label: string }): React.JSX.Element {
  return (
    <span className={`badge trust-${label === 'official' ? 'official' : 'other'}`} data-testid={`trust-${label}`}>
      {label}
    </span>
  )
}

function ShelfSection({
  shelf,
  busyKey,
  onSelect,
}: {
  shelf: Shelf
  busyKey: string | null
  onSelect: (pack: RegistryPack) => void
}): React.JSX.Element {
  return (
    <section className="shop-section" data-testid={`shelf-${shelf.source.name}`}>
      <div className="shop-section-head">
        <h2>
          {shelf.source.name} <TrustBadge label={shelf.source.trust} />
        </h2>
        <span className="muted">{shelf.source.url}</span>
      </div>

      {shelf.failure ? (
        // The reason, not a shrug. "This registry is down" and "this registry is empty" are
        // different facts and only one of them is worth an operator's attention.
        <p className="warning" data-testid={`shelf-failure-${shelf.source.name}`}>
          {shelf.failure.reason}
        </p>
      ) : shelf.packs.length === 0 ? (
        <p className="empty">This registry has no packs yet.</p>
      ) : (
        <ul className="pack-grid">
          {shelf.packs.map((pack) => {
            const key = `${pack.sourceName}/${pack.packId}`
            return (
              <li key={pack.packId} className="pack-card" data-testid={`registry-${pack.packId}`}>
                <div className="pack-card-head">
                  <h3>{pack.name}</h3>
                  <TrustBadge label={pack.trust} />
                </div>
                <p className="muted">{pack.description}</p>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => onSelect(pack)}
                  disabled={busyKey === key}
                >
                  {busyKey === key ? 'Reading…' : pack.installed ? 'Review and reinstall' : 'Review'}
                </button>
                {pack.installed && <span className="size-detail">already installed</span>}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
