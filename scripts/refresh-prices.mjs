#!/usr/bin/env node
/**
 * Refresh the bundled price tables (rockysurf-gyp1.3).
 *
 * Run by a maintainer, never at runtime. Live pricing APIs are out of v0 (ADR-0003), so prices
 * ship bundled and stamped with `fetchedAt` — which is the only thing that lets the UI say
 * "estimate based on prices as of …" instead of implying a number is current. This script is
 * what keeps that stamp from going stale silently: drift is one command away from a fix.
 *
 *   node scripts/refresh-prices.mjs              # AWS only; no credentials needed
 *   node scripts/refresh-prices.mjs --check      # fail if the on-disk table is out of date
 *   node scripts/refresh-prices.mjs --azure      # also credential-free
 *   node scripts/refresh-prices.mjs --azure --check
 *   HETZNER_TOKEN=… node scripts/refresh-prices.mjs --hetzner
 *
 * PROVENANCE, per provider:
 *
 *  - **AWS** — the public price feed behind the EC2 on-demand pricing page. No credentials, no
 *    AWS account, no SDK. It is the same JSON calculator.aws renders, so the numbers match what
 *    a customer sees on the page. Its `manifest.hawkFilePublicationDate` is recorded alongside
 *    the fetch time, because those are different facts: when AWS published, and when we looked.
 *
 *  - **Azure** — the public Retail Prices API, `https://prices.azure.com/api/retail/prices`.
 *    Also credential-free, so anyone can reproduce the numbers in this repository, which is why
 *    it supports `--check` the way AWS does. Only the price is bundled: a VM size's vCPU and
 *    memory are read LIVE from `Microsoft.Compute/skus` by the provider itself, from the same
 *    call that reports per-subscription availability, so a shape can never disagree with what
 *    Azure will actually sell.
 *
 *  - **Hetzner** — OPTIONAL, and off by default. Hetzner returns prices inline on
 *    `GET /server_types`, the very call `listOfferings()` already makes, so that provider reads
 *    them live and the bundled table is only a fallback for when a type carries no price for
 *    the configured location. Refreshing it needs a project token, which is why it is opt-in
 *    rather than part of the default run.
 *
 *  - **GCP** — OPTIONAL, and it REPORTS rather than REWRITES. See the long comment on
 *    `reportGcp()` for why: Google publishes no credential-free price feed, and the Cloud
 *    Billing Catalog API prices machine types by COMPONENT SKUs that do not reproduce the
 *    published predefined-machine-type prices. A mode that summed them would generate a
 *    confidently wrong number, which is worse than the transcription it would replace.
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The feed the EC2 on-demand pricing page itself renders. */
const AWS_FEED = (regionLabel) =>
  'https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/' +
  `${encodeURIComponent(regionLabel)}/Linux/index.json`

/** AWS region id → the label the feed is keyed by. Add a row to support another region. */
const AWS_REGIONS = {
  'us-east-1': 'US East (N. Virginia)',
}

/** Families worth bundling. Everything else reports `hourly: null` — "unknown, never free". */
const AWS_FAMILIES = ['t4g', 't3']

const AWS_OUTPUT = join(ROOT, 'packages/provider-aws/src/prices.generated.ts')
const HETZNER_OUTPUT = join(ROOT, 'packages/provider-hetzner/src/prices.generated.ts')
const AZURE_OUTPUT = join(ROOT, 'packages/provider-azure/src/prices.generated.ts')

/** The public retail feed. No key, no account — the same numbers azure.com/pricing renders. */
const AZURE_FEED = 'https://prices.azure.com/api/retail/prices'

/** Azure region ids to bundle. Add a row to support another region. */
const AZURE_REGIONS = ['eastus']

/**
 * The VM sizes Rocky Surf offers on Azure, chosen to mirror the AWS t4g/t3 pairing: a burstable
 * family and a general-purpose one, in both architectures.
 *
 * `p` in an Azure size name means Ampere Altra (arm64); `Bpsv2`/`Dpsv5` are the ARM halves of
 * `Bsv2`/`Dsv5`. This list is the CATALOGUE, not a recommendation — the provider resolves a
 * t-shirt size against requirements, and a selector can only rule out a machine it can see.
 */
const AZURE_SIZES = [
  'Standard_B2ls_v2',
  'Standard_B2s_v2',
  'Standard_B4ls_v2',
  'Standard_B4s_v2',
  'Standard_B2pls_v2',
  'Standard_B2ps_v2',
  'Standard_B4pls_v2',
  'Standard_B4ps_v2',
  'Standard_D2s_v5',
  'Standard_D4s_v5',
  'Standard_D2ps_v5',
  'Standard_D4ps_v5',
]

