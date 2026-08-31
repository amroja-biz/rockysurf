import { readFileSync, statSync } from 'node:fs'
import { Hono } from 'hono'
import type { AppEnv } from '../app.js'
import { checkConfigText, readLive, type Config, type Live, type ReloadOutcome } from '../config/index.js'
import { badRequest, conflict, forbidden, success } from '../http/responses.js'
import type { ProviderRegistry } from '../providers/registry.js'
import { applyChanges } from '../settings/document.js'
import { writeAtomically } from '../settings/routes.js'
import { computeSetupState } from './state.js'

/**
 * `/api/v1/setup` — what the first-run wizard reads and writes (rockysurf-hzi7.2, issue #280).
 *
 * Two routes, both authenticated: the wizard runs AFTER the admin has signed in with the
 * password printed at boot, which is what makes "the wizard verifies login works" true by
 * construction rather than by a separate check.
 *
 * NO ROUTE HERE TOUCHES A CREDENTIAL, by owner ruling (issue #280). The POST used to accept a
 * pasted token and encrypt-store it; now it only switches a cloud on in the config file — the
 * same edit the Settings page makes — and every credential comes from the user's own auth
 * path: an environment variable for Hetzner, the standard chains for AWS, Azure and GCP. The
 * old first-boot deadlock ("the provider that needs configuring is exactly the one that is not
 * loaded, so nothing can verify a token") dissolves rather than being worked around: there is
 * nothing to verify, and the wizard's job on return is only to LOOK at whether the provider
 * loaded, which `GET /api/v1/setup` has always answered.
 *
 * Nothing here branches on a provider id: the enable is the same one-field config edit for
 * every cloud, so a provider that does not exist yet needs no code in this file when it
 * arrives — which is the same rule the rest of core follows.
 */

export interface SetupRoutesDeps {
  /** Read per request since #264, so the wizard reflects a save without a restart. */
  config: Live<Config>
  registry: ProviderRegistry
  /**
   * The config file this process loaded, so enabling a cloud edits the file that is actually
   * in force. Absent — an embedded core, a bare test app — the POST says a cloud can only be
   * enabled by editing the file, the same honesty the settings editor shows by not mounting.
   */
  configPath?: string
  /** Environment `${VAR}` references are checked against, and credential variables read from. */
  env?: NodeJS.ProcessEnv
  /** Makes this process adopt the file it has just written (issue #264). */
  reload?: () => ReloadOutcome
}

/**
 * The keys a credential could arrive under, refused by name (issue #280).
 *
 * A `strictObject` would reject them too, but with a generic "unrecognized key" — and the one
 * request this route must never quietly half-serve is the old wizard's, or any client that
 * still believes pasting a token here stores it. The refusal says what changed and what to do
 * instead, so an out-of-date caller gets a sentence rather than a shape error.
 */
const CREDENTIAL_KEYS = ['token', 'credential', 'secret', 'password', 'key', 'apiKey'] as const

export function createSetupRoutes(deps: SetupRoutesDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  const env = deps.env ?? process.env
  const state = () =>
    computeSetupState({
      config: readLive(deps.config),
      registry: deps.registry,
      env,
    })

  routes.get('/api/v1/setup', (c) => success(c, state()))

  /**
   * Switch a cloud on: `providers.<id>.enabled: true`, written into the config file.
   *
   * The narrowest edit that makes the wizard's selection real, made through the same
   * comment-preserving document layer, the same schema check and the same atomic write the
   * Settings page uses — and then adopted by this process (#264), so the response's `setup`
   * already reflects it. Idempotent: enabling an enabled provider writes nothing.
   *
   * Admin-only for the reason the settings editor is: this writes the config file. On this
   * product that is not a restriction in practice — everyone who runs an installation is its
   * admin (docs/memories/2026-08-27) — but the seam stays consistent.
   */
  routes.post('/api/v1/setup/providers/:id', async (c) => {
    if (!c.get('user').isAdmin) return forbidden(c, 'Admin access required')

    const id = c.req.param('id')

    // REFUSE CREDENTIALS, in as many words. An empty or absent body is the correct request.
    const raw: unknown = await c.req.json().catch(() => ({}))
    if (raw !== null && typeof raw === 'object') {
      const keys = Object.keys(raw as Record<string, unknown>)
      const credentialKey = keys.find((key) => (CREDENTIAL_KEYS as readonly string[]).includes(key))
      if (credentialKey) {
        return badRequest(
          c,
          `this route no longer accepts credentials (\`${credentialKey}\` was sent). Rocky Surf stores no ` +
            'cloud credentials: set the provider’s environment variable, or use its standard ' +
            'credential chain, and restart — the wizard explains each cloud’s path.',
        )
      }
      if (keys.length > 0) return badRequest(c, `unexpected field: ${keys[0]}`)
    }

    const configured = state().providers.find((p) => p.id === id)
    if (!configured) return badRequest(c, `unknown provider: ${id}`)

    if (!configured.enabled) {
      if (!deps.configPath) {
        return conflict(
          c,
          'this installation has no config file to write, so a cloud can only be enabled by ' +
            `setting providers.${id}.enabled in rockysurf.config.yaml and restarting`,
        )
      }

      const before = readConfigFile(deps.configPath)
      let text: string
      try {
        text = applyChanges(before.text, [{ path: ['providers', id, 'enabled'], value: true }])
      } catch (err) {
        // A malformed document the Document API refuses to descend into. The file is unchanged.
        return badRequest(c, `could not enable ${id} in ${deps.configPath}: ${(err as Error).message}`)
      }

      // The same validation the boot path and the settings save use — a candidate file that
      // does not parse is refused before anything is written. A `${VAR}` reference the
      // environment lacks is a warning, not an issue, exactly as on the settings save: the
      // file is allowed to be ahead of the environment, because exporting the variable and
      // restarting is the wizard's own next instruction.
      const checked = checkConfigText(text, env)
      if (!checked.ok) {
        return badRequest(c, checked.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '))
      }

      writeAtomically(deps.configPath, text, before.mode)
      // Adopt it now (#264). When everything the provider needs is already in place — a chain
      // cloud with its fields set — the very next `state()` reports it loaded. When it is not,
      // the reload reports why and the state carries the provider's own reason; neither is an
      // error here, because "enabled, and here is what remains" is the wizard's normal output.
      deps.reload?.()
    }

    return success(c, { ok: true, setup: state() })
  })

  return routes
}

/** Read the config file, tolerating absence — a fresh install has no config file at all. */
function readConfigFile(path: string): { text: string; mode: number | null } {
  try {
    const stat = statSync(path)
    return { text: readFileSync(path, 'utf8'), mode: stat.mode & 0o777 }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', mode: null }
    throw err
  }
}
