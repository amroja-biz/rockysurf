#!/usr/bin/env node
/**
 * Refresh the bundled price tables (rockysurf-gyp1.3).
 *
 * Two jobs, two destinations (gh issue #100, ADR-0009):
 *
 *  - `--feed` emits the HOSTED PRICE FEED — the normalized JSON the `price-feed` workflow
 *    republishes to GitHub Pages daily and every installation reads at runtime. This is how
 *    prices reach installed copies now; a price change never needs a release.
 *  - The TS modes regenerate the bundled CATALOGUE files (AWS type shapes, Azure size list) —
 *    run by a maintainer when the machine-type catalogue itself should move, which does still
 *    ride a release. Every price the feed serves carries the feed's own `fetchedAt`, which is
 *    what lets the UI say "estimate based on prices as of …" instead of implying a number is
 *    current.
 *
 *   node scripts/refresh-prices.mjs              # AWS catalogue; no credentials needed
 *   node scripts/refresh-prices.mjs --azure      # Azure catalogue; also credential-free
 *   node scripts/refresh-prices.mjs --feed <dir> # emit the hosted price-feed JSON
 *   HETZNER_TOKEN=… node scripts/refresh-prices.mjs --hetzner
 *
 * PROVENANCE, per provider:
 *
 *  - **AWS** — the public price feed behind the EC2 on-demand pricing page. No credentials, no
 *    AWS account, no SDK. It is the same JSON calculator.aws renders, so the numbers match what
 *    a customer sees on the page. Its `manifest.hawkFilePublicationDate` is recorded alongside
 *    the fetch time, because those are different facts: when AWS published, and when we looked.
 *    The catalogue itself is built MECHANICALLY from that same feed rather than from a hand list
 *    of families — see the comments on `AWS_EXCLUDED_FAMILIES`, `AWS_MAX_VCPU`/
 *    `AWS_MAX_MEMORY_GIB` and `classifyAwsArch` below for what "mechanically" means and why a
 *    hand list was rejected (it is the staleness failure mode this generator exists to escape).
 *
 *  - **Azure** — the public Retail Prices API, `https://prices.azure.com/api/retail/prices`.
 *    Also credential-free, so anyone can reproduce the numbers this feed serves. Only the size
 *    LIST is bundled: a VM size's vCPU and memory are read LIVE from `Microsoft.Compute/skus`
 *    by the provider itself, from the same call that reports per-subscription availability, so
 *    a shape can never disagree with what Azure will actually sell.
 *
 *  - **Hetzner** — OPTIONAL, and off by default. Hetzner returns prices inline on
 *    `GET /server_types`, the very call `listOfferings()` already makes, so that provider reads
 *    them live and the bundled table is only a fallback for when a type carries no price for
 *    the configured location. Refreshing it needs a project token, which is why it is opt-in
 *    rather than part of the default run.
 *
 *  - **GCP** — TRANSCRIBED BY HAND, and read from `scripts/gcp-transcribed-prices.json` rather
 *    than fetched. Google publishes no credential-free price feed, so `--feed` carries the
 *    transcription instead of generating one, and every date it publishes is a date a person
 *    actually read the pricing page (`buildGcpFeedDoc`). `--gcp` REPORTS rather than REWRITES;
 *    see the long comment on `reportGcp()` for why the Cloud Billing Catalog cannot become a
 *    generator here.
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The feed the EC2 on-demand pricing page itself renders. */
const AWS_FEED = (regionLabel) =>
  'https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/' +
  `${encodeURIComponent(regionLabel)}/Linux/index.json`

/**
 * AWS region id → the label the feed is keyed by.
 *
 * HAND-MAPPED, AND THAT IS DELIBERATE: there is no feed region index to read this from (every
 * index path tried — `.../ec2-ondemand-without-sec-sel/index.json` and neighbours — 404s), so
 * the only way to learn a label is to already know it. A wrong label here is a silent gap, not a
 * loud one, unless something stops it — which is why `fetchJson` below treats a non-200 as fatal
 * and this generator has no skip-and-continue path: one bad region label fails the whole run
 * instead of quietly shipping eleven regions and calling it twelve.
 *
 * Before this list grew past `us-east-1`, every other region an operator configured was already
 * an unpriced fleet — `AWS_HOURLY_USD` had one key, so `buildOfferings()` returned `hourly: null`
 * for every offering anywhere else, and the spend cap could not see a single box in it. Add a row
 * here to bundle another region; the generator will refuse to run rather than emit silence for it.
 */
const AWS_REGIONS = {
  'us-east-1': 'US East (N. Virginia)',
  'us-east-2': 'US East (Ohio)',
  'us-west-2': 'US West (Oregon)',
  'eu-west-1': 'EU (Ireland)',
  'eu-west-2': 'EU (London)',
  'eu-west-3': 'EU (Paris)',
  'eu-central-1': 'EU (Frankfurt)',
  'ap-southeast-1': 'Asia Pacific (Singapore)',
  'ap-southeast-2': 'Asia Pacific (Sydney)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)',
  'ca-central-1': 'Canada (Central)',
  'sa-east-1': 'South America (Sao Paulo)',
}

/**
 * Feed families excluded from the catalogue, by the feed's OWN `Instance Family` classification
 * — mechanical, not a hand list of instance-type ids. Two things collapse into one rule:
 *
 *  - Selling one of these would be DISHONEST. `Offering.gpu` is reserved and unpopulated (this
 *    provider never fills it in), and the bootstrap ships no GPU or accelerator drivers — a
 *    customer who read the offering and got the box would have neither the field describing what
 *    they bought nor the software to use it.
 *  - It is SELF-UPDATING. AWS adding a new accelerator family next quarter is caught by the
 *    feed's own classification the next time this generator runs; nothing here needs to learn
 *    the new family's name.
 *
 * Checked directly against the live feed on 2026-08-21: these four values are the whole set of
 * non-general-purpose-or-compute-or-memory-or-storage families it reports.
 */
export const AWS_EXCLUDED_FAMILIES = new Set([
  'GPU instance',
  'Machine Learning ASIC Instances',
  'FPGA Instances',
  'Media Accelerator Instances',
])

