import { isProviderError } from '@rockysurf/provider-sdk'
import { describe, expect, it } from 'vitest'
import { ARM_SCOPE, CredentialChain, JWT_BEARER_ASSERTION_TYPE } from './credentials.js'

/**
 * The credential chain, with every transport injected — no test reaches the network, and no test
 * spawns a process.
 */

const SP_ENV = { AZURE_TENANT_ID: 'tenant-1', AZURE_CLIENT_ID: 'client-1', AZURE_CLIENT_SECRET: 'shhh' }

/** Workload identity federation: the three variables AKS and `azure/login` set (gh issue #170). */
const WIF_ENV = {
  AZURE_TENANT_ID: 'tenant-1',
  AZURE_CLIENT_ID: 'client-1',
  AZURE_FEDERATED_TOKEN_FILE: '/var/run/secrets/azure/tokens/azure-identity-token',
}

/** A stand-in for the JWT GitHub or the kubelet writes: never signed or parsed by this package. */
const ASSERTION = 'header.payload.signature'

/** A fetch that answers Entra, IMDS, or neither, and records what it was asked. */
function transport(options: { entra?: unknown; entraStatus?: number; imds?: unknown; imdsStatus?: number } = {}) {
  const calls: { url: string; body?: string }[] = []
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input)
    calls.push({ url, ...(init?.body ? { body: String(init.body) } : {}) })

    if (url.includes('login.microsoftonline.com')) {
      if (!options.entra) return json(options.entraStatus ?? 400, { error: 'invalid_client' })
      return json(options.entraStatus ?? 200, options.entra)
    }
    if (url.includes('169.254.169.254')) {
      if (!options.imds) throw new TypeError('connect ECONNREFUSED 169.254.169.254:80')
      return json(options.imdsStatus ?? 200, options.imds)
    }
    throw new Error(`unexpected request to ${url}`)
  }
  return { impl, calls }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('workload identity federation', () => {
  it('posts the token from the file as a client assertion, not a secret', async () => {
    const { impl, calls } = transport({ entra: { access_token: 'wif-tok', expires_in: 3599 } })
    const read: string[] = []
    const chain = new CredentialChain({
      env: WIF_ENV,
      fetchImpl: impl,
      allowAzureCli: false,
      readFileImpl: async (path) => {
        read.push(path)
        // The writer of this file ends it with a newline more often than not.
        return `${ASSERTION}\n`
      },
    })

    expect(await chain.getToken()).toBe('wif-tok')
    expect(chain.source()).toBe('federated')
    expect(read).toEqual([WIF_ENV.AZURE_FEDERATED_TOKEN_FILE])

    const form = new URLSearchParams(calls[0]!.body!)
    // The SAME endpoint the client-secret path uses — that is the whole point of this being one
    // branch rather than a dependency.
    expect(calls[0]!.url).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token')
    expect(form.get('grant_type')).toBe('client_credentials')
    expect(form.get('scope')).toBe(ARM_SCOPE)
    expect(form.get('client_id')).toBe('client-1')
    expect(form.get('client_assertion_type')).toBe(JWT_BEARER_ASSERTION_TYPE)
    // Trimmed: a trailing newline inside the assertion is an AADSTS about a malformed token.
    expect(form.get('client_assertion')).toBe(ASSERTION)
    // A secret must not be invented from anywhere, least of all sent empty.
    expect(form.has('client_secret')).toBe(false)
  })

  it('wins over a client secret left in the same environment', async () => {
    const { impl, calls } = transport({ entra: { access_token: 'wif-tok', expires_in: 3599 } })
    const chain = new CredentialChain({
      env: { ...SP_ENV, ...WIF_ENV },
      fetchImpl: impl,
      allowAzureCli: false,
      readFileImpl: async () => ASSERTION,
    })

    expect(await chain.getToken()).toBe('wif-tok')
    expect(chain.source()).toBe('federated')
    // The posture with nothing to leak or rotate is the one that gets used, and it is the ONLY
    // request made: a stale AZURE_CLIENT_SECRET beside a federated file must not silently win.
    expect(calls).toHaveLength(1)
    expect(new URLSearchParams(calls[0]!.body!).has('client_secret')).toBe(false)
  })

  it('re-reads the file on every acquisition, because its writer rotates it', async () => {
    const { impl } = transport({ entra: { access_token: 'wif-tok', expires_in: 3599 } })
    let generation = 0
    const chain = new CredentialChain({
      env: WIF_ENV,
      fetchImpl: impl,
      allowAzureCli: false,
      readFileImpl: async () => `assertion-${++generation}`,
    })

    await chain.getToken()
    chain.invalidate()
    await chain.getToken()

    // AKS re-projects the token hourly and GitHub's is minted per job; a copy cached in memory
    // would be a copy that has expired.
    expect(generation).toBe(2)
  })

  it('names the file when it cannot be read, rather than blaming Entra', async () => {
    const { impl } = transport({})
    const chain = new CredentialChain({
      env: WIF_ENV,
      fetchImpl: impl,
      allowAzureCli: false,
      readFileImpl: async () => {
        throw new Error('ENOENT: no such file or directory')
      },
    })

    const message = ((await chain.getToken().catch((e: unknown) => e)) as Error).message
    expect(message).toContain(WIF_ENV.AZURE_FEDERATED_TOKEN_FILE)
    expect(message).toContain('ENOENT')
  })

  it('refuses an empty file instead of posting an assertion Entra cannot read', async () => {
    const { impl, calls } = transport({})
    const chain = new CredentialChain({
      env: WIF_ENV,
      fetchImpl: impl,
      allowAzureCli: false,
      readFileImpl: async () => '\n',
    })

    const message = ((await chain.getToken().catch((e: unknown) => e)) as Error).message
    expect(message).toContain('is empty')
    expect(calls.some((c) => c.url.includes('login.microsoftonline.com'))).toBe(false)
  })

  it('is skipped entirely when the three variables are not all set', async () => {
    const { impl, calls } = transport({ entra: { access_token: 'sp-tok', expires_in: 3599 } })
    let readAttempts = 0
    const chain = new CredentialChain({
      // A service principal, with AZURE_FEDERATED_TOKEN_FILE absent: the ordinary case, and the
      // one that must not change behaviour now that federation is tried first.
      env: SP_ENV,
      fetchImpl: impl,
      allowAzureCli: false,
      readFileImpl: async () => {
        readAttempts++
        return ASSERTION
      },
    })

    expect(await chain.getToken()).toBe('sp-tok')
    expect(chain.source()).toBe('env')
    expect(readAttempts).toBe(0)
    expect(new URLSearchParams(calls[0]!.body!).get('client_secret')).toBe('shhh')
  })

  it('surfaces the AADSTS reason when Entra rejects the assertion', async () => {
    const { impl } = transport({
      entraStatus: 400,
      entra: {
        error: 'invalid_client',
        error_description: 'AADSTS700213: No matching federated identity record found for presented assertion subject.',
      },
    })
    const chain = new CredentialChain({
      env: WIF_ENV,
      fetchImpl: impl,
      allowAzureCli: false,
      readFileImpl: async () => ASSERTION,
    })

    const message = ((await chain.getToken().catch((e: unknown) => e)) as Error).message
    // The subject/issuer mismatch is the failure a misconfigured federated credential produces,
    // and the AADSTS code is the only part an operator can act on.
    expect(message).toContain('AADSTS700213')
    expect(message).toContain('federated token')
  })
})

