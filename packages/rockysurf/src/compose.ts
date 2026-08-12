import {
  ProviderRegistry,
  makeFakeProvider,
  type Config,
  type ProviderCompositionContext,
  type SecretsStore,
} from '@rockysurf/core'
import type { ComputeProvider, ProviderFactory } from '@rockysurf/provider-sdk'
import awsProviderFactory from '@rockysurf/provider-aws'
import byoProviderFactory from '@rockysurf/provider-byo'
import hetznerProviderFactory from '@rockysurf/provider-hetzner'

/**
 * The composition root (rockysurf-55fx.12).
 *
 * THIS IS THE ONLY PLACE IN THE REPOSITORY THAT MAY IMPORT BOTH CORE AND A PROVIDER, and the
 * dependency lint enforces exactly that. Everything the rule buys depends on it staying true:
 * the SDK is kept honest because core can only ever see the interface, and the AWS SDK stays
 * out of core's dependency tree, which is what makes an `npx` cold start fast.
 *
 * Core has always had the seam — `AppDeps.providers` — but until this package existed nothing
 * filled it in production, so `createDefaultRegistry()` handed back the fake provider and a
 * configured Hetzner token could never reach a live provider. That gap was found by driving
 * the first-run wizard in a browser (rockysurf-hzi7.2) and is what this file closes.
 *
 * The wiring is deliberately mechanical: read the config section, resolve the credential, hand
 * both to the provider package's own `configSchema.parse` and `createProvider`. Adding a
 * provider is one row in the table below — no core change, no new interface.
 */

/**
 * How a provider's credential is found, and what field it lands in.
 *
 * CREDENTIAL RESOLUTION IS CONFIG-FIRST, THEN THE SECRETS STORE. That order is the fix for the
 * second half of the wizard's problem: the config file names a token (possibly via `${VAR}`)
 * for someone who edits files, and the encrypted store holds what the wizard pasted for
 * someone who does not. Before this, the config schema rejected `enabled` without a token, so
 * the state the wizard creates — provider on, credential in the store — was not expressible at
 * all.
 *
 * Config wins on purpose. A credential written in the file is the one an operator can see,
 * diff and roll back; silently preferring a stored token would mean a file that lies.
 */
interface ProviderWiring<TConfig> {
  factory: ProviderFactory<TConfig>
  /** Pull the raw section out of the parsed config. */
  section: (config: Config) => { enabled: boolean } & Record<string, unknown>
  /** The config field the credential belongs in, or null for providers that need none. */
  credentialField: string | null
  /**
   * Build the input for the provider's own `configSchema.parse`.
   *
   * NOTE WHAT IS STRIPPED. `enabled` is CORE's field — orchestration, not provider
   * configuration — and every provider schema is a `strictObject`, so passing it through is
   * rejected outright. That rejection is the schemas doing their job: the boundary between
   * "core decides whether to load you" and "you decide what your config means" is real, and
   * this is the seam where it gets honoured.
   */
  input: (
    section: Record<string, unknown>,
    credential: string | undefined,
  ) => Record<string, unknown>
  /** Where a missing credential comes from, for the error message. */
  credentialHint: string
}

/**
 * Every provider this distribution ships.
 *
 * `byo` arrived as exactly what this design predicted: one more row, no core change, no new
 * interface (`rockysurf-ftl9.3`).
 */
