import { isProviderError, type ProviderErrorCode } from '@rockysurf/provider-sdk'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import type { AppEnv } from '../app.js'
import { STEP_RUN_AS } from '../bootstrap/plan.js'
import { DEFAULT_SSH_PORT } from '../bootstrap/push.js'
import { InvalidTransitionError } from '../db/transitions.js'
import { LimitExceededError } from '../jobs/limits.js'
import { SERVER_SIZES, type ServerRow, type ServerSize, type StoredSize } from '../db/schema.js'
import {
  getBootstrapReport,
  getServerEnvironment,
  getServerPackInputs,
  getServerRepositories,
  getServerTools,
  isBillingRow,
} from '../db/repositories/servers.js'
import { resolvePackInputs } from '../packs/inputs.js'
import { resolveServerEnvironment } from './environment.js'
import type { PackInput } from '../packs/schema.js'
import type { BootstrapReport } from '../bootstrap/failure-report.js'
import { badRequest, created, notFound, success } from '../http/responses.js'
import { validate } from '../http/validate.js'
import type { IndexedRefusal } from '../git/preflight.js'
import { fingerprintPublicKey } from '../ssh/keys.js'
import { InvalidPublicKeyError } from '../ssh/server-keys.js'
import {
  ConflictError,
  ServerNotFoundError,
  UnsupportedOperationError,
  type LifecycleService,
} from './lifecycle.js'
import type { ProviderRegistry } from '../providers/registry.js'
import { allowedOfferings, describeCatalogue, resolveSize } from './offerings.js'
import type { Context } from 'hono'

/**
 * `/api/v1/servers` — the routes the SPA's API client (`packages/web/src/lib/api.ts`) already calls.
 *
 * The paths and response shapes are held to what the SPA expects (`createServer`, `getServers`,
 * `getServer`, `startServer`, `stopServer`, `terminateServer`), so the 4d port stays mechanical.
 * `spotInstance` is accepted and ignored: spot is cut from v0.1, and rejecting a field the
 * existing client still sends would break it for no gain.
 */

/**
 * ProviderError code → HTTP status.
 *
 * The distinction that matters here is WHOSE fault it is, because that decides whether the
 * caller should change the request, wait, or call an operator:
 *
 *  - `invalid_spec` and `not_found` are the caller's request → 4xx.
 *  - `quota` and `conflict` are a state conflict the caller can act on → 409.
 *  - `rate_limited` → 429, and `capacity` → 503, both retryable and both with meaning to a
 *    client that backs off.
 *  - `auth` is THIS INSTALLATION'S credentials being wrong, not the caller's → 500. A 401
 *    here would tell the user to log in again, which would not help at all.
 *  - `network` → 504 and `unknown` → 502: the upstream cloud failed or answered
 *    incomprehensibly. Both are gateway-shaped, because that is exactly what core is here.
 */
const PROVIDER_ERROR_STATUS: Record<ProviderErrorCode, ContentfulStatusCode> = {
  invalid_spec: 400,
  not_found: 404,
  conflict: 409,
  quota: 409,
  rate_limited: 429,
  capacity: 503,
  auth: 500,
  network: 504,
  unknown: 502,
}

/**
 * An operation the provider's capabilities forbid → **501 Not Implemented**.
 *
 * Chosen over 409 deliberately, and worth stating because the SDK routes it through
 * `ProviderError('invalid_spec')`, which would otherwise land on 400. It is not a conflict
 * with the resource's current state — a BYO host is not "temporarily un-stoppable", it can
 * never be stopped — and it is not a malformed request, because asking a provider to stop is
 * perfectly well-formed. 501 is the status for "this server does not support the
 * functionality required", which is precisely the case.
 */
const UNSUPPORTED_STATUS: ContentfulStatusCode = 501

/**
 * The display fields, shared by create and the metadata PATCH (issue #46): the same rule in
 * both places, so a name the create form accepts is a name the rename form accepts.
 * Description is bounded because it renders on a card, not in a document — and an empty
 * string on PATCH means "clear it", which is what backspacing a form field down to nothing
 * says.
 */
const NAME = z.string().trim().min(1).max(63)
const DESCRIPTION = z.string().trim().max(500)

const updateBody = z
  .object({
    name: NAME.optional(),
    description: DESCRIPTION.optional(),
  })
  .refine((body) => body.name !== undefined || body.description !== undefined, {
    message: 'nothing to update: send name, description, or both',
  })

