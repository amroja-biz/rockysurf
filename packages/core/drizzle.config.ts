import { defineConfig } from 'drizzle-kit'

/**
 * drizzle-kit config, used only to GENERATE migrations (`pnpm run db:generate`).
 *
 * Applying them is core's own job at boot — see `runMigrations` in `src/db/client.ts` — so
 * that a fresh install needs no separate migrate command and no drizzle-kit at runtime.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  // Placeholder: generation is a static diff against the committed migrations and never
  // touches this database. The real path comes from config at runtime.
  dbCredentials: { url: './.data/rockysurf.db' },
  strict: true,
  verbose: true,
})
