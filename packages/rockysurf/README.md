# rockysurf

Self-hosted, persistent cloud dev boxes with your coding agents already installed. One box, on
your cloud, under your budget cap.

```bash
npx rockysurf
```

First boot prints an admin password once, opens the web UI, and walks you through adding a
cloud. With no cloud configured it still comes up with an in-memory provider, so you can create
a server, watch it boot and terminate it before deciding whether to paste a token.

## What this package is

**The composition root.** It is the only package in the repository allowed to import both the
control plane (`@rockysurf/core`) and the concrete compute providers, because somebody has to
build the provider registry and core is deliberately forbidden from doing it:

- core may import `@rockysurf/provider-sdk` and nothing else, which is what keeps the provider
  interface honest while it has no out-of-tree consumers;
- it also keeps a cloud vendor's SDK out of core's dependency tree, which is what makes an
  `npx` cold start fast.

`scripts/check-core-deps.mjs` enforces both rules, and enforces that this package exists and
reaches both sides — otherwise deleting it would leave the lint green and `npx rockysurf`
booting with no cloud at all.

It also carries the `rockysurf` binary and the npm name; `@rockysurf/core` stays private.

## How a provider gets configured

Credentials resolve **config file first, then the encrypted secrets store**:

| where | who writes it | notes |
|---|---|---|
| `rockysurf.config.yaml` | you, in an editor | wins, because it is the copy you can diff and roll back |
| encrypted secrets store | the first-run wizard | what a token pasted in the UI becomes |
| provider's own chain | AWS | `AWS_PROFILE` and friends; never stored by Rocky Surf |

**A credential pasted in the wizard takes effect at the next restart.** Providers are
constructed at boot, so the wizard saves and encrypts the token, says so plainly, and the
provider comes up on the next start. That is the documented v0.1 behaviour rather than an
oversight — hot-reloading a provider is a bigger change than it looks, and a restart is honest.

A provider that is enabled but cannot be built is **reported and skipped**, never fatal: the
control plane still starts, because the UI is where you fix it. The boot log carries one line
per provider.

## Adding a provider

One row in `src/compose.ts` — the config section to read, where its credential comes from, and
what to hand its own `configSchema`. No core change, no new interface. Each provider package
exports a `ProviderFactory` (`id`, `displayName`, `configSchema`, `createProvider`) and this
package calls it.

## Development

```bash
pnpm --filter rockysurf test
pnpm --filter rockysurf typecheck
pnpm --filter rockysurf build
```

Licensed MIT. The Rocky Surf name and logo are not covered by the MIT license.
