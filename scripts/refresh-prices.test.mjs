#!/usr/bin/env node
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
 *
 * Run directly: node scripts/refresh-prices.test.mjs
 * Wired into `pnpm run lint`, same as this repository's other self-tests.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { azureLinuxMeter, resolvePricedSizes } from './refresh-prices.mjs'

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
