/**
 * The MCP server's client for the control plane.
 *
 * IT SPEAKS HTTP TO A RUNNING CORE, deliberately, rather than importing the service layer and
 * calling it in-process. Two reasons, and the second is the security one:
 *
 *  - the MCP process then goes through EXACTLY the routes a browser goes through, so limits,
 *    ownership checks and error shapes cannot diverge between an agent and a human. The bead
 *    asks that MCP never bypass the service layer; the cheapest way to guarantee that is to
 *    give it no other way in;
 *  - it needs a token to do anything, so an MCP server with no credential is inert.
 */

export class CoreApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: {
      error?: string
      code?: string
      reason?: string
      /**
       * Per-field detail, when the refusal has any — the repository preflight's one entry per
       * bad URL being the case that needs it (rockysurf-k6xp). Declared rather than reached for
       * through the index signature so the CLI can render them without a cast (rockysurf-81wo).
       */
      issues?: Array<{ path?: string; message: string }>
    } & Record<string, unknown>,
  ) {
    super(body.error ?? `core returned HTTP ${status}`)
    this.name = 'CoreApiError'
  }
}

export interface CoreClientOptions {
  baseUrl: string
  /** Session token. Never logged, never returned in a tool result. */
  token: string
  fetchImpl?: typeof fetch
}

export interface CoreClient {
  get<T>(path: string): Promise<T>
  post<T>(path: string, body?: unknown): Promise<T>
  /**
   * A response that is NOT JSON — the SSH key route serves a PEM body as an attachment.
   *
   * Separate from `get` deliberately: `get` JSON-parses and would silently turn a PEM into an
   * empty object, which is a bug a mocked test cannot see. Making it a different method makes
   * the caller state which kind of body it expects.
   */
  getText(path: string): Promise<string>
}

export function createCoreClient(options: CoreClientOptions): CoreClient {
  const doFetch = options.fetchImpl ?? fetch
  const base = options.baseUrl.replace(/\/$/, '')

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (cause) {
      // A control plane that is not running is the most likely failure by far, and the message
      // has to say so — an agent cannot read a stack trace and act on it.
      throw new Error(
        `cannot reach Rocky Surf at ${base}. Is it running? Start it with \`rockysurf serve\`. (${String(cause)})`,
      )
    }

    if (response.status === 204) return undefined as T
    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (!response.ok) throw new CoreApiError(response.status, parsed)
    return parsed as T
  }

  async function requestText(path: string): Promise<string> {
    const response = await doFetch(`${base}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${options.token}` },
    })
    const text = await response.text()
    if (!response.ok) {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(text) as Record<string, unknown>
      } catch {
        parsed = { error: text.slice(0, 200) }
      }
      throw new CoreApiError(response.status, parsed)
    }
    return text
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    getText: requestText,
  }
}