const createBody = z.object({
  name: NAME.optional(),
  description: DESCRIPTION.optional(),
  /**
   * Optional (rockysurf-kh3u, issue #24 PR 1): the SPA's machine-type picker posts `offeringId`
   * directly and sends no size at all, because picking a specific machine IS the t-shirt-size
   * decision made concretely. `'custom'` is never a member of this enum — it is a server-side
   * derivation (below), never a value the wire may send. At least one of `size`/`offeringId`
   * is required; enforced by hand in the handler rather than by `.refine`, so the refusal can
   * name both fields instead of pointing at whichever zod happened to check first.
   */
  size: z.enum(['small', 'medium', 'large']).optional(),
  provider: z.string().trim().min(1).optional(),
  offeringId: z.string().trim().min(1).optional(),
  arch: z.enum(['amd64', 'arm64']).optional(),
  packId: z.string().trim().min(1).optional(),
  tools: z.array(z.string()).optional(),
  repositories: z.array(z.string()).optional(),
  /** Accepted and ignored — spot is cut from v0.1. The existing SPA still sends it. */
  spotInstance: z.boolean().optional(),
  sshPublicKey: z.string().optional(),
  /**
   * The remote-desktop password for a `requiresRdp` pack, set on the box's `rocky` account.
   *
   * MINIMUM LENGTH IS ENFORCED HERE, not only in the SPA (rockysurf-z0wf). The form has
   * always required eight characters; the API accepted anything and — until this bead —
   * dropped it, so the one place a short value could be refused was the one place a
   * non-browser caller never reaches. A value this route accepts is a value that ends up
   * authenticating a desktop session.
   */
  rdpPassword: z.string().min(8).optional(),
  /**
   * A script this box runs once, at the end of its bootstrap (issue #184, ADR-0011).
   *
   * BOUNDED AT 16 KiB, which is EC2's own ceiling on user-data and is quoted rather than
   * invented: the feature is deliberately that idea, the number is one a user may already know,
   * and a limit is needed at all because this text is copied into the install plan, snapshotted
   * on the row and pushed to the box — an unbounded field would be an unbounded row. A script
   * that does not fit belongs in a repository the box clones.
   *
   * TRIMMED, AND WHITESPACE-ONLY MEANS NONE. A textarea the user tabbed through and left with a
   * newline in it is not a request to run anything, and rendering a step for it would put an
   * empty `user-script` in the plan and a meaningless line in the feed.
   */
  userScript: z.string().max(16384).optional(),
  /**
   * Who runs it — the freedom the issue asked for over EC2's root-only user-data.
   *
   * Defaulted in the handler rather than here, so that "the caller said nothing" and "the caller
   * said rocky" stay distinguishable at the point the pair is validated below.
   */
  userScriptRunAs: z.enum(STEP_RUN_AS).optional(),
  /**
   * The values the selected pack declared as `inputs` (issue #189, ADR-0013).
   *
   * A FLAT `NAME: value` MAP, deliberately, rather than a list of objects: the pack has already
   * said what each name means, so a client repeating the label or the `secret` flag would be
   * sending the server facts it must not believe anyway. Everything about how a value is
   * treated comes from the pack file, never from the request.
   *
   * Shape-checked here and MEANING-checked in the handler, against the pack's own declaration
   * (`resolvePackInputs`): unknown name, missing required, oversized or multi-line value are
   * each a 400 naming the field. Bounded loosely here so that the handler's refusal — which can
   * quote the pack's label — is the one a caller reads.
   */
  packInputs: z.record(z.string().max(64), z.string().max(65536)).optional(),
  /**
   * The person's OWN environment for this box — `KEY=value` they chose, not the pack
   * (issue #197, ADR-0014).
   *
   * THE SHAPE MIRRORS `packInputs` — keyed by variable name — with the one fact no pack file
   * can supply: whether the value is a secret. There is no declaration here to read `secret`
   * off, because the whole point of this field is the value the pack never thought of, so the
   * request carries it, per entry. Per entry rather than as a second parallel map, because a
   * name appearing in both maps would be a question with no answer.
   *
   * Shape-checked here and MEANING-checked in the handler (`resolveServerEnvironment`): a name
   * Rocky Surf exports, a name the selected pack already asks for, an oversized or multi-line
   * value are each a 400 naming the key. Bounded loosely here so the handler's refusal is the
   * one a caller reads.
   */
  environment: z
    .record(z.string().max(64), z.strictObject({ value: z.string().max(65536), secret: z.boolean().optional() }))
    .optional(),
  /**
   * Create even though a repository URL failed its preflight (rockysurf-k6xp).
   *
   * REFUSE BY DEFAULT, override on request — decided that way rather than warn-by-default
   * because the cost of the two mistakes is not symmetric. A wrongly-refused create costs one
   * checkbox; a wrongly-allowed one costs a full boot, a full bootstrap, and a failed box that
   * goes on billing until somebody notices (which is 4byx, and the reason this bead exists).
   *
   * It is an explicit field rather than an absent check, because the honest limits of the
   * preflight are real: a forge behind a flaky network, a token core cannot predict the box
   * will actually use, a host that answers discovery differently. Every one of those is a case
   * where the user knows better than the check does, and none of them should mean "you cannot
   * create this server".
   */
  createAnyway: z.boolean().optional(),
})

