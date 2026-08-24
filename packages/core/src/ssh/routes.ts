import { Hono } from 'hono'
import type { AppEnv } from '../app.js'
import type { Db } from '../db/client.js'
import { getServer } from '../db/repositories/servers.js'
import { appendEvent } from '../db/repositories/users.js'
import { notFound, success, type ErrorBody } from '../http/responses.js'
import type { SecretsStore } from '../secrets/store.js'
import { fingerprintPublicKey } from './keys.js'
import { getServerKeyMaterial, privateKeyFilename } from './server-keys.js'

/**
 * The private-key download — **the only route in this codebase that returns decrypted secret
 * material**, and the one documented exemption to the custody rule in
 * `secrets/route-inventory.test.ts`. That test names this file explicitly; it is an allowlist
 * entry, not a relaxed rule, so any OTHER route that reaches for plaintext still fails it.
 *
 * Ported from the legacy Lambda backend's SSH-key handler, keeping its shape — authenticate, resolve
 * the server, check ownership, respond as a `.pem` attachment — with two deliberate changes:
 *
 *  1. THE EITHER/OR IS GONE. The old handler 404'd when the server had a user-supplied key,
 *     because a user key meant no core-generated one. Push-mode bootstrap makes that
 *     impossible: core installs over its own SSH connection, so a server whose only authorized
 *     key belongs to the user cannot be bootstrapped, resumed, or recovered. Core's key now
 *     always exists, and a user key is additional access (see `server-keys.ts`). So this route
 *     answers for every server that has key material, and 404s only when there is none.
 *  2. EVERY DOWNLOAD IS AUDITED. An `ssh_key.downloaded` event is appended before the body is
 *     written, carrying who asked and which server.
 *
 * WHY NOT LITERALLY ONCE. "Download once and never again" is tempting and worse: a transfer
 * that fails halfway strands the operator with no key and no recourse, and it buys very little
 * — the same private key remains on the box in `authorized_keys` and in core's database, so
 * the real control is revocation and rotation, not download counting. Accountability is the
 * property worth having here, so every download is recorded and re-downloads are permitted.
 */

export interface SshRoutesDeps {
  db: Db
  secrets: SecretsStore
}

