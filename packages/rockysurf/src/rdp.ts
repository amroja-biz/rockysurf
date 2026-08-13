import type { CoreClient } from './mcp/client.js'

/**
 * The one fact the CLI and the MCP server both have to know before creating a server
 * (rockysurf-kvkr): whether the chosen pack installs a remote desktop, and therefore whether a
 * password for the box's `rocky` account has to travel with the create.
 *
 * WHY IT IS ASKED BEFORE THE CREATE RATHER THAN AFTER. A `requiresRdp` pack whose create
 * carries no password still builds: core snapshots the resolver's injected `rdp` step onto the
 * plan, the box installs everything, and then the LAST step exits 1 with "RDP_PASSWORD is not
 * set". Loud, but four minutes late and billed by the hour. Refusing here costs one GET.
 */

/**
 * Where the CLI reads the password from when nobody is at a terminal.
 *
 * An environment variable rather than a flag, for the reason `ps` exists: every process on the
 * machine can read another's argv, and a shell writes its history to a file. The environment of
 * a process is readable only by its own user (and root) on Linux and macOS, which is the same
 * bar `ROCKYSURF_TOKEN` already clears.
 */
export const RDP_PASSWORD_ENV = 'ROCKYSURF_RDP_PASSWORD'

/** What `POST /api/v1/servers` enforces (rockysurf-z0wf). Checked here to fail before the call. */
export const RDP_MIN_LENGTH = 8

interface PublicPack {
  packId: string
  requiresRdp?: boolean
}

/**
 * Does this pack's box come up expecting a desktop password?
 *
 * NEVER THROWS, and answers `false` when it cannot tell. Core is the authority on both the pack
 * and the password; this is a courtesy check that turns a four-minute failure into an instant
 * one. Letting an unreachable pack list block a create would trade a rare loud failure for a
 * common one, including for every pack that needs no password at all.
 */
export async function packRequiresRdp(client: CoreClient, packId: string): Promise<boolean> {
  try {
    const body = await client.get<PublicPack[] | { packs?: PublicPack[] }>('/api/v1/surge-packs')
    const packs = Array.isArray(body) ? body : (body.packs ?? [])
    return packs.find((p) => p.packId === packId)?.requiresRdp === true
  } catch {
    return false
  }
}