/**
 * Ceiling on vCPU and memory, independent of family or generation. This is what excludes
 * `.metal` giants and the multi-terabyte `u`/`u7i` "high memory" family WITHOUT naming either —
 * a size-based rule survives AWS resizing or renaming a family in a way an id list would not.
 *
 * 128 vCPU / 1024 GiB is the chosen line: on the feed checked 2026-08-21 it keeps ≈994 types at
 * a maximum of ≈$15.01/hr, comfortably covering the up-to-64xlarge sizes a dev box realistically
 * wants while keeping the bundled table two orders of magnitude smaller than "everything". A
 * maintainer who wants a tighter bootstrap catalogue can lower this to 64 vCPU / 512 GiB instead
 * — that is a one-line edit here, not a design change, which is the point of it being a constant.
 *
 * SAME POLICY, SAME NUMBERS, DIFFERENT LAYER from `@rockysurf/provider-azure`'s `SIZE_CEILING`
 * (`{ maxCpu: 128, maxMemoryGb: 1024 }` in `packages/provider-azure/src/offerings.ts`). AWS's
 * feed carries `vCPU`/`Memory` columns on the same row as the price, so this ceiling is enforced
 * HERE, once, at generation time. Azure's retail feed carries no shape data at all — vCPU and
 * memory only exist as real numbers once read live from `Microsoft.Compute/skus` — so the
 * identical rule has to live in that provider's `buildOfferings` instead, against the numbers
 * Azure reports live. If this line ever moves, move `SIZE_CEILING` with it; the two are the same
 * decision enforced where each provider's feed makes it possible to check.
 */
export const AWS_MAX_VCPU = 128
export const AWS_MAX_MEMORY_GIB = 1024

/** `.metal` (bare-metal, no hypervisor) instances sit in the SAME `Instance Family` as their
 * virtualized siblings, so they are excluded by id rather than by family. The feed's own metal
 * ids are `<family>.metal` or `<family>.metal-<size>` (e.g. `c8g.metal-48xl`); both match. */
export function isAwsMetal(id) {
  return id.split('.')[1]?.startsWith('metal') ?? false
}

/**
 * Whether a feed row belongs in the bundled catalogue: not an excluded family, not bare-metal,
 * and within the vCPU/memory ceiling. Applied BEFORE architecture classification, so a family
 * the ceiling already drops (the `u`/`u7i` high-memory family, whose names do not fit the
 * Graviton suffix rule at all) never reaches `classifyAwsArch` in the first place.
 */
export function isAwsCatalogued(row) {
  const id = row['Instance Type']
  if (!id) return false
  if (AWS_EXCLUDED_FAMILIES.has(row['Instance Family'])) return false
  if (isAwsMetal(id)) return false
  const cpu = Number(row.vCPU)
  const memoryGb = Number(String(row.Memory).replace(/\s*GiB$/i, ''))
  if (!(cpu > 0) || !(memoryGb > 0)) return false
  return cpu <= AWS_MAX_VCPU && memoryGb <= AWS_MAX_MEMORY_GIB
}

/**
 * Families the mechanical Graviton-suffix rule below is KNOWN TO GET WRONG, seeded as hard
 * errors rather than left to fail silently into `amd64`:
 *
 *  - `a1` is Graviton1 (arm64) with no `g` anywhere in the family name — the one Graviton family
 *    that predates the suffix convention.
 *  - `mac1` is Intel (amd64); `mac2` and its variants are Apple Silicon (arm64) — the same `mac`
 *    prefix means different architectures depending on the generation digit, which the suffix
 *    rule cannot see.
 *
 * NEITHER CAN APPEAR IN THIS FEED TODAY: it is Linux-only, Mac instances have no Linux "Instance
 * Type" row to speak of, and `a1` is not present in the families it currently returns (verified
 * 2026-08-21). This set exists purely so that IF one of them ever did appear, the generator
 * refuses to guess rather than silently writing `amd64` onto an ARM box.
 */
export const AWS_ARCH_EXCEPTIONS = new Set(['a1', 'mac1', 'mac2'])

/**
 * Architecture from the family name alone, at GENERATION time — never a runtime guess, and never
 * a silent default.
 *
 * THE RULE: an AWS instance family is `<letters><generation digit><letters>`, optionally
 * followed by `-<suffix>` (`c7i-flex`, `p6-b200`, `u7in-16tb` — the part after the hyphen is
 * ignored). A Graviton family has a `g` among the letters AFTER the digit (`c8g`, `m7gd`,
 * `r8gn`, `x8g`, `i8g`, `im4gn`, `hpc7g`, `g5g`); no non-Graviton family does (`g4dn`, `g6`,
 * `gr6`, `c7i-flex` — note the `g` in `gr6` and `g4dn` sits BEFORE the digit, in the product
 * line letters, which is why it does not count). Pinned in both directions in
 * `scripts/refresh-prices.test.mjs` against the real family list this feed returned on
 * 2026-08-21.
 *
 * ERRORS on anything it cannot classify — via `AWS_ARCH_EXCEPTIONS` above or because the family
 * does not fit the `<letters><digit><letters>` shape at all — rather than defaulting to amd64.
 * A hand-maintained list goes stale silently; a generator that refuses to guess fails LOUDLY,
 * the first time it runs against a family that breaks the convention. The escape hatch, if that
 * ever happens: a maintainer runs `DescribeInstanceTypes` once with their own credentials against
 * just the offending family and hardcodes that one result, rather than reintroducing a live call
 * to this generator itself (which would need a TTL cache and reopen the questions ADR-0003 and
 * the gyp1 design already closed against a live AWS catalogue).
 */
export function classifyAwsArch(id) {
  const family = id.split('.')[0].split('-')[0]

  if (AWS_ARCH_EXCEPTIONS.has(family)) {
    throw new Error(
      `aws: family '${family}' (from '${id}') is a known exception to the Graviton suffix rule and cannot be ` +
        'classified mechanically — see AWS_ARCH_EXCEPTIONS in scripts/refresh-prices.mjs.',
    )
  }

  const match = /^[a-z]+(\d+)([a-z]*)$/i.exec(family)
  if (!match) {
    throw new Error(
      `aws: family '${family}' (from '${id}') does not match <letters><generation digit><letters> — the ` +
        'Graviton suffix rule cannot classify it. Add it to AWS_ARCH_EXCEPTIONS and classify it by hand (see ' +
        "the escape hatch on classifyAwsArch's comment), or fix the pattern if AWS changed the naming shape.",
    )
  }

  return /g/i.test(match[2]) ? 'arm64' : 'amd64'
}