export function createSshKeyRoutes(deps: SshRoutesDeps): Hono<AppEnv> {
  const { db, secrets } = deps
  const routes = new Hono<AppEnv>()

  routes.get('/api/v1/servers/:id/ssh-key', (c) => {
    const user = c.get('user')
    const server = getServer(db, c.req.param('id'))

    // Same answer for "no such server" and "not yours": a stranger must not be able to probe
    // which server ids exist by watching 404 turn into 403.
    if (!server || (server.userId !== user.id && !user.isAdmin)) {
      return notFound(c, 'Server not found')
    }

    const material = getServerKeyMaterial(secrets, server.id)
    if (!material) {
      return notFound(c, 'No SSH key material is stored for this server')
    }
    // Retired, not merely absent (ADR-0008, issue #92): a supplied-key box's bootstrap removed
    // core's key from `authorized_keys` and `retireManagedUserKey` cleared the private half
    // that would have downloaded here. The host half is still on `material` — this route never
    // served that anyway — so the 404 is specific to the thing that is actually gone.
    if (!material.userPrivateKey) {
      return notFound(c, "This server's own key was retired once your supplied key became the only key on the box")
    }

    appendEvent(db, {
      type: 'ssh_key.downloaded',
      serverId: server.id,
      userId: user.id,
      payload: { filename: privateKeyFilename(server.name, server.id), byAdmin: user.isAdmin && server.userId !== user.id },
    })

    // Attachment, not JSON: the browser saves a file the user can chmod 600 and pass to ssh.
    c.header('Content-Type', 'application/x-pem-file')
    c.header('Content-Disposition', `attachment; filename="${privateKeyFilename(server.name, server.id)}"`)
    // Belt and braces against a proxy or the browser keeping a copy of a private key.
    c.header('Cache-Control', 'no-store')
    return c.body(material.userPrivateKey)
  })


  /**
   * The server's HOST PUBLIC key, so a client can verify it without trust-on-first-use
   * (rockysurf-ftl9.2).
   *
   * A public key is not a secret — this route is deliberately NOT in the custody exemption
   * list, because there is nothing here to exempt. What it enables is the thing that matters:
   * core minted this host key before the server existed, so a client can write a real
   * `known_hosts` entry and connect with `StrictHostKeyChecking yes`. Without it the best any
   * client could do is `accept-new`, which is trust-on-first-use wearing a seatbelt — and the
   * first connection is the one that carries secrets.
   *
   * The fingerprint alone is not enough: `known_hosts` needs the key, and ssh will not verify
   * against a fingerprint non-interactively.
   *
   * WHICH IS EXACTLY WHY IT CAN REFUSE (rockysurf-ftl9.13). Core mints a host keypair for every
   * server including the ones it did not create, but a provider with `canInjectHostKeys: false`
   * has no pre-boot hook to install it with, so that box presents its OWN key forever. Core
   * knows this and already acts on it — `lifecycle` withholds the minted fingerprint from the
   * row and adopts the one the provider observed instead — but this route read the secrets
   * material regardless, so on a BYO server it answered with a key the machine will never
   * present. That is not a degraded answer, it is the worst possible one: a `known_hosts` entry
   * GUARANTEED to fail verification, and host-key failure is the alarm that means "someone is
   * intercepting this connection". A client that cried wolf on every ordinary connection would
   * teach its user to ignore the one that mattered.
   *
   * The test is the row's pin against the minted fingerprint, not `provider.id` and not a
   * capability lookup — this route has no registry and should need none. They agree exactly
   * when core minted the key the box presents, which is the only case where handing out the
   * minted key is true.
   *
   * When they disagree, the answer is the box's OWN key, which the provider observed during the
   * handshake it pinned and reported through `InstanceView.hostPublicKey` (ADR-0003 amendment
   * E14, `rockysurf-ftl9.14`). So an adopted machine yields exactly the same strict
   * `known_hosts` entry a cloud machine does, and no client anywhere has to settle for a prompt.
   *
   * The stored key is RE-HASHED here and compared to the row's pin before it is served. Core
   * verified the pin; it did not verify the key, which came out of a database row that a
   * provider wrote. Checking is one line and it is what keeps this route from becoming a second,
   * softer way to change a server's host key.
   *
   * Only when there is no key to serve — a row pinned before E14, or one where nothing has been
   * observed yet — does this 409, carrying the fingerprint so a human can still compare it with
   * what ssh prints. It degrades to "cannot hand out an entry", never to "hands out a wrong one".
   */
  routes.get('/api/v1/servers/:id/ssh-host-key', (c) => {
    const user = c.get('user')
    const server = getServer(db, c.req.param('id'))

    // Same 404 for absent and not-yours, matching the private-key route above.
    if (!server || (server.userId !== user.id && !user.isAdmin)) {
      return notFound(c, 'Server not found')
    }

    const material = getServerKeyMaterial(secrets, server.id)
    if (!material) return notFound(c, 'No SSH key material is stored for this server')

    if (server.hostKeyFingerprint !== material.hostKeyFingerprint) {
      // The box's own key, if core has it and it still hashes to the pin.
      if (server.hostPublicKey && server.hostKeyFingerprint) {
        let observed: string | undefined
        try {
          observed = fingerprintPublicKey(server.hostPublicKey)
        } catch {
          observed = undefined
        }
        if (observed === server.hostKeyFingerprint) {
          return success(c, {
            hostPublicKey: server.hostPublicKey,
            fingerprint: server.hostKeyFingerprint,
            // Which key this is, so a caller never has to infer it from the provider: `minted`
            // means core generated it before the box existed, `observed` means the provider
            // learned it from a machine core did not key. Both are strictly verifiable.
            source: 'observed',
          })
        }
      }

      const body: ErrorBody & { fingerprint?: string } = {
        error: server.hostKeyFingerprint
          ? 'This server presents its own host key, which core did not mint and does not hold. ' +
            'Its pinned fingerprint is in `fingerprint`; compare it with the one ssh shows you.'
          : 'No host key has been observed for this server yet. Core minted a key it cannot ' +
            'install on this provider, so there is nothing here a client could verify against.',
        code: 'conflict',
        ...(server.hostKeyFingerprint ? { fingerprint: server.hostKeyFingerprint } : {}),
      }
      return c.json(body, 409)
    }

    return success(c, {
      hostPublicKey: material.hostPublicKey,
      fingerprint: material.hostKeyFingerprint,
      source: 'minted',
    })
  })

  return routes
}

/**
 * Guard for callers that need the same check without the HTTP layer. Exported so the eventual
 * CLI path cannot invent a second, looser rule about who may hold a private key.
 */
export function mayDownloadKey(server: { userId: string }, user: { id: string; isAdmin: boolean }): boolean {
  return server.userId === user.id || user.isAdmin
}
