# ADR-0022: A tool can be imported from a URL, now that tools carry provenance

## Status

Accepted — 2026-09-02. Issue #299. Supersedes the "no `{ url }` arm" clause of
[ADR-0018](0018-a-tool-file-is-a-sibling-of-a-pack-file.md); the rest of ADR-0018 stands.

## Context

[ADR-0018](0018-a-tool-file-is-a-sibling-of-a-pack-file.md) shipped tool files and a paste/upload
import at `POST /api/v1/admin/tools/import`, and deliberately withheld the `{ url }` arm the pack
import has. Its reasoning was specific and correct at the time: a pack fetched from a URL records
where it came from — `registrySource`, `registryUrl`, `registrySha256`, `registryTrust` — because
[issue #88](https://github.com/amroja-biz/rockysurf/issues/88) established that "where did this
shell that runs as root on my boxes come from?" is the question an operator needs answered. The
`tools` table had no such columns, so a URL import would install root-privileged shell while being
structurally unable to say anything true about its origin — [issue #88](https://github.com/amroja-biz/rockysurf/issues/88)'s
problem restored at a finer granularity. ADR-0018 named the fix — "adding the columns is its own
change" — and left it for later. This is that change.

The withholding was never a judgement that a URL arm is wrong for tools. It was a judgement that
shipping the arm *without the provenance columns* is wrong. Once the columns exist, the arm is the
same safe operation the pack import already is.

## Decision

**1. The `tools` table gains provenance columns, the tool equivalents of the pack registry
columns:** `registrySource`, `registryUrl`, `registrySha256`, `registryTrust`,
`registryInstalledAt` (migration `0019`). They are **separate columns and deliberately not
`sourceFile`** — the boot reconcile (`syncPacksToDb`) deletes every row whose non-null
`sourceFile` names a file it cannot find, so recording a URL there would make an imported tool
vanish on the next restart. This is the exact [ADR-0006](0006-pack-registry-split-horizon.md) trap
the pack columns were shaped to dodge, now dodged the same way for tools.

**2. `POST /api/v1/admin/tools/import` accepts `{ url }`,** fetched server-side through the
existing SSRF guard `fetchPublicText` — the same guard, and the same test injection seam, the pack
import uses. Never a raw fetch: this is a control plane holding cloud credentials fetching an
operator-supplied address, so the scheme check, the private/link-local/metadata screening of every
resolved address, the hop-by-hop redirect re-validation and the body cap all apply.

**3. A URL import records provenance; a paste or upload records nothing.** `source` is the fixed
sentence `URL_IMPORT_SOURCE` (`'a URL import'`), `url` is the address, `sha256` is the digest of
the exact bytes fetched, `installedAt` is now. Every tool in a multi-tool file shares one record —
the URL is where the *file* came from and the digest is of the whole file. A pasted or uploaded
file records nothing, because there is nothing true to record: the bytes came from the admin's own
machine and this installation cannot say where they had been before that.

**4. `trust` is snapshotted as `unverified`, never borrowed.** There is no tool registry
(ADR-0018, [issue #289](https://github.com/amroja-biz/rockysurf/issues/289)), so a one-off URL
import has no operator-written trust label anywhere to borrow — and `official` is unreachable from
here as it is from every other import path. This matches the pack URL import exactly.

**5. The Tools page shows the recorded origin,** the way the packs page does: a URL-imported row
reads "imported from `<url>`" rather than "database". The URL is the answer an operator needs, so
it is shown in full.

**6. The refusals and the strict schema are unchanged.** A pack file pasted into the tool import,
an id a file-backed tool owns, and any unknown key are all still refused loudly, on both arms.

## Considered options

**Give tool provenance the pack registry's shelf concept.** Rejected. Packs have shelves because a
registry lists many; there is no tool registry and [issue #289](https://github.com/amroja-biz/rockysurf/issues/289)
explicitly did not create one. A tool only ever arrives from a one-off URL, so `registrySource` is
always the one fixed sentence and the URL beside it is the whole of what was recorded. The columns
are named for the pack ones so the two provenance surfaces read the same, not because a tool ever
has a named source of its own.

**A new `toolProvenance` column set with tool-specific names.** Rejected as needless divergence.
The pack columns already mean exactly the right things; reusing their names keeps the repository
layer, the view models and the SPA reading one vocabulary across both surfaces, and keeps the two
import paths from drifting.

**Keep withholding the arm and let the file travel by hand.** Rejected — this ADR is the decision
ADR-0018 deferred, and the only thing that was blocking it (no columns) is now removed.

## Consequences

### Positive

- The #88 question — "where did this root-running shell come from?" — now has a true answer at
  tool granularity, not just pack granularity.
- The two import paths converge: one guard, one provenance shape, one set of refusals, so they
  cannot drift into disagreeing about what an import is.

### Negative

- A second server-side fetch surface exists, so the SSRF guard now protects two routes instead of
  one. Mitigated by both going through the *same* `fetchPublicText`, not a copy.

### Risks and mitigations

- **Risk:** a future edit path re-upserts a URL-imported tool and silently erases its provenance.
  **Mitigation:** `UpsertToolInput.registry` treats *absent* as "leave it alone" (the same
  contract `alwaysInstall` and the pack `registry` field carry), so the boot reconcile and the
  admin PUT — both of which pass no `registry` — never touch it. A test pins that a pasted
  re-import clears it and a URL import stamps it.
- **Risk:** provenance leaks into an exported tool file, making one installation's fact about its
  own disk travel. **Mitigation:** `renderToolFile` carries only `toolSchema` fields, and the
  registry columns are not among them — the same reason `sourceFile` does not travel.

## References

- [ADR-0018](0018-a-tool-file-is-a-sibling-of-a-pack-file.md) — the decision this supersedes in
  part.
- [ADR-0006](0006-pack-registry-split-horizon.md) — why provenance is its own columns and never
  `sourceFile`, and why a URL import is `unverified`.
- Issue #299 (this change); issue #289 (tool files); issue #88 (pack URL provenance).
- `packages/core/src/db/schema.ts` (columns), `packages/core/drizzle/0019_useful_colleen_wing.sql`
  (migration), `packages/core/src/packs/routes.ts` (the arm), `packages/web/src/pages/AdminToolsPage.tsx`
  (the affordance and the origin cell).

## Related decisions

- ADR-0018 — supersedes its "no `{ url }` arm" clause; extends the rest.
- ADR-0006 — depends on its provenance-columns-not-`sourceFile` rule and its `unverified` snapshot.
