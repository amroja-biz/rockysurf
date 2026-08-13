# `@rockysurf/core`

The portable control plane. Hono for HTTP, Drizzle over SQLite for state, SSE for live updates,
in-process jobs for everything asynchronous — one process, one file on disk, no broker.

**Most people do not install this package.** The thing you run is
[`rockysurf`](https://www.npmjs.com/package/rockysurf), the composition root that wires the
compute providers into this control plane:

```bash
npx rockysurf
```

Install `@rockysurf/core` directly only when you are building your own composition root — a
distribution with a different set of providers, or one that embeds the control plane in a larger
process.

```ts
import { boot } from '@rockysurf/core'
import hetzner from '@rockysurf/provider-hetzner'

const app = await boot({ providers: [hetzner] })
```

## The dependency rule

Core may import `@rockysurf/provider-sdk` and **nothing else** from this workspace — never a
concrete provider, never the web package. `scripts/check-core-deps.mjs` enforces the edge and
`scripts/check-npx-closure.mjs` enforces what it is for: the AWS SDK, by a wide margin the
heaviest thing this project installs, stays out of core's production closure, so an operator who
runs Hetzner or BYO never downloads it.

Providers therefore arrive already constructed, through `BootOptions.providers`. Filling that
seam is the one job of the `rockysurf` package.

## What ships in the tarball

Four directories, and each is load-bearing at runtime rather than a build leftover:

| path | what it is |
|---|---|
| `dist/` | the compiled control plane |
| `drizzle/` | schema migrations, applied on boot |
| `bootstrap/` | the agent scripts pushed to a server over SSH |
| `public/` | the built web UI, served from the same process |

`public/` is produced by `@rockysurf/web` at build time, so a publish must follow a full
workspace build — `pnpm -r build` — not a `--filter` of this package alone. See
[docs/RELEASING.md](https://github.com/amroja-biz/rockysurf/blob/main/docs/RELEASING.md).

## Development

```bash
pnpm --filter @rockysurf/core test
pnpm --filter @rockysurf/core typecheck
```
