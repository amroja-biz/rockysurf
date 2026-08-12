import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * The SPA builds to static assets that @rockysurf/core serves from its own process — one
 * app, one port, no separate web server (ADR-0001). `base: './'` keeps the asset URLs
 * relative so core can mount the bundle wherever it likes.
 */
export default defineConfig({
  plugins: [react()],
  base: './',
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
