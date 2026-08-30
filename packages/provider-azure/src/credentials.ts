import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { ProviderError } from '@rockysurf/provider-sdk'

/**
 * Bearer tokens for ARM, without `@azure/identity`.
 *
 * WHY THIS FILE EXISTS RATHER THAN A DEPENDENCY. `DefaultAzureCredential` is the obvious answer
 * and it costs `@azure/identity` plus `msal-node` plus their trees, in a package the shipped CLI
 * imports statically — which is the closure `scripts/check-npx-closure.mjs` exists to watch, and
 * the reason the AWS SDK is called out there as the heaviest thing this project installs. The
 * three credential sources below are what a self-hoster actually has, and each is a documented
 * HTTP request or one CLI call.
 *
 * WHAT WE GIVE UP, stated plainly so nobody discovers it in production: this is NOT the full
 * `DefaultAzureCredential` chain. Visual Studio / VS Code credentials, Azure PowerShell and Azure
 * Developer CLI credentials are all absent. If you need one of them, the honest fix is an issue,
 * not a quiet `az` shim.
 *
 * Sources, tried in order:
 *
 *  1. **Workload identity federation** — `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` /
 *     `AZURE_FEDERATED_TOKEN_FILE`, the same three variables `WorkloadIdentityCredential`,
 *     AKS's mutating webhook and the `azure/login` action all use (gh issue #170). The file
 *     holds a token some OTHER issuer already minted — GitHub Actions' OIDC token, or the
 *     projected service-account token on an AKS pod — and it is exchanged at the same Entra
 *     endpoint the client-secret path uses, as a `client_assertion`. NO SECRET EXISTS ANYWHERE
 *     on this path, which is why it is tried first: an installation that has one configured
 *     chose the posture with nothing to leak or rotate, and a stale `AZURE_CLIENT_SECRET` left
 *     in the environment beside it must not silently win.
 *
 *     Note what this is NOT: an RS256 assertion signed here from a private key. That flow is the
 *     one `docs/writing-a-provider.md` says to buy rather than write, and this is not it — the
 *     assertion is read from a file, unparsed, and posted as a form field.
 *  2. **Service principal from the environment** — the same `AZURE_TENANT_ID` /
 *     `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` variables `DefaultAzureCredential` reads, so an
 *     installation already configured for other Azure tooling needs nothing new. This is the
 *     production path.
 *  3. **Managed identity via IMDS** — for a control plane running on an Azure VM, where there is
 *     no secret at all. This is the best posture available and the one the docs recommend.
 *  4. **The Azure CLI** — `az account get-access-token`. Last, and present because without it a
 *     self-hoster evaluating Rocky Surf must create a service principal before they can create
 *     one server, which is a bad first five minutes. Disable it with `allowAzureCli: false`.
 *
 * NO SOURCE READS A SECRET FROM THE CONFIG FILE, and the config schema has nowhere to put one.
 * A client secret in `rockysurf.config.yaml` would be a secret in a file that gets backed up,
 * copied to a second machine and pasted into bug reports.
 */

/** The ARM audience. The trailing slash matters: it is the App ID URI, and it lands in `aud`. */
export const ARM_RESOURCE = 'https://management.azure.com/'

/** The scope form the v2 token endpoint wants, which is the resource plus `.default`. */
export const ARM_SCOPE = `${ARM_RESOURCE}.default`

export const ENTRA_AUTHORITY = 'https://login.microsoftonline.com'

/** IMDS is link-local and plain HTTP by design; there is no TLS endpoint to prefer. */
export const IMDS_TOKEN_URL = 'http://169.254.169.254/metadata/identity/oauth2/token'
export const IMDS_API_VERSION = '2018-02-01'

/** Re-acquire this long before the token actually expires, so a slow call cannot outlive it. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000

export interface AccessToken {
  token: string
  /** Epoch milliseconds. */
  expiresAt: number
}

/**
 * The OAuth 2.0 assertion type for a JWT the CALLER did not sign — RFC 7523's client
 * authentication, and the exact string Entra requires. It is a URN, not a URL; nothing resolves.
 */
export const JWT_BEARER_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'

/** Where a token came from, for the boot log and for `validateCredentials()`'s error message. */
export type CredentialSource = 'federated' | 'env' | 'imds' | 'azure-cli'

/** The chain, in the order it is walked. One place, so the loop and the docs cannot disagree. */
const SOURCES: readonly CredentialSource[] = ['federated', 'env', 'imds', 'azure-cli']

