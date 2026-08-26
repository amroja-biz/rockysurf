#!/usr/bin/env node
/**
 * Self-test for the mechanical catalogue rules in refresh-prices.mjs — AWS's family/ceiling/
 * arch classification (rockysurf-tzzw, issue #24 PR2a), Azure's meter-filtering and
 * ambiguity-resolution rules (rockysurf-o05s, issue #24 PR2b), and GCP's transcription-date
 * honesty rule (rockysurf-ndx6).
 *
 * PURE-FUNCTION AND OFFLINE, ON PURPOSE, for all three. `refresh-prices.mjs` itself talks to
 * live feeds; a test that also needed the network would be one CI could not run reliably and a
 * contributor could not run offline. So this drives the exported classification/filter functions
 * with fixture rows and pinned family/product names — nothing here makes an HTTP request.
 *
 * Run directly: node --test scripts/refresh-prices.test.mjs
 * Wired into `pnpm run lint`, same as this repository's other self-tests.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  AWS_MAX_MEMORY_GIB,
  AWS_MAX_VCPU,
  azureCatalogue,
  azureLinuxMeter,
  buildGcpFeedDoc,
  classifyAwsArch,
  isAwsCatalogued,
  isAwsMetal,
  resolvePricedSizes,
  unreadableFeedEntries,
} from './refresh-prices.mjs'

/* =============================================================================== AWS (tzzw) === */

/**
 * WHY A PINNED FAMILY LIST RATHER THAN A PROPERTY TEST. The Graviton suffix rule
 * (`classifyAwsArch`) is exactly the kind of thing that is obviously correct until the one family
 * that breaks it ships, and by then it is bundled and believed. Enumerating the real family list
 * AWS's feed returned on 2026-08-21, in both directions, is what a future generation — an
 * `m10g`, an `x9i` — gets checked against: if the rule ever starts guessing wrong for a REAL
 * family, this fails the moment that family is added here, not the moment a customer notices
 * their arm64 box was billed as amd64 or vice versa.
 */
const ARM64_FAMILIES = ['c8g', 'm7gd', 'r8gn', 'x8g', 'i8g', 'im4gn', 'hpc7g', 'g5g']
const AMD64_FAMILIES = ['g4dn', 'g6', 'gr6', 'c7i-flex']

test('classifyAwsArch: real Graviton families resolve to arm64', () => {
  for (const family of ARM64_FAMILIES) {
    assert.equal(classifyAwsArch(`${family}.large`), 'arm64', `${family}.large should be arm64`)
  }
})

test('classifyAwsArch: real non-Graviton families resolve to amd64', () => {
  for (const family of AMD64_FAMILIES) {
    assert.equal(classifyAwsArch(`${family}.large`), 'amd64', `${family}.large should be amd64`)
  }
})

test('classifyAwsArch: a1 and mac2 are known exceptions the suffix rule gets wrong, and must throw', () => {
  // a1 (Graviton1, arm64, no `g` in the name) and mac2 (Apple Silicon, arm64, same prefix as the
  // Intel-based mac1) must ERROR, never silently resolve to amd64.
  assert.throws(() => classifyAwsArch('a1.medium'))
  assert.throws(() => classifyAwsArch('mac1.metal'))
  assert.throws(() => classifyAwsArch('mac2.metal'))
})

test('classifyAwsArch: a family that does not fit <letters><digit><letters> throws rather than guesses', () => {
  // u-3tb1 / u-6tb1: real families from the feed (the "u-" high-memory family) whose name does
  // not fit the suffix rule's shape at all. Excluded by the vCPU/memory ceiling before
  // classification is ever attempted in the generator itself, but the classifier must still
  // refuse to guess if handed one directly.
  assert.throws(() => classifyAwsArch('u-3tb1.56xlarge'))
})

