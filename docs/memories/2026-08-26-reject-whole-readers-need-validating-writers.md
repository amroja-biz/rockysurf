---
KEY: reject-whole-readers-need-validating-writers
DATE: 2026-08-26
UPDATED: 2026-08-26
STATUS: active
SOURCE: issue #140 (prices unavailable for Azure), and the published `prices/v1/azure.json` of 2026-08-26
---

# A reject-whole reader turns one bad row into a total outage, so the writer must validate too

Every provider's price-feed reader (`parsePriceFeedDoc` in `packages/provider-*/src/feed.ts`)
rejects a fetched document **whole** if any single price is not a finite number greater than
zero. That is deliberate and correct — the spend cap consumes these numbers, so a corrupted or
tampered feed must degrade to *unpriced*, never to *wrong* (ADR-0009, decision 5).

**The rule has a consequence nobody had drawn.** For a reject-whole reader, the blast radius of
one bad row is not one row — it is the entire document, every region, every installation. So an
unvalidated writer can take a whole cloud's prices offline with a single entry, and stay green
while doing it.

That is what issue #140 was. Azure publishes retail meters for VM families it has announced but
is not yet billing for, at `retailPrice: 0`. On 2026-08-26 the thirty-size Mbv4 series did this
in `eastus` and `germanywestcentral`. Each size resolved cleanly to exactly one pay-as-you-go
Linux meter, so `refresh-prices.mjs` — whose ambiguity rule only ever asked *how many* meters,
never *whether the meter had a number* — wrote sixty zeros into `azure.json`. Every install's
reader then threw the whole document away and listed all fourteen regions unpriced. Every part
of the system behaved exactly as specified. `price-feed.yml` was green all week.

Rules that follow:

- **The writer applies the reader's own rule before publishing.** `unreadableFeedEntries()` in
  `scripts/refresh-prices.mjs` is a deliberate transcription of `parsePriceFeedDoc`'s price
  check, run over every document `--feed` is about to emit; a violation fails the run. A red
  publish deploys nothing and leaves the last good document being served, which beats a green
  publish of a document no reader accepts.
- **Zero is not a price.** A vendor row with no number means the size is excluded and named in
  the run log, on the same "report, don't guess" rule that already excluded ambiguous sizes.
  Absent beats present-at-zero, and rounding to six decimals is checked for the same reason.
- **Symptom-to-cause note for next time.** "Prices unavailable" for one cloud in *every* region,
  while the other clouds are fine and the publisher is green, means the document is being
  rejected — not that the fetch failed. Diagnose it by running the shipped
  `parsePriceFeedDoc` over the live URL, which takes a minute and is unambiguous, rather than by
  reading the provider wiring, which was correct throughout.
- The general form is not specific to prices: **wherever a consumer validates all-or-nothing,
  the producer must validate too, with the same predicate.** Look for this shape anywhere else a
  document crosses a trust boundary whole.
