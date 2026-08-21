import type { Architecture, Offering, Price } from '@rockysurf/provider-sdk'
import {
  AZURE_HOURLY_USD,
  AZURE_PRICES_EFFECTIVE_FROM,
  AZURE_PRICES_FETCHED_AT,
  AZURE_PRICES_SOURCE,
  AZURE_SIZES,
} from './prices.generated.js'
import type { ArmResourceSku } from './types.js'

/**
 * Turning `Microsoft.Compute/skus` plus a bundled price table into `Offering[]`.
 *
 * THE SHAPE IS LIVE AND THE PRICE IS BUNDLED, which is a split neither other cloud provider
 * needed, and it is the honest one for Azure:
 *
 *  - **Price** ships bundled and stamped, because live pricing APIs are out of v0 (ADR-0003) and
 *    Azure's retail feed is a separate unauthenticated service rather than something already in
 *    hand. Hetzner is the documented exception precisely because its prices arrive inline on a
 *    call `listOfferings()` already makes; Azure's do not.
 *  - **Shape** — vCPU and memory — is read live, because Azure publishes it on the very call
 *    that reports availability, so fetching it costs nothing extra and a bundled copy could
 *    drift from what Azure will actually sell.
 *
 * A SIZE WHOSE SHAPE CANNOT BE READ IS OMITTED, never given a fabricated one. That is the same
 * rule `@rockysurf/provider-byo` follows for a host it cannot measure, and for the same reason: a
 * catalogue entry claiming 8 GB on a machine that has 4 is worse than a catalogue entry that is
 * not there.
 *
 * TWO MORE GATES SIT ON TOP OF THAT, both against the same live capabilities, both omitted- not
 * fabricated (rockysurf-o05s / issue #24 PR2b):
 *
 *  - `HyperVGenerations` must include `V2`. This provider's default image SKU is Canonical's
 *    Gen2 build, and a Gen1-only size cannot boot it — it would fail at ARM create with a
 *    message that does not point back at the catalogue.
 *  - `SIZE_CEILING`: nothing above 128 vCPU or 1024 GiB is a dev box. This is the same rule
 *    PR2a applied to AWS's catalogue at generation time, moved here because Azure's retail feed
 *    (unlike AWS's) carries no vCPU/memory data — the ceiling can only be checked once real
 *    numbers exist, which is exactly what this function already has.
 */

export { AZURE_PRICES_EFFECTIVE_FROM, AZURE_PRICES_FETCHED_AT, AZURE_PRICES_SOURCE, AZURE_SIZES }

const usd = (amount: number): Price => ({
  amount,
  currency: 'USD',
  fetchedAt: AZURE_PRICES_FETCHED_AT,
})

