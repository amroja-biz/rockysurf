# `@rockysurf/web`

The React SPA. It builds to static assets that `@rockysurf/core` serves from its own process —
one app, one port, no separate web server and no CORS anywhere (ADR-0001).

## Running it in development

Two processes: core for the API, Vite for the UI.

```bash
pnpm --filter @rockysurf/core dev     # http://127.0.0.1:3000
pnpm --filter @rockysurf/web dev      # http://127.0.0.1:5173
```

Open **5173**. Vite proxies `/api/*` to core, so the browser sees one origin and the SPA uses
the same relative `/api/v1` URLs it uses in production. Point the proxy elsewhere with
`ROCKYSURF_DEV_CORE=http://host:port`.

`VITE_API_BASE_URL` overrides the API base outright. It exists for the odd case where the
proxy is not an option; with the proxy you should never need it, and setting it in production
would be a mistake.

Sign in with the admin password core printed on first boot, or the one you set in
`ROCKYSURF_ADMIN_PASSWORD`.

## Production

```bash
pnpm --filter @rockysurf/web build    # → packages/web/dist
```

Core serves that directory. `base: './'` keeps asset URLs relative so it can be mounted
anywhere.

## Tests

```bash
pnpm --filter @rockysurf/web test
```

Vitest in a `jsdom` environment — the runner version is the workspace's, and
`vitest.config.ts` explains why the DOM is a config setting rather than a reason to fork the
major. The suite runs against a real HTTP server rather than a mocked `fetch`, with the real
`EventSource` from the `eventsource` package, so login and the live event stream are exercised
as the browser would. `src/test-setup.ts` documents the three things jsdom does not provide
that had to be filled in.

## Layout

| Path | What it is |
|---|---|
| `src/lib/api.ts` | API client. Same function shapes as the pre-open-source app, minus billing, limits and spot |
| `src/lib/events.ts` | SSE client and the message vocabulary core actually emits |
| `src/contexts/AuthContext.tsx` | Session state for single-admin login |
| `src/contexts/EventsContext.tsx` | One stream per session; `{ connectionStatus, subscribe }` |
| `src/hooks/useServerUpdates.ts` | Subscribe to events for all servers or one |
| `src/pages/placeholders.tsx` | Stand-ins. Every real page is its own later task |
