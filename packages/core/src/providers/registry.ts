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

export class ProviderRegistry {
  private readonly byId = new Map<string, ComputeProvider>()
  private readonly unavailableById = new Map<string, UnavailableProvider>()

  constructor(providers: ComputeProvider[] = [], unavailable: UnavailableProvider[] = []) {
    for (const provider of providers) this.byId.set(provider.id, provider)
    for (const entry of unavailable) this.unavailableById.set(entry.id, entry)
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
