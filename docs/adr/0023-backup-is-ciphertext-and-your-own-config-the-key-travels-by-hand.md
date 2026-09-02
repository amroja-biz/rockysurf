# ADR-0023: A backup is ciphertext plus your own config; the master key and cleartext tokens travel by your hand

## Status

Accepted — 2026-09-02. Issue #331. The cleartext-token clause is an owner ruling made on this
issue: a backup never carries a literal GitHub token, with no verbatim option and no toggle.

## Context

Rocky Surf runs on one person's laptop (ADR-0001), and a person who gets a new laptop wants to
pick up where they left off. `docs/self-hosting.md` already documented the manual answer — stop
the process, tar the data directory — but that path requires stopping the process (the WAL
caveat), finding the right files, and produces an archive that contains `secret.key` beside the
ciphertext it opens, which the doc itself says to treat like the key. Issue #331 asks for a
first-class mechanism on the Settings page: produce a **Backup** artifact, consume it with
**Restore**. Where the operator stores the artifact (GitHub, Drive) is explicitly out of scope,
which is precisely what makes its contents a security decision: the artifact is *built to
travel*.

The state of an installation is (1) the config file — which may hold literal GitHub PATs, a
choice ADR-0007 made deliberately — and (2) the data directory: the SQLite database (servers,
users, packs, tools, encrypted `secrets` rows, settings) and the master key. Cloud credentials
are not state; Rocky Surf stores none, unconditionally (#280). The words are **Backup** and
**Restore** because export/import already mean something else here (ADR-0018: handing a pack or
tool definition to *someone else's* installation).

## Decision

1. **The artifact is one JSON document of logical rows, stamped `formatVersion`.** Never SQL,
   never the database file. A higher version than the reader knows is refused with "made by a
   newer Rocky Surf — upgrade first"; a lower one runs through an upcaster chain
   (`migrateBackup`, `packages/core/src/backup/format.ts`) — empty at version 1, but the seam
   is the deliverable. Restore additionally picks columns by name from the live table
   definitions, so an old artifact lands on a new schema with defaults for what it never knew.
2. **Stored secrets travel verbatim as ciphertext, and the master key never travels.** The
   `secrets` rows go in exactly as the table holds them (the `session-signing-key` excepted —
   instance identity, not user data). The key crosses machines only by the operator's own hand
   (`secret.key` / `ROCKYSURF_SECRET_KEY`) — the story the first-boot banner has always told.
   With the key in place on the new machine, restored rows decrypt in place, because ids are
   preserved and the GCM associated data (`keyId kind ownerId`) still matches. Without it,
   restore still succeeds and reports how many secrets are sealed until the key arrives —
   decryption is lazy at point of use, so the key arriving later heals them with no second
   restore.
3. **The config file travels with every literal GitHub token redacted** (owner ruling). Each
   literal `github.pat` / `github.tokens[].pat` becomes a `${VAR}` placeholder — legal to
   restore, because a reference to an unset variable is a warning, not an error
   (rockysurf-1z5q) — and the token's *identity* (label, placeholder, path) travels in
   `config.redactedTokens`, so Restore lists exactly what to re-enter by name. A value that is
   already a whole `${VAR}` reference travels as written. The redaction lives in one function,
   `serializeConfigForBackup`. The Connect-GitHub OAuth token is unaffected: it is a `secrets`
   row and travels as ciphertext under clause 2.
4. **Restore is a merge: id-preserving, skip-existing, refuse-with-reason — never replace.**
   All database writes happen in one transaction; the config file is a separate later step, so
   a refusal there (an unset `${VAR}`, an invalid file) cannot half-apply anything, and
   re-running the same restore after fixing the environment is a no-op plus the missing piece.
   A pack or tool id that is file-backed on the target is refused (ADR-0018's reconcile
   argument); the per-installation switches on shipped tools (`alwaysInstall`, `enabled`,
   ADR-0020) travel separately and are applied to tools the target actually ships.
5. **User identity is reconciled by `githubId`, and the one user-owned secret kind is
   re-sealed.** The restorer already exists on the target (the local admin is
   `githubId: 'local:admin'` everywhere) and `users` is unique on githubId AND githubUsername,
   so backup users are matched by githubId, inserted only when genuinely absent, and refused
   (with their rows) when their username belongs to a different identity. Server rows are
   remapped to the matched ids. `github-token` rows are AAD-bound to the owner id, so a
   remapped user's token is re-sealed under the new id — inside `backup/restore.ts`, never a
   route file, so `secrets/route-inventory.test.ts` keeps its single exemption. A master key
   that is absent and one that is wrong are the same failure: drop the row, say "reconnect
   GitHub".
6. **The scope line: records, not machines.** Nothing is created, contacted or terminated in
   any cloud. Restored server rows are control-plane records; the existing reconciler and
   `lifecycle.sync` (flag, never auto-terminate) then report any machine that no longer
   answers, exactly as after a closed laptop. BYO trust-on-first-use records travel on the row
   (`hostKeyFingerprint`). The four pinned config paths (`server.port`, `server.host`,
   `server.dataDir`, `auth.mode` — ADR-0017's list) are kept at the *target's* values;
   `server.dataDir` above all, because writing the old machine's path would point the next
   boot at an empty database and "lose" the restore. `mcp.scopes` is deliberately not pinned —
   it travels and waits for a restart like any save.
7. **Never in the artifact:** the master key, any plaintext secret, sessions, the
   `session-signing-key` (also refused on the way in), the admin password hash (the restorer
   is already signed in with a password they know — importing an old hash mid-session is a
   self-lockout; the additive-provision ruling points the same way), the `events` log
   (forensic, bulky, its subjects get reconciled; an opt-in is open to a later formatVersion),
   and file-backed pack/tool rows (the target's release provides them).
8. **Spend history stays honest across the move.** The tracker primes the current month's
   baseline at boot (`jobs/limits.ts`), so restored lifetime costs would otherwise read as
   this month's spend and could trip the cap. Restore adjusts the current month's baseline:
   a same-month backup contributes its own baseline row; an older backup contributes the
   restored rows' full totals. Applied only when servers were actually inserted, so a re-run
   cannot adjust twice. Month bucketing takes the injectable clock (#284's rule).
9. **The manual tar coexists.** It remains the full-fidelity snapshot (events, sessions, the
   key itself) and the pre-upgrade advice; the artifact is the curated migration document. The
   doc and the Help page say which is which, and both lose the stale claim that a backup holds
   "provider credentials" (#280 made that false).

## Considered options

- **Passphrase-encrypted full artifact** (wrap the master key and everything else under a
  user-chosen passphrase): rejected. It adds a KDF and a passphrase-quality story to defend, it
  mints a second copy of the master key that then lives wherever the artifact lives, and it
  buys nothing the existing carry-the-key story does not already provide for the migration
  case.
- **No secret material at all**: rejected. Ciphertext without its key is already worthless to
  whoever finds the artifact, so excluding it costs continuity (every managed server's key,
  the Connect-GitHub token) and protects nobody.
- **Config verbatim, cleartext PATs included, with a warning**: seriously argued — the manual
  tar already sweeps the config in, and ADR-0007 made literal PATs the file's property — and
  rejected by the owner: a document built to travel never carries a cleartext token, and the
  re-enter list makes the cost a few pastes.
- **A redact-or-not toggle**: rejected by the same ruling; one behavior, no decision to get
  wrong.
- **Replace semantics on restore**: rejected — a merge with reasons is idempotent, which the
  config-refusal path depends on, and cannot clobber an installation that was not as empty as
  its operator remembered.
- **File-level backup from the Settings page** (tar the directory over HTTP): rejected — it
  cannot be taken safely from the running process the button lives in (the WAL caveat), and
  it would put `secret.key` in a downloadable artifact.

## Consequences

### Positive

- A one-click migration path whose artifact is safe to store anywhere modulo the operator's
  own config prose; the two secrets-bearing decisions (key, tokens) both fail safe.
- No new custody exemption, no new crypto, no schema migration; the format-version seam and
  the column-name mapping absorb schema drift in both directions that matter.
- The restore report is a complete account: restored / already-here / refused per domain, the
  secrets' readability under the target's key, the exact tokens to re-enter, and what the
  config step did.

### Negative

- Two more steps than "restore everything": the operator carries the key and re-pastes their
  literal tokens. The report names both.
- The `events` log does not travel, so a restored server's page has its snapshot columns
  (install plan, bootstrap report) but not its journal.
- A same-month restore into a *non-empty* installation that skips some servers undercounts the
  restored subset's month-to-date (the whole backup baseline is applied); the tracker clamps
  at zero and the supported path — restore into a fresh install — inserts everything.

### Risks and mitigations

- **An artifact is operator-supplied input to a privileged writer.** Admin-only routes, a
  32 MB body cap, magic + version + zod validation before any write, and one transaction so a
  failure means nothing was applied.
- **A hand-edited artifact could try to smuggle state** — a `session-signing-key` row is
  refused explicitly; file-backed ids are refused; `bootstrap`-style installation fields
  travel only through the two whitelisted switches.
- **The operator forgets the key.** The Backup card says so before the download, the restore
  report counts the sealed rows, and the rows heal in place when the key arrives.
