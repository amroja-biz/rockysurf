import { ProviderError } from '@rockysurf/provider-sdk'

/**
 * Credentials, and the one place this package uses a vendor library.
 *
 * THE DEPENDENCY DECISION, recorded here because it is the only one in this package that costs
 * a stranger disk space. Compute talks to the REST API through plain `fetch`, the way
 * `@rockysurf/provider-hetzner` does. Auth does not: it uses `google-auth-library`.
 *
 * The two halves were weighed separately and came out differently. The figures below name the
 * VERSION they were measured from, not just the date: an npm tarball is immutable once
 * published, so `@google-cloud/compute@7.1.0` is 110,039,229 bytes forever and anybody can
 * re-check these two numbers years from now. `docs/writing-a-provider.md` under "Vendor SDKs"
 * is where the comparison lives for a new provider author; this comment records only why THIS
 * package chose what it did.
 *
 *  - `@google-cloud/compute@7.1.0` — 110,039,229 bytes unpacked, a generated GAPIC client over
 *    protobuf. It buys typed methods for an API this provider calls eleven of. The CLI ships
 *    every provider, and this repository already runs `scripts/check-npx-closure.mjs` for the
 *    sole purpose of keeping ONE vendor SDK contained; adding a second one two orders of
 *    magnitude larger is not a trade anybody would make twice. **Rejected.**
 *  - `google-auth-library@11.0.2` — 601,781 bytes and six small dependencies. It buys the whole
 *    Application Default Credentials chain: a service-account key file, a `gcloud auth
 *    application-default login` user refresh token, the GCE metadata server when core itself
 *    runs on GCP, and workload identity federation. **Taken.**
 *
 * The asymmetry is the point. A REST call is a URL and a JSON body, and writing those by hand
 * makes the provider easier to read. Minting an RS256 assertion, exchanging it, caching the
 * result and refreshing it before expiry — across four credential sources — is the half where
 * hand-rolling buys nothing and costs a class of bug nobody wants to debug against somebody
 * else's cloud.
 */

/** The scope the Compute Engine API requires. Read/write on compute, and nothing else. */
export const COMPUTE_SCOPE = 'https://www.googleapis.com/auth/compute'

/**
 * Where a bearer token comes from.
 *
 * The seam exists so that no test in this package needs a credential, a key file or a network:
 * the provider takes a `TokenSource`, production passes the ADC-backed one, and tests pass
 * `async () => 'test-token'`. It is the same shape as the Hetzner provider's injected
 * `fetchImpl`, for the same reason.
 */
export interface TokenSource {
  /** A valid OAuth2 access token. Implementations are expected to cache and refresh. */
  getAccessToken(): Promise<string>
}

export interface AdcTokenSourceOptions {
  /**
   * Path to a service-account key file, or undefined for the ambient ADC chain.
   *
   * A PATH, never key material — the same posture `providers.byo.identityFile` takes. The key
   * stays where the operator's own tooling put it, and nothing copies it into a config file or
   * this application's database.
   */
  keyFile?: string | undefined
  /** The project the credential should act on, when the credential does not name one itself. */
  projectId?: string | undefined
}

/**
 * The production token source: Application Default Credentials.
 *
 * CONSTRUCTION DOES NO I/O, which the SDK requires of everything reachable from
 * `createProvider` (`ProviderFactory.createProvider` must be synchronous and side-effect
 * free). `new GoogleAuth(...)` only records options; the credential is not read, and no token
 * is fetched, until `getAccessToken()` is first awaited. Credentials are proven by
 * `validateCredentials()`, when core chooses to call it.
 */
export function makeAdcTokenSource(options: AdcTokenSourceOptions = {}): TokenSource {
  // Imported lazily so that constructing a provider — which core does at boot for every
  // configured provider — never pays to load the auth library, and so that an installation
  // with a broken key file still boots far enough to show the operator the page that fixes it.
  let client: Promise<{ getAccessToken(): Promise<{ token?: string | null }> }> | undefined

  const clientFor = async () => {
    client ??= (async () => {
      const { GoogleAuth } = await import('google-auth-library')
      const auth = new GoogleAuth({
        scopes: [COMPUTE_SCOPE],
        ...(options.keyFile ? { keyFile: options.keyFile } : {}),
        ...(options.projectId ? { projectId: options.projectId } : {}),
      })
      return await auth.getClient()
    })()
    return await client
  }

  return {
    async getAccessToken(): Promise<string> {
      let token: string | null | undefined
      try {
        token = (await (await clientFor()).getAccessToken()).token
      } catch (cause) {
        // A missing or unreadable credential is an `auth` failure and must not escape as a raw
        // library error: core branches on the nine codes and has no other vocabulary.
        client = undefined
        throw new ProviderError(
          'auth',
          'could not obtain Google Cloud credentials. Set GOOGLE_APPLICATION_CREDENTIALS, run ' +
            '`gcloud auth application-default login`, or set providers.gcp.keyFile to a service-account key path. ' +
            `Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        )
      }

      if (!token) {
        throw new ProviderError('auth', 'the Google Cloud credential chain returned no access token')
      }
      return token
    },
  }
}
