---
KEY: vendor-sdk-vs-rest-provider-ruling
DATE: 2026-08-13
UPDATED: 2026-08-21
STATUS: active
SOURCE: bd remember, migrated 2026-08-21
---

# Provider SDK choice: raw REST by default, buy a vendor library only for auth

The default posture for a new compute provider in this project is **raw REST over `fetch`**, with
a vendor library brought in only for the one part where hand-rolling is a genuine liability — in
practice, authentication.

The full reasoning and the currently-measured numbers behind it live in
`docs/writing-a-provider.md`, under "Vendor SDKs" — that's the one dated home for the figures;
this note deliberately doesn't repeat them (see the `measured-numbers-in-prose` memory for why).

**The shape**, which doesn't decay even as the numbers do: a generated cloud-API client (a GAPIC
client, for example) is typically orders of magnitude larger than the auth library alone. This
project rejected `@google-cloud/compute` for GCP but adopted `google-auth-library`, scoped
strictly to Application Default Credentials.

**The test to apply, in order:**

1. Is the cloud's API fetch-shaped — documented REST, JSON bodies? Write those calls by hand. The
   cost that matters isn't the whole vendor package, it's the *transport* — the part a generated
   client would replace — and for a REST API that's usually one small file.
2. Is there a part that genuinely isn't fetch-shaped — a signed-assertion flow, a credential chain
   with several sources, a token cache with refresh semantics? Buy *that part only*. (GCP's ADC,
   for example, covers a service-account keyfile, a `gcloud` user refresh token, the GCE metadata
   server, and workload identity federation — reimplementing an RS256 assertion flow by hand buys
   nothing and adds a class of bug that's hard to debug against someone else's cloud.)
3. Whatever you do take must be **contained**: a vendor dependency must be absent from
   `@rockysurf/core`'s production dependency closure and reachable only through its own provider
   package, with fixture tests proving both directions. Core is loaded by every installation,
   including operators who will never use that cloud.

**Why it matters beyond bundle size:** an SDK-shaped path can also hide the real behavior of the
API. Writing the GCE transport by hand surfaced two things a generated client would have papered
over — an HTTP 200 response means the operation was *accepted*, not *done* (every mutating call
returns a pending Operation, and failure arrives in the body of a later poll, itself returned as
HTTP 200), and GCE has two separate error vocabularies (HTTP `reason` strings versus
SCREAMING_SNAKE Operation codes). Writing the transport by hand is what made both visible.