const GCP_OUTPUT = join(ROOT, 'packages/provider-gcp/src/prices.generated.ts')

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
      const id = row['Instance Type']
      if (!id || !AWS_FAMILIES.includes(id.split('.')[0])) continue
      perRegion[id] = Number(Number(row.price).toFixed(6))
      // Shape comes from the same row as the price, so the two cannot disagree.
      specs.set(id, {
        cpu: Number(row.vCPU),
        memoryGb: Number(String(row.Memory).replace(/\s*GiB$/i, '')),
        arch: id.startsWith('t4g') ? 'arm64' : 'amd64',
      })
    }

    hourly[regionId] = Object.fromEntries(Object.entries(perRegion).sort(([a], [b]) => a.localeCompare(b)))
  }

  const types = [...specs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, spec]) => ({ id, ...spec }))

  const source = AWS_FEED(Object.values(AWS_REGIONS)[0])
  const contents = `// GENERATED by scripts/refresh-prices.mjs — do not edit by hand.
//
// Source: the public EC2 on-demand price feed that the AWS pricing page renders.
//   ${source}
// No credentials are needed to reproduce this: re-run \`node scripts/refresh-prices.mjs\`.
//
// \`fetchedAt\` is when WE read it. \`publishedAt\` is when AWS published that price file. Both
// are recorded because they are different facts, and the second is the one that says how
// current the numbers themselves are.
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

/** Shape read from the same feed row as the price, so the two cannot disagree. */
export const AWS_TYPES: AwsTypeSpec[] = ${JSON.stringify(types, null, 2).replace(/"([a-zA-Z]+)":/g, '$1:')}

/** region → instance type → USD/hour, on-demand Linux, VAT/tax exclusive. */
export const AWS_HOURLY_USD: Record<string, Record<string, number>> = ${JSON.stringify(hourly, null, 2)}
`

  if (write) writeFileSync(AWS_OUTPUT, contents)
  return { file: AWS_OUTPUT, types: types.length, publishedAt, contents }
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
 *  - `productName` containing `Cloud Services` — the legacy PaaS meter, not IaaS VMs.
 *
 * A size that does not resolve to exactly one row is reported rather than guessed at, because
 * "which of these eight numbers is the price" is not a question to answer by taking the first.
 */
function azureLinuxMeter(rows) {
  return rows.filter(
    (row) =>
      !/spot|low priority/i.test(row.skuName ?? '') &&
      !/windows/i.test(row.productName ?? '') &&
      !/cloud services/i.test(row.productName ?? ''),
  )
}