test('isAwsMetal: bare-metal ids, with or without a size suffix', () => {
  assert.equal(isAwsMetal('c8g.metal-48xl'), true)
  assert.equal(isAwsMetal('r7g.metal'), true)
  assert.equal(isAwsMetal('m5.metal'), true)
  assert.equal(isAwsMetal('t3.large'), false)
})

test('isAwsCatalogued: family exclusion, bare-metal exclusion, and the vCPU/memory ceiling', () => {
  const row = (overrides) => ({
    'Instance Type': 't3.large',
    'Instance Family': 'General purpose',
    vCPU: '2',
    Memory: '8 GiB',
    ...overrides,
  })

  assert.equal(isAwsCatalogued(row()), true, 'a plain general-purpose row should be catalogued')

  for (const family of [
    'GPU instance',
    'Machine Learning ASIC Instances',
    'FPGA Instances',
    'Media Accelerator Instances',
  ]) {
    assert.equal(isAwsCatalogued(row({ 'Instance Family': family })), false, `${family} must be excluded`)
  }

  assert.equal(isAwsCatalogued(row({ 'Instance Type': 'c8g.metal-48xl' })), false, '.metal must be excluded')

  assert.equal(isAwsCatalogued(row({ vCPU: String(AWS_MAX_VCPU + 1) })), false, `above ${AWS_MAX_VCPU} vCPU excluded`)
  assert.equal(isAwsCatalogued(row({ vCPU: String(AWS_MAX_VCPU) })), true, `exactly ${AWS_MAX_VCPU} vCPU kept`)

  assert.equal(
    isAwsCatalogued(row({ Memory: `${AWS_MAX_MEMORY_GIB + 1} GiB` })),
    false,
    `above ${AWS_MAX_MEMORY_GIB} GiB excluded`,
  )
  assert.equal(
    isAwsCatalogued(row({ Memory: `${AWS_MAX_MEMORY_GIB} GiB` })),
    true,
    `exactly ${AWS_MAX_MEMORY_GIB} GiB kept`,
  )

  assert.equal(isAwsCatalogued(row({ 'Instance Type': undefined })), false, 'no Instance Type must be excluded')
})

/* ============================================================================= Azure (o05s) === */

/**
 * Self-test for the Azure meter-filtering rules in refresh-prices.mjs (rockysurf-o05s).
 *
 * A GENERATOR THAT CANNOT DISTINGUISH A VM'S PRICE FROM A LEGACY PAAS METER'S IS A GENERATOR
 * THAT SILENTLY OVERCHARGES THE SPEND CAP, and that failure is invisible until someone compares
 * a bundled number against the pricing page by hand — exactly what nobody did for the 12-size
 * table, because the bug (a regex requiring a space the feed does not always have) happened not
 * to collide with any of those 12 sizes. This is a pinned regression test against the REAL
 * no-space productName that exposed it, `"Eadsv5 Series CloudServices"` for
 * `Standard_E96-48ads_v5`, plus the ambiguity rule the widened catalogue depends on.
 */
test('excludes a no-space CloudServices product name (the real regression)', () => {
  // The real row shape reported for Standard_E96-48ads_v5 (rockysurf-o05s): the retail feed
  // renders "CloudServices" as one word for this family, not "Cloud Services".
  const rows = [
    { skuName: 'E96-48ads v5', productName: 'Eadsv5 Series CloudServices', retailPrice: 10.704 },
    { skuName: 'E96-48ads v5', productName: 'Eadsv5 Series Windows', retailPrice: 12.5 },
    { skuName: 'E96-48ads v5 Spot', productName: 'Eadsv5 Series', retailPrice: 1.2 },
    { skuName: 'E96-48ads v5', productName: 'Virtual Machines Eadsv5 Series', retailPrice: 6.288 },
  ]

  const result = azureLinuxMeter(rows)

  assert.equal(result.length, 1, 'exactly one Linux pay-as-you-go meter should survive')
  assert.equal(result[0].productName, 'Virtual Machines Eadsv5 Series')
  assert.equal(result[0].retailPrice, 6.288)
})

