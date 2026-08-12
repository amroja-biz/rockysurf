import { Hono, type MiddlewareHandler } from 'hono'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import {
  deletePack,
  deleteTool,
  getPack,
  getTool,
  listPacks,
  listTools,
  upsertPack,
  upsertTool,
  type Pack,
} from '../db/repositories/packs.js'
import type { ToolRow } from '../db/schema.js'
import { badRequest, conflict, created, forbidden, noContent, notFound, success } from '../http/responses.js'
import { validate } from '../http/validate.js'
import { parsePackFile, renderPackFile } from './loader.js'
import { fetchPublicText } from './safe-fetch.js'
import { packSchema, toolSchema } from './schema.js'
import type { AppEnv } from '../app.js'

/**
 * Tools and packs over HTTP.
 *
 * The response shapes are the ones `frontend/src/lib/api.ts` already parses, field for field,
 * because the SPA port is supposed to be mechanical — `toolId`/`packId` rather than the `id`
 * the database column is called, `tools` expanded to objects on the public pack list and left
 * as ids on the admin one. The only additions are `requiresRepos`, `requiresRdp` and
 * `desktop`, which are additive and are what let the UI stop recognising one pack by name.
 *
 * Validation is ported from `backend/src/admin/createTool.ts` and `createSurgePack.ts`: the
 * same required fields, the same "tools must exist and be enabled" check, the same
 * already-exists conflict. What is gone is the hand-rolled body parsing — zod does it, and
 * the errors come out in the project envelope with field paths.
 */

export interface PackRoutesDeps {
  db: Db
  /**
   * How import-from-URL fetches. Defaults to the SSRF-guarded fetch in safe-fetch.ts; a test
   * that wants the happy path injects a stub here, because the guard (correctly) refuses the
   * loopback addresses a local test server lives on.
   */
  fetchText?: typeof fetchPublicText
}

/* ------------------------------------------------------------------------ view models */

/** What an unauthenticated-but-logged-in user sees: enough to choose, no scripts. */
const publicTool = (t: ToolRow) => ({
  toolId: t.id,
  name: t.name,
  description: t.description,
  category: t.category,
  url: t.url,
})

/** The admin view is the whole record, including the scripts. */
const adminTool = (t: ToolRow) => ({
  ...publicTool(t),
  installScript: t.installScript,
  setupScript: t.setupScript ?? undefined,
  enabled: t.enabled,
  installOrder: t.installOrder,
  bootstrap: t.bootstrap,
  runAs: t.runAs,
  /**
   * Provenance. A row loaded from `packs/*.yaml` names its file; one created in the admin UI
   * is null. The UI needs this to say so plainly — a file-backed tool can be edited here, but
   * the next boot overwrites it from the file, and an editor that hides that is lying to the
   * operator (ADR-0004).
   */
  sourceFile: t.sourceFile ?? undefined,
})

const packFields = (p: Pack) => ({
  packId: p.id,
  name: p.name,
  displayOrder: p.displayOrder,
  enabled: p.enabled,
  imageUrl: p.imageUrl ?? undefined,
  theme: p.theme ?? undefined,
  requiresRepos: p.requiresRepos,
  requiresRdp: p.requiresRdp,
  desktop: p.desktop ?? undefined,
})

/** Public packs carry their tools expanded — the SPA renders names, not ids. */
const publicPack = (p: Pack, byId: Map<string, ToolRow>) => ({
  ...packFields(p),
  tools: p.tools.flatMap((id) => {
    const tool = byId.get(id)
    return tool ? [publicTool(tool)] : []
  }),
})

/**
 * The admin view adds PROVENANCE. `sourceFile` is deliberately absent from the public
 * projection and present here: an operator editing packs needs to know which rows are backed
 * by a YAML file — those are owned by the repository and an edit here would be overwritten on
 * the next boot sync (ADR-0004) — and an end user choosing a pack does not.
 */
const adminPack = (p: Pack) => ({ ...packFields(p), tools: p.tools, sourceFile: p.sourceFile ?? null })

/* --------------------------------------------------------------------------- payloads */

