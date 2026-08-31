import { Hono, type Context } from 'hono'
import type { AppEnv } from '../app.js'
import { readLive, type Live } from '../config/live-config.js'
import type { Db } from '../db/client.js'
import { deleteSetting, getSetting, setSetting } from '../db/repositories/settings.js'
import { failure, forbidden, notFound, success, type ErrorBody, type ErrorCode } from '../http/responses.js'
import type { SecretsStore } from '../secrets/store.js'
import {
  fetchViewer,
  GithubDeviceFlowError,
  pollForToken,
  requestDeviceCode,
  SLOW_DOWN_INCREMENT_SECONDS,
  type FetchLike,
} from './device-flow.js'

/**
 * `/api/v1/github` — Connect GitHub, from the server side (rockysurf-7fyf.1).
 *
 * Four routes: read the connection, start a device flow, poll it, forget it. They subsume
 * rockysurf-0rw3, which asked for exactly this — an authenticated writer for the per-user
 * `github-token` row — with a button where that bead imagined a paste box.
 *
 * AUTHENTICATED, NOT ADMIN-GATED. The token this mints belongs to the person who approved it on
 * github.com and lands on the boxes THEY create, so every account holder connects their own.
 * Today only the local admin exists, which makes that the same thing with the right shape.
 *
 * WHERE THE TOKEN GOES, and why it is not the config file:
 *
 *  - `putGithubToken(user.id, …)` writes it to the ENCRYPTED store, per user, which
 *    `bootstrap/server-secrets.ts` already prefers over `github.pat` — "THE STORED TOKEN WINS",
 *    written down there before this route existed, so no precedence was invented here;
 *  - the store is read LIVE at server-create, so a connection takes effect on the very next box.
 *    The config file is read once at boot, so writing it there would make this button mean
 *    "click Connect, then restart the process" — which is the point of the button, gone;
 *  - per-user is the correct custody for a credential minted by one person's click, and it is
 *    the exact defect `SECURITY.md` warns about for the instance-wide `github.pat`.
 *
 * THE CUSTODY RULE APPLIES HERE (`secrets/route-inventory.test.ts`). "Is this user connected?"
 * is answered with `listSecretRefs` — metadata, no plaintext — which is precisely why that
 * method exists. This file must never need an exemption, and adding one is not an acceptable
 * way to make it pass.
 *
 * DISCONNECT DOES NOT REVOKE. Revocation at GitHub needs the client secret the device flow
 * deliberately does not have, so this forgets the token locally and every response says so. A
 * button that implied a revocation it cannot perform would be the kind of lie this codebase
 * writes comments to avoid.
 */

export interface GithubConnectionConfig {
  /** `github.oauth.clientId` — absent means the button renders disabled with setup steps. */
  clientId?: string
  /** True when `github.pat` is set in the config file, so the page can name the winner. */
  configFallbackSet: boolean
}

export interface GithubRoutesDeps {
  db: Db
  secrets: SecretsStore
  /** Read per request since issue #264, so a client id saved on Settings enables the button at once. */
  config: Live<GithubConnectionConfig>
  /** Injected in tests. Production takes the platform `fetch`. */
  fetch?: FetchLike
}

/**
 * A flow in progress. IN MEMORY, DELIBERATELY.
 *
 * `deviceCode` is a bearer credential: whoever holds it can redeem the pending grant the moment
 * the operator approves it. It therefore never reaches the browser — the routes hand out an
 * opaque `flowId` and keep this side of the pair here — and it is never written to the
 * database, because a flow lives fifteen minutes at most, a restart legitimately abandons an
 * unfinished one, and persisting it would put a bearer credential in a backup to buy nothing.
 */
interface PendingFlow {
  deviceCode: string
  userId: string
  expiresAt: number
  intervalMs: number
  lastPolledAt: number
}

/** Where the connection's metadata lives — the login and scopes, never the token. */
export const connectionKey = (userId: string): string => `github.connection.${userId}`

export interface StoredConnection {
  login: string | null
  scopes: readonly string[]
  connectedAt: string
}

export const DISCONNECT_NOTE =
  'Rocky Surf has forgotten this token. It is NOT revoked at GitHub — revoking needs a client ' +
  'secret the device flow does not use. To be certain it can no longer be used, remove Rocky Surf ' +
  'at https://github.com/settings/applications.'

