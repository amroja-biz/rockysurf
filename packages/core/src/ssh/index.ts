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
  deleteServerKeys,
  getServerKeyMaterial,
  InvalidPublicKeyError,
  normalizeUserPublicKey,
  privateKeyFilename,
  provisionServerKeys,
  type ProvisionKeys,
  type ProvisionKeysInput,
} from './server-keys.js'

export { createSshKeyRoutes, mayDownloadKey, type SshRoutesDeps } from './routes.js'