const AWS_OUTPUT = join(ROOT, 'packages/provider-aws/src/prices.generated.ts')
const HETZNER_OUTPUT = join(ROOT, 'packages/provider-hetzner/src/prices.generated.ts')
const AZURE_OUTPUT = join(ROOT, 'packages/provider-azure/src/prices.generated.ts')

/** The public retail feed. No key, no account — the same numbers azure.com/pricing renders. */
const AZURE_FEED = 'https://prices.azure.com/api/retail/prices'

/**
 * Azure `armRegionName` ids to price. Add a row to cover another region.
 *
 * The same geographic spread as `AWS_REGIONS` above, region for region where Azure has one:
 * three US, one Canada, one Brazil, four Europe, three Asia-Pacific. A region that is NOT on
 * this list is not an error — the provider lists its sizes with `hourly: null` ("unknown, never
 * free") because the feed's per-region map has no entry for it, exactly as AWS behaves for an
 * unlisted region.
 *
 * Unlike `AWS_REGIONS` these need no hand-mapped label: the retail feed is filtered by
 * `armRegionName` directly, and a region id that does not exist returns zero rows, which
 * `refreshAzure` treats as fatal rather than shipping a silently empty region.
 */
const AZURE_REGIONS = [
  'eastus',
  'eastus2',
  'centralus',
  'westus2',
  'canadacentral',
  'brazilsouth',
  'northeurope',
  'westeurope',
  'uksouth',
  'francecentral',
  'germanywestcentral',
  'southeastasia',
  'australiaeast',
  'japaneast',
]

/**
 * AZURE_SIZES is no longer a hand-picked list (rockysurf-o05s / issue #24 PR2b) — it is
 * DISCOVERED from the same retail feed that prices it, mechanically:
 *
 *  - a candidate's `armSkuName` must look like a real, orderable ARM SKU name at all. The feed
 *    also returns internal hardware-generation pricing artifacts that are NOT valid ARM SKU
 *    names and can never match anything `Microsoft.Compute/skus` returns — e.g. `"DCsv3 Type1"`
 *    (a literal space; ARM resource names never contain one) or `Dsv4_Type1` (no `Standard_`/
 *    `Basic_` prefix at all). `looksLikeArmSkuName` excludes these.
 *  - GPU/accelerator families are excluded by Azure's own naming convention: the `N` series
 *    letter (`NC`, `ND`, `NV`, `NM`, `NP`, …) is reserved for GPU- or FPGA-accelerated sizes.
 *    `Offering.gpu` is reserved-unpopulated and the bootstrap ships no drivers, so listing one
 *    would sell a machine dishonestly — the same reasoning PR2a used for AWS's GPU families.
 *
 * The vCPU/memory ceiling PR2a applied at generation time (AWS's feed carries `vCPU`/`Memory`
 * columns) has NO equivalent here: Azure's retail feed carries no shape fields at all — vCPU,
 * memory and architecture are read LIVE from `Microsoft.Compute/skus`, which is why that ceiling
 * is enforced in `@rockysurf/provider-azure`'s `buildOfferings` instead (see `SIZE_CEILING`
 * there), against the real numbers rather than a name guess.
 */
function looksLikeArmSkuName(armSkuName) {
  return /^(Standard|Basic)_/.test(armSkuName) && !/\s/.test(armSkuName) && !/_?[Tt]ype\d/.test(armSkuName)
}

/** Azure's GPU/FPGA-accelerated series all share the `N` family letter. */
function isAcceleratorFamily(armSkuName) {
  return /^Standard_N[A-Z]/.test(armSkuName)
}

/**
 * The hand-transcribed GCP price tables — the closest thing GCP has to a source feed.
 *
 * A PLAIN JSON FILE RATHER THAN A TS MODULE, so that fixing a transcription reaches every
 * installation through the next feed publish instead of the next release (rockysurf-ndx6,
 * ADR-0009). It carries only the NUMBERS and the date each table was read; the machine-type
 * shapes and the T2A/C4A zone lists stay bundled in `packages/provider-gcp/src/prices.generated.ts`
 * because without them there is no catalogue at all.
 */
const GCP_TRANSCRIBED = join(ROOT, 'scripts/gcp-transcribed-prices.json')

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`GET ${url} → HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  // The AWS feed is served gzipped with no content-encoding header, so `fetch` does not
  // transparently inflate it. Sniff the magic bytes rather than trusting headers.
  const body = buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer) : buffer
  return JSON.parse(body.toString('utf8'))
}

async function refreshAws({ write = true } = {}) {
  const hourly = {}
  const specs = new Map()
  let publishedAt

  for (const [regionId, label] of Object.entries(AWS_REGIONS)) {
    const feed = await fetchJson(AWS_FEED(label))
    publishedAt = feed.manifest?.hawkFilePublicationDate ?? publishedAt

    const rows = Object.values(feed.regions ?? {}).flatMap((region) => Object.values(region))
    const perRegion = {}

    for (const row of rows) {
      if (!isAwsCatalogued(row)) continue
      const id = row['Instance Type']
      perRegion[id] = Number(Number(row.price).toFixed(6))
      // Shape comes from the same row as the price, so the two cannot disagree. A type seen in
      // an earlier region keeps that spec — the shape is a fact about the hardware, not the
      // region, so the first sighting across the whole run is as good as any other.
      if (!specs.has(id)) {
        specs.set(id, {
          cpu: Number(row.vCPU),
          memoryGb: Number(String(row.Memory).replace(/\s*GiB$/i, '')),
          arch: classifyAwsArch(id),
        })
      }
    }

    hourly[regionId] = Object.fromEntries(Object.entries(perRegion).sort(([a], [b]) => a.localeCompare(b)))
  }

  const types = [...specs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, spec]) => ({ id, ...spec }))

  // ONE LINE PER TYPE, deliberately not `JSON.stringify(types, null, 2)`: at ~994 types, a
  // six-line pretty object per entry would make a nightly regen diff (one price moved, one
  // family added) unreviewable — a reviewer would see hundreds of changed lines for one changed
  // fact. One line per type means the diff IS the fact that changed.
  const typesLiteral = [
    '[',
    ...types.map(
      (t) => `  { id: ${JSON.stringify(t.id)}, cpu: ${t.cpu}, memoryGb: ${t.memoryGb}, arch: ${JSON.stringify(t.arch)} },`,
    ),
    ']',
  ].join('\n')

  const regionList = Object.keys(AWS_REGIONS).join(', ')
  const source = AWS_FEED(Object.values(AWS_REGIONS)[0])
  const contents = `// GENERATED by scripts/refresh-prices.mjs — do not edit by hand.
