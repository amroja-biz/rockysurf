import type { Db } from '../db/client.js'
import { upsertUserByGithubId } from '../db/repositories/users.js'
import type { User } from '../db/schema.js'
import { generatePassword, hashPassword } from './passwords.js'
import type { SecretStore } from './secret-store.js'

/**
 * The single-admin local mode: one account, no sign-up, no invitations.
 *
 * SCHEMA FRICTION worth recording: `users` requires `githubId` and `githubUsername`, both
 * NOT NULL and unique, because the whole app was built around GitHub identity. Local mode has
 * no GitHub anything, so it synthesizes the stable sentinel below. It works and it is
 * unambiguous, but the honest fix when `auth.mode: 'github-device'` lands is a nullable
 * `githubId` plus an explicit `authProvider` column — otherwise a real GitHub user could in
 * principle be created with the id `local:admin`.
 */
export const LOCAL_ADMIN_GITHUB_ID = 'local:admin'
export const LOCAL_ADMIN_USERNAME = 'admin'

/** Where the admin password hash lives in the secret store. */
export const ADMIN_PASSWORD_HASH_KEY = 'auth.local.passwordHash'

/** Environment override, checked before anything is generated. */
export const ADMIN_PASSWORD_ENV = 'ROCKYSURF_ADMIN_PASSWORD'

export interface EnsureLocalAdminOptions {
  db: Db
  secrets: SecretStore
  /** Explicit password. Overwrites whatever is stored, so it doubles as rotation. */
  password?: string
  /** Where a generated password is announced. Defaults to stderr. */
  announce?: (message: string) => void
}

export interface LocalAdmin {
  user: User
  /** Set only when a password was generated on this call, so callers can tell first boot. */
  generatedPassword?: string
}

/**
 * Ensure the admin user exists and has a password.
 *
 * Order matters: an explicit password always wins, so an operator who sets
 * `ROCKYSURF_ADMIN_PASSWORD` can recover an installation whose password they have lost. If
 * nothing is set and nothing is stored, one is generated and printed ONCE — it is never
 * recoverable afterwards, because only the scrypt hash is kept.
 */
export async function ensureLocalAdmin(options: EnsureLocalAdminOptions): Promise<LocalAdmin> {
  const { db, secrets } = options
  const announce = options.announce ?? ((message: string) => console.error(message))

  const user = upsertUserByGithubId(db, {
    githubId: LOCAL_ADMIN_GITHUB_ID,
    githubUsername: LOCAL_ADMIN_USERNAME,
    isAdmin: true,
  })

  if (options.password) {
    await secrets.set(ADMIN_PASSWORD_HASH_KEY, hashPassword(options.password))
    return { user }
  }

  const existing = await secrets.get(ADMIN_PASSWORD_HASH_KEY)
  if (existing) return { user }

  const generated = generatePassword()
  await secrets.set(ADMIN_PASSWORD_HASH_KEY, hashPassword(generated))
  announce(firstBootBanner(generated))
  return { user, generatedPassword: generated }
}

/** Printed once, to stderr, so it survives `| tee` and is not swallowed by a JSON log pipe. */
function firstBootBanner(password: string): string {
  const line = '─'.repeat(58)
  return [
    '',
    line,
    '  Rocky Surf first boot — your admin password is:',
    '',
    `      ${password}`,
    '',
    '  This is shown ONCE and is not recoverable: only its hash is stored.',
    `  Set ${ADMIN_PASSWORD_ENV} to choose your own, now or later.`,
    line,
    '',
  ].join('\n')
}
