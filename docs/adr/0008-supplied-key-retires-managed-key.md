# ADR-0008: A supplied key retires core's own managed key once bootstrap confirms it

## Status

Accepted — 2026-08-24. Amends [ADR-0002](0002-push-bootstrap-default-callback-fallback.md) for
the supplied-key case only; ADR-0002's push/callback topology decisions are unchanged.

## Context

Issue #92: an owner created a box with their own public key and Rocky Surf still authorized its
own generated key alongside it — both worked, both stayed. PR #60 (issue #41) had already fixed
the half of this that was a bug: nothing told the user a second key existed, so the create form
and the Connect panel presented "generate a key" and "use my own" as alternatives when they were
additive. That fix made the double-key state honest. It did not remove it, because ADR-0002 is
explicit about why: push-mode bootstrap installs everything over core's OWN outbound SSH
connection, so a box authorized for the user's key alone is a box core cannot bootstrap, resume,
or recover. PR #60's own words: "the issue's literal ask... is architecturally impossible without
re-architecting bootstrap."

The owner's ruling on #92 does not ask for that re-architecture. It asks a narrower question:
once bootstrap is DONE, why does core's key still need to be there? The two needs are different
in kind — core's key is a tool for the ~1-2 minutes it takes to install software, and after that
minute a running box has no reason to expect another visit from core (see the audit in the
Decision section: nothing in this codebase SSHes into a server that has already reached
`running`). Two standing keys forever is not what "use my own key" means to the person who typed
it, and it costs nothing to retire the tool once the job it did is finished.

## Decision

1. **Core never generates zero keys.** ADR-0002 is unchanged: `provisionServerKeys` still mints
   core's own keypair for every server, still authorizes it first, and push mode still cannot
   start without it. This ADR is about the END of a bootstrap, not its start.