//
// Source: the public EC2 on-demand price feed that the AWS pricing page renders, read once per
// covered region (${regionList}).
//   ${source}
// No credentials are needed to reproduce this: re-run \`node scripts/refresh-prices.mjs\`.
//
// THE CATALOGUE ONLY — the hourly prices that used to live here as \`AWS_HOURLY_USD\` moved to
// the hosted price feed (gh issue #100, ADR-0009), republished daily by the \`price-feed\`
// workflow and read at runtime by \`feed.ts\`, so a price change no longer needs a release. The
// shapes below still ship bundled because without them there is no catalogue at all.
//
// \`fetchedAt\` is when WE read the feed this catalogue came from. \`publishedAt\` is when AWS
// published that price file. Both are recorded because they are different facts.
//
// THE CATALOGUE IS MECHANICAL, not a hand-picked family list: every type is included unless the
// feed's own classification marks it GPU/ML-ASIC/FPGA/media-accelerator, its id is bare-metal,
// or it exceeds the vCPU/memory ceiling. See AWS_EXCLUDED_FAMILIES, AWS_MAX_VCPU/
// AWS_MAX_MEMORY_GIB and classifyAwsArch in scripts/refresh-prices.mjs for the exact rules.
import type { Architecture } from '@rockysurf/provider-sdk'

export const AWS_PRICES_FETCHED_AT = '${new Date().toISOString()}'
export const AWS_PRICES_PUBLISHED_AT = ${publishedAt ? `'${publishedAt}'` : 'undefined'}
export const AWS_PRICES_SOURCE = '${source}'

export interface AwsTypeSpec {
  id: string
  cpu: number
  memoryGb: number
  arch: Architecture
}

