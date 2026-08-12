import type { Config } from '../config/index.js'
import type { ProviderRegistry } from '../providers/registry.js'
import { PROVIDER_CREDENTIAL_ENV, type SecretsStore } from '../secrets/index.js'

/**
 * First-run state: what the wizard needs to know, and nothing more.
 *
 * The question the wizard actually asks is "can this installation create a server yet?", and
 * the honest answer is "is any provider both configured and loaded". Those are two different
 * facts and the shape below keeps them apart, because a user who has pasted a token but not
 * restarted needs a different sentence from one who has pasted nothing.
 */

/** Where a provider's credential comes from, and therefore whether the UI may edit it. */
export type CredentialSource =
  /** From the environment. READ-ONLY: the secrets store refuses to persist over it. */
  | 'env'
  /** In `rockysurf.config.yaml`, possibly via `${VAR}`. Read-only here; edit the file. */
  | 'config'
  /** Pasted into the UI and encrypted at rest. Editable. */
  | 'stored'
  /** Nothing anywhere. */
  | 'none'

export interface ProviderSetupState {
  id: string
  displayName: string
  /** Enabled in the config file. A disabled provider is not offered by the wizard. */
  enabled: boolean
  /** A credential exists somewhere. Says nothing about whether it works. */
  configured: boolean
  source: CredentialSource
  /**
   * The provider is present in this process's registry, so it can actually be used.
   *
   * Distinct from `configured` on purpose: core cannot import a provider package (the
   * dependency lint forbids it), so providers arrive already constructed. A credential stored
   * through the wizard is therefore live only once something constructs that provider —
   * today, at the next boot.
   */
  loaded: boolean
  /** True when a pasted credential would be refused, and why. */
  readOnlyReason?: string
}

export interface SetupState {
  /** At least one provider is enabled, credentialed AND loaded — the app can create servers. */
  complete: boolean
  /** No provider is enabled at all: the state the wizard exists for. */
  needsProvider: boolean
  providers: ProviderSetupState[]
}

export interface SetupStateDeps {
  config: Config
  registry: ProviderRegistry
  secrets?: SecretsStore
  env?: NodeJS.ProcessEnv
}

const DISPLAY_NAMES: Record<string, string> = {
  hetzner: 'Hetzner Cloud',
  aws: 'Amazon EC2',
  byo: 'Bring your own hosts',
}

/** Which env var, if any, is supplying this provider's credential right now. */
function envCredential(providerId: string, env: NodeJS.ProcessEnv): string | undefined {
  return PROVIDER_CREDENTIAL_ENV[providerId]?.find((name) => (env[name] ?? '').trim() !== '')
}

export function computeSetupState(deps: SetupStateDeps): SetupState {
  const env = deps.env ?? process.env
  const configured = deps.config.providers

  const providers: ProviderSetupState[] = Object.entries(configured).map(([id, provider]) => {
    const fromEnv = envCredential(id, env)
    const stored = deps.secrets?.getProviderToken(id) !== undefined

    // `byo` has no credential at all — its "configuration" is a list of hosts.
    const inConfig =
      id === 'byo'
        ? (configured.byo.hosts.length ?? 0) > 0
        : Boolean((provider as { token?: string }).token)

    const source: CredentialSource = fromEnv ? 'env' : inConfig ? 'config' : stored ? 'stored' : 'none'

    const registryHas = deps.registry.has(id)
    const base: ProviderSetupState = {
      id,
      displayName: DISPLAY_NAMES[id] ?? id,
      enabled: provider.enabled,
      configured: source !== 'none',
      source,
      loaded: registryHas,
    }

    if (fromEnv) {
      return {
        ...base,
        readOnlyReason:
          `${fromEnv} is set in the environment, which wins at runtime. Rocky Surf refuses to ` +
          'store a credential that something else would override — unset it to manage the token here.',
      }
    }
    if (source === 'config') {
      return {
        ...base,
        readOnlyReason: 'This credential comes from rockysurf.config.yaml. Edit the file to change it.',
      }
    }
    return base
  })

  return {
    complete: providers.some((p) => p.enabled && p.configured && p.loaded),
    needsProvider: !providers.some((p) => p.enabled),
    providers,
  }
}
