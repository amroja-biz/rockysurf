/**
 * Per-server SSH identity: two ed25519 keypairs, encrypted at rest, pinned on first contact.
 *
 * Key material moves in exactly three directions out of this module — to the provider (public
 * halves), to the SSH client (private halves plus the pinned fingerprint), and to the one
 * audited download route. Nothing else may hold it.
 */

export {
  fingerprintFromBlob,
  fingerprintPublicKey,
  generateServerKeys,
  generateSshKeyPair,
  makeHostKeyVerifier,
  type ServerKeys,
  type SshKeyPair,
} from './keys.js'

export {
  InvalidPublicKeyError,
  normalizeUserPublicKey,
  SUPPORTED_PUBLIC_KEY_TYPES,
} from './public-key.js'

export {
  deleteServerKeys,
  getServerKeyMaterial,
  privateKeyFilename,
  provisionServerKeys,
  RETIRED_USER_KEY,
  retireManagedUserKey,
  type ProvisionKeys,
  type ProvisionKeysInput,
} from './server-keys.js'

export { createSshKeyRoutes, mayDownloadKey, type SshRoutesDeps } from './routes.js'