test('still excludes the spaced "Cloud Services" spelling (no regression the other way)', () => {
  const rows = [
    { skuName: 'D2s v5', productName: 'Virtual Machines D Series Cloud Services', retailPrice: 1 },
    { skuName: 'D2s v5', productName: 'Virtual Machines D Series', retailPrice: 0.096 },
  ]

  const result = azureLinuxMeter(rows)

  assert.equal(result.length, 1)
  assert.equal(result[0].retailPrice, 0.096)
})

test('excludes Spot, Low Priority and Windows meters same as before', () => {
  const rows = [
    { skuName: 'B2s v2 Spot', productName: 'Virtual Machines B Series', retailPrice: 0.001 },
    { skuName: 'B2s v2 Low Priority', productName: 'Virtual Machines B Series', retailPrice: 0.002 },
    { skuName: 'B2s v2', productName: 'Virtual Machines B Series Windows', retailPrice: 0.1 },
    { skuName: 'B2s v2', productName: 'Virtual Machines B Series', retailPrice: 0.0832 },
  ]

  const result = azureLinuxMeter(rows)

  assert.equal(result.length, 1)
  assert.equal(result[0].retailPrice, 0.0832)
})

test('resolvePricedSizes excludes rather than guesses when a candidate is not exactly one meter', () => {
  const { priced, skipped } = resolvePricedSizes({
    // Zero surviving meters — e.g. a retired *_Promo SKU the feed no longer sells as PAYG Linux.
    Standard_Retired_Promo: [{ productName: 'Virtual Machines Foo Windows', retailPrice: 1 }],
    // Two surviving meters — a genuinely ambiguous shape the filter cannot resolve.
    Standard_Ambiguous: [
      { productName: 'Virtual Machines Bar', retailPrice: 1 },
      { productName: 'Virtual Machines Bar', retailPrice: 2 },
    ],
    // Exactly one — the only shape that gets priced.
    Standard_Clean: [{ productName: 'Virtual Machines Baz', retailPrice: 3 }],
  })

  assert.deepEqual(Object.keys(priced), ['Standard_Clean'])
  assert.equal(priced.Standard_Clean.retailPrice, 3)

  assert.equal(skipped.length, 2)
  const byId = Object.fromEntries(skipped.map((s) => [s.id, s.matches]))
  assert.equal(byId.Standard_Retired_Promo, 0)
  assert.equal(byId.Standard_Ambiguous, 2)
})

/**
 * THE ISSUE #140 REGRESSION, and the reason it was worth a test rather than a one-line guard.
 *
 * The rows below are the real shape the retail feed returned for `Standard_M16bs_v4` in
 * `eastus` on 2026-08-26: four meters, Linux and Windows, spot and not, every one of them at
 * `retailPrice: 0` because Azure had announced the Mbv4 series without billing for it yet.
 * Exactly one survives the Linux/PAYG filter, so the "exactly one meter" rule above is
 * perfectly happy — and the number it hands over is a zero.
 *
 * Thirty sizes did that, and the runtime readers reject a feed document WHOLE on a single
 * non-positive price, so those thirty zeros unpriced every Azure size in all fourteen regions
 * for every installation. A size Azure has not priced must be ABSENT, never present at zero.
 */
test('resolvePricedSizes excludes a size whose one Linux meter is priced at zero (issue #140)', () => {
  const { priced, skipped } = resolvePricedSizes({
    Standard_M16bs_v4: [
      { skuName: 'Standard_M16bs_v4', productName: 'Virtual Machines Mbsv4 series Linux', retailPrice: 0 },
      { skuName: 'Standard_M16bs_v4 Spot', productName: 'Virtual Machines Mbsv4 series Windows', retailPrice: 0 },
      { skuName: 'Standard_M16bs_v4', productName: 'Virtual Machines Mbsv4 series Windows', retailPrice: 0 },
      { skuName: 'Standard_M16bs_v4 Spot', productName: 'Virtual Machines Mbsv4 series Linux', retailPrice: 0 },
    ],
    Standard_B2ps_v2: [{ productName: 'Virtual Machines Bpsv2 Series', retailPrice: 0.0672 }],
  })

  assert.deepEqual(Object.keys(priced), ['Standard_B2ps_v2'])
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].id, 'Standard_M16bs_v4')
  assert.match(skipped[0].reason, /no price/)
})

