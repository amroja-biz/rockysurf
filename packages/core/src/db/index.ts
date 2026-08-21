/**
 * The data layer: schema, migrations, and typed repositories.
 *
 * Everything that touches SQL lives under `src/db/`. Nothing above this directory should
 * import `drizzle-orm` directly — repositories are the seam, which is what will make the
 * Postgres move a change here rather than everywhere.
 */

export {
  defaultDatabasePath,
  MIGRATIONS_DIR,
  openDatabase,
  openTestDatabase,
  runMigrations,
  type Db,
  type OpenDatabaseOptions,
  type OpenedDatabase,
} from './client.js'

export { buildIdempotencyKey, newEventId, newId, newSecretId, newServerId, newSessionId, newUserId } from './ids.js'

export * as schema from './schema.js'

export {
  ARCHITECTURES,
  BOOTSTRAP_MODES,
  PROVISIONING_STEPS,
  SERVER_SIZES,
  SERVER_STATUSES,
  events,
  packs,
  secrets,
  serverRepositories,
  servers,
  sessions,
  settings,
  tools,
  users,
  type Architecture,
  type BootstrapMode,
  type EventRow,
  type NewEventRow,
  type NewPackRow,
  type NewSecretRow,
  type NewServerRow,
  type NewToolRow,
  type NewUser,
  type PackRow,
  type ProvisioningStep,
  type SecretRow,
  type ServerRow,
  type ServerSize,
  type ServerStatus,
  type StoredSize,
  type Session,
  type SettingRow,
  type ToolRow,
  type User,
} from './schema.js'

export {
  acceptsProgressReports,
  advancesProvisioning,
  assertTransition,
  assertValidProvisioningStep,
  canTransition,
  InvalidProvisioningStepError,
  InvalidTransitionError,
  isTerminalStatus,
  isValidProvisioningStep,
  resolveIpChange,
  SERVER_STATUS_TRANSITIONS,
  statusForStep,
  type IpChange,
} from './transitions.js'

export {
  BILLING_INSTANCE_STATES,
  countActiveServersForUser,
  getProviderData,
  getServer,
  getServerByIdempotencyKey,
  getServerRepositories,
  getServerTools,
  insertServer,
  isBillingRow,
  listBillingServers,
  listServersByStatus,
  listServersByUser,
  listServersNeedingRecovery,
  recordProgress,
  recordProviderState,
  setInstallPlan,
  setKeyMaterial,
  setProviderData,
  updateServerStatus,
  type CreateServerInput,
  type ProgressReport,
} from './repositories/servers.js'

export {
  appendEvent,
  createSession,
  deleteExpiredSessions,
  deleteSession,
  getLiveSessionByTokenHash,
  getUser,
  getUserByGithubUsername,
  listEventsForServer,
  touchSession,
  upsertUserByGithubId,
  type AppendEventInput,
  type UpsertUserInput,
} from './repositories/users.js'
