# ADR-0009: AWS/Azure prices are served from a hosted feed, with no bundled fallback

## Status

Accepted — 2026-08-25. Amends ADR-0003's "live pricing APIs are out of v0" exclusion for the
price *table* only; the offering catalogues (type shapes, size lists) stay bundled.

## Context

ADR-0003 kept live pricing APIs out of v0, so AWS and Azure prices shipped compiled into the
release artifact (`packages/provider-{aws,azure}/src/prices.generated.ts`) with a `fetchedAt`
stamp for honesty. That made the *data's delivery vehicle a software release*: a cloud provider
changing a price — on their schedule, not ours — created release pressure for a zero-code
change. The nightly `price-drift` job made the cost visible: it could *detect* drift every
morning but the *fix* was a human regenerating tables and shipping, so the alarm was guaranteed
to fire repeatedly and sit red. Issue #99 was the terminal case: the job went red for an AWS
feed republish in which **no bundled price had changed** — only the publication stamp moved.
Issue #100 asked for the structural fix; the owner added the requirement that pricing updates
must never require new versions of Rocky Surf.

## Decision

1. **Prices are published to a hosted feed.** `scripts/refresh-prices.mjs --feed` emits one
   normalized JSON document per provider — identical keys (`schemaVersion`, `provider`,
   `fetchedAt`, `source`, `currency`, `regions`) plus at most one provider-specific provenance
   stamp — under a versioned path. The `price-feed.yml` workflow republishes them to GitHub
   Pages daily (`https://amroja-biz.github.io/rockysurf/prices/v1/`); the cadence is one
   labeled cron line, plus `workflow_dispatch`. The writer is the repository's own Actions
   OIDC token: no new secrets, every update an auditable deployment, no PR step because the
   data is generated, not judged.
2. **Installations read the feed at runtime.** A `pricing` config section (`enabled`,
   `feedUrl`, `refreshHours`) defaults to the hosted feed; compose injects the per-provider
   document URL into the AWS and Azure providers, each of which carries a small feed client
   (3-second timeout, single-flight, TTL cache, 5-minute failure memory). The feed's own
   `fetchedAt` flows into `Price.fetchedAt`, so the UI's "estimate based on prices as of …"
   label keeps telling the truth.
3. **There is no bundled fallback — owner ruling.** When the feed cannot be fetched, every
   offering lists with `hourly: null` (the SDK's "unknown, never free"), the Create page shows
   one aggregate "prices are currently unavailable" notice, and everything else — creates,
   lifecycle, the whole product — keeps working. Reachability reasoning: if an installation
   cannot reach a public GitHub Pages URL, either its internet is gone (and nothing in Rocky
   Surf works anyway) or GitHub is down (rare, visible, self-resolving). A stale bundled table
   pretending to be a price was judged worse than an honest "unavailable".
4. **Catalogues stay bundled; only prices moved.** `AWS_TYPES` and `AZURE_SIZES` remain
   generated-and-bundled because without them there are no offerings and creates would break
   offline — violating "the system should still work". New machine *types* still ride
   releases; new *prices* never do.
5. **A rejected document is a missing document.** The reader validates the whole feed
   (`schemaVersion === 1` exactly, every price a finite positive number) and rejects it
   entirely on any violation. The spend cap consumes these numbers, so a malformed or tampered
   feed must degrade to *unpriced*, never to *wrong*. Schema evolution is a new `/v2/` path,
   never a mutation under old installs' feet.
6. **The `price-drift` job and `--check` are retired.** Drift cannot exist when the nightly
   publisher is the source of truth; a failed publish is `price-feed.yml`'s own red.

## Scope

AWS and Azure only. Hetzner already prices live on the `listOfferings()` call itself (its
bundled table remains a per-location gap-filler). GCP publishes no credential-free feed and
its Billing Catalog prices components that do not reproduce published machine-type prices —
its transcribed table stays as ADR-0003 left it. Serving GCP's transcription *through* the
feed (fixing its delivery, not its provenance) is a possible follow-up, not decided here.

## Considered options

- **Keep bundling, automate the release** (nightly regenerates, commits, tags): rejected —
  turns every price twitch into repository churn and still couples data freshness to operators
  upgrading.
- **Bundled fallback behind the feed**: proposed and explicitly rejected by the owner. The
  fallback's staleness is unbounded, its wrongness silent, and the outage it papers over is
  approximately "GitHub is down".
- **Live vendor APIs from each installation**: rejected in ADR-0003 and still — thousands of
  installs hammering vendor feeds, each paying the parse cost and the failure modes, versus
  one publisher doing it once.

## Consequences

### Positive

- A vendor price change reaches every installation within one publish + one cache TTL — no
  release, no human.
- The #99 failure class is structurally gone; the nightly lost a job that could only cry wolf.
- `prices.generated.ts` shrank by ~11k lines; release diffs stop drowning in price churn.

### Negative

- Cost estimates now depend on a network fetch at runtime; an air-gapped install shows no
  prices at all (`pricing.enabled: false` makes that explicit rather than a timeout).
- During a feed outage the AWS per-region omission semantics degrade: types a region does not
  sell are listed (unpriced) because the region map lives in the feed. Worst case is a
  retryable create error during an outage — accepted over a staleness-prone fallback.
- The feed URL is one more piece of hosted infrastructure tied to this repository's name.

### Risks and mitigations

- **Feed poisoning / corruption** (the spend cap reads these numbers): HTTPS to a repo-owned
  Pages origin, whole-document validation with positive-finite bounds, reject-whole-not-part.
  Signing was considered and deferred — the write path is this repo's Actions identity.
- **Publisher rot** (workflow silently disabled/red): a red `price-feed.yml` run is the
  alarm; installs age gracefully with the honest "as of" stamp, then show unavailable when an
  operator restarts past the cache.