/** Shape read from the same feed row as its price, so the two cannot disagree. */
export const AWS_TYPES: AwsTypeSpec[] = ${typesLiteral}
`

  if (write) writeFileSync(AWS_OUTPUT, contents)
  return { file: AWS_OUTPUT, types: types.length, publishedAt, contents, hourly, source }
}

/**
 * The Linux, pay-as-you-go, non-Spot meter for one VM size in one region.
 *
 * The retail feed returns EIGHT rows for a typical size and only one of them is the number a
 * Linux customer pays. The other seven are traps, and each is excluded for its own reason:
 *
 *  - `skuName` containing `Spot` or `Low Priority` — interruptible capacity at a fraction of the
 *    price, and spot is deliberately out of v0.1 (ADR-0003). Bundling one of these would
 *    advertise a machine at a third of what it actually costs.
 *  - `productName` containing `Windows` — the same hardware with a Windows licence folded in.
 *  - `productName` containing `Cloud Services` — the legacy PaaS meter, not IaaS VMs. The feed
 *    does not always spell it with a space: some products render it as one word, e.g. the real
 *    row `"Eadsv5 Series CloudServices"` for `Standard_E96-48ads_v5`. Matching only the spaced
 *    form let that CloudServices meter survive filtering and be bundled as if it were the VM
 *    price (rockysurf-o05s) — at today's 12 hand-picked sizes none happened to collide with a
 *    no-space CloudServices product, which is why it went unnoticed; at widened scale ~40 sizes
 *    did, each bundled at roughly 70% above the real Virtual Machines price. `\s*` matches both.
 *
 * A size that does not resolve to exactly one row is reported rather than guessed at, because
 * "which of these eight numbers is the price" is not a question to answer by taking the first.
 */
export function azureLinuxMeter(rows) {
  return rows.filter(
    (row) =>
      !/spot|low priority/i.test(row.skuName ?? '') &&
      !/windows/i.test(row.productName ?? '') &&
      !/cloud\s*services/i.test(row.productName ?? ''),
  )
}

/**
 * Resolve every candidate size's rows to its one pay-as-you-go Linux meter, or leave it out.
 *
 * THE RULE IS "REPORT, DON'T GUESS" (unchanged from the 12-size table); WHAT CHANGED IS THE
 * CONSEQUENCE. The hand-picked table could afford to throw and abort the whole refresh the
 * moment one size didn't resolve cleanly, because every entry was chosen by a person and an
 * anomaly there meant the feed itself had changed shape. At widened scale the candidate pool is
 * discovered mechanically and legitimately contains sizes with no clean answer today — retired
 * `*_Promo` SKUs that resolve to zero current meters, mainly — and throwing on those would make
 * a widened refresh permanently unable to complete. So a size that doesn't resolve to exactly
 * one row is EXCLUDED from the catalogue and named in `skipped`, for the caller to report; a
 * fabricated price is never written for it, which is the property this rule exists to protect.
 */
export function resolvePricedSizes(candidatesByArmSkuName) {
  const priced = {}
  const skipped = []
  for (const [id, rows] of Object.entries(candidatesByArmSkuName)) {
    const matches = azureLinuxMeter(rows)
    if (matches.length !== 1) {
      skipped.push({ id, matches: matches.length })
      continue
    }
    priced[id] = matches[0]
  }
  return { priced, skipped }
}

/**
 * The bundled size catalogue from the per-region accepted sets: THE UNION of sizes that priced
 * cleanly in ANY configured region, not the intersection of all of them (rockysurf-lodw).
 *
 * It was the intersection while `AZURE_REGIONS` held one region, where the two are the same set
 * and the choice cost nothing. Across the fourteen regions that list now covers they are very
 * different sets — measured 2026-08-25: union 1721 sizes, intersection 1097. Shipping the
 * intersection would have DELETED 532 sizes that eastus sells and prices today, a third of the
 * catalogue, from eastus users, because some other region does not stock them. Half the arm64
 * catalogue goes with it (97 sizes down to 48): `Standard_B2ps_v2`, the cheap Ampere dev box, is
 * priced in thirteen of the fourteen and absent only from brazilsouth. Azure varies what it
 * stocks per region much more than EC2 does, so "priced everywhere" is a far smaller set here.
 *
 * The intersection was never buying the honesty it looked like it was buying, either. Per-region
 * pricing honesty is enforced downstream, not here: prices live in the hosted feed's own
 * per-region map (ADR-0009), and `buildOfferings` in `@rockysurf/provider-azure` lists a size
 * with `hourly: null` — "unknown, never free" — when the configured region has no price for it.
 * And a size Azure does not sell in a region never reaches that code at all, because this list is
 * intersected with what `Microsoft.Compute/skus` reports live FOR THAT REGION. So the failure the
 * intersection guarded against cannot happen, while its cost — hiding a size from the thirteen
 * regions that do sell it because the fourteenth does not — is real. Same shape as AWS, whose
 * catalogue is likewise every type seen in any covered region.
 *
 * `everywhere` is not used for the catalogue; it is reported so a maintainer regenerating this
 * can see how far apart the two rules have drifted.
 *
 * @param acceptedByRegion region → the set of armSkuNames that priced cleanly in it
 */
export function azureCatalogue(acceptedByRegion) {
  const regions = [...acceptedByRegion.keys()]
  const sizes = [...new Set(regions.flatMap((region) => [...acceptedByRegion.get(region)]))].sort((a, b) =>
    a.localeCompare(b),
  )
  const everywhere = sizes.filter((id) => regions.every((region) => acceptedByRegion.get(region).has(id)))
  return { sizes, everywhere }
}

async function refreshAzure({ write = true } = {}) {
  const hourly = {}
  /** The oldest meter start date across everything bundled: how current these numbers are. */
  let effectiveFrom
  /** region → the set of armSkuNames that priced cleanly in it. */
  const acceptedByRegion = new Map()

  for (const region of AZURE_REGIONS) {
    const filter =
      `serviceName eq 'Virtual Machines' and armRegionName eq '${region}' and priceType eq 'Consumption'`
    let url = `${AZURE_FEED}?$filter=${encodeURIComponent(filter)}`

    /** armSkuName → every meter the feed returned for it, before the Linux filter. */
    const candidates = {}
    // PAGE GUARD, not a page budget. Measured 2026-08-25 across all fourteen regions: the feed
    // returns ~1000 rows a page and a region carries 6,200-8,800 VM meter rows, so 7-9 pages —
    // 200 is roughly twenty times the largest real region. Running out of guard means the feed
    // changed shape (a smaller page size, or a filter that stopped filtering), and that throws
    // below rather than quietly shipping a region missing most of its sizes.
    for (let page = 0; url && page < 200; page++) {
      const body = await fetchJson(url)
      for (const item of body.Items ?? []) {
        const id = (item.armSkuName ?? '').trim()
        if (!id || !looksLikeArmSkuName(id) || isAcceleratorFamily(id)) continue
        ;(candidates[id] ??= []).push(item)
      }
      url = body.NextPageLink
    }
    if (url) {
      throw new Error(
        `azure: ${region} still had pages after the 200-page guard — the retail feed changed shape. ` +
          'Raise the guard once you know why, rather than shipping a truncated region.',
      )
    }

    const { priced, skipped } = resolvePricedSizes(candidates)

    // A whole-region shape break (the feed itself stopped returning anything sensible) is worth
    // aborting for, same as the old per-size throw did — it is the one case that is NOT routine
    // SKU-level noise. A handful of individually unpriceable SKUs (retired `*_Promo` meters,
    // mainly) is routine, and is reported below rather than treated as failure.
    if (Object.keys(priced).length === 0) {
      throw new Error(`azure: ${region} priced zero VM sizes from the feed — it changed shape; fix the filter.`)
    }
    if (skipped.length > 0) {
      console.log(
        `azure: ${region}: excluded ${skipped.length} candidate size(s) with 0 or >1 pay-as-you-go Linux meters ` +
          `(reported, not guessed): ${skipped.map((s) => `${s.id}(${s.matches})`).join(', ')}`,
      )
    }

    const perRegion = {}
    for (const [id, meter] of Object.entries(priced)) {
      perRegion[id] = Number(Number(meter.retailPrice).toFixed(6))
      if (!effectiveFrom || meter.effectiveStartDate < effectiveFrom) effectiveFrom = meter.effectiveStartDate
    }

    acceptedByRegion.set(region, new Set(Object.keys(priced)))
    hourly[region] = Object.fromEntries(Object.entries(perRegion).sort(([a], [b]) => a.localeCompare(b)))
  }

  const { sizes, everywhere } = azureCatalogue(acceptedByRegion)
  console.log(
    `azure: catalogue is ${sizes.length} size(s) priced in at least one of ${acceptedByRegion.size} region(s); ` +
      `${everywhere.length} priced in all of them`,
  )

  const contents = `// GENERATED by \`node scripts/refresh-prices.mjs --azure\` — do not edit by hand.
//
// Source: the public Azure Retail Prices API, which needs no credentials and no Azure account.
//   ${AZURE_FEED}
// Reproduce with: node scripts/refresh-prices.mjs --azure
//
// PAY-AS-YOU-GO LINUX ONLY. The feed returns eight meters for a typical size — Spot, Low
// Priority, Windows and Cloud Services variants of each — and only one is what a Linux customer
// pays. A size that does not resolve to exactly one such meter is EXCLUDED from this table and
// reported on stderr when regenerating, rather than guessed at (rockysurf-o05s).
//
// THE CATALOGUE ITSELF IS DISCOVERED, not hand-picked: every armSkuName the feed returns, minus
// internal pricing artifacts that are not real ARM SKU names, minus the GPU/accelerator (N-series)
// families, minus whatever does not resolve to exactly one meter above. See
// \`looksLikeArmSkuName\`/\`isAcceleratorFamily\` in this script. It is the UNION across the
// ${AZURE_REGIONS.length} priced regions — a size priced in any of them is catalogued, and a region that does not
// sell it simply never lists it, because this list is intersected with what
// \`Microsoft.Compute/skus\` reports live for the configured region. The vCPU/memory ceiling PR2a
// applied to AWS at generation time has no equivalent here — Azure's feed carries no shape data at
// all, so that ceiling is enforced in \`@rockysurf/provider-azure\`'s \`buildOfferings\` instead,
// against the live numbers Azure actually reports.
//
// THE CATALOGUE ONLY — the hourly prices that used to live here as \`AZURE_HOURLY_USD\` moved
// to the hosted price feed (gh issue #100, ADR-0009), republished daily by the \`price-feed\`
// workflow and read at runtime by \`feed.ts\`, so a price change no longer needs a release.
//
// \`fetchedAt\` is when WE read the retail feed this catalogue came from. \`effectiveFrom\` is
// the oldest meter start date across that read. Both are recorded because they are different
// facts.
//
// Only the size LIST is bundled. A size's vCPU, memory and architecture are read live from
// Microsoft.Compute/skus by the provider, on the same call that reports per-subscription
// availability, so a shape here could never disagree with what Azure will actually sell.

