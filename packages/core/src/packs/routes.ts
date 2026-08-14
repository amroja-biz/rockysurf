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
import { describePack } from './disclosure.js'
import { parsePackFile, renderPackFile } from './loader.js'
import type { RegistryClient } from './registry.js'
import { fetchPublicText } from './safe-fetch.js'
import { packSchema, toolSchema, type PackFile, type ToolDefinition } from './schema.js'
import type { RegistryProvenance } from '../db/repositories/packs.js'
import type { AppEnv } from '../app.js'

/**
 * Tools and packs over HTTP.
 *
 * The response shapes are the ones the SPA's API client (`packages/web/src/lib/api.ts`)
 * parses, field for field, because the SPA port from the hosted SaaS was mechanical —
 * `toolId`/`packId` rather than the `id` the database column is called, `tools` expanded to
 * objects on the public pack list and left as ids on the admin one. The only additions are
 * `requiresRepos`, `requiresRdp` and `desktop`, which are additive and are what let the UI
 * stop recognising one pack by name.
 *
 * Validation is ported from the legacy Lambda backend's create-tool and create-pack handlers: the
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
  /**
   * The pack registries, when this installation has any (rockysurf-arym.4).
   *
   * Optional so an embedder — and every existing test — can build these routes without one. Its
   * absence is not an error state: the registry routes answer with a disabled registry, exactly
   * as they do when the operator set `registry.enabled: false`, because from the outside those
   * are the same situation and inventing a second one helps nobody.
   */
  registry?: RegistryClient
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
  /**
   * In the PUBLIC projection as well as the admin one, deliberately: the guide is written for
   * whoever has to log into the box, and the server detail page reads it from this list.
   * It carries no secrets — it says which credential to supply, never what it is.
   */
  guide: p.guide ?? undefined,
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
const adminPack = (p: Pack) => ({
  ...packFields(p),
  tools: p.tools,
  sourceFile: p.sourceFile ?? null,
  /**
   * Registry provenance, and it is a SEPARATE field from `sourceFile` rather than an
   * alternative spelling of it. A registry pack has `sourceFile: null` — that is what keeps the
   * boot reconcile from deleting it — so a UI that read provenance out of `sourceFile` would
   * show every installed pack as "database" and lose where it came from.
   */
  registry: p.registrySource
    ? {
        source: p.registrySource,
        url: p.registryUrl,
        sha256: p.registrySha256,
        trust: p.registryTrust,
        installedAt: p.registryInstalledAt,
      }
    : null,
})

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
  const { db, fetchText = fetchPublicText, registry } = deps
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
          guide: body.guide ?? null,
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
          guide: body.guide ?? existing.guide,
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
        ...(pack.guide ? { guide: pack.guide } : {}),
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

  /**
   * THE ONE FUNCTION THAT TURNS A VALIDATED PackFile INTO ROWS.
   *
   * Both the YAML/URL import below and the registry install (rockysurf-arym.4) call it. Two code
   * paths that both write packs is how two ways of installing a pack start disagreeing about
   * what a pack is — and the disagreement would surface as an operator's catalog behaving
   * differently depending on where a pack came from, which is exactly the thing provenance is
   * supposed to make legible rather than confusing.
   *
   * `sourceFile` IS ALWAYS NULL HERE, for both callers. A non-null value marks a row as backed
   * by a file in `packs/`, and the boot reconcile deletes every such row whose file it cannot
   * find — so an imported or installed pack recorded that way would vanish on the next restart.
   * Provenance goes in the registry columns instead.
   */
  function installPackFile(
    file: PackFile,
    provenance?: RegistryProvenance,
  ): { ok: true; pack: Pack } | { ok: false; problem: string } {
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
    // After the tools are written, because a pack may reference one this very file just
    // introduced — and before the pack row, because a pack whose tools do not resolve installs
    // nothing and should not appear in the picker at all.
    const problem = checkTools(file.pack.tools)
    if (problem) return { ok: false, problem }

    return {
      ok: true,
      pack: upsertPack(db, {
        id: file.pack.packId,
        name: file.pack.name,
        tools: file.pack.tools,
        displayOrder: file.pack.displayOrder,
        enabled: file.pack.enabled,
        imageUrl: file.pack.imageUrl ?? null,
        theme: file.pack.theme ?? null,
        guide: file.pack.guide ?? null,
        requiresRepos: file.pack.requiresRepos,
        requiresRdp: file.pack.requiresRdp,
        desktop: file.pack.desktop ?? null,
        sourceFile: null,
        // `null` rather than `undefined` on the import path, deliberately: importing a YAML file
        // over a pack that came from a registry CLEARS the provenance, because the bytes now in
        // the database are no longer the ones that registry published. Leaving the old
        // provenance would attribute an operator's local file to somebody else.
        registry: provenance ?? null,
      }),
    }
  }

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

    const installed = installPackFile(file)
    if (!installed.ok) return badRequest(c, installed.problem)
    return success(c, adminPack(installed.pack))
  })

  /* --------------------------------------------------------------- admin: the pack shop */

  /**
   * Browsing and installing from the configured pack registries (rockysurf-arym.4, issue #9).
   *
   * ADMIN-ONLY, because installing a pack means accepting shell that will run as root on every
   * box created with it. It is the same authority the import endpoint needs and for the same
   * reason.
   */

  /** One answer for "no registry", whether it is unconfigured or switched off. */
  const noRegistry = () =>
    ({
      enabled: false,
      sources: [],
      shelves: [],
    }) as const

  routes.get('/api/v1/admin/pack-registry', async (c) => {
    if (!registry) return success(c, noRegistry())
    const installedIds = new Set(listPacks(db).map((p) => p.id))
    const shelves = await registry.browse({ force: c.req.query('refresh') === '1' })
    return success(c, {
      ...registry.describe(),
      shelves: shelves.map((shelf) => ({
        source: shelf.source,
        fetchedAt: shelf.fetchedAt?.toISOString() ?? null,
        // The reason is carried, not swallowed. One registry being unreachable renders as one
        // shelf saying why, never as a shop that looks empty.
        failure: shelf.failure ? { kind: shelf.failure.kind, reason: shelf.failure.reason } : null,
        packs: shelf.packs.map((pack) => ({
          ...pack,
          /** So the UI offers "Reinstall" rather than "Install" and nobody is surprised. */
          installed: installedIds.has(pack.packId),
        })),
      })),
    })
  })

  /**
   * A pack's full disclosure, fetched and verified but NOT installed.
   *
   * This is the screen an operator reads before consenting. It carries every install and setup
   * script verbatim, plus the two derived facts hardest to see in a long file — which steps run
   * as root, and every URL the scripts fetch. `summaryIsComplete` is false and must be shown:
   * the URL list is a pattern match over shell and a script can build a URL the match will not
   * see. The scripts are the ground truth; the summary is a reading aid.
   */
  routes.get('/api/v1/admin/pack-registry/:sourceName/:packId', async (c) => {
    if (!registry) return notFound(c, 'No pack registry is configured')
    const fetched = await registry.getPack(c.req.param('sourceName'), c.req.param('packId'))
    if (!fetched.ok) {
      return fetched.kind === 'not-found' ? notFound(c, fetched.reason) : badRequest(c, fetched.reason)
    }

    // The local catalog, so the disclosure describes what THIS installation would run rather
    // than only what the file happens to carry. A pack referencing `claude-code` runs that
    // tool's script too, and an operator consenting to the install is consenting to that.
    const known = new Map<string, ToolDefinition>(
      listTools(db).map((t) => [
        t.id,
        {
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
        },
      ]),
    )

    return success(c, {
      entry: fetched.entry,
      yaml: fetched.yaml,
      disclosure: describePack({ file: fetched.file, knownTools: known }),
    })
  })

  routes.post('/api/v1/admin/pack-registry/:sourceName/:packId/install', async (c) => {
    if (!registry) return notFound(c, 'No pack registry is configured')
    const sourceName = c.req.param('sourceName')

    // Refetched and re-verified here rather than trusting anything the browser sends back from
    // the disclosure screen. An install that took its YAML from the client would let whatever
    // reached the disclosure decide what actually runs as root, which is the whole point of
    // having verified it.
    const fetched = await registry.getPack(sourceName, c.req.param('packId'))
    if (!fetched.ok) {
      return fetched.kind === 'not-found' ? notFound(c, fetched.reason) : badRequest(c, fetched.reason)
    }

    const source = registry.describe().sources.find((s) => s.name === sourceName)
    const installed = installPackFile(fetched.file, {
      source: sourceName,
      url: source?.url ?? '',
      sha256: fetched.entry.sha256,
      // Snapshotted from the operator's config as it is NOW: this records what they believed
      // when they consented, which is the question an audit asks — not what the config says
      // later.
      trust: fetched.entry.trust,
      installedAt: new Date().toISOString(),
    })
    if (!installed.ok) return badRequest(c, installed.problem)

    return created(c, adminPack(installed.pack))
  })

  return routes
}
