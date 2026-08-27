# ADR-0011: A user-supplied script is one more plan step, run last and optional

## Status

Accepted — 2026-08-27. Issue #184. Extends [ADR-0002](0002-push-bootstrap-default-callback-fallback.md)'s
InstallPlan with one more singleton step id without bumping its frozen version, and applies
[ADR-0010](0010-failed-tool-install-terminates-the-box.md)'s rule — only a failed *tool* install
releases a machine — to a step ADR-0010 did not anticipate.

## Context

Everything that runs on a Rocky Surf box during setup is written by somebody else: a pack author
wrote the install scripts, and the operator decided which packs exist. The person who actually
clicks Create can choose a pack, a machine and a list of repositories, and then has to wait for
the box, SSH in, and do their own last mile by hand — dotfiles, a language runtime the pack does
not carry, an `npm ci`, a service to start.

Every cloud already has the primitive for this. EC2 calls it
[user data](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/user-data.html): a script handed
over at create time, run once at first boot. The owner's request (issue #184) was that, "but give
more freedom of what process runs it, i.e. root or rocky" — because EC2's version is root-only,
and on a box whose entire purpose is an unprivileged `rocky` account with a toolchain in its home
directory, root-only is the wrong default. A file written by root in `rocky`'s home is a file
`rocky` cannot edit.

Three facts about this codebase shaped the answer.

1. **The install plan already is this feature, minus a field.** `bootstrap/resolver.ts` renders a
   flat list of steps, each with `run`, `runAs: 'root' | 'rocky'`, `optional` and
   `timeoutSeconds`, and `agent.sh` already dispatches privilege with `sudo -u`, already
   establishes `$HOME` for either user, and already forwards `secrets.env` to unprivileged steps.
   Nothing on the box needed to change at all.
2. **The plan's wire format is frozen at version 1** (`bootstrap/plan.ts`, ADR-0002), and both
   sides reject anything else. So the question was whether a user script needs a new *field*.
3. **`bootstrap/failure.ts` keys the terminate rule on the step's phase**, and `stepPhase()`
   derives the phase from the step id — anything that is not `tool:`, `repo:` or `tool-setup:` is
   `finishing`, which is kept, not terminated.

## Decision

1. **A user script is one more plan step, `user-script`, not a new mechanism.** It is added to
   `SINGLETON_STEP_IDS` beside `branding`, `rdp` and `supplied-key-only`. **`PLAN_VERSION` stays
   1**: version 1 freezes the set of FIELDS a step and a plan may carry, and no field changed. An
   agent that has never heard of the id still executes the step correctly through
   `run`/`runAs`/`optional`/`timeoutSeconds`, which is the property the freeze exists to protect;
   a new field would not have that property and would have bumped the version.

2. **It runs as phase 5: after everything the pack contributes, before everything core finishes
   with.** After phases 1-4 (base tools, pack tools, repository clones, setup scripts) because
   that is the box the user wrote their script against — the pack's toolchain is installed and
   `$REPOS` is checked out. Before phases 6-8 (branding, the desktop password, retiring core's own
   key) for two reasons: ADR-0008 requires the key retirement to be *last* after everything that
   needs SSH, and all three of those steps report `ready`, which in callback mode promotes the row
   out of `provisioning` — a `running_user_script` report arriving after one of them would be
   refused by `acceptsProgressReports` and vanish.

3. **A failed user script is a warning on a running box, not a failed bootstrap.** The step
   carries `optional: true`. ADR-0010 released a machine for a failed tool install because a
   half-installed toolchain is worthless and billing; this is the opposite case. Every tool is
   installed, every repository is cloned, the machine is exactly what was ordered, and the only
   thing that failed is text the user typed — so failing the plan would confiscate the box they
   need in order to fix it. The whole step log is captured as a warning, the same treatment a
   repository that would not clone gets. `stepPhase('user-script')` is `finishing` besides, so
   even a required version could never have terminated the instance.