describe('service principal from the environment', () => {
  it('exchanges the secret for a token against the ARM scope', async () => {
    const { impl, calls } = transport({ entra: { access_token: 'tok', expires_in: 3599, token_type: 'Bearer' } })
    const chain = new CredentialChain({ env: SP_ENV, fetchImpl: impl, allowAzureCli: false })

    expect(await chain.getToken()).toBe('tok')
    expect(chain.source()).toBe('env')

    const form = new URLSearchParams(calls[0]!.body!)
    expect(calls[0]!.url).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token')
    expect(form.get('grant_type')).toBe('client_credentials')
    // A scope of anything else yields a token ARM will reject with a confusing message.
    expect(form.get('scope')).toBe(ARM_SCOPE)
    expect(form.get('client_id')).toBe('client-1')
  })

  it('caches the token rather than exchanging the secret on every call', async () => {
    const { impl, calls } = transport({ entra: { access_token: 'tok', expires_in: 3599 } })
    const chain = new CredentialChain({ env: SP_ENV, fetchImpl: impl, allowAzureCli: false })

    await chain.getToken()
    await chain.getToken()
    await chain.getToken()

    expect(calls).toHaveLength(1)
  })

  it('acquires ONE token for concurrent callers', async () => {
    const { impl, calls } = transport({ entra: { access_token: 'tok', expires_in: 3599 } })
    const chain = new CredentialChain({ env: SP_ENV, fetchImpl: impl, allowAzureCli: false })

    await Promise.all([chain.getToken(), chain.getToken(), chain.getToken()])

    expect(calls).toHaveLength(1)
  })

  it('re-acquires shortly before expiry rather than at it', async () => {
    const { impl, calls } = transport({ entra: { access_token: 'tok', expires_in: 600 } })
    let now = 1_000_000
    const chain = new CredentialChain({ env: SP_ENV, fetchImpl: impl, allowAzureCli: false, now: () => now })

    await chain.getToken()
    // Four minutes in: still inside the ten-minute lifetime and outside the skew.
    now += 4 * 60 * 1000
    await chain.getToken()
    expect(calls).toHaveLength(1)

    // Six minutes in: within five minutes of expiry, so a slow call could otherwise outlive it.
    now += 2 * 60 * 1000
    await chain.getToken()
    expect(calls).toHaveLength(2)
  })

  it('surfaces the AADSTS reason rather than a bare status', async () => {
    const { impl } = transport({
      entraStatus: 401,
      entra: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' },
    })
    const chain = new CredentialChain({ env: SP_ENV, fetchImpl: impl, allowAzureCli: false })

    const error = await chain.getToken().catch((e: unknown) => e)
    expect((error as Error).message).toContain('AADSTS7000215')
  })

  it('is skipped entirely when the three variables are not all set', async () => {
    const { impl, calls } = transport({ imds: { access_token: 'imds-tok', expires_in: '3599' } })
    const chain = new CredentialChain({
      env: { AZURE_TENANT_ID: 'tenant-1', AZURE_CLIENT_ID: 'client-1' },
      fetchImpl: impl,
      allowAzureCli: false,
    })

    expect(await chain.getToken()).toBe('imds-tok')
    // A half-configured service principal must not produce a token request that cannot succeed.
    expect(calls.some((c) => c.url.includes('login.microsoftonline.com'))).toBe(false)
  })
})

