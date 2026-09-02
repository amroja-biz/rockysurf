import { readFileSync } from 'node:fs'
import { like, ne } from 'drizzle-orm'
import { applyChanges, parseTree } from '../settings/document.js'
import { secretView } from '../settings/view.js'
import type { Db } from '../db/client.js'
import { packs, secrets, servers, serverRepositories, settings, tools, users } from '../db/schema.js'
import { BACKUP_ARTIFACT, BACKUP_FORMAT_VERSION, type BackupArtifact, type RedactedToken } from './format.js'

/**
 * Build the backup artifact from the running installation (issue #331, ADR-0023).
 *
 * ALL DATABASE READS HAPPEN IN ONE TRANSACTION, and that is the reason a running process can
 * do this at all: the manual path (`docs/self-hosting.md`) has to stop the process first
 * because a file copy of a WAL-mode database can silently miss recent writes, while a set of
 * reads inside a single transaction is a consistent snapshot by SQLite's own rules. The two
 * paths coexist on purpose — the tar is the full-fidelity everything-including-the-key
 * snapshot; this artifact is the curated, travels-safely migration document.
 *
 * NO PLAINTEXT ACCESSOR IS CALLED HERE. Secret rows are read as the ciphertext they are
 * (`secrets/route-inventory.test.ts` remains at its single exemption), and the config text
 * has its literal GitHub tokens redacted before it enters the artifact — see
 * {@link serializeConfigForBackup}.
 */

export interface CreateBackupDeps {
  db: Db
  /** The configuration file to embed. Absent (no `configPath` wired) means an empty config. */
  configPath?: string
  /** Which build wrote the artifact. Informational; `formatVersion` carries compatibility. */
  appVersion?: string
  /** Injectable clock (repo rule: anything time-stamped takes one). */
  now?: () => Date
}

/** The one config path that is a single token rather than a list entry. */
const INSTANCE_PAT_PATH = 'github.pat'

/**
 * Redact every literal GitHub token out of the config text (owner ruling, issue #331).
 *
 * ALWAYS, with no toggle: a backup is built to be put somewhere — a drive, a repository — and
 * a cleartext PAT must never ride along. Each literal `github.pat` / `github.tokens[].pat`
 * value is replaced with a `${VAR}` placeholder; a value that is already a whole `${VAR}`
 * reference is left exactly as written (it is the name of a variable, not a secret, and the
 * operator's own choice of indirection). Mixed values — a literal with a variable inside —
 * are literals for this purpose and are redacted whole, the same line `settings/view.ts`
 * draws.
 *
 * The placeholder is legal to restore as-is: `checkConfigText` treats a reference to an unset
 * variable as a warning, not an error (rockysurf-1z5q), so the restored file applies and the
 * operator re-enters each token on the Settings page — which is why the IDENTITY of every
 * redacted token is preserved in the artifact: restore lists them by label so the operator
 * knows exactly what to paste back in.
 */
