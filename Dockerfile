# syntax=docker/dockerfile:1
#
# Rocky Surf in a container (rockysurf-ftl9.4).
#
# The shape is forced by two facts about this codebase:
#
#  - **The SPA is served by core's own process** (ADR-0001). There is no second web server and
#    no CDN, so the image has to contain the built bundle sitting where core looks for it —
#    `packages/core/public`. Nothing in the repository copies it there; the release path does,
#    and here that release path is the `cp` below.
#  - **`better-sqlite3` is a native module.** It needs a toolchain to install and nothing at
#    run time, which is the textbook reason for two stages: the compiler and the whole dev
#    dependency tree stay in `build`, and `runtime` gets the result.
#
# The workspace is copied whole rather than deployed package-by-package. `pnpm deploy` would
# produce a smaller tree, but core resolves `packs/` from the working directory and the
# bootstrap agent from its own package — both of which survive a plain copy and are exactly
# the sort of thing a flattening step loses quietly.

ARG NODE_VERSION=24
# Pinned rather than floating: the lockfile is v9 and a pnpm that reads it differently would
# turn a reproducible build into a moving one. Matches the version the repository is developed
# against; bump both together.
ARG PNPM_VERSION=11.21.0

# ----------------------------------------------------------------------------------- build

FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# `better-sqlite3` and `ssh2`/`cpu-features` compile from source when no prebuild matches the
# platform — which is the normal case on arm64. Present here and in no other stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Manifests first, so a source-only change reuses the install layer. Every workspace member is
# listed explicitly: `pnpm install --frozen-lockfile` fails if the set of packages it can see
# disagrees with the lockfile, so a new package under packages/ must be added here too.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/provider-aws/package.json packages/provider-aws/
COPY packages/provider-byo/package.json packages/provider-byo/
COPY packages/provider-conformance/package.json packages/provider-conformance/
COPY packages/provider-hetzner/package.json packages/provider-hetzner/
COPY packages/provider-sdk/package.json packages/provider-sdk/
COPY packages/rockysurf/package.json packages/rockysurf/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm -r build

# The SPA into the directory core serves from. `server.ts` resolves `../public` relative to its
# own module, so this path is not configurable without `ROCKYSURF_PUBLIC_DIR`; getting it wrong
# does not fail the build, it just serves the "no web bundle is configured" page.
RUN rm -rf packages/core/public && cp -R packages/web/dist packages/core/public

# Prune to production. Re-running install with --prod removes every devDependency from the
# workspace's node_modules while leaving the already-compiled native bindings in place, which
# is what keeps the runtime stage free of TypeScript, vitest and the AWS SDK's test doubles.
RUN pnpm install --frozen-lockfile --prod

# --------------------------------------------------------------------------------- runtime

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOME=/home/rocky

# NON-ROOT, with a fixed uid so a bind-mounted data directory can be chowned to a number the
# host can predict. Named `rocky` to match the unprivileged user the bootstrap agent creates on
# a managed box — same name, same idea, different machine.
RUN groupadd --system --gid 10001 rocky \
 && useradd --system --uid 10001 --gid rocky --home-dir /home/rocky --create-home rocky

WORKDIR /app
COPY --from=build --chown=rocky:rocky /app /app

# The data directory exists IN THE IMAGE, owned by rocky and 0700. That is not decoration:
# Docker seeds a fresh named volume from whatever is at the mount path in the image, ownership
# included, so this line is what makes `/data` writable by a non-root process on first start.
# A BIND mount gets no such treatment and arrives owned by the host user — see
# docs/self-hosting.md for the chown that fixes it.
RUN install -d -m 700 -o rocky -g rocky /data

USER rocky
EXPOSE 3000
VOLUME ["/data"]

# `/health` is unauthenticated by design, so this needs no credential. Node's global fetch
# keeps the image free of curl.
HEALTHCHECK --interval=5s --timeout=3s --start-period=30s --retries=12 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/app/docker/entrypoint.sh"]
