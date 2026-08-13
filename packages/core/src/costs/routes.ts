import { Hono } from 'hono'
import type { AppEnv } from '../app.js'
import type { Db } from '../db/client.js'
import { listServersByUser } from '../db/repositories/servers.js'
import type { ServerRow } from '../db/schema.js'
import { success } from '../http/responses.js'
import type { SpendTracker } from '../jobs/limits.js'
import type { LimitsConfig } from '../config/index.js'

/**
 * Costs, read-only (rockysurf-hzi7.4).
 *
 * There is no billing here and there never will be: this installation is not a payment
 * processor, it is a thing that spends the operator's OWN cloud budget. So the page this feeds
 * answers one question — how much has this month cost me so far, and how close am I to the cap
 * that will start refusing to create servers.
 *
 * EVERY NUMBER HERE IS AN ESTIMATE, and the response says so in its own shape rather than
 * leaving the UI to remember:
 *
 *  - `estimatedTotalCost` is uptime multiplied by a price quoted when the server was created.
 *    It rounds DOWN: uptime is accrued by a ticker, so the seconds since the last tick are not
 *    counted yet, and a server that is running right now is always a little cheaper here than
 *    it is at the provider.
 *  - prices are per-currency and never summed across currencies. A Hetzner project billed in
 *    EUR and an AWS account billed in USD cannot be added together honestly (amendment B2),
 *    and a UI that shows one total would be inventing an exchange rate.
 *  - `pricedAt` is when the price was fetched, carried per server row. It is the honest answer
 *    to "based on what?", and it comes from the row rather than from a provider package
 *    because core may not import one (the dependency rule that keeps the AWS SDK out of an
 *    `npx` cold start).
 */

export interface CostsRoutesDeps {
  db: Db
  spend: SpendTracker
  limits: LimitsConfig
}

export interface ServerCost {
  id: string
  name: string
  provider: string
  status: string
  totalUptimeSeconds: number
  /** Null when the provider quoted no price for this offering. */
  hourlyCost: { amount: number; currency: string } | null
  estimatedTotalCost: number
  currency: string | null
  /** When the price behind these numbers was fetched. */
  pricedAt: string | null
}

const serverCost = (row: ServerRow): ServerCost => ({
  id: row.id,
  name: row.name,
  provider: row.provider,
  status: row.status,
  totalUptimeSeconds: row.totalUptimeSeconds,
  hourlyCost:
    row.hourlyCostAmount !== null && row.hourlyCostCurrency !== null
      ? { amount: row.hourlyCostAmount, currency: row.hourlyCostCurrency }
      : null,
  estimatedTotalCost: row.estimatedTotalCost,
  currency: row.hourlyCostCurrency,
  pricedAt: row.hourlyCostFetchedAt,
})

export function createCostsRoutes(deps: CostsRoutesDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.get('/api/v1/costs', (c) => {
    const user = c.get('user')
    // Scoped to the caller, like every other server-shaped route: the fleet total a user sees
    // is THEIR fleet. A single-admin install makes these the same thing; a multi-user one must
    // not leak someone else's spend.
    const rows = listServersByUser(deps.db, user.id)
    const servers = rows.map(serverCost)

    // Per currency, never summed: see the module comment.
    const fleetByCurrency: Record<string, number> = {}
    for (const row of rows) {
      if (!row.hourlyCostCurrency) continue
      fleetByCurrency[row.hourlyCostCurrency] =
        (fleetByCurrency[row.hourlyCostCurrency] ?? 0) + row.estimatedTotalCost
    }

    // Latest price fetch per provider, so the UI can say what the estimates are based on
    // without core knowing anything about a specific cloud.
    const pricedAtByProvider: Record<string, string> = {}
    for (const row of rows) {
      if (!row.hourlyCostFetchedAt) continue
      const seen = pricedAtByProvider[row.provider]
      if (!seen || row.hourlyCostFetchedAt > seen) pricedAtByProvider[row.provider] = row.hourlyCostFetchedAt
    }

    // `refresh()`, not `snapshot()`: the cached snapshot is only as fresh as the last uptime
    // tick, so a server created since then would be invisible here — including in
    // `unpricedServers`, where showing zero when the fleet has an unpriced server is worse
    // than showing nothing. Recomputing reads a handful of rows on a laptop control plane, and
    // it leaves the tracker's cache updated, so this page and the create path's cap check
    // agree on the same number.
    const snapshot = deps.spend.refresh()

    return success(c, {
      monthToDate: {
        month: snapshot.month,
        byCurrency: snapshot.byCurrency,
        unpricedServers: snapshot.unpricedServers,
      },
      lifetime: { byCurrency: fleetByCurrency },
      limits: {
        maxServers: deps.limits.maxServers,
        // Read-only: the cap is configuration, and changing it is an edit to the config file.
        // A UI control here would imply core could raise its own ceiling.
        spendCap: deps.limits.spendCap ?? null,
      },
      cap: {
        overCap: snapshot.overCap,
        ...(snapshot.cap ? { amount: snapshot.cap.amount, currency: snapshot.cap.currency } : {}),
        /** Fraction of the cap spent, 0..1+, only when a cap is configured. */
        ...(snapshot.cap
          ? { fraction: snapshot.cap.amount > 0 ? (snapshot.byCurrency[snapshot.cap.currency] ?? 0) / snapshot.cap.amount : 0 }
          : {}),
      },
      servers,
      pricedAtByProvider,
      /** Said once, here, so every consumer repeats the same caveat. */
      estimateNote: 'Estimates only, and they round down: uptime accrues on a timer, so a running server costs a little more than shown.',
    })
  })

  return routes
}
