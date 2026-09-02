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
import { parsePackFile, parseToolFile, renderPackFile, renderToolFile } from './loader.js'
import type { RegistryClient } from './registry.js'
import { sha256Text } from './registry-index.js'
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

/**
 * The tool LIST's projection: what a pack embeds, plus whether it installs on every box.
 *
 * A SEPARATE PROJECTION rather than a wider `publicTool`, because the two answer different
 * questions and one of them is pinned. `publicPack` embeds `publicTool` for each tool the pack
 * names, and `routes.test.ts` pins that embedded shape to exactly its five keys — rightly: a
 * pack's tool list is "what this pack installs", and whether a tool ALSO installs on boxes
 * built from other packs is not a fact about this pack. It is a fact about the installation,
 * so it rides on the installation-wide list, which is the one the create page reads to say
 * "also installed, whichever pack you pick" (issue #295).
 */
const listedTool = (t: ToolRow) => ({
  ...publicTool(t),
  alwaysInstall: t.alwaysInstall,
})

/** The admin view is the whole record, including the scripts. */
const adminTool = (t: ToolRow) => ({
  ...listedTool(t),
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
  /**
   * Where a tool imported from a URL came from (issue #299), a SEPARATE field from `sourceFile`
   * exactly as it is on `adminPack`. A URL-imported tool has `sourceFile: null` — that null is
   * what keeps the boot reconcile from deleting it — so a UI reading provenance out of
   * `sourceFile` would show it as "database" and lose where it came from. The Tools page needs
   * this to say the row is shell fetched from off this machine, and which URL.
   */
  registry: t.registrySource
    ? {
        source: t.registrySource,
        url: t.registryUrl,
        sha256: t.registrySha256,
        trust: t.registryTrust,
        installedAt: t.registryInstalledAt,
      }
    : null,
})

const packFields = (p: Pack) => ({
  packId: p.id,
  name: p.name,
  /**
   * The pack this one was forked from (issue #295), in BOTH projections.
   *
   * It names a pack that is already listed to the same audience, so it discloses nothing new —
   * and the Surge Packs page needs it on the public list to mark an official pack whose
   * personal version exists. Deriving that mark in the browser, from the list it already has,
   * is what makes the mark disappear the moment the fork is deleted with no route to notify.
   */
  derivedFromPackId: p.derivedFromPackId ?? undefined,
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
  webPort: p.webPort ?? undefined,
  /**
   * What this pack will ASK the person creating a server for (issue #189, ADR-0013).
   *
   * In the public projection because the create form is built from it, field for field, with
   * no per-pack code — the same contract `requiresRdp` established. It is the question and
   * never an answer: `default` is a value the pack author wrote into a file everyone can read,
   * and a `secret` input may not have one (`packs/schema.ts`). Omitted entirely for a pack that
   * asks for nothing, so the field's presence means something.
   */
  ...(p.inputs?.length ? { inputs: p.inputs } : {}),
})

/**
 * WHERE A PACK CAME FROM, in three words and nothing else (rockysurf-jn71).
 *
 * THREE VALUES, NOT TWO. A pack the operator wrote here is not "community" — nobody outside
 * this installation has ever seen it — so a two-valued field would make core assert something
 * false, and would bake one screen's tab labels into the API's vocabulary. Core states the
 * fact; a view decides what to call it. The Surge Pack picker groups `registry` and `local`
 * together under "Community", and that grouping is the view's business, reversible without a
 * change to this route.
 *
 * The precedence is `describeInstalled`'s in the admin Pack Shop, and it is that way round
 * because a `sourceFile` is what the boot sync will enforce on the next start (ADR-0004): what
 * is on disk wins over what a registry once said.
 *
 * `official` still means only "arrived in the tarball", still computed here from `sourceFile`,
 * which no registry writes — so no registry can claim it (ADR-0006).
 */
const packProvenance = (p: Pack): 'official' | 'registry' | 'local' =>
  p.sourceFile ? 'official' : p.registrySource ? 'registry' : 'local'

/** Public packs carry their tools expanded — the SPA renders names, not ids. */
const publicPack = (p: Pack, byId: Map<string, ToolRow>) => ({
  ...packFields(p),
  tools: p.tools.flatMap((id) => {
    const tool = byId.get(id)
    return tool ? [publicTool(tool)] : []
  }),
  provenance: packProvenance(p),
})