export interface ServerRoutesDeps {
  lifecycle: LifecycleService
  registry: ProviderRegistry
  /** Default provider when the request does not name one. */
  defaultProvider?: string
  /**
   * Check each repository URL before an instance is launched (rockysurf-k6xp).
   *
   * IN THE ROUTE, so the SPA, the CLI and the MCP server are covered by construction rather
   * than by three callers each remembering — the same reason `priceOffering` lives in the
   * lifecycle rather than here. Optional so a core built without git configuration, and every
   * test that does not care, simply does not check.
   */
  preflightRepositories?: (urls: readonly string[]) => Promise<IndexedRefusal[]>
  /**
   * The scope IDENTITIES a box built for these repositories carries (rockysurf-18lq).
   *
   * Injected for the same reason `preflightRepositories` is: the answer depends on the config
   * file, and the route must not grow a dependency on it. Optional, so a core built without git
   * configuration says nothing rather than saying "none" — which are different claims.
   */
  githubTokenScopes?: (repositories: readonly string[]) => string[]
  /**
   * Whether the instance-wide `github.pat` — which every box carries — is configured at all.
   *
   * A function since issue #264, for the reason the two hooks above are: the answer lives in the
   * config file, which is now re-read on save, so a token pasted a moment ago has to be visible
   * here without a restart.
   */
  carriesFallbackToken?: () => boolean
  /**
   * The offering ids this installation permits on a given cloud — `providers.<cloud>.sizes`
   * (rockysurf-j10e). `undefined` for a provider with no allowlist, which offers everything.
   *
   * A FUNCTION rather than the config section, for the reason `preflightRepositories` is one:
   * the answer lives in the config file and the route must not grow a dependency on it. It
   * also keeps the provider ids out of core — the composition point reads whatever sections
   * the file has, and this route only ever passes a registry id back in.
   */
  offeringAllowlist?: (providerId: string) => readonly string[] | undefined
  /**
   * The machine type the user has saved for a size on a cloud — `preferences.tiers` (issue #124).
   *
   * A FUNCTION for the same reason `offeringAllowlist` is one: the answer lives in the config
   * file, the route must not grow a dependency on it, and passing a registry id back in keeps
   * every cloud's name out of core. Absent, or `undefined` for a pair, means "no preference",
   * which is the default resolution this route has always done.
   */
  tierPreference?: (providerId: string, size: ServerSize) => string | undefined
  /**
   * What the pack the request names asks the user for — its `inputs` declaration (issue #189).
   *
   * A FUNCTION over the pack id rather than a database handle, on the same discipline as
   * `offeringAllowlist`: this route validates a request, and giving it a `Db` would let the
   * next edit reach for anything. Returning `undefined` means "no such pack, or it asks for
   * nothing", which this route treats identically — a request naming a pack that does not exist
   * is already refused downstream by the plan render, and duplicating that refusal here would
   * put two different sentences on one mistake.
   *
   * Optional so a test that does not care wires nothing. Production always supplies it, and
   * `servers/routes.wiring.test.ts` drives the real `boot()`-built app to prove it: the
   * validation exists to stop a value reaching a box that nobody asked for, and a hook nothing
   * supplies is exactly the failure `docs/memories/2026-08-21-whole-boot-wiring-tests.md`
   * describes.
   */
  packInputs?: (packId: string) => readonly PackInput[] | undefined
  /**
   * Whether an explicit `tools` selection names tools that exist and are enabled (issue #289).
   *
   * A FUNCTION over the ids, on the same discipline as `packInputs` and `offeringAllowlist`
   * above, returning the operator-facing sentence or `undefined` for "fine".
   *
   * This exists because `tools` was the one create-time field nothing checked. The plan
   * resolver drops an id it cannot find and skips a disabled one (`bootstrap/resolver.ts`), by
   * design — a tool disabled after a server was created should stop being installed, not stop
   * the server booting. But that leniency is about a plan RENDER, and it was also answering a
   * fresh request: a create naming a misspelled tool launched a machine, charged for it, and
   * quietly installed less than was asked for. Same doctrine as every other check here — fail
   * before the money.
   *
   * Optional so an existing test that does not care wires nothing. `servers/routes.test.ts`
   * drives the real `createApp` for this, not a hand-wired route, because a hook nothing
   * supplies is exactly the failure `docs/memories/2026-08-21-whole-boot-wiring-tests.md`
   * describes — the check would exist and never run.
   */
  checkTools?: (ids: string[]) => string | undefined
  /**
   * The public keys the operator saved by name in `ssh.keys` (issue #302).
   *
   * A FUNCTION, on the same discipline as `offeringAllowlist` and `tierPreference` above: the
   * answer lives in the config file, which is re-read on every settings save (ADR-0017), so a
   * key saved a moment ago has to be offered on the next page load without a restart — and the
   * route must not grow the ability to read the config itself.
   *
   * Absent means "this installation has no saved-key list", which the route reports as an empty
   * list. That is the honest answer for an app built without the hook: the picker simply has
   * nothing to offer, and the paste box — which never depended on this — still works.
   */
  savedSshKeys?: () => readonly { name: string; publicKey: string }[]
}

/**
 * Fingerprint and comment for a stored `authorized_keys` line (issue #41), degrading to
 * `undefined` rather than throwing — the column could hold a line written before a future
 * format change, and a `GET /servers/:id` must not 500 over a display detail.
 */
function describeSuppliedKey(line: string): { fingerprint: string; comment?: string } | undefined {
  try {
    const fingerprint = fingerprintPublicKey(line)
    const comment = line.trim().split(/\s+/)[2]
    return { fingerprint, ...(comment ? { comment } : {}) }
  } catch {
    return undefined
  }
}