export interface CredentialChainOptions {
  /** Overrides `process.env`; injected by tests. */
  env?: NodeJS.ProcessEnv
  /** Injected by tests, and used for both the Entra and IMDS calls. */
  fetchImpl?: typeof fetch
  /** Overrides `https://login.microsoftonline.com`; injected by tests. */
  authorityUrl?: string
  /** Overrides the IMDS endpoint; injected by tests. */
  imdsUrl?: string
  /**
   * Whether `az account get-access-token` may be used. Default true.
   *
   * Turning it off is the right call on a server: a control plane that can shell out to whatever
   * `az` resolves to on `PATH` has a wider trust boundary than one that cannot.
   */
  allowAzureCli?: boolean
  /** Injected by tests, so no test reads a real file. */
  readFileImpl?: (path: string) => Promise<string>
  /** Injected by tests, so no test spawns a process. */
  execImpl?: (command: string, args: string[]) => Promise<string>
  /** Injected by tests. Real clocks make expiry assertions flaky. */
  now?: () => number
}

const defaultReadFile = (path: string): Promise<string> => readFile(path, 'utf8')

const defaultExec = (command: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })

/**
 * One token, cached until shortly before it expires.
 *
 * The cache is per provider instance and holds a bearer token in memory, which is the same place
 * every SDK holds one. It is never written anywhere.
 */
export class CredentialChain {
  private readonly env: NodeJS.ProcessEnv
  private readonly doFetch: typeof fetch
  private readonly authorityUrl: string
  private readonly imdsUrl: string
  private readonly allowAzureCli: boolean
  private readonly readTokenFile: (path: string) => Promise<string>
  private readonly exec: (command: string, args: string[]) => Promise<string>
  private readonly now: () => number

  private cached: AccessToken | undefined
  /** In flight, so N concurrent calls acquire ONE token rather than N. */
  private pending: Promise<AccessToken> | undefined
  private lastSource: CredentialSource | undefined

  constructor(options: CredentialChainOptions = {}) {
    this.env = options.env ?? process.env
    this.doFetch = options.fetchImpl ?? fetch
    this.authorityUrl = options.authorityUrl ?? ENTRA_AUTHORITY
    this.imdsUrl = options.imdsUrl ?? IMDS_TOKEN_URL
    this.allowAzureCli = options.allowAzureCli ?? true
    this.readTokenFile = options.readFileImpl ?? defaultReadFile
    this.exec = options.execImpl ?? defaultExec
    this.now = options.now ?? Date.now
  }

  /** Which source last produced a token, for the boot log. Undefined before the first call. */
  source(): CredentialSource | undefined {
    return this.lastSource
  }

  /** Drop the cached token, so the next call re-acquires. Used after a 401. */
  invalidate(): void {
    this.cached = undefined
    this.pending = undefined
  }

