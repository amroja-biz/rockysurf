# History

Rocky Surf existed for months before this repository did. It was a hosted, AWS-serverless
product — Lambda, API Gateway, DynamoDB, CloudFront, Stripe — and the open-source control plane
in `packages/` is a rewrite of it, not its next version.

The private history of that work is not published (see the note in
[`CONTRIBUTING.md`](../../CONTRIBUTING.md#a-note-on-this-repositorys-history)). What was worth
keeping from it is [`DEVLOG.md`](DEVLOG.md): the development log, written as it happened — every
fight with AWS, every wrong turn, every thing that broke in production and why.

The two phase specifications that used to sit beside it (`SPEC-P1.md`, the dogfooding build, and
`SPEC-P2.md`, the SaaS features) were removed in #339: they specified the hosted product, not
this one, and nothing in this repository was built from them.

## Read it as history, not as documentation

**Nothing here describes the software this repository builds.** The architecture is different,
the deployment model is different, and much of what the log calls "Rocky Surf" no longer
exists. For how the current system works, start at [`docs/adr/llms.txt`](../adr/llms.txt); for
running it, [`docs/self-hosting.md`](../self-hosting.md).

It is kept because the reasoning is reusable and the mistakes were expensive. The AWS lessons in
it were generalized into the AWS learnings library at
https://github.com/jbdamask/aws-learnings-library, which *is* meant to be read for advice; the
copy that used to live at `docs/learnings/aws.md` was removed in #339 as a duplicate of it.

## Scrubbing

This file was scrubbed before being moved here: an AWS account id, an API Gateway id and a
test box's public IP were replaced with documentation-range placeholders
(`111111111111`, `abcd1234ef`, `203.0.113.10`). Resource *names* from the old deployment were
left alone — they are all prefixed `rocky-surf-` and none of them identifies anything reachable.

`gitleaks` runs over the full history on every pull request, which is what keeps this from
having to be done twice.
