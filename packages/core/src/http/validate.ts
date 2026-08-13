import { zValidator } from '@hono/zod-validator'
import type { Context, ValidationTargets } from 'hono'
import type { z } from 'zod'
import { badRequest } from './responses.js'

/**
 * Request validation, zod v4, in the project's error envelope.
 *
 * `@hono/zod-validator` returns its own error shape by default, which would give the API two
 * different-looking 400s depending on whether a route validated with zod or checked by hand.
 * The hook below funnels both into `{ error, code, issues }`.
 *
 * Field paths are rendered the same way the config loader renders them — dotted, with
 * `unrecognized_keys` pulled out of `issue.keys`, because zod reports that issue against the
 * containing object and the offending name is exactly what the caller needs to see.
 *
 * THE BODY IS PART OF VALIDATION, and that is what `readableJson` below is about
 * (rockysurf-1z5q). Hono's validator decodes the body before any schema sees it, and it has two
 * ways of getting there that this envelope did not cover:
 *
 *  - a body that is not JSON throws an `HTTPException`, which `app.onError` cannot tell from a
 *    real crash, so a typo in a hand-written `curl` came back as **500 server_error** with a
 *    stack trace in the log — the exact 500 rockysurf-1z5q was filed on;
 *  - a body sent with no `Content-Type: application/json` is not decoded at ALL. The validator
 *    silently substitutes `{}`, so the schema then complains about whichever field it misses
 *    first — `mtimeMs: expected number, received undefined` for a request that in fact SENT
 *    `mtimeMs` — and the caller goes hunting for a field that was never the problem.
 *
 * Both are the caller's mistake, both are 400, and both now say which mistake it was.
 */
const JSON_CONTENT_TYPE = /^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i

/**
 * Decode a JSON body ahead of the validator, so a bad one is a 400 rather than a thrown
 * exception. `c.req.json()` caches on the request, so the validator's own call reuses this
 * parse rather than reading the stream a second time.
 */
async function unreadableJson(c: Context): Promise<Response | undefined> {
  // No body at all is left to the schema: "nothing was sent" is a statement about the FIELDS,
  // and the schema names them better than anything here could.
  if (c.req.raw.body === null) return undefined

  const contentType = c.req.header('Content-Type')
  if (contentType === undefined || !JSON_CONTENT_TYPE.test(contentType)) {
    return badRequest(
      c,
      'this route reads a JSON body, and the request sent one declared as ' +
        `${contentType ?? 'nothing'} rather than application/json — so none of it was read.`,
    )
  }
  try {
    await c.req.json()
  } catch {
    return badRequest(c, 'the request body is not valid JSON')
  }
  return undefined
}

function issuePath(issue: z.core.$ZodIssue): string {
  const segments = issue.path.map(String)
  if (issue.code === 'unrecognized_keys') {
    const base = segments.join('.')
    return issue.keys.map((k) => (base ? `${base}.${k}` : k)).join(', ')
  }
  return segments.join('.') || '(body)'
}

/** `validate('json', schema)` — same call shape as `zValidator`, project-standard errors. */
export function validate<T extends z.ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) {
  const validator = zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({ path: issuePath(issue), message: issue.message }))
      const summary = issues.map((i) => `${i.path}: ${i.message}`).join('; ')
      return badRequest(c, summary || 'Invalid request', issues)
    }
    return undefined
  })
  if (target !== 'json') return validator
  // The body check runs BEFORE the validator rather than as a try/catch around it. The
  // validator awaits the route handler, so a catch around it would also swallow whatever the
  // handler threw and report a genuine bug as a malformed request.
  return (async (c, next) => (await unreadableJson(c)) ?? validator(c, next)) as typeof validator
}