  async getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - EXPIRY_SKEW_MS > this.now()) return this.cached.token
    this.pending ??= this.acquire().finally(() => {
      this.pending = undefined
    })
    const token = await this.pending
    return token.token
  }

  /**
   * Walk the chain, keeping every failure so the error names all of them.
   *
   * A chain that reports only the last failure is close to useless: an operator who set
   * `AZURE_CLIENT_ID` and misspelled `AZURE_CLIENT_SECRET` would be told "the Azure CLI is not
   * installed", which is true and has nothing to do with their problem.
   */
  private async acquire(): Promise<AccessToken> {
    const attempts: string[] = []

    for (const source of SOURCES) {
      const skip = this.whyNotApplicable(source)
      if (skip) {
        attempts.push(`${source}: ${skip}`)
        continue
      }

      try {
        const token = await this.fromSource(source)
        this.cached = token
        this.lastSource = source
        return token
      } catch (err) {
        attempts.push(`${source}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    throw new ProviderError(
      'auth',
      'no Azure credential could be acquired. Tried, in order:\n  ' +
        attempts.join('\n  ') +
        '\nSet AZURE_TENANT_ID, AZURE_CLIENT_ID and either AZURE_FEDERATED_TOKEN_FILE (workload ' +
        'identity federation — no secret) or AZURE_CLIENT_SECRET, run on a VM with a managed ' +
        'identity, or run `az login`. Rocky Surf never reads a client secret from its config file.',
    )
  }

  /** Why a source cannot answer at all, or undefined when it is worth trying. */
  private whyNotApplicable(source: CredentialSource): string | undefined {
    if (source === 'federated' && this.federatedIdentity() === undefined) {
      return 'AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_FEDERATED_TOKEN_FILE are not all set'
    }
    if (source === 'env' && this.servicePrincipal() === undefined) {
      return 'AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET are not all set'
    }
    if (source === 'azure-cli' && !this.allowAzureCli) {
      return 'disabled by configuration (allowAzureCli: false)'
    }
    return undefined
  }

  private fromSource(source: CredentialSource): Promise<AccessToken> {
    if (source === 'federated') return this.fromFederatedToken()
    if (source === 'env') return this.fromServicePrincipal()
    if (source === 'imds') return this.fromImds()
    return this.fromAzureCli()
  }

  private federatedIdentity(): { tenantId: string; clientId: string; tokenFile: string } | undefined {
    const tenantId = this.env['AZURE_TENANT_ID']?.trim()
    const clientId = this.env['AZURE_CLIENT_ID']?.trim()
    const tokenFile = this.env['AZURE_FEDERATED_TOKEN_FILE']?.trim()
    if (!tenantId || !clientId || !tokenFile) return undefined
    return { tenantId, clientId, tokenFile }
  }

  private servicePrincipal(): { tenantId: string; clientId: string; clientSecret: string } | undefined {
    const tenantId = this.env['AZURE_TENANT_ID']?.trim()
    const clientId = this.env['AZURE_CLIENT_ID']?.trim()
    const clientSecret = this.env['AZURE_CLIENT_SECRET']?.trim()
    if (!tenantId || !clientId || !clientSecret) return undefined
    return { tenantId, clientId, clientSecret }
  }

  /**
   * OAuth 2.0 client credentials against Entra ID's v2 endpoint, authenticated with a secret.
   *
   * The secret is the only difference from the federated path below; the request they both make
   * is {@link clientCredentialsGrant}.
   */
  private async fromServicePrincipal(): Promise<AccessToken> {
    const principal = this.servicePrincipal()
    if (!principal) throw new Error('AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET are not all set')

    return this.clientCredentialsGrant(principal.tenantId, 'the service principal', {
      client_id: principal.clientId,
      client_secret: principal.clientSecret,
    })
  }

  /**
   * Workload identity federation: exchange a token SOMEBODY ELSE minted for an ARM token.
   *
   * The file named by `AZURE_FEDERATED_TOKEN_FILE` holds a JWT whose issuer Entra has been told
   * to trust for this app registration — GitHub Actions' OIDC token in CI, the projected
   * service-account token on an AKS pod. The exchange is the SAME endpoint and the same
   * `client_credentials` grant as the client-secret path, with `client_assertion` and
   * `client_assertion_type` in place of `client_secret`. That is the entire mechanism, and it is
   * why this costs one branch rather than a dependency: nothing here signs, parses or validates
   * a JWT. See gh issue #170.
   *
   * READ ON EVERY ACQUISITION, never cached separately. The assertion is short-lived by design
   * and its writer rotates the file — AKS's kubelet re-projects it hourly — so a copy held in
   * memory would be a copy that expires. The ARM token this returns is what gets cached, on the
   * same terms as every other source.
   */
  private async fromFederatedToken(): Promise<AccessToken> {
    const identity = this.federatedIdentity()
    if (!identity) throw new Error('AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_FEDERATED_TOKEN_FILE are not all set')

    let assertion: string
    try {
      assertion = (await this.readTokenFile(identity.tokenFile)).trim()
    } catch (cause) {
      throw new Error(
        `AZURE_FEDERATED_TOKEN_FILE (${identity.tokenFile}) could not be read: ${firstLine(String(cause))}`,
      )
    }
    // An empty file is a token that has not been written yet, which is worth saying rather than
    // posting and having Entra answer with a generic AADSTS about a malformed assertion.
    if (!assertion) throw new Error(`AZURE_FEDERATED_TOKEN_FILE (${identity.tokenFile}) is empty`)

    return this.clientCredentialsGrant(identity.tenantId, 'the federated token', {
      client_id: identity.clientId,
      client_assertion_type: JWT_BEARER_ASSERTION_TYPE,
      client_assertion: assertion,
    })
  }

  /**
   * The one POST both credential paths make, differing only in how the client authenticates.
   *
   * `URLSearchParams` does the form encoding, which matters for both: the docs require the
   * client secret to be URL-encoded and secrets routinely contain characters that are not safe
   * raw, and a JWT assertion carries `.`-separated base64url that must not be mangled either.
   */
  private async clientCredentialsGrant(
    tenantId: string,
    subject: string,
    credential: Record<string, string>,
  ): Promise<AccessToken> {
    const url = `${this.authorityUrl}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`
    const body = new URLSearchParams({
      ...credential,
      scope: ARM_SCOPE,
      grant_type: 'client_credentials',
    })

    let response: Response
    try {
      response = await this.doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })
    } catch (cause) {
      throw new Error(`token request to Entra ID failed: ${String(cause)}`)
    }

    const parsed = (await response.json().catch(() => null)) as
      | { access_token?: string; expires_in?: number | string; error?: string; error_description?: string }
      | null

    if (!response.ok || !parsed?.access_token) {
      // The description carries the AADSTS code, which is the only part an operator can act on.
      const detail = parsed?.error_description ?? parsed?.error ?? `HTTP ${response.status}`
      throw new Error(`Entra ID rejected ${subject}: ${firstLine(detail)}`)
    }

    return { token: parsed.access_token, expiresAt: this.expiryFrom(parsed.expires_in) }
  }

  /**
   * The Instance Metadata Service, for a control plane running on an Azure VM.
   *
   * Two things the docs are firm about and that are easy to get wrong: the `Metadata: true`
   * header is mandatory and must be lower-case, and the `resource` is the App ID URI WITH its
   * trailing slash. Note also that IMDS answers `expires_in` and `expires_on` as STRINGS, unlike
   * the Entra endpoint's number — {@link expiryFrom} takes both.
   */
  private async fromImds(): Promise<AccessToken> {
    const url = `${this.imdsUrl}?api-version=${IMDS_API_VERSION}&resource=${encodeURIComponent(ARM_RESOURCE)}`
    // A user-assigned identity has to be named; a VM with several and no client_id gets a
    // deterministic 400 rather than an arbitrary identity.
    const clientId = this.env['AZURE_CLIENT_ID']?.trim()
    const withIdentity = clientId ? `${url}&client_id=${encodeURIComponent(clientId)}` : url

    let response: Response
    try {
      response = await this.doFetch(withIdentity, { method: 'GET', headers: { metadata: 'true' } })
    } catch (cause) {
      // Off an Azure VM this is a connection refused or a timeout to a link-local address, which
      // is the ordinary case rather than an error worth dressing up.
      throw new Error(`no managed identity available (IMDS unreachable: ${String(cause)})`)
    }

    const parsed = (await response.json().catch(() => null)) as
      | { access_token?: string; expires_in?: number | string; expires_on?: number | string; error?: string }
      | null

    if (!response.ok || !parsed?.access_token) {
      throw new Error(`IMDS returned HTTP ${response.status}${parsed?.error ? `: ${parsed.error}` : ''}`)
    }

    // `expires_on` is absolute epoch seconds and survives a slow response; `expires_in` is
    // relative and is the fallback.
    const absolute = Number(parsed.expires_on)
    const expiresAt = Number.isFinite(absolute) && absolute > 0 ? absolute * 1000 : this.expiryFrom(parsed.expires_in)
    return { token: parsed.access_token, expiresAt }
  }

  /**
   * `az account get-access-token`, for a developer who has already run `az login`.
   *
   * The CLI prints JSON on stdout; a missing `az`, a stale login and a wrong subscription all
   * arrive as a non-zero exit with the reason on stderr, which the caller reports as one of the
   * chain's attempts.
   */
  private async fromAzureCli(): Promise<AccessToken> {
    let stdout: string
    try {
      stdout = await this.exec('az', ['account', 'get-access-token', '--resource', ARM_RESOURCE, '--output', 'json'])
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      throw new Error(`az account get-access-token failed: ${firstLine(message)}`)
    }

    let parsed: { accessToken?: string; expiresOn?: string; expires_on?: number } | null
    try {
      parsed = JSON.parse(stdout) as typeof parsed
    } catch {
      throw new Error('az account get-access-token did not return JSON')
    }
    if (!parsed?.accessToken) throw new Error('az account get-access-token returned no accessToken')

    // The CLI's `expires_on` is epoch seconds; `expiresOn` is a local-time string with no zone,
    // which is not safely parseable. Prefer the epoch, and fall back to a conservative hour.
    const epoch = Number(parsed.expires_on)
    const expiresAt = Number.isFinite(epoch) && epoch > 0 ? epoch * 1000 : this.now() + 3600 * 1000
    return { token: parsed.accessToken, expiresAt }
  }

  /** `expires_in` is seconds, and arrives as a number from Entra and a string from IMDS. */
  private expiryFrom(expiresIn: number | string | undefined): number {
    const seconds = Number(expiresIn)
    return this.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000
  }
}

/** Azure error text is often several paragraphs; the first line is the part worth reporting. */
function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? text
}