/** One capability off a `resourceSkus` entry, as a number. */
function capability(sku: ArmResourceSku, name: string): number | undefined {
  const raw = sku.capabilities?.find((c) => c.name === name)?.value
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/**
 * The Hyper-V generations a size supports, as Azure reports them — typically `"V1,V2"` or
 * `"V1"` alone for the oldest families. Undefined when the capability is absent, same as any
 * other capability this file reads: omitted, never fabricated.
 */
function hyperVGenerationsOf(sku: ArmResourceSku): string[] | undefined {
  const raw = sku.capabilities?.find((c) => c.name === 'HyperVGenerations')?.value
  if (raw === undefined) return undefined
  return raw.split(',').map((v) => v.trim())
}

/**
 * The mechanical size ceiling, same rule PR2a applied to AWS at generation time — but enforced
 * HERE instead, because Azure's feed carries no shape data at all (rockysurf-o05s): vCPU and
 * memory only exist as real numbers once read live from `Microsoft.Compute/skus`, which is
 * exactly what this function already has in hand. One named constant, so an operator who wants a
 * different limit changes one place.
 */
export const SIZE_CEILING = { maxCpu: 128, maxMemoryGb: 1024 }

/**
 * The architecture of a VM size.
 *
 * `CpuArchitectureType` is authoritative and is what gets used. The fallback reads the size name,
 * where Azure's own convention is that a `p` in the family segment means Ampere Altra — `B2ps_v2`
 * is the arm64 sibling of `B2s_v2`. The fallback exists because the capability is a relatively
 * recent addition and an older api-version or an odd SKU may omit it; getting this wrong pairs an
 * arm64 image with an x64 machine, which fails at create with an unhelpful message.
 */
export function architectureOf(sku: ArmResourceSku): Architecture | undefined {
  const declared = sku.capabilities?.find((c) => c.name === 'CpuArchitectureType')?.value
  if (declared) {
    if (/arm/i.test(declared)) return 'arm64'
    if (/x64|x86/i.test(declared)) return 'amd64'
  }
  return architectureFromName(sku.name)
}

/** `Standard_B2ps_v2` → arm64; `Standard_B2s_v2` → amd64. Undefined for a name we cannot read. */
export function architectureFromName(name: string | undefined): Architecture | undefined {
  // Standard_<family><cpus><letters>[_v<n>] — the letters after the digits are the feature
  // suffixes, and `p` among them is the Ampere marker.
  const suffix = /^Standard_[A-Z]+\d+([a-z]*)/.exec(name ?? '')?.[1]
  if (suffix === undefined) return undefined
  return suffix.includes('p') ? 'arm64' : 'amd64'
}

/**
 * Whether this subscription can order this size in this location right now (ADR-0003, B1).
 *
 * Azure reports restrictions PER SUBSCRIPTION — a size can be sold in a region and still be
 * refused to a particular account, which is exactly the "a price is not an offer" case the
 * `available` flag exists for. A `Location` restriction means no; a `Zone` restriction means some
 * zones are out but the region is orderable, and this provider does not pin a zone, so it is not
 * a refusal.
 */
export function isAvailable(sku: ArmResourceSku, location: string): boolean {
  const wanted = location.toLowerCase()
  return !(sku.restrictions ?? []).some((restriction) => {
    if (restriction.type !== 'Location') return false
    const locations = restriction.restrictionInfo?.locations ?? []
    // A location restriction with no stated locations is a blanket one.
    return locations.length === 0 || locations.some((l) => l.toLowerCase() === wanted)
  })
}

/**
 * Build the offering list for one region from a `resourceSkus` page.
 *
 * @param skus every `Microsoft.Compute/skus` entry the API returned for this location
 * @param location the ARM region id, which is also `Offering.region`
 * @param diskGb the OS disk size this provider is configured to attach, so the offering
 *   describes the machine core will actually create rather than the image's default
 */
export function buildOfferings(
  skus: readonly ArmResourceSku[],
  location: string,
  diskGb: number,
): Offering[] {
  const prices = AZURE_HOURLY_USD[location]
  const catalogue = new Set<string>(AZURE_SIZES)
  const offerings: Offering[] = []

  for (const sku of skus) {
    if (sku.resourceType !== 'virtualMachines') continue
    const id = sku.name
    if (!id || !catalogue.has(id)) continue

    const cpu = capability(sku, 'vCPUs')
    const memoryGb = capability(sku, 'MemoryGB')
    const arch = architectureOf(sku)
    const hyperVGenerations = hyperVGenerationsOf(sku)
    // Omitted rather than fabricated. See the note at the top of this file.
    if (cpu === undefined || memoryGb === undefined || arch === undefined || hyperVGenerations === undefined) continue

    // A Gen1-only size cannot boot this provider's default image SKU (Canonical's Gen2 build)
    // and fails at ARM create with an unhelpful message — never list one (rockysurf-o05s).
    if (!hyperVGenerations.includes('V2')) continue

    // The same mechanical ceiling PR2a applied to AWS's catalogue: nothing this large is a dev
    // box, and Offering.gpu stays reserved-unpopulated regardless (rockysurf-o05s).
    if (cpu > SIZE_CEILING.maxCpu || memoryGb > SIZE_CEILING.maxMemoryGb) continue

    const amount = prices?.[id]
    offerings.push({
      id,
      cpu,
      memoryGb,
      diskGb,
      arch,
      // `null` is "unknown, never free": a region this repository has not bundled prices for
      // gets no number rather than a us-east number that would be wrong.
      hourly: amount === undefined ? null : usd(amount),
      available: isAvailable(sku, location),
      region: location,
    })
  }

  return offerings.sort((a, b) => a.id.localeCompare(b.id))
}