export function serializeConfigForBackup(text: string): { text: string; redactedTokens: RedactedToken[] } {
  const tree = parseTree(text)
  const github =
    tree !== null && typeof tree === 'object' && !Array.isArray(tree)
      ? (tree as Record<string, unknown>).github
      : undefined
  if (github === null || typeof github !== 'object' || Array.isArray(github)) return { text, redactedTokens: [] }

  const redactedTokens: RedactedToken[] = []
  const changes: { path: (string | number)[]; value: string }[] = []
  const used = new Set<string>()

  const placeholderFor = (hint: string): string => {
    const base = `GITHUB_PAT${hint ? `_${hint}` : ''}`
      .toUpperCase()
      .replace(/[^A-Z0-9_]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/_$/, '')
    let name = base
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`
    used.add(name)
    return `\${${name}}`
  }

  const pat = (github as Record<string, unknown>).pat
  if (secretView(pat).state === 'set') {
    const placeholder = placeholderFor('')
    changes.push({ path: ['github', 'pat'], value: placeholder })
    redactedTokens.push({ path: INSTANCE_PAT_PATH, label: 'instance-wide github.pat', placeholder })
  }

  const tokens = (github as Record<string, unknown>).tokens
  if (Array.isArray(tokens)) {
    tokens.forEach((entry, index) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return
      const record = entry as Record<string, unknown>
      if (secretView(record.pat).state !== 'set') return
      const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)
      const host = str(record.host)
      const owner = str(record.owner)
      const repo = str(record.repo)
      /** What the operator recognises the entry BY — its scope, the way the page renders it. */
      const scope = repo ? (repo.includes('/') ? repo : `${owner}/${repo}`) : (owner ?? host ?? `entry ${index + 1}`)
      const label = host && (owner || repo) ? `${scope} @ ${host}` : scope
      const placeholder = placeholderFor(scope)
      changes.push({ path: ['github', 'tokens', index, 'pat'], value: placeholder })
      redactedTokens.push({ path: `github.tokens.${index}.pat`, label, placeholder })
    })
  }

  if (changes.length === 0) return { text, redactedTokens: [] }
  return { text: applyChanges(text, changes), redactedTokens }
}

/** `rockysurf-backup-2026-09-02-1415.json` — sortable, and says what it is. */
export function backupFilename(at: Date): string {
  const iso = at.toISOString()
  return `rockysurf-backup-${iso.slice(0, 10)}-${iso.slice(11, 16).replace(':', '')}.json`
}

export function createBackup(deps: CreateBackupDeps): BackupArtifact {
  const at = (deps.now ?? (() => new Date()))()

  let configText = ''
  if (deps.configPath) {
    try {
      configText = readFileSync(deps.configPath, 'utf8')
    } catch {
      // No file yet — a fresh install running on defaults. An empty config is that fact.
      configText = ''
    }
  }
  const config = serializeConfigForBackup(configText)

  return deps.db.transaction((tx) => {
    const allTools = tx.select().from(tools).all()
    return {
      artifact: BACKUP_ARTIFACT,
      formatVersion: BACKUP_FORMAT_VERSION,
      ...(deps.appVersion ? { appVersion: deps.appVersion } : {}),
      createdAt: at.toISOString(),
      config,
      users: tx.select().from(users).all(),
      servers: tx.select().from(servers).all(),
      serverRepositories: tx.select().from(serverRepositories).all(),
      /**
       * User-owned rows only. File-backed rows belong to the target's own release — restoring
       * one would fight the boot reconcile, the exact trap ADR-0018's import rule refuses —
       * but the operator's two switches ON them (ADR-0020) are installation state and travel
       * separately below.
       */
      tools: allTools.filter((t) => t.sourceFile === null),
      fileBackedToolState: allTools
        .filter((t) => t.sourceFile !== null)
        .map((t) => ({ toolId: t.id, alwaysInstall: t.alwaysInstall, enabled: t.enabled })),
      packs: tx
        .select()
        .from(packs)
        .all()
        .filter((p) => p.sourceFile === null),
      /**
       * Ciphertext rows, verbatim, ids included — the ids keep `servers.managedKeySecretId`
       * coherent, and the GCM associated data (`keyId kind ownerId`) is what makes a verbatim
       * row decrypt in place beside the operator's own copy of the master key. The signing
       * key is instance identity, not user data: a new instance mints its own.
       */
      secrets: tx.select().from(secrets).where(ne(secrets.kind, 'session-signing-key')).all(),
      /**
       * Spend baselines only. Everything else in `settings` is deliberately absent: the admin
       * password hash stays home (the person restoring is already signed in over there —
       * swapping their password mid-session is a self-lockout, and provision-is-additive says
       * no), and there is nothing else in the table a new installation should inherit.
       */
      settings: tx.select().from(settings).where(like(settings.key, 'jobs.spend.baseline.%')).all(),
    }
  })
}