test('resolvePricedSizes excludes a negative or non-numeric price the same way', () => {
  const { priced, skipped } = resolvePricedSizes({
    Standard_Negative: [{ productName: 'Virtual Machines Foo', retailPrice: -1 }],
    Standard_NotANumber: [{ productName: 'Virtual Machines Foo', retailPrice: 'free' }],
    Standard_Missing: [{ productName: 'Virtual Machines Foo' }],
  })

  assert.deepEqual(Object.keys(priced), [])
  assert.equal(skipped.length, 3)
})

/**
 * The generator-side transcription of the readers' own rule (issue #140). It exists so that the
 * next thing Azure decides to publish at zero fails the workflow — which publishes nothing and
 * leaves yesterday's good document being served — instead of silently unpricing a cloud.
 */
test('unreadableFeedEntries names exactly what the runtime readers would reject', () => {
  assert.deepEqual(
    unreadableFeedEntries({
      eastus: { Standard_B2ps_v2: 0.0672, Standard_M16bs_v4: 0 },
      westeurope: { Standard_D2s_v5: -0.1, Standard_D4s_v5: 0.19, Standard_Weird: 'free' },
    }),
    ['eastus/Standard_M16bs_v4 = 0', 'westeurope/Standard_D2s_v5 = -0.1', 'westeurope/Standard_Weird = "free"'],
  )
})

test('unreadableFeedEntries passes a document every reader would accept', () => {
  assert.deepEqual(unreadableFeedEntries({ eastus: { Standard_B2ps_v2: 0.0672 }, westeurope: {} }), [])
  assert.deepEqual(unreadableFeedEntries({}), [])
})

/**
 * The catalogue rule is a UNION across the priced regions, and this is the test that keeps it
 * one (rockysurf-lodw). The distinction was invisible while `AZURE_REGIONS` held a single region
 * — union and intersection are the same set then — so it is worth pinning now that the list is
 * fourteen regions wide and the two rules differ by ~600 sizes.
 */
test('azureCatalogue is the union across regions, not the intersection', () => {
  const { sizes, everywhere } = azureCatalogue(
    new Map([
      ['eastus', new Set(['Standard_B2ps_v2', 'Standard_D2s_v5', 'Standard_D2ps_v5'])],
      ['brazilsouth', new Set(['Standard_D2s_v5'])],
      ['westeurope', new Set(['Standard_D2s_v5', 'Standard_D2ps_v5', 'Standard_E2s_v6'])],
    ]),
  )

  // Sorted, deduplicated, and INCLUDING the sizes only some regions sell — brazilsouth not
  // stocking Standard_B2ps_v2 must not delete it from the two regions that do.
  assert.deepEqual(sizes, ['Standard_B2ps_v2', 'Standard_D2ps_v5', 'Standard_D2s_v5', 'Standard_E2s_v6'])

  // Reported for the maintainer, never used as the catalogue.
  assert.deepEqual(everywhere, ['Standard_D2s_v5'])
})

test('azureCatalogue with a single region is that region, unchanged', () => {
  const one = new Map([['eastus', new Set(['Standard_D2s_v5', 'Standard_B2ps_v2'])]])
  const { sizes, everywhere } = azureCatalogue(one)
  assert.deepEqual(sizes, ['Standard_B2ps_v2', 'Standard_D2s_v5'])
  assert.deepEqual(everywhere, sizes)
})

/* ================================================================================ GCP (ndx6) === */

/**
 * WHY THIS HAS A TEST AT ALL. GCP's feed document is the one `--feed` does not fetch: its
 * numbers are hand-transcribed and its DATES ARE THE POINT. `price-feed.yml` republishes every
 * document daily, so the single thing that must never happen is a publish-time stamp landing on
 * a two-week-old transcription and presenting it as this morning's price.
 */