export const AZURE_PRICES_FETCHED_AT = '${new Date().toISOString()}'
export const AZURE_PRICES_EFFECTIVE_FROM = '${effectiveFrom}'
export const AZURE_PRICES_SOURCE = '${AZURE_FEED}'

/** The sizes this provider offers. Anything else is not in the catalogue at all. */
export const AZURE_SIZES: string[] = ${JSON.stringify(sizes, null, 2)}
`

  if (write) writeFileSync(AZURE_OUTPUT, contents)
  return { file: AZURE_OUTPUT, sizes: sizes.length, regions: AZURE_REGIONS.length, effectiveFrom, contents, hourly }
}

async function refreshHetzner() {
  const token = process.env.HETZNER_TOKEN
  if (!token) throw new Error('HETZNER_TOKEN is required for --hetzner (it is optional; see the header)')

  const headers = { authorization: `Bearer ${token}` }
  const pricing = await fetchJson('https://api.hetzner.cloud/v1/pricing', headers)
  const currency = pricing.pricing?.currency ?? 'EUR'

  const hourly = {}
  let page = 1
  for (;;) {
    const body = await fetchJson(`https://api.hetzner.cloud/v1/server_types?page=${page}&per_page=50`, headers)
    for (const type of body.server_types ?? []) {
      for (const price of type.prices ?? []) {
        hourly[type.name] ??= {}
        hourly[type.name][price.location] = Number(Number(price.price_hourly.net).toFixed(6))
      }
    }
    const next = body.meta?.pagination?.next_page
    if (!next) break
    page = next
  }

  const sorted = Object.fromEntries(
    Object.entries(hourly)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, locations]) => [id, Object.fromEntries(Object.entries(locations).sort(([a], [b]) => a.localeCompare(b)))]),
  )

  const contents = `// GENERATED by scripts/refresh-prices.mjs --hetzner — do not edit by hand.
//
// FALLBACK ONLY. This provider reads prices LIVE from \`GET /server_types\`, which returns them
// inline on the call \`listOfferings()\` already makes, so this table is consulted only when a
// type carries no price for the configured location. See packages/provider-hetzner/README.md.
//
// Amounts are VAT-exclusive, in the project's billing currency at the time of the fetch.
import type { PriceTable } from './prices.js'

export const BUNDLED_PRICES: PriceTable = {
  fetchedAt: '${new Date().toISOString()}',
  currency: '${currency}',
  hourly: ${JSON.stringify(sorted, null, 2).split('\n').join('\n  ')},
}
`
  writeFileSync(HETZNER_OUTPUT, contents)
  return { file: HETZNER_OUTPUT, types: Object.keys(sorted).length, currency }
}

/**
 * Turn the hand-transcribed GCP tables into the feed's normalized document (rockysurf-ndx6).
 *
 * THE HONESTY RULE THIS FUNCTION EXISTS TO ENFORCE: a GCP price's date is the day a PERSON READ
 * IT off Google's pricing page, and nothing here may move it. `price-feed.yml` republishes every
 * document daily; if `fetchedAt` were stamped at publish time — as it legitimately is for AWS and
 * Azure, whose numbers really are re-fetched on each run — a two-week-old transcription would
 * present itself as this morning's price, and the UI's "estimate based on prices as of …" label
 * would be actively lying. So:
 *
 *  - `fetchedAt` is the OLDEST table's date. It is the document-level floor: no number in this
 *    document is older than it, and none is misreported as newer by a reader that ignores the
 *    per-row stamps.
 *  - `transcribedAt` — GCP's one provider-specific provenance stamp, the slot ADR-0009 gives
 *    AWS's `publishedAt` and Azure's `effectiveFrom` — carries machine type → the date THAT row
 *    was read. The c4a-standard-* rows were transcribed eight days after the e2/t2a ones, and
 *    `provider-gcp`'s `buildOfferings` stamps each price from this map, so a c4a price still
 *    reports 2026-08-21 rather than borrowing a day nobody looked at it.
 *
 * A type appearing in two tables is a THROW rather than a last-write-wins merge: two dates for
 * one number means the transcription is ambiguous, and a feed publisher must not pick one.
 */
export function buildGcpFeedDoc(transcribed) {
  const tables = transcribed.tables ?? []
  if (tables.length === 0) throw new Error('gcp: no transcribed price tables')

  const regions = {}
  const transcribedAt = {}
  for (const table of tables) {
    if (!table.fetchedAt) throw new Error('gcp: a transcribed table has no fetchedAt — see scripts/gcp-transcribed-prices.json')
    for (const [region, prices] of Object.entries(table.regions ?? {})) {
      regions[region] ??= {}
      for (const [type, amount] of Object.entries(prices)) {
        if (transcribedAt[type] !== undefined) {
          throw new Error(`gcp: ${type} is transcribed in two tables (${transcribedAt[type]} and ${table.fetchedAt}) — one price, one date`)
        }
        if (!Number.isFinite(amount) || amount <= 0) throw new Error(`gcp: ${region}/${type} is not a price: ${amount}`)
        regions[region][type] = amount
        transcribedAt[type] = table.fetchedAt
      }
    }
  }

  const oldest = tables.map((t) => t.fetchedAt).sort()[0]
  return {
    schemaVersion: 1,
    provider: 'gcp',
    // NOT `new Date()`. See the honesty rule above.
    fetchedAt: oldest,
    transcribedAt,
    source: transcribed.source,
    currency: transcribed.currency,
    regions,
  }
}

