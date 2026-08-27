import { summarizePackInputs, type PackInputSummary } from './inputs.js'
import type { PackFile, ToolDefinition } from './schema.js'

/**
 * What a pack will actually do to a box, derived from the pack itself (rockysurf-arym.4).
 *
 * THIS IS THE CONTROL THAT CARRIES WHAT SCANNING CANNOT.
 *
 * Issue #9 asks that packs be "scanned to ensure they are secure". `rockysurf pack lint` checks
 * the file format and the mechanical author rules; `rockysurf pack check` proves a pack survives
 * being resumed. Neither can decide whether an `installScript` is benign, because it is
 * arbitrary shell executed as **root** on the operator's machine, and no static analysis of
 * shell settles that question. Pretending otherwise would be the most dangerous thing this
 * feature could do: an operator who believes a pack was "security scanned" reads nothing.
 *
 * So the honest control is disclosure. Before an install, the operator sees every script
 * verbatim, plus the two derived facts hardest to spot by eye in a long file: **which steps run
 * as root**, and **every URL the scripts fetch**. Then they decide.
 *
 * WHAT THE DERIVED SUMMARY IS AND IS NOT. It is a reading aid, not a boundary. The URL list is a
 * regex over the script text, so a script that builds a URL from variables, or pipes one in from
 * a file it downloaded, will not appear in it — and `verbatim` is present on every tool precisely
 * because the summary can be evaded and the script cannot. Anything shown to an operator
 * alongside this must say so; `summaryIsComplete` exists so a UI cannot forget.
 */

/** One tool's disclosure, in the order it will run. */
export interface ToolDisclosure {
  toolId: string
  name: string
  description: string
  /** The vendor or project page from the pack, so an operator can look the tool up. */
  url: string
  /** `root` or `rocky`. The former is the one worth reading twice. */
  runAs: string
  installOrder: number
  /** The scripts, exactly as they will execute. Rendered as text, never as markup. */
  installScript: string
  setupScript?: string
  /** Every http(s) URL appearing literally in either script, deduplicated, in first-seen order. */
  fetchesUrls: string[]
}

export interface PackDisclosure {
  packId: string
  name: string
  /** Every tool the pack runs, in `installOrder` then `toolId` order — the executor's order. */
  tools: ToolDisclosure[]
  /** Tool ids the pack references but this file does not define. Resolved from the local catalog. */
  referencesTools: string[]
  /** How many of the steps above run as root. The number an operator reacts to. */
  rootStepCount: number
  /** The union of every tool's `fetchesUrls`, deduplicated, for a single at-a-glance list. */
  fetchesUrls: string[]
  /** The pack's own post-install prose, if it has any. Shown, never executed. */
  guide?: string
  requiresRepos: boolean
  requiresRdp: boolean
  desktop?: string
  /**
   * What this pack will ask the person creating a server for (issue #189) — names, labels and
   * whether each is required and secret.
   *
   * Part of the disclosure rather than only of the create form because it is a fact about what
   * installing this pack costs you: a pack that asks for an API key is asking you to put a
   * credential on a box you are about to consent to, and an operator deciding whether to
   * install it should see that BEFORE the form does. No values appear here — a `default` is
   * omitted on purpose, because this list is read as "what will I be asked", not "what will be
   * sent". Empty for a pack that asks for nothing.
   */
  inputs: PackInputSummary[]
  /**
   * ALWAYS FALSE, and it is a field rather than a comment so a UI has to render something.
   *
   * A URL list extracted by pattern-matching shell cannot be complete: a script that assembles
   * a URL from variables, or reads one out of a file it fetched, contributes nothing to it. The
   * scripts above are the ground truth. A page that presents the summary without saying this is
   * telling the operator they have seen everything, and they have not.
   */
  summaryIsComplete: false
}

/**
 * Every http(s) URL appearing literally in a script.
 *
 * Trailing punctuation is trimmed because URLs in shell are usually quoted or followed by a
 * shell operator, and `https://example.com/x",` is not a URL anybody wants to read. Deliberately
 * greedy about what it matches and conservative about what it claims: over-reporting a URL costs
 * an operator a glance, while under-reporting one is the failure mode that matters.
 */
export function urlsIn(script: string): string[] {
  const found = script.match(/https?:\/\/[^\s'"`)>\]}\\]+/g) ?? []
  const cleaned = found.map((url) => url.replace(/[.,;:!?]+$/, ''))
  return [...new Set(cleaned)]
}

export interface DisclosureInput {
  file: PackFile
  /**
   * Tools this installation already has, for the references the file does not define.
   *
   * A pack that references `claude-code` runs that tool's script too, and an operator consenting
   * to the install is consenting to that. Passing the local catalog means the disclosure shows
   * the scripts THIS installation would actually run, rather than only the ones the file
   * happens to carry — the difference between describing a file and describing an install.
   */
  knownTools?: Map<string, ToolDefinition>
}

export function describePack(input: DisclosureInput): PackDisclosure {
  const { file } = input
  const defined = new Map(file.tools.map((t) => [t.toolId, t]))
  const known = input.knownTools ?? new Map<string, ToolDefinition>()

  const resolved: ToolDefinition[] = []
  const unresolved: string[] = []
  for (const toolId of file.pack.tools) {
    const tool = defined.get(toolId) ?? known.get(toolId)
    if (tool) resolved.push(tool)
    else unresolved.push(toolId)
  }

  // The executor's ordering, so the disclosure reads in the order the steps actually run
  // (`resolveInstallPlan`: installOrder ascending, ties broken on toolId).
  const ordered = [...resolved].sort((a, b) => a.installOrder - b.installOrder || a.toolId.localeCompare(b.toolId))

  const tools: ToolDisclosure[] = ordered.map((tool) => ({
    toolId: tool.toolId,
    name: tool.name,
    description: tool.description,
    url: tool.url,
    runAs: tool.runAs,
    installOrder: tool.installOrder,
    installScript: tool.installScript,
    ...(tool.setupScript ? { setupScript: tool.setupScript } : {}),
    fetchesUrls: [...new Set([...urlsIn(tool.installScript), ...urlsIn(tool.setupScript ?? '')])],
  }))

  return {
    packId: file.pack.packId,
    name: file.pack.name,
    tools,
    referencesTools: unresolved,
    rootStepCount: tools.filter((t) => t.runAs === 'root').length,
    fetchesUrls: [...new Set(tools.flatMap((t) => t.fetchesUrls))],
    ...(file.pack.guide ? { guide: file.pack.guide } : {}),
    requiresRepos: file.pack.requiresRepos,
    requiresRdp: file.pack.requiresRdp,
    ...(file.pack.desktop ? { desktop: file.pack.desktop } : {}),
    inputs: summarizePackInputs(file.pack.inputs),
    summaryIsComplete: false,
  }
}
