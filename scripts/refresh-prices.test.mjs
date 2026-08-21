#!/usr/bin/env node
/**
 * Self-test for the mechanical catalogue rules in refresh-prices.mjs — AWS's family/ceiling/
 * arch classification (rockysurf-tzzw, issue #24 PR2a) and Azure's meter-filtering and
 * ambiguity-resolution rules (rockysurf-o05s, issue #24 PR2b).
 *
 * PURE-FUNCTION AND OFFLINE, ON PURPOSE, for both halves. `refresh-prices.mjs` itself talks to
 * live feeds; a test that also needed the network would be one CI could not run reliably and a
 * contributor could not run offline. So this drives the exported classification/filter functions
 * with fixture rows and pinned family/product names — nothing here makes an HTTP request.
 *
 * Run directly: node --test scripts/refresh-prices.test.mjs
 * Wired into `pnpm run lint`, same as this repository's other self-tests.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AWS_MAX_MEMORY_GIB,
  AWS_MAX_VCPU,
  azureLinuxMeter,
  classifyAwsArch,
  isAwsCatalogued,
  isAwsMetal,
  resolvePricedSizes,
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