async function refreshAzure({ write = true } = {}) {
  const hourly = {}
  /** The oldest meter start date across everything bundled: how current these numbers are. */
  let effectiveFrom

  for (const region of AZURE_REGIONS) {
    const filter =
      `serviceName eq 'Virtual Machines' and armRegionName eq '${region}' and priceType eq 'Consumption'`
    let url = `${AZURE_FEED}?$filter=${encodeURIComponent(filter)}`

    /** armSkuName → every meter the feed returned for it, before the Linux filter. */
    const candidates = {}
    // The feed pages 100 rows at a time and a region carries a few hundred pages of VM meters;
    // the guard is a hard stop rather than an expectation.
    for (let page = 0; url && page < 200; page++) {
      const body = await fetchJson(url)
      for (const item of body.Items ?? []) {
        if (!AZURE_SIZES.includes(item.armSkuName)) continue
        ;(candidates[item.armSkuName] ??= []).push(item)
      }
      url = body.NextPageLink
    }

    const perRegion = {}
    for (const size of AZURE_SIZES) {
      const matches = azureLinuxMeter(candidates[size] ?? [])
      if (matches.length !== 1) {
        throw new Error(
          `azure: ${size} in ${region} resolved to ${matches.length} pay-as-you-go Linux meters, expected 1. ` +
            'The feed changed shape; fix the filter rather than picking one.',
        )
      }
      const meter = matches[0]
      perRegion[size] = Number(Number(meter.retailPrice).toFixed(6))
      if (!effectiveFrom || meter.effectiveStartDate < effectiveFrom) effectiveFrom = meter.effectiveStartDate
    }

    hourly[region] = Object.fromEntries(Object.entries(perRegion).sort(([a], [b]) => a.localeCompare(b)))
  }

  const contents = `// GENERATED by \`node scripts/refresh-prices.mjs --azure\` — do not edit by hand.
//
// Source: the public Azure Retail Prices API, which needs no credentials and no Azure account.
//   ${AZURE_FEED}
// Reproduce with: node scripts/refresh-prices.mjs --azure
//
// PAY-AS-YOU-GO LINUX ONLY. The feed returns eight meters for a typical size — Spot, Low
// Priority, Windows and Cloud Services variants of each — and only one is what a Linux customer
// pays. The generator refuses to write a size that does not resolve to exactly one such meter,
// rather than taking the first row and advertising a machine at a third of its price.
//
// \`fetchedAt\` is when WE read it. \`effectiveFrom\` is the oldest meter start date across this
// table, which is what says how current the numbers themselves are. Both are recorded because
// they are different facts.
//
// Only the PRICE is bundled. A size's vCPU and memory are read live from Microsoft.Compute/skus
// by the provider, on the same call that reports per-subscription availability, so a shape here
// could never disagree with what Azure will actually sell.

export const AZURE_PRICES_FETCHED_AT = '${new Date().toISOString()}'
export const AZURE_PRICES_EFFECTIVE_FROM = '${effectiveFrom}'
export const AZURE_PRICES_SOURCE = '${AZURE_FEED}'

/** The sizes this provider offers. Anything else is not in the catalogue at all. */
export const AZURE_SIZES: string[] = ${JSON.stringify(AZURE_SIZES, null, 2)}

/** region → VM size → USD/hour, pay-as-you-go Linux, tax exclusive. */
export const AZURE_HOURLY_USD: Record<string, Record<string, number>> = ${JSON.stringify(hourly, null, 2)}
`

  if (write) writeFileSync(AZURE_OUTPUT, contents)
  return { file: AZURE_OUTPUT, sizes: AZURE_SIZES.length, regions: AZURE_REGIONS.length, effectiveFrom, contents }
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
 * Compare a freshly-fetched table against the one on disk, without writing either.
 *
 * Never writes: a `--check` that clobbers the file it is checking would leave the tree dirty if
 * it were interrupted, and CI runs this on a clean checkout. The fetch stamp is stripped before
 * comparing, because it changes on every run by construction and a stamp-only difference is not
 * drift.
 */
async function checkTable(label, output, refresh, stampPattern) {
  const before = (() => {
    try {
      return readFileSync(output, 'utf8')
    } catch {
      return ''
    }
  })()
  const { contents } = await refresh({ write: false })

  const strip = (text) => text.replace(stampPattern, '')
  if (strip(before) !== strip(contents)) {
    console.error(`${label}: bundled prices are OUT OF DATE — run without --check to refresh`)
    process.exit(1)
  }
  console.log(`${label}: bundled prices are current`)
}

/**
 * GCP: report the Cloud Billing Catalog, and deliberately do NOT rewrite the table.
 *
 * THIS MODE IS A READING AID, NOT A GENERATOR, and the asymmetry with the AWS path above is a
 * fact about Google's pricing surface rather than an unfinished job. Three things, in the order
 * they constrain the design:
 *
 * 1. **There is no credential-free feed.** Verified 2026-08-13: the old
 *    `cloudpricingcalculator.appspot.com/static/data/pricelist.json` is HTTP 404, and
 *    `cloudbilling.googleapis.com/.../skus` is HTTP 403 without a key. So unlike AWS, nothing
 *    here can run in CI or on a contributor's machine unprompted.
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
 * So this prints what the Catalog says beside what is bundled, and leaves the decision to a
 * person. If Google ever publishes per-machine-type SKUs, this becomes a generator and the
 * comment goes away.
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

  const bundled = readFileSync(GCP_OUTPUT, 'utf8')
  const stamp = /GCP_PRICES_FETCHED_AT = '([^']*)'/.exec(bundled)?.[1] ?? 'unknown'

  console.log(`gcp: ${rows.length} component SKU(s) for ${region} from the Cloud Billing Catalog\n`)
  for (const row of rows.sort((a, b) => a.description.localeCompare(b.description))) {
    console.log(`  ${row.amount.toFixed(9)}  per ${row.usage ?? '?'}  ${row.description}`)
  }

  console.log(`\ngcp: the bundled table in ${GCP_OUTPUT}`)
  console.log(`     was read on ${stamp} from Google's published pricing page.`)
  console.log('\nTHESE ARE NOT DIRECTLY COMPARABLE, and this mode does not rewrite the table.')
  console.log('Predefined machine types (e2-standard-2, t2a-standard-2, …) are priced as their OWN SKUs,')
  console.log('cheaper than the sum of the per-core and per-GiB component rates printed above — summing')
  console.log('them for e2-standard-2 overstates the published price by about 5%. Use this output to')
  console.log('sanity-check magnitude and currency; refresh the bundled numbers from the pricing page.')

  return { rows: rows.length, region }
}

const args = process.argv.slice(2)
const check = args.includes('--check')

try {
  if (args.includes('--hetzner')) {
    const result = await refreshHetzner()
    console.log(`hetzner: ${result.types} types (${result.currency}) → ${result.file}`)
  } else if (args.includes('--gcp')) {
    // A REPORT rather than a refresh: it reads Google's Cloud Billing Catalog and prints what it
    // found beside the bundled stamp, and deliberately rewrites nothing — so `--check` has no
    // table to compare and does not apply here.
    await reportGcp()
  } else if (args.includes('--azure')) {
    if (check) {
      await checkTable('azure', AZURE_OUTPUT, refreshAzure, /AZURE_PRICES_FETCHED_AT = '[^']*'/)
    } else {
      const result = await refreshAzure()
      console.log(`azure: ${result.sizes} sizes × ${result.regions} region(s) → ${result.file}`)
      console.log(`       oldest meter in this table took effect ${result.effectiveFrom}`)
    }
  } else if (check) {
    await checkTable('aws', AWS_OUTPUT, refreshAws, /AWS_PRICES_FETCHED_AT = '[^']*'/)
  } else {
    const result = await refreshAws()
    console.log(`aws: ${result.types} types → ${result.file}`)
    console.log(`     AWS published this price file at ${result.publishedAt}`)
  }
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error))
  process.exit(1)
}
