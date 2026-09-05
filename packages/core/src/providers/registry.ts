import { ProviderError, type ComputeProvider } from '@rockysurf/provider-sdk'
import { makeFakeProvider } from './fake.js'

/**
 * The provider registry — the ONLY provider-aware code in core.
 *
 * Everything above this looks a provider up by the id stored on the server row and then
 * branches on `capabilities.*`, never on the id itself. That property is what
 * `scripts/check-core-deps.mjs` protects from the other direction: core cannot even import a
 * concrete provider package, so providers arrive here already constructed.
 */
/**
 * A provider the operator turned on that this process could not build.
 *
 * Kept because the reason is otherwise lost. Composition happens once, at boot, and before
 * this existed a rejected provider section left only a line in the boot log — so an
 * installation with `aws.enabled: true` and no `sshAllowedCidr` came up looking like a
 * single-cloud installation, with no way for anyone in the UI to learn why (rockysurf-va2l).
 */
export interface UnavailableProvider {
  id: string
  /** The provider's own words, verbatim: it is the only text that names the missing field. */
  reason: string
}

/**
 * What the composition root knows about a provider FACTORY, whether or not a provider was built
 * from it (ADR-0026).
 *
 * A registry holds constructed providers, and a provider exists only when its section is enabled
 * and its config parsed. Two things core has to say about a cloud do not wait for that: the
 * setup wizard names a cloud that is switched off or failed to load, and it reports which
 * environment variable would supply the credential so the export-and-restart loop can say when
 * it closed. For the shipped five those facts live in core's own tables; for a personal provider
 * they live on the factory the composition root loaded, and this is how they travel without core
 * ever importing the package.
 */
export interface ProviderDescriptor {
  id: string
  displayName: string
  /** `ProviderFactory.credentialEnv` (E18) — the variables the composition root reads. */
  credentialEnv?: readonly string[]
}

export class ProviderRegistry {
  private readonly byId = new Map<string, ComputeProvider>()
  private readonly unavailableById = new Map<string, UnavailableProvider>()
  private readonly descriptorsById = new Map<string, ProviderDescriptor>()

  constructor(
    providers: ComputeProvider[] = [],
    unavailable: UnavailableProvider[] = [],
    descriptors: ProviderDescriptor[] = [],
  ) {
    this.fill(providers, unavailable, descriptors)
  }

  /**
   * Take on another registry's contents, keeping this object's identity (issue #264).
   *
   * WHY THE IDENTITY MATTERS. Composition happens outside core — `packages/rockysurf` is the
   * only place allowed to import both core and a provider — and the registry it builds is passed
   * once and then held by the job loop, the lifecycle service, the server routes and the
   * bootstrap supervisor. Handing all of them a new object on every save would mean rethreading
   * every one of those seams; swapping the CONTENTS of the one they already hold means the
   * next `get()` returns a client built from the config now in force, and nothing else changed.
   *
   * WHAT AN IN-FLIGHT OPERATION SEES: the client it already resolved, for as long as it holds
   * it. That is the correct answer and not a compromise — a create half-way through talking to
   * EC2 must finish against the account it started with, not be handed a different one mid-call.
   *
   * The old providers are simply dropped. Nothing in the SDK is closeable (ADR-0003 deliberately
   * has no lifecycle on a provider), so there is nothing to release; a provider still referenced
   * by an in-flight call stays alive until that call is done, which is exactly what is wanted.
   */
  replaceWith(next: ProviderRegistry): void {
    this.byId.clear()
    this.unavailableById.clear()
    this.descriptorsById.clear()
    this.fill(next.list(), next.unavailable(), next.descriptors())
  }

  private fill(providers: ComputeProvider[], unavailable: UnavailableProvider[], descriptors: ProviderDescriptor[]): void {
    for (const provider of providers) this.byId.set(provider.id, provider)
    for (const entry of unavailable) this.unavailableById.set(entry.id, entry)
    for (const descriptor of descriptors) this.descriptorsById.set(descriptor.id, descriptor)
  }

  /** Every factory the composition root knows, loaded or not. See `ProviderDescriptor`. */
  descriptors(): ProviderDescriptor[] {
    return [...this.descriptorsById.values()]
  }

  /** What the composition root knows about one factory, when it told us anything. */
  describe(id: string): ProviderDescriptor | undefined {
    return this.descriptorsById.get(id)
  }

  /** Throws `invalid_spec` for an unknown id, which the routes map to 400. */
  get(id: string): ComputeProvider {
    const provider = this.byId.get(id)
    if (!provider) {
      throw new ProviderError(
        'invalid_spec',
        `unknown provider: ${id}. Configured: ${this.ids().join(', ') || '(none)'}`,
      )
    }
    return provider
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }

  list(): ComputeProvider[] {
    return [...this.byId.values()]
  }

  ids(): string[] {
    return [...this.byId.keys()]
  }

  /** Providers the operator enabled that could not be built, and why. */
  unavailable(): UnavailableProvider[] {
    return [...this.unavailableById.values()]
  }

  /** Why `id` is missing from this registry, when something knows it should not be. */
  unavailableReason(id: string): string | undefined {
    return this.unavailableById.get(id)?.reason
  }
}

/**
 * The registry core builds when nothing else has been wired.
 *
 * DEV MODE, and a deliberate one: with no cloud credentials configured, `npx rockysurf` still
 * comes up with a working provider, so someone can create a server, watch it boot, stop it and
 * terminate it without an AWS account. The real providers replace this in 4b/4c once they are
 * loaded through configuration — the seam is `AppDeps.providers`.
 *
 * `simulateBootstrap` is what makes "watch it boot" true rather than aspirational: without it the
 * row reached `provisioning` and stopped there, because promotion belongs to a bootstrap and a
 * simulated instance had no way to run one (rockysurf-8fkz).
 */
export function createDefaultRegistry(): ProviderRegistry {
  return new ProviderRegistry([makeFakeProvider({ bootMs: 2000, terminateMs: 1500, simulateBootstrap: true })])
}