/** The row as the SPA expects to see it. Legacy field names, no internal columns. */
function present(row: ServerRow, deps: ServerRoutesDeps, staleReason?: string) {
  const repos = getServerRepositories(row)
  return {
    serverId: row.id,
    name: row.name,
    /**
     * Why this row may be STALE (rockysurf-gg9x): the provider could not be asked just now —
     * expired credentials, a cloud outage — and the reads served what core last knew instead
     * of failing. The provider's message travels verbatim because it names the remedy; for
     * an expired login, the exact command to run. `undefined` serializes to ABSENT, which is
     * what every fresh row's JSON carries.
     */
    syncError: staleReason,
    description: row.description ?? undefined,
    provider: row.provider,
    /**
     * Where this box was placed, as the user chose it at create (issue #125).
     *
     * The column has existed since the first migration and was the one placement fact this
     * function dropped — which nobody missed on a running box, whose address and console link
     * say where it is, and which is unanswerable on a terminated one, where the row is all that
     * is left. Absent when the provider takes no region (a BYO host, a single-region cloud).
     */
    region: row.region ?? undefined,
    size: row.size,
    offeringId: row.offeringId,
    arch: row.arch,
    status: row.status,
    provisioningStep: row.provisioningStep ?? undefined,
    publicIp: row.publicIp ?? undefined,
    publicDns: row.publicDns ?? undefined,
    previousIp: row.previousIp ?? undefined,
    ipChangedAt: row.ipChangedAt ?? undefined,
    packId: row.packId ?? undefined,
    tools: getServerTools(row),
    repositories: repos,
    /**
     * The NON-SECRET pack inputs this box was built with (issue #189, ADR-0013).
     *
     * Safe to return, and useful: they are the answers a person typed into a form they can
     * still see, and showing them is how "what is this box configured with" gets an answer
     * after the create screen is gone. A pack's SECRET inputs are not here and are not in any
     * other route either — the custody rule (`secrets/route-inventory.test.ts`) has exactly one
     * exemption and this is not it.
     *
     * Absent rather than `{}` when there are none, so the SPA can tell "asked for nothing" from
     * "asked and got nothing". A plain key holding `undefined` rather than a conditional spread,
     * like `githubTokenScopes` below: JSON drops it either way, and `DashboardPage.wiring.test`
     * reads this object's keys out of the SOURCE to prove the SPA declares nothing core does not
     * send — a spread hides the key from it.
     */
    packInputs: row.packInputs ? getServerPackInputs(row) : undefined,
    /**
     * The NON-SECRET half of the Environment this box's creator typed (issue #197, ADR-0014).
     *
     * Beside `packInputs` and separate from it, because the server page says which of the two a
     * variable came from — "the pack asked for this" and "you added this" are different
     * sentences, and only two fields can carry both. Secret lines are in neither, here or on
     * any other route.
     */
    environment: row.environment ? getServerEnvironment(row) : undefined,
    /**
     * WHICH GIT TOKENS THIS BOX HOLDS, by scope, never by value (rockysurf-18lq).
     *
     * A box no longer receives every configured token — only the ones its declared repositories
     * selected — so "which of them did this one get" became a question with an answer worth
     * showing. It is also the honest place to state the cost of narrowing: a repository cloned
     * by hand later, that nobody declared here, gets whatever the fallback covers and nothing
     * else.
     *
     * Absent (rather than `[]`) when core has no git configuration to answer from, because
     * "this installation configures no tokens" and "this box was given none of them" are
     * different facts and a page that showed them identically would be guessing on the reader's
     * behalf.
     */
    githubTokenScopes: deps.githubTokenScopes?.(repos),
    carriesFallbackToken: deps.carriesFallbackToken?.(),
    sshUser: row.sshUser,
    // Absent when it is 22, so every existing client keeps rendering `ssh user@host` unchanged
    // and only a host that really is somewhere else grows a `-p` (ADR-0003, E13).
    sshPort: row.sshPort && row.sshPort !== DEFAULT_SSH_PORT ? row.sshPort : undefined,
    /**
     * The key the user brought, when they brought one (issue #41). Fingerprint and comment
     * only: enough for a client to say "connect with the key whose fingerprint is X" without
     * pasting a key blob into a page. Absent means core's key is the only one authorized.
     *
     * Core's key is authorized too FOR BOOTSTRAP — a box authorized for the user's key alone
     * could not be bootstrapped, resumed or recovered (ADR-0002, SECURITY.md) — but it is a
     * provisioning tool, not a standing credential (ADR-0008, issue #92): once bootstrap
     * confirms the user's key is on the box, the plan's last step removes core's, and
     * `suppliedKeyOnly` below says whether that has happened yet.
     */
    suppliedSshKey: row.userSuppliedPublicKey ? describeSuppliedKey(row.userSuppliedPublicKey) : undefined,
    /**
     * Whether the supplied key above is now the ONLY key on the box (ADR-0008, issue #92).
     * Absent when no key was supplied at all — the question does not apply, core's key is the
     * only way in and always will be. `false` while a supplied-key box's bootstrap is still
     * running or on a box that shipped before this feature; `true` once the removal step has
     * confirmed core's key is gone and its stored private half retired.
     */
    suppliedKeyOnly: row.userSuppliedPublicKey ? Boolean(row.managedSshKeyRetiredAt) : undefined,
    // Absent unless the provider reported one, which is the only way core ever gets a console
    // URL — it does not know what any provider's console looks like (ADR-0003, E16).
    consoleUrl: row.consoleUrl ?? undefined,
    bootstrapMode: row.bootstrapMode,
    hourlyCost:
      row.hourlyCostAmount === null
        ? undefined
        : { amount: row.hourlyCostAmount, currency: row.hourlyCostCurrency, fetchedAt: row.hourlyCostFetchedAt },
    totalUptimeSeconds: row.totalUptimeSeconds,
    estimatedTotalCost: row.estimatedTotalCost,
    /**
     * Present only when the machine is metering and the STATUS does not say so (rockysurf-4byx).
     *
     * Computed here rather than left to each client to derive from `providerState`, so the SPA,
     * the CLI and the MCP server cannot disagree about which provider states count as billing —
     * and so the honesty is a property of the API rather than of three front ends each
     * remembering. Absent on a plain `running` row, where `status` already tells the whole
     * truth and a second billing notice would be noise.
     *
     * `since` is when core CONFIRMED the machine was billing, not when it started — see the
     * column's own comment. A client showing a cost beside this should say so.
     */
    billing:
      isBillingRow(row) && row.status !== 'running'
        ? {
            live: true as const,
            providerState: row.providerState ?? undefined,
            since: row.billingSince ?? undefined,
            confirmedAt: row.providerStateAt ?? undefined,
          }
        : undefined,
    errorMessage: row.errorMessage ?? undefined,
    /**
     * The complete account of a bootstrap that went wrong (ADR-0010, issue #119): the failed
     * step by name, the classified cause, the decisive lines, the whole captured log, and what
     * core did with the machine — or, on a box that came up, the repositories that did not
     * clone. `errorMessage` is the paragraph; this is the evidence. Absent on a clean row.
     */
    bootstrapReport: getBootstrapReport<BootstrapReport>(row),
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? undefined,
    stoppedAt: row.stoppedAt ?? undefined,
    terminatedAt: row.terminatedAt ?? undefined,
  }
}

/**
 * Turn a thrown lifecycle or provider error into the response envelope.
 *
 * The envelope mirrors `http/responses.ts` exactly — `{ error, code }` — because the SPA's
 * API client (`packages/web/src/lib/api.ts`) reads `error` and hands the whole body to `ApiError`. It is built
 * here rather than through those helpers only because the statuses this needs (501, 502, 503,
 * 504) are outside that module's fixed table.
 */
function fail(c: Context, err: unknown) {
  if (err instanceof ServerNotFoundError) return notFound(c, 'Server not found')
  // A pasted key that isn't one (issue #41 fallout). The message is already written for a
  // human — "public key body is not base64; paste the contents of a .pub file" — so it rides
  // straight through rather than being translated into something vaguer.
  if (err instanceof InvalidPublicKeyError) {
    return c.json({ error: err.message, code: 'invalid_public_key' }, 400)
  }
  // A configured limit refused the request (rockysurf-55fx.6). 403 rather than 429: the
  // caller is not being throttled for going too fast, they are being told this installation
  // will not do it. `reason` lets the UI say WHICH limit without parsing prose.
  if (err instanceof LimitExceededError) {
    return c.json({ error: err.message, code: 'limit_exceeded', reason: err.reason, ...err.detail }, 403)
  }
  if (err instanceof UnsupportedOperationError) {
    return c.json({ error: err.message, code: 'unsupported_operation' }, UNSUPPORTED_STATUS)
  }
  if (err instanceof ConflictError || err instanceof InvalidTransitionError) {
    return c.json({ error: err.message, code: 'conflict' }, 409)
  }
  if (isProviderError(err)) {
    const status = PROVIDER_ERROR_STATUS[err.code]
    return c.json(
      {
        error: err.message,
        code: err.code,
        // What the cloud actually said, after the nine-code mapping flattened it (F1).
        ...(err.providerCode ? { providerCode: err.providerCode } : {}),
        retryable: err.retryable,
      },
      status,
    )
  }
  throw err // genuinely unexpected: let the app's onError log it as a 500
}