/**
 * The admin view adds the RAW provenance. `sourceFile` and the registry object are deliberately
 * absent from the public projection and present here: an operator editing packs needs to know
 * which rows are backed by a YAML file — those are owned by the repository and an edit here
 * would be overwritten on the next boot sync (ADR-0004) — and an end user choosing a pack does
 * not. What the public list gets instead is `packProvenance`, one derived word that discloses
 * no filesystem path, no registry URL, no digest and no trust label, because that route is
 * served to every logged-in user and those four are operator infrastructure detail.
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

/**
 * `alwaysInstall` is added HERE, on the request bodies, and never to `toolSchema` (issue #295).
 *
 * That one placement is what makes the whole rule hold with no guard to maintain. `toolSchema`
 * is the frozen shape a pack file and a tool file BOTH carry (ADR-0018), and both are
 * `strictObject`s — so a file naming `alwaysInstall` is already refused, loudly, by the schema
 * that has never heard of it. The field is installation state: "install this on every box I
 * create" is a fact about one installation, and a file that carried it would be making a
 * promise about someone else's. See `tool-file.test.ts`, which pinned this before the column
 * existed.
 */
const alwaysInstallField = { alwaysInstall: z.boolean().optional() }

/** Create accepts the frozen tool shape minus the id, which may be derived from the name. */
const createToolBody = toolSchema
  .partial({ toolId: true, enabled: true, installOrder: true, bootstrap: true })
  .extend(alwaysInstallField)
  .strict()
const updateToolBody = toolSchema.omit({ toolId: true }).partial().extend(alwaysInstallField).strict()

/**
 * `derivedFromPackId` is on CREATE only, and deliberately not on update (issue #295).
 *
 * Where a pack came from is settled the moment it is forked. An update route that accepted it
 * would let a pack claim a parentage it never had, and — worse — the SPA's pack PUT sends a
 * whole form, so the field would arrive as `undefined` on every ordinary edit and need a rule
 * to distinguish "not mentioned" from "cleared". Keeping it off this body means the repository
 * layer's "absent leaves it alone" is the only rule there is.
 */
const createPackBody = packSchema
  .partial({ packId: true, enabled: true, displayOrder: true })
  .extend({ derivedFromPackId: z.string().optional() })
  .strict()
const updatePackBody = packSchema.omit({ packId: true }).partial().strict()

/**
 * The `registrySource` a URL import records, so the row can say it came from off this machine.
 *
 * A SENTENCE FRAGMENT RATHER THAN A NAME, deliberately: every other value in this column is the
 * name of a source the operator configured, and one that reads like a name would invite the UI
 * to treat a one-off fetch as a shelf it could go back to. There is no shelf — the URL beside it
 * is the whole of what was recorded. The SPA keys its wording off this exact string.
 */
export const URL_IMPORT_SOURCE = 'a URL import'

const importBody = z
  .union([z.strictObject({ yaml: z.string().min(1) }), z.strictObject({ url: z.url() })])
  .describe('either the file contents or a URL to fetch them from')

/**
 * Tool import takes the file contents or a URL to fetch them from (issue #299 adds the `url`
 * arm ADR-0018 deferred).
 *
 * The same union `importBody` uses for packs, and now for the same reason it is safe to: the
 * `tools` table gained the provenance columns a URL import needs (issue #299), so a fetched
 * tool can record where its root-running shell came from rather than reading — falsely — as one
 * typed in here. That was the whole of ADR-0018's objection to the arm.
 */
const importToolsBody = z
  .union([z.strictObject({ yaml: z.string().min(1) }), z.strictObject({ url: z.url() })])
  .describe('either the contents of a tool file or a URL to fetch them from')

/**
 * A database row back to the frozen tool shape.
 *
 * The columns and the format agree field for field except in their spelling of the id and in
 * SQLite's nullable columns, which the format spells as absent. `renderToolFile` drops
 * `sourceFile`, so it is deliberately not carried here.
 */
