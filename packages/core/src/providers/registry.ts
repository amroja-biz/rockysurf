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
export class ProviderRegistry {
  private readonly byId = new Map<string, ComputeProvider>()

  constructor(providers: ComputeProvider[] = []) {
    for (const provider of providers) this.byId.set(provider.id, provider)
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
}

/**
 * The registry core builds when nothing else has been wired.
 *
 * DEV MODE, and a deliberate one: with no cloud credentials configured, `npx rockysurf` still
 * comes up with a working provider, so someone can create a server, watch it boot, stop it and
 * terminate it without an AWS account. The real providers replace this in 4b/4c once they are
 * loaded through configuration — the seam is `AppDeps.providers`.
 */
export function createDefaultRegistry(): ProviderRegistry {
  return new ProviderRegistry([makeFakeProvider({ bootMs: 2000, terminateMs: 1500 })])
}
