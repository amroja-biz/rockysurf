import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * The SPA builds to static assets that @rockysurf/core serves from its own process — one
 * app, one port, no separate web server (ADR-0001).
 *
 * `base` MUST BE ABSOLUTE, and was `'./'` until rockysurf-a29w. The relative form was chosen
 * so core could mount the bundle under any path, which core does not do — `app.use('/*', …)`
 * in `core/src/app.ts` serves it at the root and nowhere else — and it broke every client-side
 * route below the first segment. `index.html` is served for `/servers/new` (that fallback is
 * the point of a SPA), the document's base is then `/servers/`, and `./assets/index-x.js`
 * resolves to `/servers/assets/index-x.js`, which no file matches. The SPA fallback answers
 * THAT request with `index.html` too, so the browser receives `text/html` where it asked for a
 * script and a stylesheet, and the page renders blank and white. It failed the same way before
 * there was any CSS to lose, which is why `/` and `/login` — one segment, base `/` — looked
 * fine and hid it. An absolute base makes every asset URL root-relative and route-independent.
 */
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: { outDir: 'dist', sourcemap: true },
  server: {
    port: 5173,
    /**
     * In production the SPA and the API share an origin, so the client asks for `/api/v1/…`
     * and no base URL is configured anywhere. `vite dev` would break that — the page is on
     * 5173 and core on 3000 — so the dev server forwards the same paths to core and the
     * same-origin assumption keeps holding. Without this you would need
     * `VITE_API_BASE_URL` plus a CORS policy on core, which is exactly what ADR-0001 got
     * rid of.
     *
     * `/api/v1/events` is SSE, hence no buffering and a long timeout: a proxy that buffers
     * turns a live stream into a response that arrives all at once, at the end.
     */
    proxy: {
      '/api': {
        target: process.env['ROCKYSURF_DEV_CORE'] ?? 'http://127.0.0.1:3000',
        changeOrigin: false,
        ws: false,
        timeout: 0,
      },
    },
  },
})
