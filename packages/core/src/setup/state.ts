import type { Config } from '../config/index.js'
import type { ProviderRegistry } from '../providers/registry.js'

/**
 * First-run state: what the wizard needs to know, and nothing more.
 *
 * The question the wizard actually asks is "can this installation create a server yet?", and
 * the honest answer is "is any provider both enabled and loaded". Those are two different
 * facts and the shape below keeps them apart, because a user who has switched a cloud on but
 * not finished its auth path needs a different sentence from one who has enabled nothing.
 *
 * NOTHING HERE READS OR WRITES A CREDENTIAL (issue #280). The wizard selects clouds; every
 * cloud authenticates through the user's own auth path — an environment variable for Hetzner,
 * the standard chains for AWS, Azure and GCP — and Rocky Surf stores none of it.
 */

/**
 * The environment variables that supply each provider's credential, when one does.
 *
 * Used for two things: reporting `source: 'env'` and `envVar` below, so the wizard can say
 * "HETZNER_TOKEN detected" after the set-the-variable-and-restart loop, and the composition
 * root's credential fallback for providers whose config field was left empty
 * (`packages/rockysurf/src/compose.ts`).
 *
 * These variables are configuration, not data — they are never written anywhere.
 */
export const PROVIDER_CREDENTIAL_ENV: Readonly<Record<string, readonly string[]>> = {
  hetzner: ['HETZNER_TOKEN', 'HCLOUD_TOKEN'],
  aws: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE'],
  // The same variables `DefaultAzureCredential` reads, which is what lets an installation
  // already configured for other Azure tooling need nothing new. A managed identity supplies no
  // variable at all, so an Azure control plane running on an Azure VM is credentialed with none
  // of these set — which this reports as "no credential" and is, for that path, simply wrong.
  // It is the same shape as an AWS instance role, and is left alone for the same reason: the
  // honest fix is asking the provider, not adding a fourth variable name here. `loaded` is the
  // fact that matters for readiness, and chain-auth providers load without any of these.
  azure: ['AZURE_CLIENT_SECRET', 'AZURE_CLIENT_ID', 'AZURE_TENANT_ID'],
  // Application Default Credentials. ADC's other paths — `gcloud auth application-default
  // login`, the metadata server — set no variable at all, so a GCP installation can be fully
  // credentialed while this reports nothing, exactly as an AWS installation using an SSO
  // session does.
  gcp: ['GOOGLE_APPLICATION_CREDENTIALS'],
}

/** Where a provider's credential comes from. Informational: nothing here is editable. */
export type CredentialSource =
  /** From the environment — the auth path the wizard steers a token cloud to. */
  | 'env'
  /** Named in `rockysurf.config.yaml`, usually as a `${VAR}` reference. Edit the file. */
  | 'config'
  /** Nothing anywhere. For a chain-auth cloud this can still be a fully working install. */
  | 'none'

export interface ProviderSetupState {
  id: string
  displayName: string
  /** Enabled in the config file. The wizard's own POST is one way this becomes true. */
  enabled: boolean
  /** A credential exists somewhere this process can see. Says nothing about whether it works. */
  configured: boolean
  source: CredentialSource
  /** The environment variable currently supplying the credential, when `source` is `'env'`. */
  envVar?: string
  /**
   * The provider is present in this process's registry, so it can actually be used.
   *
   * Distinct from `configured` on purpose: core cannot import a provider package (the
   * dependency lint forbids it), so providers arrive already constructed. A cloud enabled
   * through the wizard is live only once something constructs that provider — on a config
   * reload when everything it needs is already in place, otherwise at the next boot, which is
   * how an environment variable can only ever arrive.
   */
  loaded: boolean
  /**
   * Why an enabled provider is not loaded, in the provider's own words.
   *
   * Only ever set alongside `loaded: false`. `configured` says whether a credential exists;
   * this says what the composition root refused, which is a different failure and the one that
   * used to be invisible — a rejected `providers.aws` section produced a boot-log line and an
   * app that quietly offered one cloud (rockysurf-va2l).
   */
  unavailableReason?: string
}

export interface SetupState {
  /**
   * At least one provider is enabled AND loaded — the app can create servers.
   *
   * Deliberately not "enabled, credentialed and loaded" (issue #280): an AWS instance role, an
   * Azure managed identity or a GCP ADC session credentials a provider without setting any
   * variable this process could detect, so `configured` would call a working installation
   * incomplete forever. `loaded` already implies the composition root found what it needed.
   */
  complete: boolean
  /** No provider is enabled at all: the state the wizard exists for. */
  needsProvider: boolean
  providers: ProviderSetupState[]
}

export interface SetupStateDeps {
  config: Config
  registry: ProviderRegistry
  env?: NodeJS.ProcessEnv
}

const DISPLAY_NAMES: Record<string, string> = {
  hetzner: 'Hetzner Cloud',
  aws: 'Amazon EC2',
  azure: 'Microsoft Azure',
  gcp: 'Google Compute Engine',
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

    // `byo` has no credential at all — its "configuration" is a list of hosts.
    const inConfig =
      id === 'byo'
        ? (configured.byo.hosts.length ?? 0) > 0
        : Boolean((provider as { token?: string }).token)

    // Config first, then the environment — the same order the composition root resolves in,
    // so this report never disagrees with what actually loaded. A `${VAR}` reference in the
    // file arrives here already interpolated, so the common Hetzner setup reads as 'config'.
    const source: CredentialSource = inConfig ? 'config' : fromEnv ? 'env' : 'none'

    const registryHas = deps.registry.has(id)
    const unavailableReason = registryHas ? undefined : deps.registry.unavailableReason(id)
    return {
      id,
      displayName: DISPLAY_NAMES[id] ?? id,
      enabled: provider.enabled,
      configured: source !== 'none',
      source,
      ...(fromEnv && !inConfig ? { envVar: fromEnv } : {}),
      loaded: registryHas,
      ...(unavailableReason ? { unavailableReason } : {}),
    }
  })

  return {
    complete: providers.some((p) => p.enabled && p.loaded),
    needsProvider: !providers.some((p) => p.enabled),
    providers,
  }
}
