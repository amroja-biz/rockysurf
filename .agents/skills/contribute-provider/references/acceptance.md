# How this skill is verified

Read this only if you are changing this skill. It is not part of contributing a provider.

Every serious defect in the skills that came before this one was found the same way, and none of
them was visible by re-reading: give a fresh agent the skill and *nothing else*, deny it the rest
of the repository, and have it do the real thing. `add-provider` found eighteen that way
(#409/#410), several of which were wrong instructions rather than gaps. Re-reading a skill tells
you whether it is coherent; a run tells you whether it is true.

## The live run — what the owner runs

**Preconditions.** A fresh agent session, outside any Rocky Surf checkout, given exactly two
things: a copy of `.agents/skills/contribute-provider/` and a provider package that builds and
passes conformance. `packages/provider-digitalocean` copied out of a checkout is the fixture to
use — it is a complete personal provider with zero runtime dependencies, which is the shape the
procedure assumes. The agent gets no other file from this repository, and it must not read one:
the whole point is to find out what the skill fails to say.

The machine needs the prerequisites, and the `gh` account must be one that may **create a release
on the repository holding the fixture** and **fork a public repository**. Those are two different
permissions; a run that only has the second one cannot exercise step 3, which is the step this
skill exists for.

**The instruction to the agent** is one sentence, in the user's voice: *contribute this provider to
the Rocky Surf shop.*

**What a pass looks like.**

1. It builds, runs the conformance suite, packs, and reports each result — including the tarball's
   member list and the empty `dependencies` check, not just "it packed".
2. It asks the user for the one-line description rather than inventing one.
3. It creates the release under a **package-scoped tag** if the fixture sits in a monorepo, and
   downloads the asset back to compare the digest before generating anything.
4. It runs `rockysurf-shop-entry` and puts its output into `providers.json` unedited, bumps
   `generatedAt`, and runs `scripts/validate-providers.mjs` before pushing.
5. `provider listing` is **green on the first push**, with no fixing round. A second push to make
   CI green is a finding about this skill, and what it says is that the local checks are not the
   checks CI runs.
6. It ends with the pull request URL and the sentence about a maintainer reading the code.

**Then close the pull request and delete the branch.** A fixture must never merge into the shop:
`providers.json` is a document real operators read before installing code with full access to their
machine.

**Where to point the pull request.** Base it on the fork's own `main`, so the workflow runs on a
real pull request without proposing a change to the registry. `provider listing` is
`pull_request`-triggered and runs from the branch's own checkout, so a fork-internal pull request
exercises the same validator and the same digest download. Opening one against
`amroja-biz/rockysurf-shop` would work identically and would also put a fixture in front of the
maintainers, which is the one outcome this run must not produce.

**The two negative cases, in the same session.** Both are in the issue's acceptance criteria, and
both must end with **no pull request** and a plain statement of which rule failed:

- **A package with runtime dependencies.** Add one to the fixture's manifest and pack again.
  `rockysurf-shop-entry` refuses it by name. A pass is: the agent stops at step 2 or step 4,
  names the dependency, and says the fix is to bundle it — not that it edits somebody's manifest
  to get past its own check, and not that it hand-writes the entry the generator refused to print.
- **A digest that does not match the release asset.** Attach a different build than the one that
  was hashed. A pass is: the agent stops at step 3, says the release is wrong, and does not adjust
  the `sha256` to match what came down. An agent that "fixes" the mismatch by re-hashing the
  downloaded file has found a serious defect in this skill, because that is the one edit that
  turns a caught error into a shipped one.

**What the agent's report should contain**, in the shape #410's did: every place the skill sent it
wrong, was ambiguous, was missing, or made it guess — with the file and line — and then what the
skill got right that it would otherwise have got wrong. Both halves matter; the second is what
stops the next edit from removing something load-bearing.

## What the last rehearsal covered, and what it did not

**2026-09-06, on the machine that wrote this skill.** The in-tree `packages/provider-digitalocean`
at `@rockysurf/provider-digitalocean` 0.1.0, packed from the worktree after `pnpm install &&
pnpm -r build`, against a local clone of `amroja-biz/rockysurf-shop` at `main` (whose
`providers.json` held zero entries).

Exercised, all as the skill describes:

- `pnpm --filter @rockysurf/provider-digitalocean test` — 80 tests in 2 files, passed.
- `pnpm -C packages/provider-digitalocean pack --pack-destination <scratch>` — wrote
  `rockysurf-provider-digitalocean-0.1.0.tgz`.
- `tar -tzf` — eleven members, all under `package/`, `package/dist/index.js` present and it is
  what `exports` points at.
- `tar -xzOf … package/package.json | grep -A3 '"dependencies"'` — no output.
- `shasum -a 256` — `227011c38b5a4033cfafbf7797692d763ba81c25ef5e6141f90d03705236723d`.
- The entry generated by `node packages/provider-sdk/dist/bin/shop-entry.js <tgz>
  --tarball-url https://github.com/amroja-biz/rockysurf/releases/download/provider-digitalocean-v0.1.0/rockysurf-provider-digitalocean-0.1.0.tgz
  --description "…"` — nine fields, six settings in declared order, seven capabilities, and a
  `sha256` equal to the one `shasum` printed. The tag in that URL is the package-scoped form,
  because the fixture lives in a monorepo.
- The entry appended to the shop clone's `providers.json` with `generatedAt` bumped, then
  `node scripts/validate-providers.mjs providers.json` — `providers.json: 1 provider entry, all
  valid`.
- The branch `providers/digitalocean` and the one-file commit `providers: add digitalocean 0.1.0`,
  committed locally.
- **Negative case 1**, for real: the fixture repacked with `"dependencies": {"undici": "^7.0.0"}`
  added to its manifest. `rockysurf-shop-entry` exited **1** with
  `@rockysurf/provider-digitalocean declares runtime dependencies (undici) and a provider is
  installed by unpacking a tarball, which resolves none of them — bundle them into your dist/ or
  drop them, then pack again`, and printed no entry.
- **Negative case 2**, mechanically: a byte appended to a copy of the tarball, and the digest
  compared — the mismatch was detected and reported as `asset=… listing=…`.

**Not exercised: the release, the fork and the pull request themselves.** No tag was pushed, no
GitHub release was created, no fork was made and no pull request was opened — deliberately: the
owner was mid-flight on the shop's own `providers.json` at the time, and a public release, fork
and pull request are not things to produce as a side effect of writing a skill. So:

- `gh release create` and its asset upload were **not run**. Step 3's digest round trip was
  **simulated** — the "downloaded" file was a copy of the local tarball, so what the rehearsal
  proved is that the comparison is written correctly and catches a mismatch, not that a real
  GitHub release serves the bytes that were hashed.
- `gh repo fork --clone`, the push, `gh pr create` and `gh pr checks --watch` were **not run**.
- The claim that `provider listing` is green on the first push is **read out of
  `.github/workflows/providers-pr.yml` and reproduced locally step for step** — the validator was
  run with the same command CI runs, and the digest comparison was run by hand against the same
  file — rather than observed on a pull request.

That is exactly the gap the live run above closes, and it is why the live run is still owed.
