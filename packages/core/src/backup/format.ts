import { z } from 'zod'

/**
 * The backup artifact: one JSON document, produced by `create.ts` and consumed by
 * `restore.ts` (issue #331, ADR-0023).
 *
 * The words are BACKUP and RESTORE, deliberately — "export"/"import" already belong to packs
 * and tools (ADR-0018), where they mean "hand a definition to somebody else's installation".
 * A backup is the opposite: the same installation's own state, carried to its owner's next
 * machine.
 *
 * WHAT THE FORMAT IS. Logical rows as JSON objects — never SQL, never the database file — so
 * a later schema change is absorbed by the restore mapping rather than baked into every
 * artifact ever downloaded. The `formatVersion` stamp is the compatibility contract:
 *
 *  - an artifact with a HIGHER version than this build knows is refused with "made by a newer
 *    Rocky Surf" — the honest answer, since this code cannot know what a future field means;
 *  - an artifact with a LOWER version runs through {@link migrateBackup}, a chain of
 *    upcasters keyed by the version they read. Today the chain is empty because version 1 is
 *    the only version there has ever been; the seam is the deliverable, so that version 2 is
 *    an entry in a table rather than a rewrite of the reader.
 *
 * WHAT IS IN IT, AND WHAT NEVER IS — the load-bearing decisions, stated here because this
 * file is the schema of record (SECURITY.md carries the full analysis):
 *
 *  - `secrets` rows travel VERBATIM AS CIPHERTEXT — ciphertext, nonce, auth tag, key id,
 *    exactly as they sit in the `secrets` table. **The master key is never in the artifact.**
 *    It travels by the operator's own hand (`secret.key` / `ROCKYSURF_SECRET_KEY`), which is
 *    the story the first-boot banner has always told. An artifact without its key is
 *    worthless to whoever finds it; an artifact restored beside its key decrypts in place,
 *    because restore preserves the ids the GCM associated data binds.
 *  - `session-signing-key` is excluded (instance-scoped; a new instance mints its own), and
 *    so are session rows, the admin password hash (anti-lockout: the person restoring is
 *    already signed in with a password they know), and the `events` log (forensic, bulky, and
 *    its subjects get reconciled anyway — a candidate for an opt-in in a later version).
 *  - `config.text` is the configuration file's own text — with every literal GitHub token
 *    REDACTED to a `${VAR}` placeholder (owner ruling, issue #331): a backup is built to
 *    travel, and a cleartext PAT must not travel with it. What survives is the token's
 *    IDENTITY — `config.redactedTokens` lists each one by label and placeholder — so restore
 *    can tell the operator exactly which tokens to paste back in. The redaction lives in ONE
 *    place, `serializeConfigForBackup` in `create.ts`. (The encrypted Connect-GitHub OAuth
 *    token is a different thing: it is a `secrets` row and travels as ciphertext like any
 *    other.)
 *  - Cloud credentials cannot be in the artifact because Rocky Surf stores none (issue #280) —
 *    there is nothing to include.
 *
 * Entity schemas below are deliberately LOOSE — they pin the fields restore logic depends on
 * and pass the rest through, because the restorer picks writable columns by name from the
 * live table definition (`restore.ts`) and ignores anything it has never heard of. Tightness
 * here would only mean an artifact from a slightly newer same-version build failing on a
 * field the reader was going to ignore anyway.
 */

export const BACKUP_ARTIFACT = 'rockysurf-backup'
export const BACKUP_FORMAT_VERSION = 1

const row = z.looseObject({ id: z.string().min(1) })

const userEntry = z.looseObject({
  id: z.string().min(1),
  githubId: z.string().min(1),
  githubUsername: z.string().min(1),
})

const secretEntry = z.looseObject({
  id: z.string().min(1),
  kind: z.string().min(1),
  ownerId: z.string().nullable(),
  ciphertext: z.string().min(1),
  nonce: z.string().min(1),
  authTag: z.string().min(1),
  keyId: z.string().min(1),
})

const serverRepositoryEntry = z.looseObject({
  serverId: z.string().min(1),
  repositoryUrl: z.string().min(1),
})

/**
 * The two per-installation fields an operator may set on a SHIPPED (file-backed) tool
 * (ADR-0020). The tool rows themselves do not travel — the target's own release provides
 * them, and restoring one would fight the boot reconcile (the ADR-0018 trap) — but the
 * operator's switches on them are backup-worthy state.
 */
const fileBackedToolStateEntry = z.looseObject({
  toolId: z.string().min(1),
  alwaysInstall: z.boolean().optional(),
  enabled: z.boolean().optional(),
})

const settingEntry = z.object({
  key: z.string().min(1),
  value: z.string(),
})

/**
 * One GitHub token the backup left behind, by identity only (owner ruling, issue #331).
 *
 * `label` is what the operator sees ("acme/widgets", "instance-wide `github.pat`");
 * `placeholder` is the `${VAR}` the config text now carries where the literal was; `path` is
 * the config path, so a client that wants to link to the field can. The VALUE is exactly what
 * this record must never hold.
 */
const redactedTokenEntry = z.object({
  path: z.string().min(1),
  label: z.string().min(1),
  placeholder: z.string().min(1),
})

export type RedactedToken = z.infer<typeof redactedTokenEntry>

export const backupSchema = z.looseObject({
  artifact: z.literal(BACKUP_ARTIFACT),
  formatVersion: z.number().int().min(1),
  /** Informational: which build wrote it. Compatibility is `formatVersion`'s job alone. */
  appVersion: z.string().optional(),
  /** ISO-8601. Also the month anchor for the spend-baseline adjustment on restore. */
  createdAt: z.string().min(1),
  config: z.object({
    text: z.string(),
    /** Tokens redacted out of `text`, by identity. Absent in a config that had none. */
    redactedTokens: z.array(redactedTokenEntry).default([]),
  }),
  users: z.array(userEntry),
  servers: z.array(row),
  serverRepositories: z.array(serverRepositoryEntry),
  tools: z.array(row),
  fileBackedToolState: z.array(fileBackedToolStateEntry),
  packs: z.array(row),
  secrets: z.array(secretEntry),
  /** `jobs.spend.baseline.*` rows only — see `create.ts` for why nothing else qualifies. */
  settings: z.array(settingEntry),
})

export type BackupArtifact = z.infer<typeof backupSchema>

/** Refused with this exact sentence when the artifact is from a future Rocky Surf. */
export const NEWER_BACKUP_REFUSAL =
  'this backup was made by a newer Rocky Surf than the one restoring it — upgrade this installation first, then restore.'

/**
 * Upcast an artifact written by an older format version to the current one.
 *
 * A chain keyed by the version each step READS: a version-1 artifact restored by a build
 * whose current version is 3 runs the 1→2 step and then the 2→3 step. Empty today — version 1
 * is the only version — but the seam is deliberate: adding a version means adding an entry
 * here and bumping the constant, not touching the reader.
 */
const UPCASTERS: Record<number, (artifact: BackupArtifact) => BackupArtifact> = {}

export function migrateBackup(artifact: BackupArtifact): BackupArtifact {
  let current = artifact
  for (let v = artifact.formatVersion; v < BACKUP_FORMAT_VERSION; v++) {
    const step = UPCASTERS[v]
    if (!step) throw new Error(`no migration from backup format version ${v}`)
    current = { ...step(current), formatVersion: v + 1 }
  }
  return current
}
