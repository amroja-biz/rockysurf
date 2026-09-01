/**
 * ONE PARSE OF AN SSH PUBLIC KEY, consulted by everything that accepts one.
 *
 * It lived in `server-keys.ts` until issue #302, which gave public keys a second entrance: a
 * named list in `rockysurf.config.yaml` that the New Server page offers as a picker. Both
 * entrances have to agree about what a public key is — a key the settings editor accepts and
 * the create path then refuses would be a key that saves cleanly and fails at launch — so the
 * parse moved into its own module rather than being written a second time. `server-keys.ts`
 * still re-exports it, and `config/schema.ts` now calls it too.
 *
 * ZERO IMPORTS, deliberately. `config/schema.ts` is loaded before anything else in the process
 * and must not drag the database or the secrets store in behind it; keeping this a leaf module
 * is what lets the schema validate a saved key with the same code the create path runs.
 */

export class InvalidPublicKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidPublicKeyError'
  }
}

/** Key types sshd accepts on an `authorized_keys` line, and therefore the ones taken here. */
export const SUPPORTED_PUBLIC_KEY_TYPES = [
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
] as const

/**
 * THE PREDICTABLE MISTAKE, named before anything else is checked (issue #302).
 *
 * A keypair has two halves in two files whose names differ by four characters, and the wrong
 * one is the one that must never be pasted anywhere. Every check below would refuse a private
 * key eventually — it is multi-line, and `-----BEGIN` is not a key type — but it would refuse
 * it with "public key must be a single line", which reads as a formatting complaint and invites
 * the person to strip the newlines out and try again with their private key on one line. So the
 * private half gets its own sentence, said first and said plainly, and it names the file to
 * paste instead.
 *
 * Matched on the words rather than a strict PEM parse, because the point is to catch a paste
 * that is going wrong, not to certify a private key. Every format that could arrive here says
 * `PRIVATE KEY` in its header: OpenSSH's own, PKCS#1 (`BEGIN RSA PRIVATE KEY`), PKCS#8, and
 * the encrypted variants.
 */
const PRIVATE_KEY_MARKER = /PRIVATE KEY/i

/**
 * A conservative parse of an authorized_keys line. Rejects anything with a newline, so a
 * pasted "key" cannot smuggle a second entry — or an `authorized_keys` option like
 * `command=` — into the file cloud-init writes.
 */
export function normalizeUserPublicKey(raw: string): string {
  const value = raw.trim()
  if (value === '') throw new InvalidPublicKeyError('public key is empty')
  if (PRIVATE_KEY_MARKER.test(value)) {
    throw new InvalidPublicKeyError(
      'that is a PRIVATE key, and it must never be pasted here or stored by Rocky Surf. ' +
        'Paste the PUBLIC half instead — the file ending in `.pub`, one line starting `ssh-ed25519` ' +
        'or `ssh-rsa`. Treat the private key you just copied as compromised and rotate it.',
    )
  }
  if (/[\r\n]/.test(value)) {
    throw new InvalidPublicKeyError('public key must be a single line; multiple keys are not accepted here')
  }

  const [type, blob] = value.split(/\s+/)
  if (!type || !SUPPORTED_PUBLIC_KEY_TYPES.includes(type as (typeof SUPPORTED_PUBLIC_KEY_TYPES)[number])) {
    throw new InvalidPublicKeyError(
      `unsupported key type "${type ?? ''}"; expected one of ${SUPPORTED_PUBLIC_KEY_TYPES.join(', ')}`,
    )
  }
  if (!blob || !/^[A-Za-z0-9+/]+=*$/.test(blob)) {
    throw new InvalidPublicKeyError('public key body is not base64; paste the contents of a .pub file')
  }
  // The type must match what the blob declares, or sshd silently ignores the entry.
  const declared = Buffer.from(blob, 'base64').subarray(4, 4 + type.length).toString('utf8')
  if (declared !== type) {
    throw new InvalidPublicKeyError('public key body does not match its declared type')
  }
  return value
}
