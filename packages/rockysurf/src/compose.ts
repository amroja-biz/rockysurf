import {
  ProviderRegistry,
  makeFakeProvider,
  type Config,
  type ProviderCompositionContext,
  type SecretsStore,
  type UnavailableProvider,
} from '@rockysurf/core'
import type { ComputeProvider, ProviderFactory } from '@rockysurf/provider-sdk'
import awsProviderFactory from '@rockysurf/provider-aws'
import azureProviderFactory from '@rockysurf/provider-azure'
import byoProviderFactory from '@rockysurf/provider-byo'
import gcpProviderFactory from '@rockysurf/provider-gcp'
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
    factory: azureProviderFactory as unknown as ProviderFactory<never>,
    section: (config) => config.providers.azure,
    // Azure credentials come from the environment, from a managed identity, or from the Azure
    // CLI — never from a field this app stores. Same posture as AWS, and it is what keeps the
    // wizard from drawing a box inviting someone to paste a client secret into a file that gets
    // backed up and pasted into bug reports.
    credentialField: null,
    // `sizes` is core's own idea — an allowlist for the UI — and the provider has never heard of
    // it, so it is stripped alongside `enabled`.
    input: ({ enabled: _enabled, sizes: _sizes, ...rest }) => rest,
    credentialHint:
      'set AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET, run on a VM with a managed identity, or run `az login`',
  },
  {
    factory: gcpProviderFactory as unknown as ProviderFactory<never>,
    section: (config) => config.providers.gcp,
    // GCP credentials come from Application Default Credentials — an ambient session, a key
    // file named by path, or the metadata server — so there is nothing for the wizard to hold
    // and nothing for `resolveCredential` to decrypt. A path is not a secret to store.
    credentialField: null,
    // `sizes` is core's own idea — an allowlist for the UI — and the provider has never heard
    // of it, so it is stripped alongside `enabled`.
    input: ({ enabled: _enabled, sizes: _sizes, ...rest }) => rest,
    credentialHint:
      'run `gcloud auth application-default login`, set GOOGLE_APPLICATION_CREDENTIALS, or set providers.gcp.keyFile',
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
  const unavailable: UnavailableProvider[] = []

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
      unavailable.push({ id, reason: `no credential found — ${wiring.credentialHint}` })
      continue
    }

    try {
      const parsed = wiring.factory.configSchema.parse(wiring.input(section, credential))
      providers.push(wiring.factory.createProvider(parsed))
      notes.push(`${id}: ready${credential ? '' : ' (credentials from the environment)'}`)
    } catch (error) {
      // A provider's own schema rejected the section. Report it and carry on: the other
      // providers, and the UI that lets someone fix this one, still deserve to come up.
      //
      // The reason also rides into the registry. The boot log alone was not enough: an
      // operator who enabled AWS without `sshAllowedCidr` got a working Hetzner-only app and
      // a single log line they had already scrolled past, which is exactly how "multi-cloud
      // silently isn't" happens (rockysurf-va2l).
      const reason = describeConfigError(error)
      notes.push(`${id}: not loaded — ${reason}`)
      unavailable.push({ id, reason })
    }
  }

  /**
   * The fake provider, when nothing real is configured.
   *
   * Not a test double here: it is what lets `npx rockysurf` come up with a working provider on
   * a machine with no cloud account, so someone can create a server, watch it boot and
   * terminate it before deciding whether to paste a token. Dropped the moment a real provider
   * loads, so it can never be picked by accident on a configured installation.
   *
   * `simulateBootstrap` is the difference between that sentence being true and being a promise
   * (rockysurf-8fkz). Promotion out of `provisioning` belongs to a server's own bootstrap, and a
   * simulated instance had no way to run one — so the trial run this note advertises reached
   * `instance_running`, stopped, and was terminated by the 30-minute timeout. With the flag, the
   * provider declares that it has no machine (ADR-0003, E15) and core drives the real install
   * plan in-process: the same steps, the same timeline, the same promotion, no cloud account.
   */
  if (providers.length === 0) {
    providers.push(makeFakeProvider({ bootMs: 2000, terminateMs: 1500, simulateBootstrap: true }))
    notes.push('fake: no cloud configured, so the in-memory provider is available for a trial run')
  }

  for (const note of notes) log(`[providers] ${note}`)

  return { registry: new ProviderRegistry(providers, unavailable), notes }
}

/**
 * A rejected provider section, in a sentence rather than a JSON dump.
 *
 * A zod error's `.message` is the serialised issue array, so the honest text an author wrote —
 * "sshAllowedCidr is required: state which network may reach SSH…" — arrives wrapped in
 * brackets, quotes and escapes. That was tolerable while this string only reached the boot log
 * and is not once it reaches a page (rockysurf-va2l).
 *
 * Duck-typed rather than `instanceof ZodError`: a provider's `configSchema` is structural by
 * SDK contract, so a provider is free to validate with something else entirely, and this file
 * should not acquire a zod dependency to read an error it did not create.
 */
function describeConfigError(error: unknown): string {
  const issues = (error as { issues?: unknown }).issues
  if (Array.isArray(issues) && issues.length > 0) {
    const described = issues
      .map((issue) => {
        const { message, path } = issue as { message?: unknown; path?: unknown }
        if (typeof message !== 'string') return undefined
        const field = Array.isArray(path) ? path.join('.') : ''
        // The field name is usually already in the message; adding it again reads as a stutter.
        return field && !message.includes(field) ? `${field}: ${message}` : message
      })
      .filter((text): text is string => Boolean(text))
    if (described.length > 0) return described.join(' ')
  }
  return error instanceof Error ? error.message : String(error)
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