/**
 * Emit the hosted price feed (gh issue #100): the JSON documents the `price-feed` workflow
 * publishes to GitHub Pages, which installed copies of Rocky Surf read at runtime.
 *
 * Same fetches as the TS modes above, different destination. The shape is NORMALIZED — one
 * document per provider with identical keys (`schemaVersion`, `provider`, `fetchedAt`,
 * `source`, `currency`, `regions`) plus at most a provider-specific provenance stamp
 * (`publishedAt` for AWS, `effectiveFrom` for Azure, `transcribedAt` for GCP) — so the read side
 * needs no provider-specific parsing. The path is VERSIONED (`prices/v1/`): a breaking schema
 * change is a new `/v2/` directory, never a rewrite under old installs' feet.
 *
 * GCP IS THE ONE DOCUMENT THIS FUNCTION DOES NOT FETCH (rockysurf-ndx6). Its numbers are read
 * off a file in this repository rather than off Google, because Google publishes no
 * credential-free feed — so its `fetchedAt` is a transcription date and stays put while the
 * other two move with each run. That asymmetry is the honest one: see `buildGcpFeedDoc`.
 */
async function writeFeed(outdir) {
  const aws = await refreshAws({ write: false })
  const azure = await refreshAzure({ write: false })
  const gcp = buildGcpFeedDoc(JSON.parse(readFileSync(GCP_TRANSCRIBED, 'utf8')))

  const docs = {
    'aws.json': {
      schemaVersion: 1,
      provider: 'aws',
      fetchedAt: new Date().toISOString(),
      publishedAt: aws.publishedAt,
      source: aws.source,
      currency: 'USD',
      regions: aws.hourly,
    },
    'azure.json': {
      schemaVersion: 1,
      provider: 'azure',
      fetchedAt: new Date().toISOString(),
      effectiveFrom: azure.effectiveFrom,
      source: AZURE_FEED,
      currency: 'USD',
      regions: azure.hourly,
    },
    'gcp.json': gcp,
  }
  // The index is for HUMANS AND TOOLING POKING AROUND, not for Rocky Surf — the runtime
  // readers are handed their provider's document URL directly and never fetch this. So it
  // says where the actual data is, rather than assuming the visitor already knows.
  const summaries = Object.entries(docs).map(([document, doc]) => ({
    provider: doc.provider,
    document,
    fetchedAt: doc.fetchedAt,
    regions: Object.keys(doc.regions).length,
    entries: Object.values(doc.regions).reduce((n, table) => n + Object.keys(table).length, 0),
  }))
  docs['index.json'] = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    note: 'Rocky Surf hosted price feed. The prices are in the per-provider documents listed under providers[].document.',
    providers: summaries,
  }

  mkdirSync(outdir, { recursive: true })
  for (const [name, doc] of Object.entries(docs)) {
    writeFileSync(join(outdir, name), `${JSON.stringify(doc, null, 1)}\n`)
  }
  // A browser visit to the directory gets this instead of raw JSON: what the feed is, where
  // the documents are, how fresh they are. Static — the numbers are baked in at generation,
  // so the page needs no script and works wherever the JSON documents are mirrored.
  writeFileSync(join(outdir, 'index.html'), feedIndexHtml(summaries))
  return {
    outdir,
    awsTypes: aws.types,
    azureSizes: azure.sizes,
    gcpTypes: Object.keys(gcp.transcribedAt).length,
    gcpFetchedAt: gcp.fetchedAt,
  }
}