/** Create accepts the frozen tool shape minus the id, which may be derived from the name. */
const createToolBody = toolSchema
  .partial({ toolId: true, enabled: true, installOrder: true, bootstrap: true })
  .strict()
const updateToolBody = toolSchema.omit({ toolId: true }).partial().strict()

const createPackBody = packSchema.partial({ packId: true, enabled: true, displayOrder: true }).strict()
const updatePackBody = packSchema.omit({ packId: true }).partial().strict()

const importBody = z
  .union([z.strictObject({ yaml: z.string().min(1) }), z.strictObject({ url: z.url() })])
  .describe('either the file contents or a URL to fetch them from')

/** Ported from the legacy handlers: a name becomes an id when the caller does not supply one. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function createPackRoutes(deps: PackRoutesDeps): Hono<AppEnv> {
  const { db, fetchText = fetchPublicText } = deps
  const routes = new Hono<AppEnv>()

  const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (!c.get('user').isAdmin) return forbidden(c, 'Admin access required')
    await next()
  }

  /* ------------------------------------------------------------------------ public */

  routes.get('/api/v1/tools', (c) => success(c, listTools(db).filter((t) => t.enabled).map(publicTool)))

  routes.get('/api/v1/surge-packs', (c) => {
    const byId = new Map(listTools(db).map((t) => [t.id, t]))
    const packs = listPacks(db)
      .filter((p) => p.enabled)
      .sort((a, b) => a.displayOrder - b.displayOrder || a.id.localeCompare(b.id))
    return success(c, packs.map((p) => publicPack(p, byId)))
  })

  /* ------------------------------------------------------------------- admin: tools */

  routes.use('/api/v1/admin/*', requireAdmin)

  routes.get('/api/v1/admin/tools', (c) =>
    success(c, listTools(db).sort((a, b) => a.installOrder - b.installOrder || a.id.localeCompare(b.id)).map(adminTool)),
  )

  routes.post('/api/v1/admin/tools', validate('json', createToolBody), (c) => {
    const body = c.req.valid('json')
    const id = body.toolId ?? slugify(body.name)
    if (!id) return badRequest(c, 'toolId could not be derived from name; supply one explicitly')
    if (getTool(db, id)) return conflict(c, 'A tool with this ID already exists')

    return created(
      c,
      adminTool(
        upsertTool(db, {
          id,
          name: body.name,
          description: body.description,
          category: body.category,
          url: body.url,
          installScript: body.installScript,
          setupScript: body.setupScript ?? null,
          enabled: body.enabled ?? true,
          installOrder: body.installOrder ?? 100,
          bootstrap: body.bootstrap ?? false,
          runAs: body.runAs,
          // Created here, not loaded from a file: null keeps the loader from deleting it.
          sourceFile: null,
        }),
      ),
    )
  })

  routes.get('/api/v1/admin/tools/:toolId', (c) => {
    const tool = getTool(db, c.req.param('toolId'))
    return tool ? success(c, adminTool(tool)) : notFound(c, 'Tool not found')
  })

  routes.put('/api/v1/admin/tools/:toolId', validate('json', updateToolBody), (c) => {
    const existing = getTool(db, c.req.param('toolId'))
    if (!existing) return notFound(c, 'Tool not found')
    const body = c.req.valid('json')

    return success(
      c,
      adminTool(
        upsertTool(db, {
          id: existing.id,
          name: body.name ?? existing.name,
          description: body.description ?? existing.description,
          category: body.category ?? existing.category,
          url: body.url ?? existing.url,
          installScript: body.installScript ?? existing.installScript,
          setupScript: body.setupScript ?? existing.setupScript,
          enabled: body.enabled ?? existing.enabled,
          installOrder: body.installOrder ?? existing.installOrder,
          bootstrap: body.bootstrap ?? existing.bootstrap,
          runAs: body.runAs ?? existing.runAs,
          // An edit to a file-backed tool keeps its provenance, and is therefore overwritten
          // on the next boot — that is ADR-0004's stated behaviour, and the export endpoint
          // is how an edit becomes a pull request instead of a surprise.
          sourceFile: existing.sourceFile,
        }),
      ),
    )
  })

  routes.delete('/api/v1/admin/tools/:toolId', (c) => {
    const id = c.req.param('toolId')
    if (!getTool(db, id)) return notFound(c, 'Tool not found')
    const usedBy = listPacks(db).filter((p) => p.tools.includes(id))
    if (usedBy.length > 0) {
      return conflict(c, `Tool is used by: ${usedBy.map((p) => p.id).join(', ')}`)
    }
    deleteTool(db, id)
    return noContent(c)
  })

  /* ------------------------------------------------------------------- admin: packs */

  /** Ported check: every referenced tool must exist and be enabled. */
  function checkTools(ids: string[]): string | undefined {
    const found = new Map(listTools(db).map((t) => [t.id, t]))
    const missing = ids.filter((id) => !found.has(id))
    if (missing.length > 0) return `Tools not found: ${missing.join(', ')}`
    const disabled = ids.map((id) => found.get(id)!).filter((t) => !t.enabled)
    if (disabled.length > 0) return `Cannot include disabled tools: ${disabled.map((t) => t.name).join(', ')}`
    return undefined
  }

  routes.get('/api/v1/admin/surge-packs', (c) =>
    success(c, listPacks(db).sort((a, b) => a.displayOrder - b.displayOrder).map(adminPack)),
  )

  routes.post('/api/v1/admin/surge-packs', validate('json', createPackBody), (c) => {
    const body = c.req.valid('json')
    const id = body.packId ?? slugify(body.name)
    if (!id) return badRequest(c, 'packId could not be derived from name; supply one explicitly')
    if (getPack(db, id)) return conflict(c, 'A surge pack with this ID already exists')
    const problem = checkTools(body.tools)
    if (problem) return badRequest(c, problem)

    return created(
      c,
      adminPack(
        upsertPack(db, {
          id,
          name: body.name,
          tools: body.tools,
          displayOrder: body.displayOrder ?? 100,
          enabled: body.enabled ?? true,
          imageUrl: body.imageUrl ?? null,
          theme: body.theme ?? null,
          requiresRepos: body.requiresRepos,
          requiresRdp: body.requiresRdp,
          desktop: body.desktop ?? null,
          sourceFile: null,
        }),
      ),
    )
  })

  routes.get('/api/v1/admin/surge-packs/:packId', (c) => {
    const pack = getPack(db, c.req.param('packId'))
    return pack ? success(c, adminPack(pack)) : notFound(c, 'Surge pack not found')
  })

  routes.put('/api/v1/admin/surge-packs/:packId', validate('json', updatePackBody), (c) => {
    const existing = getPack(db, c.req.param('packId'))
    if (!existing) return notFound(c, 'Surge pack not found')
    const body = c.req.valid('json')
    const nextTools = body.tools ?? existing.tools
    const problem = checkTools(nextTools)
    if (problem) return badRequest(c, problem)

    return success(
      c,
      adminPack(
        upsertPack(db, {
          id: existing.id,
          name: body.name ?? existing.name,
          tools: nextTools,
          displayOrder: body.displayOrder ?? existing.displayOrder,
          enabled: body.enabled ?? existing.enabled,
          imageUrl: body.imageUrl ?? existing.imageUrl,
          theme: body.theme ?? existing.theme,
          requiresRepos: body.requiresRepos ?? existing.requiresRepos,
          requiresRdp: body.requiresRdp ?? existing.requiresRdp,
          desktop: body.desktop ?? existing.desktop,
          sourceFile: existing.sourceFile,
        }),
      ),
    )
  })

  routes.delete('/api/v1/admin/surge-packs/:packId', (c) => {
    const id = c.req.param('packId')
    if (!getPack(db, id)) return notFound(c, 'Surge pack not found')
    deletePack(db, id)
    return noContent(c)
  })

  /* ------------------------------------------------------------- admin: export/import */

  /**
   * Export a pack as a `packs/*.yaml` file. This is the path ADR-0004 promises: an edit made
   * in the admin UI becomes a reviewable pull request rather than a local divergence.
   *
   * Only the tools this pack OWNS could be rendered here, but a pack whose file omits a tool
   * it references would not load, so every referenced tool is included. Re-importing it into
   * a tree that already defines those tools elsewhere is the one case an author must resolve
   * by hand — the loader will name the duplicate.
   */
  routes.get('/api/v1/admin/surge-packs/:packId/export', (c) => {
    const pack = getPack(db, c.req.param('packId'))
    if (!pack) return notFound(c, 'Surge pack not found')
    const byId = new Map(listTools(db).map((t) => [t.id, t]))
    const missing = pack.tools.filter((id) => !byId.has(id))
    if (missing.length > 0) return badRequest(c, `Cannot export: unknown tools ${missing.join(', ')}`)

    const yaml = renderPackFile(
      {
        packId: pack.id,
        name: pack.name,
        tools: pack.tools,
        displayOrder: pack.displayOrder,
        enabled: pack.enabled,
        ...(pack.imageUrl ? { imageUrl: pack.imageUrl } : {}),
        ...(pack.theme ? { theme: pack.theme } : {}),
        requiresRepos: pack.requiresRepos,
        requiresRdp: pack.requiresRdp,
        ...(pack.desktop ? { desktop: pack.desktop as 'xfce' } : {}),
      },
      pack.tools.map((id) => {
        const t = byId.get(id)!
        return {
          toolId: t.id,
          name: t.name,
          description: t.description,
          category: t.category as 'agent' | 'base',
          url: t.url,
          installScript: t.installScript,
          ...(t.setupScript ? { setupScript: t.setupScript } : {}),
          enabled: t.enabled,
          installOrder: t.installOrder,
          bootstrap: t.bootstrap,
          runAs: t.runAs as 'root' | 'rocky',
        }
      }),
    )

    c.header('content-type', 'application/yaml; charset=utf-8')
    c.header('content-disposition', `attachment; filename="${pack.id}.yaml"`)
    return c.body(yaml)
  })

  routes.post('/api/v1/admin/surge-packs/import', validate('json', importBody), async (c) => {
    const body = c.req.valid('json')

    let text: string
    if ('yaml' in body) {
      text = body.yaml
    } else {
      // This is a server-side fetch of an operator-supplied URL on a control plane holding
      // cloud credentials, so it goes through the SSRF guard (rockysurf-ftl9.9): scheme
      // check, every resolved address screened against private/link-local/metadata ranges,
      // redirects re-validated hop by hop, body capped.
      const fetched = await fetchText(body.url)
      if (!fetched.ok) return badRequest(c, fetched.reason)
      text = fetched.text
    }

    const { file, issues } = parsePackFile('imported.yaml', text)
    // The filename check cannot apply to a paste, so it is dropped rather than failed.
    const real = issues.filter((i) => !i.message.includes('does not match the filename'))
    if (!file || real.length > 0) {
      return badRequest(c, 'Invalid pack file', real.map((i) => ({ path: i.file, message: i.message })))
    }

    for (const tool of file.tools) {
      upsertTool(db, {
        id: tool.toolId,
        name: tool.name,
        description: tool.description,
        category: tool.category,
        url: tool.url,
        installScript: tool.installScript,
        setupScript: tool.setupScript ?? null,
        enabled: tool.enabled,
        installOrder: tool.installOrder,
        bootstrap: tool.bootstrap,
        runAs: tool.runAs,
        sourceFile: null,
      })
    }
    const problem = checkTools(file.pack.tools)
    if (problem) return badRequest(c, problem)

    return success(
      c,
      adminPack(
        upsertPack(db, {
          id: file.pack.packId,
          name: file.pack.name,
          tools: file.pack.tools,
          displayOrder: file.pack.displayOrder,
          enabled: file.pack.enabled,
          imageUrl: file.pack.imageUrl ?? null,
          theme: file.pack.theme ?? null,
          requiresRepos: file.pack.requiresRepos,
          requiresRdp: file.pack.requiresRdp,
          desktop: file.pack.desktop ?? null,
          sourceFile: null,
        }),
      ),
    )
  })

  return routes
}