4. **It gets the setup-script preamble and nothing else.** `$REPOS` plus the clone step's git
   credential environment (issue #142), because a user script does exactly the kind of
   per-repository work a setup script does. Deliberately **not** prefixed with `set -euo
   pipefail`, which every *pack* script is told to open with: this script is the user's, forcing
   `-e` would change the meaning of a script that already works elsewhere, and EC2 imposes nothing
   on user data either. The step's exit status is the script's own, and the docs say to write
   `set -e` yourself. Timeout: 1800 seconds, the same as a tool install.

5. **Two columns on `servers`, in plain text, and nothing in the secrets store.** `user_script`
   and `user_script_run_as`. The script is rendered into `installPlan`, which is snapshotted on
   the same row and pushed to the box as `plan.json` in the clear — encrypting one copy while the
   other sits beside it would buy a custody exemption (`secrets/route-inventory.test.ts`) for
   nothing. The form, the CLI and `docs/self-hosting.md` all say plainly that this is not where
   credentials go.

6. **Bounded at 16 KiB**, quoted from EC2 rather than invented: it is a number a user may already
   know, the feature is deliberately that idea, and a bound is needed because this text is copied
   into a plan, a row and an SSH push. Enforced in the create route (so every front end is covered)
   and again in the CLI (so a 40 MB file named by mistake is refused by the sentence that names the
   file).

7. **Not returned by any route.** `present()` renders what a screen shows and nothing shows this
   yet; a copy of a user's script in a JSON payload is exposure bought for nothing. The row and the
   plan snapshot are the record. A future "what did this box run" panel adds the field then.

8. **`running_user_script` joins the provisioning vocabulary**, between `cloning_repos` and
   `ready`, and the feed labels it **"Running your script"**. A word of its own rather than a
   reuse of `tools_installed`, because this is the one step in a plan core did not write: a person
   watching needs to know that a wait here is theirs to explain, and that the thing to debug is
   their own text.

9. **Three surfaces, one rule.** The create form (a textarea and a two-option run-as choice, on
   the form for every pack exactly like Repositories since issue #178), `POST /api/v1/servers`
   (`userScript`, `userScriptRunAs`), and `rockysurf create --user-script <file>
   [--user-script-as root|rocky]`. The CLI takes a **path**, never the script itself: an argument
   would put a whole program in `argv`, where every `ps` on the machine can read it, and
   `aws ec2 run-instances --user-data file://…` takes a file for the same reason. An empty or
   whitespace-only script means *no script*, and a `runAs` with nothing to run is a 400 rather
   than a silent create.

## Considered options

**Where the step runs.**

- *Last of all, after `supplied-key-only`* — rejected. ADR-0008 states that step is last after
  everything that needs SSH, and quietly demoting it would be an amendment to a decision this
  change has no business amending.
- *After branding and the desktop password, before key retirement* — considered, and it has a real
  argument: the box is then as finished as it will ever be, so a script that configures the
  desktop sees the final state. Rejected because those steps report `ready`, and in callback mode
  the first `ready` promotes the row and closes it to further progress reports — the user's own
  step would then be the one step with no feed entry. The cost of the choice made instead is
  stated honestly below.
- *Interleaved, as a pack-declared hook* — not evaluated seriously. Packs are data (ADR-0004) and
  this field exists for every pack; a hook would make the user's own instructions something a pack
  author could decline to support.

**Required or optional on failure.**

- *Required* — rejected, per Decision 3. It would have produced a `failed` row on a box whose every
  ordered component works, and the failure would be in the one place the user can actually fix.
- *Required, with `bootstrap.onFailure` deciding* — rejected as a second meaning for a knob that
  today says one thing ("what happens to a machine whose TOOLS did not install").

**Storage.**

- *In the encrypted secrets store* — rejected per Decision 5: the plan snapshot holds the same
  bytes in the clear, so it would be custody theatre.
- *No column, threaded through `snapshotInstallPlan`'s options* — rejected. The row is the record
  of what the user asked for (`repositories`, `userSuppliedPublicKey` are both there), and a
  re-render months later must produce the same plan without replaying the create request.

**A new provisioning word.**

- *Reuse `tools_installed`* — rejected. It would have shown "Tools installed" for the whole of a
  user's script, which is both wrong and the least helpful moment to be vague.

## Consequences

### Positive

- The last mile of setting up a box is expressible at create time, on every surface, for every
  pack, without a pack author being involved.
- `root` *or* `rocky` — the freedom the issue asked for — costs nothing, because `agent.sh`
  already dispatches privilege and establishes `$HOME` for either.
- A failed script leaves a usable box and a complete log, which is the state in which a script is
  actually fixable.
- No change at all to `agent.sh`, to the plan version, or to either bootstrap topology.

### Negative

- **The script runs before the login banner and the desktop password.** A script that writes
  `/etc/motd` will be overwritten by the branding step, and one that wanted the `rocky` account's
  desktop password already set will not find it. Both are stated in `docs/self-hosting.md`. The
  callback-mode ordering above is why, and it is the honest cost of the placement.
- **Plain text, on the row and on the wire.** A user who ignores three warnings and pastes a token
  into the field has put it in the database and on the box. Mitigated by saying so on the form
  itself, not only in the docs.
- **One more word in a vocabulary six clients mirror by hand** (`schema.ts`, `lib/api.ts`,
  `lib/events.ts`, `lib/format.ts`, the feed's labels). `ServerDetailPage.wiring.test.tsx` reads
  core's list as text and fails the build when they drift, which is what caught the mirror during
  this change.

### Risks and mitigations

- **Risk:** a user script that hangs holds a box in `provisioning` and bills for it.
  **Mitigation:** the same 1800-second `timeout(1)` a tool install gets, after which the step is
  killed and recorded as a warning and the box comes up.
- **Risk:** a root script breaks the box badly enough that the remaining plan steps fail.
  **Mitigation:** none beyond `runAs: rocky` being the default and the form saying what root
  means. This is the same trust EC2 user data asks for, and refusing it would be refusing the
  feature.
- **Risk:** the 16 KiB bound pushes someone into base64-ing a tarball into the field.
  **Mitigation:** the docs name the intended alternative — put it in a repository the box clones,
  and have the script run that.

## Deliberately unresolved

- **Showing the script back to its owner.** Decision 7 keeps it off the API. If a "what did this
  box run" panel lands, the field goes on `present()` then, with the exposure question answered by
  what the panel actually renders.
- **Re-running it on an existing server.** Out of scope: this is a create-time input, and a
  "run this on a running box" feature is a different thing with a different threat model.
- **The MCP `create_server` tool** does not expose it. It can be added without any change here;
  nothing in the decision is surface-specific.

## References

- Issue #184, and [EC2 user data](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/user-data.html)
  as the model it deliberately mimics.
- `packages/core/src/bootstrap/resolver.ts` (phase 5), `bootstrap/plan.ts` (`SINGLETON_STEP_IDS`),
  `bootstrap/install-plan.ts`, `bootstrap/failure-report.ts` (`stepLabel`), `db/schema.ts`
  (`PROVISIONING_STEPS`, the two columns), `servers/routes.ts` (validation),
  `servers/lifecycle.ts`, `packages/web/src/pages/CreateServerPage.tsx`,
  `packages/rockysurf/src/cli/commands.ts` (`readUserScript`).
- `docs/bootstrap-contract.md` § Step ordering and § Failure semantics;
  `docs/self-hosting.md` § Your own startup script on a new server.

## Related decisions

- [ADR-0002](0002-push-bootstrap-default-callback-fallback.md) — depends on; adds a step id to its
  frozen plan without changing the format it froze.
- [ADR-0010](0010-failed-tool-install-terminates-the-box.md) — depends on; applies its rule to a
  step it did not anticipate, and its "only a tool install releases the machine" is what makes
  Decision 3 consistent rather than an exception.
- [ADR-0008](0008-supplied-key-retires-managed-key.md) — complements; its "last after everything
  that needs SSH" is why phase 5 is not phase 9.
- [ADR-0004](0004-packs-as-pr-able-yaml.md) — complements; this is the user's own script and is
  deliberately outside the pack format it froze.