const NO_CLIENT_ID =
  'This installation has no GitHub OAuth App configured, so there is nothing to connect to. Set ' +
  'github.oauth.clientId to the client ID of an OAuth App with "Enable Device Flow" ticked — you ' +
  'can register one at https://github.com/settings/applications/new.'

export function createGithubRoutes(deps: GithubRoutesDeps): Hono<AppEnv> {
  const { db, secrets } = deps
  const routes = new Hono<AppEnv>()
  const now = () => Date.now()
  const flows = new Map<string, PendingFlow>()

  /** Drop everything past its expiry. Runs on every start and poll; no timer to leak. */
  function sweep(): void {
    const at = now()
    for (const [id, flow] of flows) if (flow.expiresAt <= at) flows.delete(id)
  }

  function readConnection(userId: string): StoredConnection | undefined {
    const raw = getSetting(db, connectionKey(userId))
    if (raw === undefined) return undefined
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) return undefined
      return parsed as StoredConnection
    } catch {
      // A hand-edited row. The token is what makes a connection real; metadata is decoration.
      return undefined
    }
  }

  /**
   * Connected is decided by the SECRET ROW, not by the metadata row — via `listSecretRefs`,
   * which returns existence and provenance and no value at all.
   */
  function isConnected(userId: string): boolean {
    return secrets.listSecretRefs({ kind: 'github-token', ownerId: userId }).length > 0
  }

  /**
   * A device-flow failure as an HTTP error, carrying GitHub's own code alongside ours.
   *
   * `githubCode` rides along rather than being folded into the message because the page renders
   * the message and the tests assert the code — `device_flow_disabled` in particular must arrive
   * as itself, not as prose that could be reworded into meaninglessness.
   */
  function deviceFlowFailure(c: Context<AppEnv>, err: GithubDeviceFlowError) {
    // Unreachable GitHub is this installation's problem to report, not the caller's mistake.
    const code: ErrorCode = err.code === 'network' ? 'server_error' : 'bad_request'
    const body: ErrorBody & { githubCode: string } = { error: err.message, code, githubCode: err.code }
    return c.json(body, code === 'server_error' ? 500 : 400)
  }

  /* ------------------------------------------------------------------------ the state */

  routes.get('/api/v1/github/connection', (c) => {
    const user = c.get('user')
    const connected = isConnected(user.id)
    const stored = connected ? readConnection(user.id) : undefined
    return success(c, {
      clientIdConfigured: Boolean(readLive(deps.config).clientId),
      connected,
      ...(stored
        ? { login: stored.login, scopes: stored.scopes ?? [], connectedAt: stored.connectedAt }
        : {}),
      /**
       * `github.pat` is also set. NOT a refusal — a warning, which is rockysurf-0rw3's open
       * question answered. Nothing persists the config value, so there is no stale copy to go
       * stale, and per-user-beats-instance-wide is the intended precedence. What the page
       * prevents by rendering this is the support question "which token did my box get?".
       */
      configFallbackSet: readLive(deps.config).configFallbackSet,
    })
  })

  /* ------------------------------------------------------------------------ the start */

  routes.post('/api/v1/github/connect', async (c) => {
    const user = c.get('user')
    const { clientId } = readLive(deps.config)
    if (!clientId) return failure(c, 'bad_request', NO_CLIENT_ID)

    sweep()
    // One pending flow per user: starting again abandons the last one rather than stacking.
    for (const [id, flow] of flows) if (flow.userId === user.id) flows.delete(id)

    let grant
    try {
      grant = await requestDeviceCode({
        clientId,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      })
    } catch (err) {
      if (err instanceof GithubDeviceFlowError) return deviceFlowFailure(c, err)
      throw err
    }

    const flowId = globalThis.crypto.randomUUID()
    flows.set(flowId, {
      deviceCode: grant.deviceCode,
      userId: user.id,
      expiresAt: now() + grant.expiresInSeconds * 1000,
      intervalMs: grant.intervalSeconds * 1000,
      // The clock starts now, so a browser that polls immediately is throttled rather than
      // spending one of the installation's requests on an answer GitHub cannot have yet.
      lastPolledAt: now(),
    })

    // `deviceCode` is deliberately absent from this body. See `PendingFlow` above.
    return success(c, {
      flowId,
      userCode: grant.userCode,
      verificationUri: grant.verificationUri,
      expiresInSeconds: grant.expiresInSeconds,
      intervalSeconds: grant.intervalSeconds,
    })
  })

  /* ------------------------------------------------------------------------- the poll */

  routes.post('/api/v1/github/connect/:flowId/poll', async (c) => {
    const user = c.get('user')
    sweep()

    const flowId = c.req.param('flowId')
    const flow = flows.get(flowId)
    if (!flow) {
      return notFound(
        c,
        'That connection attempt is no longer in progress — it expired, finished, or this ' +
          'process restarted. Start a new one to get a fresh code.',
      )
    }
    /**
     * A FLOW BELONGS TO THE USER WHO STARTED IT. Polling someone else's `flowId` would be a
     * token handover: the poll that succeeds is the one that WRITES the secret, so without this
     * check the account holder who approved the code on github.com would not necessarily be the
     * one whose boxes get the token.
     */
    if (flow.userId !== user.id) return forbidden(c, 'That connection attempt belongs to another account.')

    /**
     * SERVER-SIDE THROTTLE. A browser tab looping faster than the interval must not be able to
     * get the whole installation `slow_down`-ed or rate-limited by GitHub, so a poll that
     * arrives early is answered `pending` from here with no request made at all.
     */
    const at = now()
    if (at - flow.lastPolledAt < flow.intervalMs) {
      return success(c, {
        status: 'pending',
        intervalSeconds: Math.ceil(flow.intervalMs / 1000),
        message: 'Waiting for you to enter the code on github.com.',
      })
    }
    flow.lastPolledAt = at

    let result
    try {
      result = await pollForToken({
        clientId: readLive(deps.config).clientId!,
        deviceCode: flow.deviceCode,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      })
    } catch (err) {
      if (err instanceof GithubDeviceFlowError) {
        flows.delete(flowId)
        return success(c, { status: 'error', githubCode: err.code, message: err.message })
      }
      throw err
    }

    if (result.status === 'pending') {
      if (result.slowDown) {
        // Up by five seconds and it STAYS up, per the device-flow RFC. GitHub's own `interval`
        // wins when it sent one.
        flow.intervalMs =
          result.intervalSeconds !== undefined
            ? result.intervalSeconds * 1000
            : flow.intervalMs + SLOW_DOWN_INCREMENT_SECONDS * 1000
      }
      return success(c, {
        status: 'pending',
        intervalSeconds: Math.ceil(flow.intervalMs / 1000),
        slowDown: result.slowDown,
        message: result.message,
      })
    }

    if (result.status !== 'connected') {
      flows.delete(flowId)
      return success(c, {
        status: result.status === 'denied' ? 'denied' : result.status === 'expired' ? 'expired' : 'error',
        ...(result.status === 'error' ? { githubCode: result.code } : {}),
        message: result.message,
      })
    }

    /* ------------------------------------------------------------------- connected */

    flows.delete(flowId)

    let login: string | null = null
    let scopes: readonly string[] = result.scopes
    let note: string | undefined
    try {
      const viewer = await fetchViewer({
        token: result.accessToken,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      })
      login = viewer.login
      if (viewer.scopes.length > 0) scopes = viewer.scopes
    } catch (err) {
      /**
       * The token is REAL — GitHub just handed it over — so it is stored either way. Only the
       * name of the account is missing, and discarding a working credential because a second
       * request failed would be the worse outcome by a distance.
       */
      note =
        'Connected, but GitHub would not say which account this token belongs to: ' +
        (err instanceof Error ? err.message : String(err))
    }

    secrets.putGithubToken(user.id, result.accessToken)
    const connection: StoredConnection = { login, scopes, connectedAt: new Date().toISOString() }
    setSetting(db, connectionKey(user.id), JSON.stringify(connection))

    // The token itself is deliberately absent, here and from every other response in this file.
    return success(c, {
      status: 'connected',
      login,
      scopes,
      connectedAt: connection.connectedAt,
      ...(note ? { message: note } : {}),
    })
  })

  /* ------------------------------------------------------------------- the disconnect */

  routes.delete('/api/v1/github/connection', (c) => {
    const user = c.get('user')
    const removed = secrets.deleteSecret({ kind: 'github-token', ownerId: user.id })
    deleteSetting(db, connectionKey(user.id))
    for (const [id, flow] of flows) if (flow.userId === user.id) flows.delete(id)
    // Idempotent: disconnecting twice is a 200 both times. `removed` says whether there was
    // anything to forget, so a page can tell the difference without the status code lying.
    return success(c, { disconnected: true, removed, message: DISCONNECT_NOTE })
  })

  return routes
}
