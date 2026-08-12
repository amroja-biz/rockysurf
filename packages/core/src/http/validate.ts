import { zValidator } from '@hono/zod-validator'
import type { ValidationTargets } from 'hono'
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
 */

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
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({ path: issuePath(issue), message: issue.message }))
      const summary = issues.map((i) => `${i.path}: ${i.message}`).join('; ')
      return badRequest(c, summary || 'Invalid request', issues)
    }
    return undefined
  })
}