const toolDefinitionOf = (t: ToolRow): ToolDefinition => ({
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
})

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

  routes.get('/api/v1/tools', (c) => success(c, listTools(db).filter((t) => t.enabled).map(listedTool)))

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
          alwaysInstall: body.alwaysInstall ?? false,
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
          // Editable on a FILE-BACKED tool too, unlike everything above it, because it is the
          // one field here that is not file content (issue #295, ADR-0020). The next boot
          // rewrites this row's name and scripts from its YAML and leaves this alone.
          alwaysInstall: body.alwaysInstall ?? existing.alwaysInstall,
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

  /* ------------------------------------------------- admin: sharing one tool (issue #289) */

  /**
   * EXPORT ONE TOOL as a tool file (ADR-0018).
   *
   * Any tool exports, file-backed ones included: a shipped tool is exactly what somebody wants
   * to hand a colleague who is not running this installation, and the bytes are already public
   * in the repository. What does NOT travel is `sourceFile` — `renderToolFile` strips it,
   * because provenance is this installation's fact about its own disk.
   */
  routes.get('/api/v1/admin/tools/:toolId/export', (c) => {
    const tool = getTool(db, c.req.param('toolId'))
    if (!tool) return notFound(c, 'Tool not found')

    const yaml = renderToolFile([toolDefinitionOf(tool)])
    c.header('content-type', 'application/yaml; charset=utf-8')
    c.header('content-disposition', `attachment; filename="${tool.id}.yaml"`)
    return c.body(yaml)
  })

  /**
   * IMPORT TOOLS from a pasted or uploaded tool file, or from a URL (issue #299).
   *
   * THE `{ url }` ARM, which ADR-0018 deferred until the `tools` table could record provenance.
   * It now can (issue #299), so a fetched tool records where it came from
   * (`registrySource`/`registryUrl`/`registrySha256`, ADR-0006's columns) exactly as a pack
   * URL import does — that was the whole of the objection. A fetch on a control plane holding
   * cloud credentials goes through the SSRF guard `fetchPublicText` (rockysurf-ftl9.9), never a
   * raw fetch, the same guard and injection seam the pack import uses.
   *
   * `trust` is snapshotted as `unverified`, and a PASTED file records nothing — both mirror the
   * pack path; see the provenance block below for why.
   *
   * A file-backed id is refused rather than overwritten. The boot reconcile owns those rows, so
   * an import that "won" would be silently undone at the next restart — a 409 that explains
   * itself is the honest answer.
   */
  routes.post('/api/v1/admin/tools/import', validate('json', importToolsBody), async (c) => {
    const body = c.req.valid('json')

    let text: string
    if ('yaml' in body) {
      text = body.yaml
    } else {
      // A server-side fetch of an operator-supplied URL on a control plane holding cloud
      // credentials, so it goes through the SSRF guard: scheme check, every resolved address
      // screened against private/link-local/metadata ranges, redirects re-validated hop by hop,
      // body capped. Identical to the pack import's own url arm.
      const fetched = await fetchText(body.url)
      if (!fetched.ok) return badRequest(c, fetched.reason)
      text = fetched.text
    }

    const { file, issues } = parseToolFile('imported.yaml', text)
    if (!file || issues.length > 0) {
      return badRequest(
        c,
        'Invalid tool file',
        issues.map((i) => ({ path: i.file, message: i.message })),
      )
    }

    const fileBacked = file.tools.filter((t) => getTool(db, t.toolId)?.sourceFile)
    if (fileBacked.length > 0) {
      return conflict(
        c,
        `Cannot replace tools that come from a pack file: ${fileBacked.map((t) => t.toolId).join(', ')}`,
      )
    }

    /**
     * AN IMPORT FROM A URL REMEMBERS THE URL (issue #88, issue #299).
     *
     * The tool half of what the pack import already does. A tool fetched from somebody's URL and
     * a tool typed into the admin form used to be indistinguishable — both `sourceFile: null`,
     * "created here" — which is false about the first, and false in the direction an operator
     * cares about: this is shell that will run as root on a box. The provenance columns are the
     * right home for it (ADR-0006: never `sourceFile`, which the boot reconcile would delete the
     * row for). `trust` is `unverified` rather than borrowed from any configured source — there
     * is no tool registry (ADR-0018), so a one-off fetch has no operator-written trust line to
     * borrow, and claiming one would put words in their mouth.
     *
     * Every tool in the fetched file shares one provenance record: the URL is where the file
     * came from and the sha256 is of the whole file, exactly the bytes the fetch returned.
     *
     * A PASTED OR UPLOADED FILE STILL RECORDS NOTHING, because there is nothing true to record:
     * the bytes came from the admin's own machine, and this installation cannot say where they
     * had been before that.
     */
    const registry: RegistryProvenance | undefined =
      'url' in body
        ? {
            source: URL_IMPORT_SOURCE,
            url: body.url,
            sha256: sha256Text(text),
            trust: 'unverified',
            installedAt: new Date().toISOString(),
          }
        : undefined

    const imported = file.tools.map((tool) =>
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
        // Imported, not loaded from a file — null is what keeps the boot reconcile off it.
        sourceFile: null,
        // `null` on the paste path clears any stale provenance if this import replaces a row
        // that had been fetched from a URL before; the URL path stamps the fetch.
        registry: registry ?? null,
      }),
    )

    return created(c, imported.map(adminTool))
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
    /**
     * A fork names a pack that EXISTS RIGHT NOW, checked once, here (issue #295).
     *
     * Checked at create time and never again, which is the same contract `servers.tools` moved
     * to in #289: leniency is right when RENDERING an old row and wrong as the answer to a
     * fresh request. Afterwards the parent may be edited, or dropped from a release entirely,
     * and the recorded id stays exactly as it is — a dangling id is still the truth about where
     * this pack began, and nothing downstream dereferences it without checking.
     */
    if (body.derivedFromPackId !== undefined) {
      if (body.derivedFromPackId === id) return badRequest(c, 'A pack cannot be derived from itself')
      if (!getPack(db, body.derivedFromPackId)) {
        return badRequest(c, `Pack not found: ${body.derivedFromPackId}`)
      }
    }

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
          webPort: body.webPort ?? null,
          inputs: body.inputs ?? null,
          sourceFile: null,
          derivedFromPackId: body.derivedFromPackId ?? null,
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
          webPort: body.webPort ?? existing.webPort,
          // OMITTED MEANS "LEAVE THEM", like every other field on this PUT — and it matters
          // more here than elsewhere, because the admin pack editor has no inputs control and
          // sends none. Without this fallback, saving a name change through that form would
          // silently delete a pack's whole declaration and break the create form for it.
          inputs: body.inputs ?? existing.inputs ?? null,
          sourceFile: existing.sourceFile,
          // `derivedFromPackId` IS DELIBERATELY NOT LISTED HERE (issue #295). This is a whole-row
          // literal, and the field is settled at fork time and absent from `updatePackBody`, so
          // naming it would only create a way to lose it. `upsertPack` reads "absent" as "leave
          // it alone", which is what keeps a fork's provenance — and the mark on the official
          // pack's icon — through the very first "add a tool to my fork".
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
        /**
         * ARTWORK INHERITED BY FORKING DOES NOT LEAVE THIS INSTALLATION (issue #295).
         *
         * Three conditions, and dropping any one of them breaks something real:
         *
         *  - `derivedFromPackId` — the art was inherited HERE, by forking, rather than arriving
         *    in the pack's own file. This is the case the owner's ruling is about.
         *  - not `sourceFile` — an official pack always exports its own artwork, because that
         *    export is how an operator sends a pack upstream as a pull request (ADR-0004) and
         *    the file must be the file that shipped.
         *  - root-relative — `/images/surge-packs/…` is served out of THIS installation's
         *    bundle. On the far side it resolves to whatever that installation ships at the
         *    path, or to nothing, and either way it arrives unmarked: a personal pack wearing a
         *    first-party face, which is ADR-0006's concern about who gets to look official.
         *    An absolute `https://…` image is one its owner chose and can serve, so it travels.
         *
         * WHY NOT the simpler "not file-backed and root-relative": a pack IMPORTED from an
         * official pack's export is exactly that — `sourceFile` is null and the artwork is
         * root-relative — and stripping there would break the pinned export/import/re-export
         * round trip while preventing nothing. That art already travelled, legitimately, inside
         * the file the recipient is holding. What must not travel is art this installation
         * attached by forking, which is what `derivedFromPackId` identifies and nothing else does.
         *
         * The invariant this defends: artwork-without-a-mark never occurs. In the app a fork's
         * inherited art always renders under the delta, and art that would arrive somewhere with
         * no delta to explain it does not leave.
         */
        ...(pack.imageUrl && !(pack.derivedFromPackId && !pack.sourceFile && pack.imageUrl.startsWith('/'))
          ? { imageUrl: pack.imageUrl }
          : {}),
        ...(pack.theme ? { theme: pack.theme } : {}),
        ...(pack.guide ? { guide: pack.guide } : {}),
        requiresRepos: pack.requiresRepos,
        requiresRdp: pack.requiresRdp,
        ...(pack.desktop ? { desktop: pack.desktop as 'xfce' } : {}),
        ...(pack.webPort != null ? { webPort: pack.webPort } : {}),
        ...(pack.inputs?.length ? { inputs: pack.inputs } : {}),
      },
      pack.tools.map((id) => toolDefinitionOf(byId.get(id)!)),
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
        webPort: file.pack.webPort ?? null,
        inputs: file.pack.inputs ?? null,
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

    /**
     * AN IMPORT FROM A URL REMEMBERS THE URL (issue #88).
     *
     * Before this, a pack fetched from somebody's personal URL and a pack typed into the create
     * form were the same row: `local`, "created here, in this installation". That is false about
     * the first one and it is the false half operators care about — where did this shell that
     * runs as root on my boxes actually come from?
     *
     * The registry columns are the right home for it (ADR-0006: never `sourceFile`, which the
     * boot reconcile would delete the row for). `trust` is snapshotted as `unverified` rather
     * than borrowed from `REGISTRY_TRUST`: those two labels mean "what the operator wrote next
     * to a source they configured", and a one-off URL import has no such line. Claiming one
     * would put words in the operator's mouth, and `official` remains unreachable from here as
     * it is from everywhere else.
     *
     * A PASTED OR UPLOADED FILE STILL RECORDS NOTHING, because there is nothing true to record:
     * the bytes came from the admin's own machine, and this installation cannot say where they
     * had been before that.
     */
    const provenance: RegistryProvenance | undefined =
      'url' in body
        ? {
            source: URL_IMPORT_SOURCE,
            url: body.url,
            sha256: sha256Text(text),
            trust: 'unverified',
            installedAt: new Date().toISOString(),
          }
        : undefined

    const installed = installPackFile(file, provenance)
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
