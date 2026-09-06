# The live dry run

Read this after the unit suite is green and before the package is published or installed. It is
the verification step a personal provider gets instead of a nightly leg: `provision()` against
the real account, with the billable create refused before it leaves the machine, and every
request the provider made logged with the cloud's answer.

## Why a green suite is not enough

The unit suite runs against a fake of the cloud. A fake asserts that the provider does what its
author believed the cloud does; it cannot know when the belief is wrong. The first provider built
with this skill went live with seventy-four green tests and failed on its first create, because a
firewall it wrote named a tag nobody had created — the cloud creates that tag implicitly on an
instance create and not on a firewall create, the documentation did not say so, and the fake
accepted the reference. The research protocol now asks (question 21) and the fake now refuses
(`scaffold.md`, "The fake starts empty"); the dry run is the third guard, the one that hears the
real API say no.

## What it does

[`assets/dry-run-provision.mjs`](../assets/dry-run-provision.mjs) is a zero-dependency Node script
that needs nothing but the built package and the credential in the environment:

1. Replaces `globalThis.fetch` with an interceptor **before importing the package**, so a
   transport that binds `fetch` at import time and one that takes it at construction time both go
   through it. This is why it works for any provider written against `@rockysurf/provider-sdk`
   over `fetch` without a per-provider seam — `createProvider(config)` is one-argument and has
   nowhere to hang a `fetchImpl`, and the test-only constructor option differs by package.
2. Drives the factory the way Rocky Surf's composition root does: `configSchema.parse` with the
   credential taken from `credentialEnv` under `credentialField` when the config leaves it empty
   (nothing stored), `createProvider`, `validateCredentials`, `listOfferings`, `validateSpec`,
   `provision`.
3. Applies a policy to every request. **Reads pass. Writes are refused** — answered locally with
   a 422, never sent — **unless** `METHOD /path` matches an `--allow` pattern, and always when it
   matches a `--refuse` pattern. A pattern broad enough to match a path it does not name is
   rejected as an argument.
4. Prints each request in order with its status, the body of every write, and the cloud's own
   words on every write and every failed read; then a summary of what the cloud accepted (paired
   with the later `DELETE` that reaped it, when the provider did), what it rejected, and what was
   refused; then a verdict and an exit code.

| exit | meaning |
|---|---|
| 0 | `provision()` threw after a refused write and the cloud rejected nothing it saw |
| 1 | `provision()` threw before any write was refused, or the cloud rejected a write — a finding |
| 2 | `provision()` resolved: nothing was refused, so a billable instance may now exist |
| 3 | the script could not run — arguments, package, or a config the schema rejected |

## How to run it

The first run allows nothing. It walks the reads and stops at the first write, which it prints in
full and refuses. That is the run to read carefully: the first write is the object everything
after it references, and its body is the first thing the fake never saw.

```sh
export MYCLOUD_TOKEN=…   # the name the factory declares in credentialEnv
node .agents/skills/add-provider/assets/dry-run-provision.mjs \
  --package ./packages/provider-mycloud \
  --config-json '{"region":"…","sshAllowedCidr":"203.0.113.7/32"}' \
  --refuse 'POST /v2/instances$'
```

Then allow the non-billable objects one collection at a time — the firewall, the key — and run
again, until the chain reaches the instance create. **Name the instance create with `--refuse`
from the first run**, so that reaching it is deliberate and the verdict can say so; the
policy's default already refuses it, but a default is not a decision. Allowing the `DELETE` of a
key the provider makes lets the provider reap it after the refused create, which is what it does
in production and what the summary pairs up.

```sh
node .agents/skills/add-provider/assets/dry-run-provision.mjs \
  --package ./packages/provider-mycloud --config ./dry-run-config.json \
  --allow 'POST /v2/firewalls$' \
  --allow 'POST /v2/account/keys$' --allow 'DELETE /v2/account/keys/[0-9]+$' \
  --refuse 'POST /v2/instances$'
```

`--offering` picks the size (default: the first available one for `--arch`); `--ssh-key` hands
the spec a real public key instead of a throwaway ed25519 one nobody holds the private half of;
`--user-data` a real document instead of a two-line marker. Neither is needed to see the chain.

Match patterns against `METHOD /path` with the host and query stripped — the same string a
`fetch` route-table fake keys on, so the paths in the fake and the patterns here are the same
vocabulary.

## What to do with the result

- **Exit 0, stopped at the write `--refuse` names:** record it in the README's Verified section —
  the date, the region, and the sentence "provision walked to the instance create with the
  create refused". That is what the dry run proves and nothing more; the daggers on the
  capability values stay until a real machine has been made and read back.
- **Exit 0, stopped at a write no `--allow` matched:** allow that collection if it is not
  billable and run again. If you cannot say whether it is billable, do not allow it.
- **The cloud rejected a write (exit 1):** the message it printed is the finding. It is usually
  an existence precondition — the write named an object the chain had not created yet. Fix the
  order in `provision()`, add the precondition to the research answers as a question-21 row, make
  the fake refuse the reference (so the unit suite fails the way the cloud did), and run again.
- **Exit 2:** something was allowed that should not have been. Find the instance in the console
  and terminate it now, before reading anything else.

## What it is not

It does not make a machine, so it proves nothing about first boot, user-data, the host key, the
status vocabulary or the absence grace. It is not a replacement for running a real lifecycle
once and writing down what happened; it is what makes the first real lifecycle likely to get past
its first request.