describe('managed identity via IMDS', () => {
  it('sends the Metadata header and the ARM resource, and parses string expiries', async () => {
    const calls: { url: string; metadata?: string }[] = []
    const impl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push({ url, ...(headers['metadata'] ? { metadata: headers['metadata'] } : {}) })
      return json(200, {
        access_token: 'imds-tok',
        // IMDS answers these as STRINGS, unlike the Entra endpoint's number.
        expires_in: '3599',
        expires_on: '1900000000',
        token_type: 'Bearer',
      })
    }
    const chain = new CredentialChain({ env: {}, fetchImpl: impl, allowAzureCli: false })

    expect(await chain.getToken()).toBe('imds-tok')
    expect(chain.source()).toBe('imds')
    // Mandatory, and lower-case: without it IMDS answers 401.
    expect(calls[0]!.metadata).toBe('true')
    expect(calls[0]!.url).toContain('resource=https%3A%2F%2Fmanagement.azure.com%2F')
  })

  it('is skipped quietly when there is no Azure VM under it', async () => {
    const { impl } = transport({})
    const chain = new CredentialChain({ env: {}, fetchImpl: impl, allowAzureCli: false })

    const error = await chain.getToken().catch((e: unknown) => e)
    expect(isProviderError(error)).toBe(true)
    expect((error as Error).message).toContain('IMDS unreachable')
  })
})

describe('the Azure CLI', () => {
  it('reads a token from az account get-access-token', async () => {
    const { impl } = transport({})
    const commands: { command: string; args: string[] }[] = []
    const chain = new CredentialChain({
      env: {},
      fetchImpl: impl,
      execImpl: async (command, args) => {
        commands.push({ command, args })
        return JSON.stringify({ accessToken: 'cli-tok', expires_on: 1_900_000_000 })
      },
    })

    expect(await chain.getToken()).toBe('cli-tok')
    expect(chain.source()).toBe('azure-cli')
    expect(commands[0]).toMatchObject({ command: 'az' })
    expect(commands[0]!.args).toContain('--resource')
  })

  it('is not consulted at all when disabled', async () => {
    const { impl } = transport({})
    let spawned = false
    const chain = new CredentialChain({
      env: {},
      fetchImpl: impl,
      allowAzureCli: false,
      execImpl: async () => {
        spawned = true
        return '{}'
      },
    })

    await chain.getToken().catch(() => undefined)
    // On a server, a control plane that can shell out to whatever `az` resolves to on PATH has a
    // wider trust boundary than one that cannot.
    expect(spawned).toBe(false)
  })

  it('is last: a configured service principal wins over a logged-in CLI', async () => {
    const { impl } = transport({ entra: { access_token: 'sp-tok', expires_in: 3599 } })
    const chain = new CredentialChain({
      env: SP_ENV,
      fetchImpl: impl,
      execImpl: async () => JSON.stringify({ accessToken: 'cli-tok' }),
    })

    expect(await chain.getToken()).toBe('sp-tok')
  })
})

describe('when nothing works', () => {
  it('reports every source it tried, not just the last one', async () => {
    const { impl } = transport({ entraStatus: 401, imds: undefined })
    const chain = new CredentialChain({
      env: SP_ENV,
      fetchImpl: impl,
      execImpl: async () => {
        throw new Error('az: command not found')
      },
    })

    const error = await chain.getToken().catch((e: unknown) => e)
    expect(isProviderError(error) && error.code).toBe('auth')
    const message = (error as Error).message
    // An operator who misspelled AZURE_CLIENT_SECRET must not be told "the Azure CLI is not
    // installed", which is true and has nothing to do with their problem.
    expect(message).toContain('federated:')
    expect(message).toContain('AZURE_FEDERATED_TOKEN_FILE')
    expect(message).toContain('env:')
    expect(message).toContain('imds:')
    expect(message).toContain('azure-cli:')
    expect(message).toContain('never reads a client secret from its config file')
  })

  it('re-acquires after invalidate(), which is what a 401 from ARM triggers', async () => {
    const { impl, calls } = transport({ entra: { access_token: 'tok', expires_in: 3599 } })
    const chain = new CredentialChain({ env: SP_ENV, fetchImpl: impl, allowAzureCli: false })

    await chain.getToken()
    chain.invalidate()
    await chain.getToken()

    expect(calls).toHaveLength(2)
  })
})