const GCP_TRANSCRIBED_FIXTURE = {
  source: 'https://example.invalid/pricing',
  currency: 'USD',
  tables: [
    { fetchedAt: '2026-08-21T00:00:00.000Z', regions: { 'us-central1': { 'c4a-standard-1': 0.0449 } } },
    { fetchedAt: '2026-08-13T00:00:00.000Z', regions: { 'us-central1': { 't2a-standard-1': 0.0385 } } },
  ],
}

test('gcp: fetchedAt is the oldest transcription date, never the publish date', () => {
  const doc = buildGcpFeedDoc(GCP_TRANSCRIBED_FIXTURE)

  assert.equal(doc.fetchedAt, '2026-08-13T00:00:00.000Z')
  // Table order must not decide it: the floor is the oldest, and the newer table is listed first
  // in the fixture above precisely so a naive "first table wins" would fail here.
  assert.ok(new Date(doc.fetchedAt) < new Date())
})

test('gcp: every row keeps the date its own table was read', () => {
  const doc = buildGcpFeedDoc(GCP_TRANSCRIBED_FIXTURE)

  assert.deepEqual(doc.transcribedAt, {
    'c4a-standard-1': '2026-08-21T00:00:00.000Z',
    't2a-standard-1': '2026-08-13T00:00:00.000Z',
  })
  assert.deepEqual(doc.regions, { 'us-central1': { 'c4a-standard-1': 0.0449, 't2a-standard-1': 0.0385 } })
  assert.equal(doc.schemaVersion, 1)
  assert.equal(doc.provider, 'gcp')
})

test('gcp: one type in two tables is a throw, not a last-write-wins merge', () => {
  // Two dates for one number means the transcription is ambiguous, and a publisher must not
  // silently pick the date that flatters it.
  const doubled = {
    ...GCP_TRANSCRIBED_FIXTURE,
    tables: [...GCP_TRANSCRIBED_FIXTURE.tables, { fetchedAt: '2026-08-25T00:00:00.000Z', regions: { 'us-central1': { 't2a-standard-1': 0.04 } } }],
  }
  assert.throws(() => buildGcpFeedDoc(doubled), /transcribed in two tables/)
})

test('gcp: a table without a date, and a non-price, are throws', () => {
  assert.throws(() => buildGcpFeedDoc({ tables: [{ regions: {} }] }), /no fetchedAt/)
  assert.throws(() => buildGcpFeedDoc({ tables: [] }), /no transcribed price tables/)
  for (const bad of [0, -1, 'free', null]) {
    const doc = { tables: [{ fetchedAt: '2026-08-13T00:00:00.000Z', regions: { 'us-central1': { 'e2-micro': bad } } }] }
    assert.throws(() => buildGcpFeedDoc(doc), /is not a price/)
  }
})

test('gcp: the shipped transcription file builds a document the feed reader would accept', () => {
  // The real file, not a fixture: a typo in it is a broken publish, and this is the cheapest
  // place to catch one.
  const file = fileURLToPath(new URL('gcp-transcribed-prices.json', import.meta.url))
  const doc = buildGcpFeedDoc(JSON.parse(readFileSync(file, 'utf8')))

  assert.equal(doc.currency, 'USD')
  assert.ok(doc.source.startsWith('https://'))
  for (const [region, prices] of Object.entries(doc.regions)) {
    assert.match(region, /^[a-z]+-[a-z]+\d+$/)
    for (const [type, amount] of Object.entries(prices)) {
      assert.ok(Number.isFinite(amount) && amount > 0, `${type} is not a price`)
      assert.match(doc.transcribedAt[type], /^\d{4}-\d{2}-\d{2}T/)
      assert.ok(new Date(doc.transcribedAt[type]) >= new Date(doc.fetchedAt))
    }
  }
})