2. **A REQUIRED, LAST plan step removes core's key — only when a key was supplied, only after
   confirming the user's is there.** `resolver.ts` renders a `supplied-key-only` step (phase 7,
   after branding and `rdp`) exactly when the row carries `userSuppliedPublicKey` and the caller
   passes `managedPublicKey` (core's own just-minted public key line). The step's script:
   - guards first: `grep -qxF` the user's exact line in `authorized_keys`, under
     `set -euo pipefail` — if it is not there, the script aborts before touching anything;
   - then removes ONLY core's own line, by exact match (`grep -vxF`) — never a rewrite of the
     whole file. A BYO host's `authorized_keys` may already hold the operator's own pre-existing
     access from before Rocky Surf ever touched the box (`provider-byo/prepare.ts` appends to it
     for exactly this reason); a step that overwrote the file with just the supplied key would
     delete that access. Surgical removal of the one line core knows the exact bytes of, because
     it minted them, is what keeps this safe on every provider, not just the ones core boots
     itself;
   - `check`s independently afterward: the user's line present, core's line gone.

   The step is NOT `optional: true`. If the guard fails, the step fails, and because it is
   required that fails the whole plan — the box stays `failed`/diagnosable with both keys
   intact, the same outcome as any step before it failing. This is deliberate: the guard failing
   at all (the user's key core was told to authorize is not actually there) is not a state worth
   finishing past silently, and it is also what lets core trust "the plan succeeded" as proof the
   removal happened, in both bootstrap topologies, with no second signal to invent.

3. **Once the whole plan succeeds, core retires the private half it minted for itself.**
   `retireManagedUserKey` (`ssh/server-keys.ts`) rewrites the server's stored key material with
   the user half cleared, keeping the host half untouched — `GET /servers/:id/ssh-host-key` still
   needs it, independent of which user key is authorized. `managedSshKeyRetiredAt` on the row
   records that this happened, cheaply, without a secrets-store read on every list call. Two call
   sites trigger it, one per topology, both at the same "row just reached `running`" moment
   push mode's own promotion (`supervisor.ts`) already treats as authoritative, and callback
   mode's status POST handler (`internal-routes.ts`) treats the same way — because core never
   opens SSH for a callback-mode bootstrap and so has no drive of its own to hook the push-mode
   trigger onto.

4. **The SPA drops the `.pem` entirely once it is gone.** `suppliedKeyOnly` on `GET
   /servers/:id` (true only once `managedSshKeyRetiredAt` is set) gates the Connect panel: the
   "Rocky Surf's own key" disclosure, its download button, and every `.pem`-based tunnel/RDP
   command disappear. A box mid-bootstrap or one that shipped before this feature — `suppliedKeyOnly`
   false or absent — keeps exactly the PR #60/#93 behaviour: primary command uses the placeholder
   path, the generated key is demoted into a disclosure, tunnel and RDP commands still use it.
   The download route 404s with a specific reason once retired, distinct from "never had one".

## Considered options

- **Never generate core's key when one is supplied** (the issue's literal, original ask). Rejected
  again, for the same reason PR #60 rejected it: push mode cannot bootstrap without it. Unchanged
  from ADR-0002.
- **Overwrite `authorized_keys` with just the supplied key**, rather than surgically removing
  core's one line. Considered and rejected: it is simpler, but it is wrong for BYO hosts, which
  may carry the operator's own pre-existing keys that this step has no way to distinguish from
  noise. Surgical removal costs one more `grep`/`shellQuote` pair and is safe everywhere.
- **Make the removal step optional**, like `branding`. Considered and rejected: an optional step
  means "ran, but I don't know if it did what it was for" is a state the plan can finish in
  silently, which is exactly the ambiguity Decision 3 needs NOT to have — core needs to know,
  cheaply and without inventing a second signal, whether it is safe to delete its own key.
  Required-and-fails-the-plan turns "did the removal happen" into "did the plan succeed", which
  both topologies already answer.
- **Delete the whole `server-ssh-key` secret row** rather than clearing only the user half.
  Considered and rejected: the row also holds the HOST key material, and `GET
  /servers/:id/ssh-host-key` still legitimately serves that to any client wanting to verify the
  box independent of which user key is authorized. Deleting the row would 409 that route for
  every retired box.

## Consequences

### Positive

- The end state matches what "use my own key" means in plain language: after bootstrap, the
  supplied key is the only one on the box.
- No wire-protocol change. The removal is plan DATA — a bash script the SAME agent already runs —
  so both topologies get it for free from one resolver change, and both topologies' existing
  "did the plan finish" signal is what already answers "is it safe to retire".
- The `/ssh-host-key` route, and anything else that only needs the host identity, is unaffected.

### Negative

- One more plan step on every supplied-key server, adding a few seconds to every such bootstrap.
- A narrow SSH-continuity risk this ADR accepts rather than fully engineers around: if the box
  finishes removing core's key but the connection that would have told core so drops in the gap
  before core observes it, a RETRY of that same bootstrap attempt would need to reconnect with a
  key the box no longer accepts. See the Risks section.

### Risks and mitigations

- **Risk:** the guard finds no matching user-key line (a cloud-init failure, an out-of-band edit)
  and the whole plan fails, even though every OTHER step succeeded. **Mitigation:** accepted by
  design — see Decision 2. The box is fully installed and diagnosable; a human can inspect
  `authorized_keys` and re-push. Both keys remain authorized the whole time, so nothing is lost.
- **Risk:** the SSH connection drops in the narrow window between the box's own removal
  succeeding and core observing the plan's overall completion, and a RETRY of the SAME bootstrap
  attempt then cannot reconnect (core's key was already removed server-side). **Mitigation:** none
  implemented here — this is the same class of risk every bootstrap's final observation already
  carries, made worse in consequence (a permanent auth failure rather than a benign resume) but
  not larger in probability. A future core could re-key on retry or split the removal into a
  two-phase confirm; neither is built, because the window is the single `exec` that checks
  `state.json` for `status: "done"` on an already-open connection, not a network round trip
  core has to newly establish.
- **Risk:** a caller snapshots a plan for a supplied-key row without threading `managedPublicKey`
  through (a test, or a future code path). **Mitigation:** the resolver requires BOTH fields
  before rendering the step; a caller supplying only one gets the pre-this-ADR behaviour — both
  keys, forever — which is safe, not silently wrong (`install-plan.test.ts` pins this).

## Deliberately unresolved

- **Whether BYO hosts should offer "supply your own key" at all**, given the host may already
  have its own operator access predating Rocky Surf. Out of scope here: this ADR makes the
  removal step safe FOR that case (Decision 2's surgical removal) without deciding whether the
  combination should be offered in the UI.

## References

- Issue #92 (this ADR), issue #41 and PR #60 (the visibility fix this ADR builds on), PR #93 (the
  placeholder-path primary command this ADR's SPA changes leave unchanged).
- `packages/core/src/bootstrap/resolver.ts` — `suppliedKeyOnlyScript`, `suppliedKeyOnlyCheck`.
- `packages/core/src/ssh/server-keys.ts` — `retireManagedUserKey`.
- `packages/core/src/bootstrap/supervisor.ts`, `packages/core/src/bootstrap/internal-routes.ts` —
  the two topology-specific trigger points.
- `packages/core/src/servers/routes.ts` — `suppliedKeyOnly` on `present()`.
- `packages/web/src/pages/ServerDetailPage.tsx` — the Connect panel changes.
- `packages/provider-byo/src/prepare.ts` — why the removal is surgical, not a rewrite.

## Related decisions

- ADR-0002 — the push-bootstrap design this amends; unchanged for every server with no supplied
  key, and for the bootstrap window itself on every server.