/** The human-readable face of the feed directory. */
function feedIndexHtml(summaries) {
  const rows = summaries
    .map(
      (s) =>
        `      <tr><td><a href="${s.document}">${s.document}</a></td><td>${s.provider}</td>` +
        `<td>${s.regions}</td><td>${s.entries}</td><td>${s.fetchedAt}</td></tr>`,
    )
    .join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rocky Surf price feed</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 44rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #ccc; font-variant-numeric: tabular-nums; }
  code { background: rgba(127,127,127,.15); padding: .1em .3em; border-radius: 3px; }
</style>
</head>
<body>
  <h1>Rocky Surf price feed</h1>
  <p>Machine-readable hourly prices for the clouds <a href="https://github.com/amroja-biz/rockysurf">Rocky Surf</a>
  manages, regenerated daily from the providers' public pricing feeds. Installed copies of Rocky Surf
  read these documents at runtime, so cost estimates stay current without a release
  (<a href="https://github.com/amroja-biz/rockysurf/blob/main/docs/adr/0009-prices-served-from-hosted-feed.md">ADR-0009</a>).</p>
  <table>
    <thead><tr><th>Document</th><th>Provider</th><th>Regions</th><th>Prices</th><th>Fetched</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <p>Each document is <code>{ schemaVersion, provider, fetchedAt, source, currency, regions }</code>,
  where <code>regions</code> maps region &rarr; machine type &rarr; hourly price. A machine-readable
  listing of this directory is <a href="index.json"><code>index.json</code></a>.</p>
  <p><strong>GCP&rsquo;s dates are older than today on purpose.</strong> Google publishes no
  credential-free price feed, so <code>gcp.json</code> carries numbers a person read off
  <a href="https://cloud.google.com/products/compute/pricing/general-purpose">Google&rsquo;s pricing page</a>
  by hand. Its <code>fetchedAt</code> is the day that reading happened and does not move when this
  directory is republished &mdash; a daily publish must not present a hand-copied number as fresh.
  Rows transcribed on different days keep their own dates in <code>transcribedAt</code>, which is
  the date a Rocky Surf install shows beside a GCP estimate.</p>
</body>
</html>
`
}

/**
 * GCP: report the Cloud Billing Catalog, and deliberately do NOT rewrite the table.
 *
 * THIS MODE IS A READING AID, NOT A GENERATOR, and the asymmetry with the AWS path above is a
 * fact about Google's pricing surface rather than an unfinished job. That did not change when
 * the numbers moved out of `prices.generated.ts` and into `scripts/gcp-transcribed-prices.json`
 * (rockysurf-ndx6): moving to the feed fixed the DELIVERY of the transcription, not its
 * provenance, so what this mode may safely do is still "print, and let a person decide". Three
 * things, in the order they constrain the design:
 *
 * 1. **There is no credential-free feed.** Verified 2026-08-13: the old
 *    `cloudpricingcalculator.appspot.com/static/data/pricelist.json` is HTTP 404, and
 *    `cloudbilling.googleapis.com/.../skus` is HTTP 403 without a key. So unlike AWS, nothing
 *    here can run in CI or on a contributor's machine unprompted — which is exactly why
 *    `--feed` reads GCP's numbers off disk instead of calling this.
 * 2. **An API key is enough** — not full OAuth — which is the same shape as the Hetzner path
 *    needing a project token, hence the same opt-in treatment.
 * 3. **The Catalog prices COMPONENTS, not machine types.** Compute Engine SKUs are "E2 Instance
 *    Core running in Americas" and "E2 Instance Ram running in Americas", and predefined
 *    machine types are a SEPARATE, CHEAPER SKU set. Summing the component rates for
 *    e2-standard-2 gives ≈0.070362/hour against a published 0.06701142 — about 5% high. A
 *    script that wrote that into the bundled table would replace a careful transcription with a
 *    confidently wrong number that nobody would think to check, which is exactly the failure
 *    the `fetchedAt` stamp exists to make visible.
 *
 * So this prints what the Catalog says beside what is transcribed, and leaves the decision to a
 * person. If Google ever publishes per-machine-type SKUs, this becomes a generator writing
 * `scripts/gcp-transcribed-prices.json` and the comment goes away.
 */
const GCP_COMPUTE_SERVICE = '6F81-5844-456A'

async function reportGcp() {
  const key = process.env.GCP_BILLING_API_KEY
  if (!key) {
    throw new Error(
      'GCP_BILLING_API_KEY is required for --gcp. Google publishes no credential-free price feed, so this ' +
        'mode needs an API key for the Cloud Billing Catalog API (no IAM permissions required; enable the ' +
        'Cloud Billing API on any project and mint a key). See packages/provider-gcp/src/prices.generated.ts.',
    )
  }

  const region = process.env.GCP_REGION ?? 'us-central1'
  const wanted = /(E2|T2A) Instance (Core|Ram)/i

  const rows = []
  let pageToken = ''
  for (let guard = 0; guard < 50; guard++) {
    const url =
      `https://cloudbilling.googleapis.com/v1/services/${GCP_COMPUTE_SERVICE}/skus` +
      `?key=${encodeURIComponent(key)}&pageSize=5000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
    const body = await fetchJson(url)

    for (const sku of body.skus ?? []) {
      if (!wanted.test(sku.description ?? '')) continue
      if (!(sku.serviceRegions ?? []).includes(region)) continue
      // Tiered rates; the first tier is the on-demand one for these SKUs.
      const tier = sku.pricingInfo?.[0]?.pricingExpression?.tieredRates?.[0]?.unitPrice
      if (!tier) continue
      const amount = Number(tier.units ?? 0) + Number(tier.nanos ?? 0) / 1e9
      rows.push({
        description: sku.description,
        usage: sku.pricingInfo?.[0]?.pricingExpression?.usageUnitDescription,
        amount,
      })
    }

    if (!body.nextPageToken) break
    pageToken = body.nextPageToken
  }

  const transcribed = JSON.parse(readFileSync(GCP_TRANSCRIBED, 'utf8'))

  console.log(`gcp: ${rows.length} component SKU(s) for ${region} from the Cloud Billing Catalog\n`)
  for (const row of rows.sort((a, b) => a.description.localeCompare(b.description))) {
    console.log(`  ${row.amount.toFixed(9)}  per ${row.usage ?? '?'}  ${row.description}`)
  }

  console.log(`\ngcp: the transcribed tables in ${GCP_TRANSCRIBED}`)
  for (const table of transcribed.tables ?? []) {
    const types = Object.values(table.regions ?? {}).flatMap((prices) => Object.keys(prices))
    console.log(`     read ${table.fetchedAt} from Google's published pricing page: ${types.sort().join(', ')}`)
  }
  console.log("     Those dates are what installs see; they move only when somebody re-reads the page.")
  console.log('\nTHESE ARE NOT DIRECTLY COMPARABLE, and this mode does not rewrite the table.')
  console.log('Predefined machine types (e2-standard-2, t2a-standard-2, …) are priced as their OWN SKUs,')
  console.log('cheaper than the sum of the per-core and per-GiB component rates printed above — summing')
  console.log('them for e2-standard-2 overstates the published price by about 5%. Use this output to')
  console.log('sanity-check magnitude and currency; refresh the transcribed numbers from the pricing page,')
  console.log(`editing ${GCP_TRANSCRIBED} and moving that table's fetchedAt to the day you read it.`)

  return { rows: rows.length, region }
}

// Guarded so the exported helpers above (`azureLinuxMeter`, `resolvePricedSizes`, the AWS
// classification/filter functions) can be imported by a test without also firing off network
// calls or exiting the process — this file is both the CLI entry point and, since rockysurf-o05s
// and rockysurf-tzzw, a module other code imports from.
if (import.meta.main) {
  const args = process.argv.slice(2)

  // `--check` is gone with the price-drift job it served (gh issue #100, ADR-0009): the
  // bundled files hold only the CATALOGUE now, prices ship via `--feed`, and a catalogue-only
  // refresh is a deliberate maintainer act rather than something CI diff-polices nightly.
  if (args.includes('--check')) {
    console.error('--check was removed: prices are no longer bundled, so there is no table to drift. See ADR-0009.')
    process.exit(1)
  }

  try {
    if (args.includes('--hetzner')) {
      const result = await refreshHetzner()
      console.log(`hetzner: ${result.types} types (${result.currency}) → ${result.file}`)
    } else if (args.includes('--gcp')) {
      // A REPORT rather than a refresh: it reads Google's Cloud Billing Catalog and prints what it
      // found beside the bundled stamp, and deliberately rewrites nothing.
      await reportGcp()
    } else if (args.includes('--feed')) {
      const outdir = args[args.indexOf('--feed') + 1]
      if (!outdir || outdir.startsWith('--')) throw new Error('--feed requires an output directory')
      const result = await writeFeed(outdir)
      console.log(
        `feed: aws (${result.awsTypes} types) + azure (${result.azureSizes} sizes) + ` +
          `gcp (${result.gcpTypes} types, transcribed, oldest read ${result.gcpFetchedAt}) → ` +
          `${result.outdir}/{index,aws,azure,gcp}.json`,
      )
    } else if (args.includes('--azure')) {
      const result = await refreshAzure()
      console.log(`azure: ${result.sizes} sizes × ${result.regions} region(s) → ${result.file}`)
      console.log(`       oldest meter in this table took effect ${result.effectiveFrom}`)
    } else {
      const result = await refreshAws()
      console.log(`aws: ${result.types} types → ${result.file}`)
      console.log(`     AWS published this price file at ${result.publishedAt}`)
    }
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error))
    process.exit(1)
  }
}
