import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

/**
 * Response helpers, ported from the legacy Lambda backend of the hosted SaaS this project
 * replaced (see `docs/history/`).
 *
 * The error envelope is deliberately unchanged — `{ error: <human message> }` — because
 * the SPA's API client (`packages/web/src/lib/api.ts`) parses the body and hands it to
 * `ApiError(status, statusText, data)` untouched. Keeping the shape is what made the SPA
 * port mechanical. A machine-readable
 * `code` rides alongside for callers that want to branch without matching on prose; the old
 * clients ignore unknown fields.
 *
 * The CORS block from the Lambda version is GONE, and its absence is the point: API Gateway
 * lived on a different origin from the SPA, so every response needed `Access-Control-Allow-
 * Origin: *`. Core serves the SPA from the same process and the same origin (ADR-0001), so
 * there is no cross-origin request to permit — and a wildcard CORS header on a control plane
 * that provisions cloud servers would be a real hole, not dead weight.
 */

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'server_error'

export interface ErrorBody {
  /** Human message. Legacy shape — the SPA reads this field. */
  error: string
  /** Machine-readable equivalent. Additive; old clients ignore it. */
  code: ErrorCode
  /** Field-level detail, when validation produced any. */
  issues?: { path: string; message: string }[]
}

const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  server_error: 500,
}

export const success = <T>(c: Context, data: T) => c.json(data, 200)
export const created = <T>(c: Context, data: T) => c.json(data, 201)
export const noContent = (c: Context) => c.body(null, 204)

export function failure(c: Context, code: ErrorCode, message: string, issues?: ErrorBody['issues']) {
  const body: ErrorBody = issues ? { error: message, code, issues } : { error: message, code }
  return c.json(body, STATUS[code])
}

export const badRequest = (c: Context, message = 'Bad request', issues?: ErrorBody['issues']) =>
  failure(c, 'bad_request', message, issues)
export const unauthorized = (c: Context, message = 'Unauthorized') => failure(c, 'unauthorized', message)
export const forbidden = (c: Context, message = 'Forbidden') => failure(c, 'forbidden', message)
export const notFound = (c: Context, message = 'Not found') => failure(c, 'not_found', message)
export const conflict = (c: Context, message = 'Conflict') => failure(c, 'conflict', message)
export const serverError = (c: Context, message = 'Internal server error') => failure(c, 'server_error', message)