const WIRINGS: ProviderWiring<never>[] = [
  {
    factory: hetznerProviderFactory as unknown as ProviderFactory<never>,
    section: (config) => config.providers.hetzner,
    credentialField: 'token',
    input: ({ enabled: _enabled, ...rest }, credential) => ({
      ...rest,
      ...(credential ? { token: credential } : {}),
    }),
    credentialHint:
      'set providers.hetzner.token in rockysurf.config.yaml (e.g. "${HETZNER_TOKEN}"), or paste it in the setup wizard',
  },
  {
    factory: awsProviderFactory as unknown as ProviderFactory<never>,
    section: (config) => config.providers.aws,
    // AWS credentials come from the standard SDK chain, never from a field we store.
    credentialField: null,
    // `sizes` is core's own idea — an allowlist for the UI — and the provider has never heard
    // of it, so it is stripped alongside `enabled`.
    input: ({ enabled: _enabled, sizes: _sizes, ...rest }) => rest,
    credentialHint: 'set AWS_PROFILE, or the standard AWS environment variables',
  },
  {
    factory: byoProviderFactory as unknown as ProviderFactory<never>,
    section: (config) => config.providers.byo,
    // No credential to resolve. BYO authenticates with the operator's OWN SSH key — a path in
    // `identityFile`, or an agent — and a path is not a secret to store, so there is nothing for
    // the wizard to hold and nothing for `resolveCredential` to decrypt.
    credentialField: null,
    input: ({ enabled: _enabled, ...rest }) => rest,
    credentialHint: 'set providers.byo.identityFile, or run an SSH agent that holds the key you log in with',
  },
]

export interface ComposeResult {
  registry: ProviderRegistry
  /** One line per provider, for the boot log. */
  notes: string[]
}

/**
 * Build the registry from configuration.
 *
 * Never throws for a provider that is misconfigured: one bad section must not stop the control
 * plane from starting, because the operator needs the UI up to fix it. A provider that cannot
 * be built is reported and left out, and `/api/v1/setup` then shows it as configured-but-not-
 * loaded — which is exactly the state the wizard's "Almost there" step explains.
 */
export function composeRegistry(context: ProviderCompositionContext): ComposeResult {
  const { config, secrets, log } = context
  const providers: ComputeProvider[] = []
  const notes: string[] = []

  for (const wiring of WIRINGS) {
    const section = wiring.section(config)
    const id = wiring.factory.id

    if (!section.enabled) {
      notes.push(`${id}: disabled in config`)
      continue
    }

    const credential = resolveCredential(wiring, section, id, secrets)
    if (wiring.credentialField && !credential) {
      notes.push(`${id}: enabled but no credential found — ${wiring.credentialHint}`)
      continue
    }

    try {
      const parsed = wiring.factory.configSchema.parse(wiring.input(section, credential))
      providers.push(wiring.factory.createProvider(parsed))
      notes.push(`${id}: ready${credential ? '' : ' (credentials from the environment)'}`)
    } catch (error) {
      // A provider's own schema rejected the section. Report it and carry on: the other
      // providers, and the UI that lets someone fix this one, still deserve to come up.
      notes.push(`${id}: not loaded — ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * The fake provider, when nothing real is configured.
   *
   * Not a test double here: it is what lets `npx rockysurf` come up with a working provider on
   * a machine with no cloud account, so someone can create a server, watch it boot and
   * terminate it before deciding whether to paste a token. Dropped the moment a real provider
   * loads, so it can never be picked by accident on a configured installation.
   */
  if (providers.length === 0) {
    providers.push(makeFakeProvider({ bootMs: 2000, terminateMs: 1500 }))
    notes.push('fake: no cloud configured, so the in-memory provider is available for a trial run')
  }

  for (const note of notes) log(`[providers] ${note}`)

  return { registry: new ProviderRegistry(providers), notes }
}

/**
 * Config first, then the secrets store.
 *
 * `getProviderToken` is a decrypt, so it is only reached when the config has nothing — both to
 * avoid needless decryption and to keep the file authoritative when it speaks.
 */
function resolveCredential(
  wiring: ProviderWiring<never>,
  section: Record<string, unknown>,
  id: string,
  secrets: SecretsStore,
): string | undefined {
  if (!wiring.credentialField) return undefined

  const fromConfig = section[wiring.credentialField]
  if (typeof fromConfig === 'string' && fromConfig.trim() !== '') return fromConfig

  try {
    return secrets.getProviderToken(id)
  } catch {
    // A store that cannot be read is not this function's problem to report; the caller's
    // "no credential found" message covers it, and boot must not die here.
    return undefined
  }
}
