/**
 * The secrets store: AES-256-GCM ciphertext rows, and the master key that opens them.
 *
 * THE CUSTODY RULE, restated here because this barrel is what other modules import: nothing
 * in this package may return decrypted secret material from an HTTP handler. Plaintext moves
 * from here to the SSH client, the git credential helper and the provider clients, and
 * nowhere else. `listSecretRefs` answers "what secrets exist" without decrypting anything,
 * and is the only listing offered on purpose.
 */

export {
  assertMasterKey,
  AUTH_TAG_BYTES,
  CURRENT_KEY_ID,
  KEY_BYTES,
  NONCE_BYTES,
  open,
  seal,
  secretAad,
  SecretDecryptionError,
  secretEquals,
  type SealedSecret,
} from './crypto.js'

export {
  assertPrivateMode,
  loadMasterKey,
  MasterKeyError,
  SECRET_KEY_ENV,
  SECRET_KEY_FILENAME,
  secretKeyPath,
  type LoadMasterKeyOptions,
  type MasterKey,
  type MasterKeyOrigin,
} from './master-key.js'

export {
  createSecretsStore,
  SECRET_KINDS,
  type SecretKind,
  type SecretMetadata,
  type SecretRef,
  type SecretsStore,
  type ServerKeyMaterial,
} from './store.js'
