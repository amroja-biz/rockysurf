# The vendor SDK decision

**Default to raw REST over `fetch`.** Buy a vendor library for the part where hand-rolling is a
liability, which in practice means auth, and for nothing else.

This is a decision to **measure**, not to recall. The instruction below is a process; running it is
the deliverable, and its output goes in the provider's code as a comment naming the versions
measured.

## The test, in order

### 1. Is the API fetch-shaped?

Documented REST, JSON bodies? **Write the calls by hand.** The relevant cost is not the whole SDK
package — it is the *transport*, the part a generated client would replace, and in this repository
that is one small file per provider.

### 2. Is some part of it not fetch-shaped?

A signed assertion flow, a credential chain with four sources, a token cache with refresh
semantics? **Buy that part and only that part.**

The worked example: GCP's Application Default Credentials span a service-account keyfile, a
`gcloud` user refresh token, the GCE metadata server and workload identity federation. An RS256
assertion flow written by hand buys nothing and costs a class of bug you cannot debug against
somebody else's cloud. `@rockysurf/provider-gcp` took `google-auth-library` for ADC only, and
declined `@google-cloud/compute` — a generated GAPIC client over protobuf — for everything else.
The ratio between the two was roughly 180 to 1 at the time of that decision.

**Do not quote that ratio or those sizes from here.** Their dated home is the "Vendor SDKs" section
of `docs/writing-a-provider.md` (in a checkout), and the instruction there is to re-measure rather
than quote. Measure the packages you are actually considering:

```sh
npm view <package>@<version> dist.unpackedSize
```

Name the **version** in whatever you write, not the date. An npm tarball is immutable once
published, so `@google-cloud/compute@7.1.0 is 110,039,229 bytes` is checkable indefinitely, while
"measured on 2026-08-13" does not say what `latest` pointed at and decays on the next release.

### 3. Whatever you take has to be contained

The principle applies wherever the provider lives: a vendor dependency must not leak out of the
package that needs it. Core is loaded by every installation, including operators who will never call
your cloud, and its cold start is a feature.

**In tree**, this is mechanised. `scripts/check-npx-closure.mjs` walks core's and the CLI's
production closures and asserts that each vendor package is **absent from the first** and **reaches
the second only through its own provider**. Add the dependency to its rules, with fixture tests
proving the check fails in *both* directions when it is broken.

**Out of tree** that script does not exist and there is nothing to edit. The obligation that
survives is the one it encodes: keep the vendor package a dependency of your provider alone, never
a peer or transitive requirement of anything that embeds it.

## The argument that is not about disk

A generated client hides the API, and the hidden parts are where the bugs are. Writing GCE's
transport by hand surfaced two things a generated client would have papered over:

- **HTTP 200 means *accepted*, not *done*.** Every mutating call returns a pending Operation, and
  the failure arrives in the body of a later poll — also HTTP 200.
- **GCE has two separate error vocabularies**, HTTP `reason` strings and SCREAMING_SNAKE Operation
  codes, and both have to be mapped.

Neither would have been visible through a client that returns a promise of a resource. The same
shape recurs: if the cloud has an async operation model, you need to see it, because
`provision()` returning is not the same as the instance existing.

## What to write down

In the provider's auth or transport file, a comment recording:

- which package was taken, at which version, and for exactly which job;
- which was declined, at which version, and the measured sizes behind the comparison;
- the reason, in one sentence.

That comment is safe to inline because it measures **external immutable artifacts**. Do not put a
count of *this repository* in it — line counts, file counts — because those go stale on the next
edit, including the edit that corrects them.
