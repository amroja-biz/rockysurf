# History

Rocky Surf existed for months before this repository did. It was a hosted, AWS-serverless
product — Lambda, API Gateway, DynamoDB, CloudFront, Stripe — and the open-source control plane
in `packages/` is a rewrite of it, not its next version.

The private history of that work is not published (see the note in
[`CONTRIBUTING.md`](../../CONTRIBUTING.md#a-note-on-this-repositorys-history)). These files are
what was worth keeping from it.

| File | What it is |
|---|---|
| [`DEVLOG.md`](DEVLOG.md) | The development log, written as it happened. Every fight with AWS, every wrong turn, every thing that broke in production and why. |
| [`SPEC-P1.md`](SPEC-P1.md) | Phase 1 specification — the dogfooding build. |
| [`SPEC-P2.md`](SPEC-P2.md) | Phase 2 specification — the SaaS features. |

## Read them as history, not as documentation

**Nothing here describes the software this repository builds.** The architecture is different,
the deployment model is different, and much of what these files call "Rocky Surf" no longer
exists. For how the current system works, start at [`docs/adr/llms.txt`](../adr/llms.txt); for
running it, [`docs/self-hosting.md`](../self-hosting.md).

They are kept because the reasoning is reusable and the mistakes were expensive. The AWS lessons
in particular were pulled out into [`docs/learnings/aws.md`](../learnings/aws.md), which *is*
meant to be read for advice.

## Scrubbing

These files were scrubbed before being moved here: an AWS account id, an API Gateway id and a
test box's public IP were replaced with documentation-range placeholders
(`111111111111`, `abcd1234ef`, `203.0.113.10`). Resource *names* from the old deployment were
left alone — they are all prefixed `rocky-surf-` and none of them identifies anything reachable.

`gitleaks` runs over the full history on every pull request, which is what keeps this from
having to be done twice.