export function createServerRoutes(deps: ServerRoutesDeps): Hono<AppEnv> {
  const { lifecycle, registry } = deps
  const routes = new Hono<AppEnv>()

  /**
   * Providers, their capabilities, and what they can sell.
   *
   * The offerings ride along rather than living at their own endpoint because the create page
   * needs both together — it has to resolve a t-shirt size to a CONCRETE offering and show its
   * price before the user submits, and splitting that across two requests only creates a
   * window where the page knows one and not the other.
   *
   * A provider whose `listOfferings()` fails does not fail the whole response: the others are
   * still usable, and the failed one arrives with an empty list and an `offeringsError` the UI
   * can show. One cloud having a bad day should not make the create page unusable for the
   * other.
   *
   * The catalogue is narrowed by `providers.<cloud>.sizes` before it leaves (rockysurf-j10e),
   * so the settings page's claim that the field controls "the instance types offered on the
   * New Server page" is finally true. The create route applies the same allowlist, because a
   * limit only the UI honours is not a limit.
   */
  /**
   * The saved types for one cloud, as `{ small?, medium?, large? }` (issue #124).
   *
   * Rides along with the catalogue for exactly the reason the catalogue rides along with the
   * provider: the create page resolves in the browser, so it needs the preference and the
   * offering it names in the same response, and two requests would only create a window where
   * it has one and not the other. Omitted entirely for a cloud with nothing saved.
   */
  const tierPreferencesFor = (providerId: string) => {
    if (!deps.tierPreference) return undefined
    const saved = SERVER_SIZES.map((size) => [size, deps.tierPreference!(providerId, size)] as const).filter(
      (entry): entry is readonly [ServerSize, string] => entry[1] !== undefined,
    )
    return saved.length > 0 ? Object.fromEntries(saved) : undefined
  }

  routes.get('/api/v1/providers', async (c) => {
    const providers = await Promise.all(
      registry.list().map(async (p) => {
        const preferences = tierPreferencesFor(p.id)
        try {
          return {
            id: p.id,
            displayName: p.displayName,
            capabilities: p.capabilities,
            offerings: allowedOfferings(await p.listOfferings(), deps.offeringAllowlist?.(p.id)),
            ...(preferences ? { tierPreferences: preferences } : {}),
          }
        } catch (err) {
          return {
            id: p.id,
            displayName: p.displayName,
            capabilities: p.capabilities,
            offerings: [],
            offeringsError: isProviderError(err) ? err.message : String(err),
            ...(preferences ? { tierPreferences: preferences } : {}),
          }
        }
      }),
    )
    return success(c, providers)
  })

  /**
   * THE SAVED PUBLIC KEYS, for the New Server page's picker (issue #302).
   *
   * Beside `/api/v1/providers` rather than in `ssh/routes.ts`, and both halves of that are
   * deliberate. This is the create form's option source, which is what that neighbour is; and
   * `ssh/routes.ts` is the one file exempted from the custody rule in
   * `secrets/route-inventory.test.ts`, so a route with nothing to do with key material has no
   * business inside the exemption. It is also mounted unconditionally, where the SSH routes are
   * mounted only when a secrets store exists — a picker that vanished with the secrets store
   * would be a mystery for whoever hit it.
   *
   * NOT ADMIN-ONLY, and it does not need to be: a public key is published material, it is handed
   * to a cloud provider in the clear on every create, and the person reading this route is the
   * person about to be offered these keys on the form below it. Half-filled entries — a name
   * added in Settings with no key typed in yet — are dropped here rather than offered as a
   * choice that would fail at submit.
   */
  routes.get('/api/v1/ssh-keys', (c) =>
    success(
      c,
      (deps.savedSshKeys?.() ?? [])
        .filter((key) => key.publicKey.trim() !== '')
        .map((key) => ({ name: key.name, publicKey: key.publicKey })),
    ),
  )

  routes.get('/api/v1/servers', async (c) => {
    try {
      // `syncError` is additive and absent when the provider view is fresh, so every client
      // that reads this as a plain array keeps working; the SPA surfaces it per provider
      // (rockysurf-gg9x).
      return success(
        c,
        (await lifecycle.list(c.get('user').id)).map(({ row, syncError }) => present(row, deps, syncError)),
      )
    } catch (err) {
      return fail(c, err)
    }
  })

  /*
   * `validate`, not the bare `zValidator` this route used to call (rockysurf-k6xp).
   *
   * It was the only non-test site in core still using the raw validator, so a schema failure
   * here came back as `@hono/zod-validator`'s own `{success:false, error:{name,message}}` —
   * an OBJECT where every client reads a string. The SPA rendered "API Error: 400 Bad
   * Request", and the CLI and the MCP server both printed `[object Object]`, because
   * `CoreApiError` passes `body.error` to `super()`. This bead adds a field-level refusal to
   * this very route, so the envelope it lands in had to be the one the clients can read.
   */
  routes.post('/api/v1/servers', validate('json', createBody), async (c) => {
    const body = c.req.valid('json')
    const user = c.get('user')

    /**
     * NEITHER `size` NOR `offeringId` NAMES A MACHINE (rockysurf-kh3u).
     *
     * `size` became optional so the machine-type picker can post `offeringId` alone, but a
     * request with neither is not asking for anything. Checked here, before either field is
     * used for anything, and named as an issue on BOTH fields — a caller who sent neither
     * needs to know both ways out, not just whichever this route happened to check first.
     */
    if (body.size === undefined && body.offeringId === undefined) {
      return badRequest(c, 'send a size or an offeringId — neither was sent, so there is no machine to create', [
        { path: 'size', message: 'send this, or offeringId' },
        { path: 'offeringId', message: 'send this, or size' },
      ])
    }

    /**
     * THE USER'S OWN SCRIPT, and the one way of getting it wrong worth a refusal (issue #184).
     *
     * Whitespace is not a script, so the trimmed value is what decides whether there is one at
     * all — and a `userScriptRunAs` with nothing to run is refused rather than ignored. A caller
     * that named a user for a script it forgot to send has a bug, and silently creating a box
     * with no script on it would let that bug reach the bill. `rocky` is the default when a
     * script arrives with no user, because the unprivileged account is the one whose home,
     * PATH and toolchain the pack just built.
     */
    const userScriptBody = body.userScript?.trim()
    if (!userScriptBody && body.userScriptRunAs) {
      return badRequest(c, 'userScriptRunAs was sent without a userScript to run', [
        { path: 'userScript', message: 'send the script this runAs applies to, or drop userScriptRunAs' },
      ])
    }
    const userScript = userScriptBody ? { script: userScriptBody, runAs: body.userScriptRunAs ?? 'rocky' } : undefined

    /**
     * AN EXPLICIT TOOL SELECTION, checked on the same doctrine as everything below it
     * (issue #289). `tools` overrides the pack's own list, so a typo in it is not a smaller
     * box — it is a box missing the software the person asked for, discovered after the
     * instance is running and billing.
     */
    if (body.tools?.length) {
      const problem = deps.checkTools?.(body.tools)
      if (problem) return badRequest(c, problem, [{ path: 'tools', message: problem }])
    }

    /**
     * WHAT THE PACK ASKED FOR, checked against what arrived (issue #189, ADR-0013).
     *
     * BEFORE THE PROVIDER IS TOUCHED, on the doctrine every other create-time check here is
     * built on (`rockysurf-kvkr`, `rockysurf-k6xp`): fail before the money. A missing required
     * input is not discoverable on the box until the pack's own install script reads an empty
     * variable, which is minutes and one launched instance later — and on a pack whose tools are
     * required, ADR-0010 then confiscates the machine. The refusal is field-level and names every
     * problem rather than the first, so a form can put each message on its own field.
     *
     * The split it returns is the custody decision, made once, here: non-secret values go on
     * the row and secret ones to the encrypted store. Nothing downstream re-reads the pack to
     * work out which is which.
     */
    const packInputs = resolvePackInputs(
      body.packId ? deps.packInputs?.(body.packId) : undefined,
      body.packInputs,
    )
    if (packInputs.issues.length > 0) {
      return badRequest(
        c,
        packInputs.issues.length === 1
          ? packInputs.issues[0]!.message
          : `${packInputs.issues.length} of this pack's inputs are wrong or missing.`,
        packInputs.issues,
      )
    }

    /**
     * THE USER'S OWN ENVIRONMENT, checked the same way and in the same place (issue #197).
     *
     * Immediately after the pack's own inputs, before the provider is touched, on the same
     * doctrine: fail before the money. Both halves are validated by the same name and value
     * rules — the box cannot tell a pack's variable from a user's — and the declaration is
     * passed in for one purpose only, refusing a name both fields would write.
     */
    const environment = resolveServerEnvironment(
      body.environment,
      body.packId ? deps.packInputs?.(body.packId) : undefined,
    )
    if (environment.issues.length > 0) {
      return badRequest(
        c,
        environment.issues.length === 1
          ? environment.issues[0]!.message
          : `${environment.issues.length} of the environment variables you set are wrong.`,
        environment.issues,
      )
    }

    /**
     * WHICH CLOUD THIS SERVER LANDS ON, and why there is no silent fallback (rockysurf-va2l).
     *
     * The old rule ended in `registry.ids()[0]`, so a request that named no provider on a
     * two-cloud installation was created on whichever one composition happened to build first
     * — a spend decision settled by the order of a table in `compose.ts`. Registration order
     * is not consent.
     *
     * So: an explicit `provider` wins, then a configured default, then the only provider there
     * is. Past that the request is genuinely ambiguous and is refused, naming the ids the
     * caller may choose from — actionable for the SPA, the CLI's `--provider` and the MCP
     * tool's `provider`, all of which can name one.
     */
    const ids = registry.ids()
    const providerId = body.provider ?? deps.defaultProvider ?? (ids.length === 1 ? ids[0] : undefined)
    if (!providerId) {
      if (ids.length === 0) return badRequest(c, 'no compute provider is configured')
      return badRequest(
        c,
        `more than one provider is configured, so which one to create on is not implied: name it in "provider". Configured: ${ids.join(', ')}`,
      )
    }

    let provider
    try {
      provider = registry.get(providerId)
    } catch (err) {
      return fail(c, err)
    }

    /**
     * The repository preflight, BEFORE the offering lookup and long before the provider is
     * asked for a machine (rockysurf-k6xp).
     *
     * Placed here for the reason `checkLimits` is placed where it is: this is the last point at
     * which a refusal leaves nothing behind. A URL typo used to be discovered at the clone
     * step, which is nearly the last thing a bootstrap does — after a boot, after cloud-init,
     * after every tool in the pack — and the box that discovered it kept running and kept
     * billing (4byx). kvkr's doctrine, applied to repositories: fail before the money.
     *
     * The refusal is field-level, names every bad URL rather than the first, and carries the
     * override in its own message so the way out is where the problem is.
     */
    if (deps.preflightRepositories && body.repositories?.length && !body.createAnyway) {
      const refusals = await deps.preflightRepositories(body.repositories)
      if (refusals.length > 0) {
        return badRequest(
          c,
          refusals.length === 1
            ? `${refusals[0]!.reason} Create it anyway by sending "createAnyway": true.`
            : `${refusals.length} of the repositories could not be opened. Create anyway by sending "createAnyway": true.`,
          // The path is into the request body, so a form can put each message on its own field
          // rather than dumping the lot into one banner.
          refusals.map((refusal) => ({ path: `repositories.${refusal.index}`, message: refusal.reason })),
        )
      }
    }

    /**
     * WHICH MACHINE, and the end of "any size resolves to the cheapest offering"
     * (rockysurf-clf2, amending ADR-0003's "deliberately unresolved" t-shirt item).
     *
     * What this replaced took the cheapest AVAILABLE offering in the whole catalogue whenever
     * either `offeringId` or `arch` was absent, which was wrong three separate ways:
     *
     *  - `size` did nothing. `large` and `small` produced the same machine, and the caller
     *    learned which one only from the bill.
     *  - `arch` did worse than nothing. The cheapest offering was chosen without consulting
     *    it, then the caller's `arch` was kept via `arch ??=`, and the provider refused the
     *    pair — `invalid_spec: arch arm64 does not match offering e2-micro (amd64)` — blaming
     *    the caller for a contradiction this route had just built. Arch-only creation was
     *    therefore impossible on every surface except the SPA.
     *  - An explicit `offeringId` with no `arch` stamped the CHEAPEST offering's arch onto a
     *    row provisioning a different one, so the box's `$ARCH` could disagree with its own
     *    machine type.
     *
     * Now: the size is a floor, the arch is part of it, and the answer is the cheapest
     * available offering that actually satisfies both. Nothing silently substitutes — an
     * unsatisfiable request is refused, and refused differently depending on whether this
     * cloud cannot do it at all (400) or cannot do it right now (503).
     */
    const allowlist = deps.offeringAllowlist?.(providerId)

    /*
     * The allowlist is checked against the caller's string BEFORE the catalogue is fetched,
     * because it can be: it is a list of ids, and so is the request. An operator's spend limit
     * that the HTTP API could step over while the SPA honoured it would protect nobody — the
     * API is the surface an agent uses — and doing it here means the limit holds even when the
     * cloud's own catalogue is unreadable.
     */
    if (body.offeringId && allowlist && !allowlist.includes(body.offeringId)) {
      return badRequest(
        c,
        `offering "${body.offeringId}" is not one this installation offers on ${providerId}. Allowed: ${allowlist.join(', ')}`,
        [{ path: 'offeringId', message: 'not an offering this installation can create' }],
      )
    }

    let offeringId: string
    let arch: 'amd64' | 'arm64'
    /**
     * `'custom'` DERIVED, NEVER READ OFF THE WIRE (rockysurf-kh3u).
     *
     * `createBody` does not admit the literal — the only way this variable becomes `'custom'`
     * is a caller naming an `offeringId` and sending no `size` at all, which is exactly the
     * picker's contract. A caller who sends a real size alongside an `offeringId` keeps it: the
     * column is display sugar, and there is no reason to overwrite a size the caller stated.
     */
    let size: StoredSize
    /**
     * Why the machine created is not the one the user saved for this size (issue #124).
     *
     * ON THE RESPONSE, not only in the SPA, because the caller that most needs it is the one
     * with no screen: `rockysurf create --size small` and the `create_server` MCP tool both
     * post a size and get a row back, and a preference that silently stopped applying — the
     * type retired, out of stock, or quota-refused — would otherwise show up first on a bill.
     * Absent whenever the preference was honoured or never set, which is the ordinary case.
     */
    let sizeNote: string | undefined

    if (body.offeringId && body.arch) {
      /*
       * FULLY SPECIFIED, so the catalogue is not consulted at all — deliberately.
       *
       * A caller who named both the machine and its architecture has left core nothing to
       * resolve, and making the create depend on `listOfferings()` anyway would mean a cloud's
       * pricing endpoint having a bad day could block a create that needs no pricing to
       * proceed (the property `pricing.test.ts` pins). A wrong id is still caught — by the
       * provider's own `validateSpec`, in the provider's own words, which is where it was
       * caught before this bead too.
       */
      offeringId = body.offeringId
      arch = body.arch
      size = body.size ?? 'custom'
    } else if (body.offeringId) {
      /*
       * An id with no arch. The catalogue is REQUIRED here rather than optional: arch is not
       * derivable from a native id without it, and the code this replaced filled the gap with
       * the cheapest offering's arch — stamping `amd64` on a row provisioning an ARM machine.
       * Failing is the honest answer; guessing is what the bug was.
       */
      let catalogue
      try {
        catalogue = allowedOfferings(await provider.listOfferings(), allowlist)
      } catch (err) {
        return fail(c, err)
      }
      const offering = catalogue.find((o) => o.id === body.offeringId)
      if (!offering) {
        // NAME WHAT THERE IS, the way the missing-provider refusal does (rockysurf-va2l,
        // rockysurf-oeay). "provider X has no offering Y" told a caller only that it had
        // guessed wrong, and an agent that guessed wrong once has nothing better to try.
        //
        // THIS IS THE NO-ALLOWLIST CASE, which is the default and was the silent one. An
        // installation that HAS set `providers.<cloud>.sizes` was already answered above,
        // against the operator's list, before the catalogue was even fetched. Reaching here
        // means the id is simply not something this cloud sells — and the catalogue is in
        // hand, so saying what it does sell costs nothing.
        //
        // Capped, because this is a sentence rather than a catalogue: a cloud sells dozens of
        // types and an error that scrolls is one nobody reads. The full list has its own
        // surface now — `rockysurf offerings`, and the `list_offerings` MCP tool.
        return badRequest(
          c,
          `provider ${providerId} has no offering "${body.offeringId}". ${describeCatalogue(catalogue)}`,
          [{ path: 'offeringId', message: 'not an offering this installation can create' }],
        )
      }
      if (!offering.available) {
        // The provider's own reason where it gives one (Azure: which quota gate refused, issue
        // #116) — a caller told "sold out" for a size their subscription has no quota for
        // would wait for stock that never comes.
        const why = offering.unavailableReason ? `is unavailable: ${offering.unavailableReason}` : 'is sold out right now'
        return c.json({ error: `offering "${offering.id}" ${why}`, code: 'capacity' }, 503)
      }
      offeringId = offering.id
      // From the OFFERING, never from the cheapest row in the catalogue: this is what the box
      // is actually built on, and it is what `$ARCH` in every pack script resolves to.
      arch = offering.arch
      size = body.size ?? 'custom'
    } else {
      // No `offeringId` reaches here, and the door guard above already refused "neither field
      // sent" — so `body.size` is guaranteed present. TypeScript cannot see that invariant
      // across the branch, hence the assertion rather than a fourth impossible-in-practice check.
      const requestedSize = body.size!
      let catalogue
      try {
        catalogue = allowedOfferings(await provider.listOfferings(), allowlist)
      } catch (err) {
        return fail(c, err)
      }
      /*
       * The user's own answer for this size on this cloud comes FIRST (issue #124), and the
       * catalogue it is checked against is the allowlisted one — a preference the operator has
       * since excluded with `providers.<cloud>.sizes` is not quietly reinstated here.
       */
      const preference = deps.tierPreference?.(providerId, requestedSize)
      const resolution = resolveSize(catalogue, requestedSize, {
        ...(body.arch ? { arch: body.arch } : {}),
        ...(preference ? { preference } : {}),
      })
      if (!resolution.ok) {
        const scope = allowlist ? ` (of the ${allowlist.length} this installation offers)` : ''
        // The preference note leads when there is one: "your saved large type is unavailable"
        // is the fact that explains the refusal, and "no machine type meets 4 vCPU" alone would
        // send someone to look at a floor they never set.
        const why = resolution.note ? `${resolution.note}; ${resolution.reason}` : resolution.reason
        const message = `${providerId}: ${why}${scope}`
        // Sold out is retryable and unsatisfiable is not, so they must not share a status.
        if (resolution.soldOut) return c.json({ error: message, code: 'capacity' }, 503)
        return badRequest(c, message, [{ path: 'size', message: why }])
      }
      sizeNote = resolution.note
      offeringId = resolution.offering.id
      arch = resolution.offering.arch
      size = requestedSize
    }

    try {
      const row = await lifecycle.create({
        userId: user.id,
        name: body.name ?? `server-${Date.now().toString(36)}`,
        ...(body.description ? { description: body.description } : {}),
        provider: providerId,
        size,
        offeringId,
        arch,
        ...(body.packId ? { packId: body.packId } : {}),
        ...(body.tools ? { tools: body.tools } : {}),
        ...(body.repositories ? { repositories: body.repositories } : {}),
        /**
         * THE TWO CREDENTIALS THE BODY CARRIES, which this call used to leave behind
         * (rockysurf-z0wf). Both fields were declared on `createBody`, validated, and then
         * never named again: `lifecycle.create` has taken an `sshPublicKey` since it was
         * written and gained `rdpPassword` with this bead, and neither was spread in here.
         *
         * The RDP one is what the bug reproduced from. The user typed a password into the
         * form, core dropped it, `secretsStore.getRdpPassword` therefore found nothing,
         * `secrets.env` omitted `RDP_PASSWORD` (correctly — an empty value would be worse),
         * and the plan's `rdp` step refused to run. The box came up with `rocky`'s shadow
         * field still holding cloud-init's `!`, so xrdp's sesman connected and PAM refused
         * every password there was to type.
         *
         * The SSH one failed more quietly and is the same defect in the same object literal:
         * a user who pasted their own public key got a box authorized for core's key alone,
         * which still works — through the SPA's key download — so nothing looked broken.
         */
        ...(body.sshPublicKey ? { sshPublicKey: body.sshPublicKey } : {}),
        ...(body.rdpPassword ? { rdpPassword: body.rdpPassword } : {}),
        // Trimmed, paired with its runAs and defaulted above (issue #184). Not echoed back on
        // the response: `present()` renders what a screen shows, and nothing shows this.
        ...(userScript ? { userScript } : {}),
        // Already validated and split by custody above (issue #189). Passed whenever there is
        // anything at all — including when only the secret half is non-empty, because the
        // lifecycle files the two in two different places.
        ...(Object.keys(packInputs.values).length || Object.keys(packInputs.secrets).length
          ? { packInputs: { values: packInputs.values, secrets: packInputs.secrets } }
          : {}),
        // The same again for what the user typed themselves (issue #197): passed whenever there
        // is anything at all, including when only the secret half is non-empty, because the
        // lifecycle files the two in two different places.
        ...(Object.keys(environment.values).length || Object.keys(environment.secrets).length
          ? { environment: { values: environment.values, secrets: environment.secrets } }
          : {}),
        // A retried POST carrying the same key returns the original server and provisions
        // nothing — the standard header, so a client can be safe without inventing a scheme.
        ...(c.req.header('idempotency-key') ? { idempotencyKey: c.req.header('idempotency-key')! } : {}),
      })
      return created(c, { ...present(row, deps), ...(sizeNote ? { sizeNote } : {}) })
    } catch (err) {
      return fail(c, err)
    }
  })

  routes.get('/api/v1/servers/:serverId', async (c) => {
    try {
      const { row, syncError } = await lifecycle.get(c.get('user').id, c.req.param('serverId'))
      return success(c, present(row, deps, syncError))
    } catch (err) {
      return fail(c, err)
    }
  })

  /**
   * Edit the display fields — name, description — and nothing else (issue #46).
   *
   * PATCH, because it is one: omitted means "leave it". A description sent as the empty
   * string clears it — that is what backspacing the form field down to nothing says — while
   * a name cannot be cleared, only replaced, because every row has one.
   */
  routes.patch('/api/v1/servers/:serverId', validate('json', updateBody), async (c) => {
    const body = c.req.valid('json')
    try {
      const row = await lifecycle.updateMetadata(c.get('user').id, c.req.param('serverId'), {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description || null } : {}),
      })
      return success(c, present(row, deps))
    } catch (err) {
      return fail(c, err)
    }
  })

  for (const [path, action] of [
    ['start', 'start'],
    ['stop', 'stop'],
    ['terminate', 'terminate'],
  ] as const) {
    routes.post(`/api/v1/servers/:serverId/${path}`, async (c) => {
      try {
        return success(c, present(await lifecycle[action](c.get('user').id, c.req.param('serverId')), deps))
      } catch (err) {
        return fail(c, err)
      }
    })
  }

  return routes
}
