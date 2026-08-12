# `@rockysurf/provider-aws`

AWS EC2 compute provider. Plain `RunInstances` against the EC2 API — **no CloudFormation**, so
there is no stack to drift, no template to reconcile, and nothing left behind that Rocky Surf's
own reaper cannot see.

```ts
import aws from '@rockysurf/provider-aws'

const config = aws.configSchema.parse({ region: 'us-east-1' })
const provider = aws.createProvider(config)
```

`createProvider` is synchronous and does no I/O, so core can load the provider, show its identity
and validate its configuration before it holds anything live. Credentials are proven separately
by `validateCredentials()`; they are resolved by the standard AWS SDK credential chain, so
profiles, SSO, instance roles and environment variables all work the way they do everywhere else.

## Prices ship bundled

Unlike Hetzner, AWS publishes its price list through a **separate service**, so reading it live
would add a runtime dependency for a number that changes a few times a year. Prices are therefore
bundled and stamped with `fetchedAt` (`AWS_PRICES_FETCHED_AT`), and AWS quotes per **region** —
outside the regions in the bundled table `hourly` is `null`, which the SDK defines as *unknown,
never free* rather than zero.

Refresh the table with:

```bash
node scripts/refresh-prices.mjs            # AWS is the default; --check asserts it is current
```

## The IAM policy is checked, not described

The permissions this provider needs are written down in
[docs/providers/aws.md](https://github.com/amroja-biz/rockysurf/blob/main/docs/providers/aws.md),
and `scripts/check-iam-policy.mjs` asserts that the documented policy still covers every API call
the source makes — a new call with no matching action fails lint rather than failing in a
stranger's account.

## Dependency weight

This is the only package in the workspace that pulls in `@aws-sdk/*`, and that is enforced:
`scripts/check-npx-closure.mjs` asserts every AWS SDK package in the shipped CLI closure arrives
through this package, so dropping this one provider drops all 17 of them.

## Development

```bash
pnpm --filter @rockysurf/provider-aws test        # vitest, aws-sdk-client-mock
pnpm --filter @rockysurf/provider-aws typecheck
```

SDK conformance assertions come from `@rockysurf/provider-conformance`, a test-only package, so
the SDK's zero-runtime-dependency promise holds.
