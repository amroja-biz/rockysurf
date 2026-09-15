import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { generate } from 'selfsigned'

/**
 * A self-signed certificate for `server.tls.selfSigned`, generated once and reused.
 *
 * GENERATED UNDER `server.dataDir`, NOT `os.tmpdir()`: it has to survive a restart, or every
 * boot re-invalidates whatever "yes, I trust this" exception the operator's browser holds for
 * it — training them to click through a certificate warning without reading it, which is the
 * opposite of what a certificate warning is for.
 *
 * NOT A REPLACEMENT FOR A REAL CERTIFICATE. A self-signed one still shows a browser warning;
 * the point is only to make plaintext HTTP not the path of least resistance for an operator who
 * has widened `server.host` beyond loopback and has not put a reverse proxy in front yet.
 */

const TLS_DIR_NAME = 'tls'
const KEY_FILENAME = 'self-signed-key.pem'
const CERT_FILENAME = 'self-signed-cert.pem'

export interface SelfSignedCertPaths {
  keyPath: string
  certPath: string
}

export function selfSignedCertPaths(dataDir: string): SelfSignedCertPaths {
  const dir = join(dataDir, TLS_DIR_NAME)
  return { keyPath: join(dir, KEY_FILENAME), certPath: join(dir, CERT_FILENAME) }
}

export interface TlsCredentials {
  key: string
  cert: string
}

/**
 * The name(s) the certificate should actually match.
 *
 * `server.publicUrl`, when set, is what an operator will type into a browser — it takes
 * priority. Otherwise fall back to `host` itself, UNLESS it is `0.0.0.0`/`::` (every interface):
 * neither is a name a browser ever navigates to, so a cert naming it would satisfy nothing.
 * `localhost`/`127.0.0.1`/`::1` are always included, since testing from the same box is the
 * common case and should not need `publicUrl` set to avoid a second warning on top of the
 * self-signed one.
 */
export function selfSignedCertNames(host: string, publicUrl?: string): string[] {
  const names = new Set(['localhost', '127.0.0.1', '::1'])
  if (publicUrl) {
    try {
      names.add(new URL(publicUrl).hostname)
    } catch {
      // An invalid publicUrl is a config-validation problem elsewhere; this just skips it.
    }
  } else if (host !== '0.0.0.0' && host !== '::') {
    names.add(host)
  }
  return [...names]
}

function toAltNames(names: readonly string[]): Array<{ type: 2 | 7; value?: string; ip?: string }> {
  return names.map((name) => (isIP(name) ? { type: 7 as const, ip: name } : { type: 2 as const, value: name }))
}

async function generateCert(names: readonly string[]): Promise<TlsCredentials> {
  const primary = names[0] ?? 'localhost'
  const pems = await generate([{ name: 'commonName', value: primary }], {
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'subjectAltName', altNames: toAltNames(names) },
    ],
  })
  return { key: pems.private, cert: pems.cert }
}

/**
 * Load the cached certificate under `dataDir`, generating one on first use.
 *
 * `dataDir` is already created with owner-only permissions before anything reaches this
 * (`boot/data-dir.ts`); the `tls` subdirectory and the key file inherit that same discipline —
 * a TLS private key gets exactly the file mode a secret key already gets in this codebase
 * (`secrets/master-key.ts`), not a looser one because this one signs traffic instead of
 * encrypting a database.
 */
export async function ensureSelfSignedCert(dataDir: string, host: string, publicUrl?: string): Promise<TlsCredentials> {
  const { keyPath, certPath } = selfSignedCertPaths(dataDir)
  if (existsSync(keyPath) && existsSync(certPath)) {
    return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') }
  }

  const credentials = await generateCert(selfSignedCertNames(host, publicUrl))

  mkdirSync(join(dataDir, TLS_DIR_NAME), { recursive: true, mode: 0o700 })
  writeFileSync(keyPath, credentials.key, { mode: 0o600 })
  chmodSync(keyPath, 0o600) // writeFileSync's mode is masked by the umask; set it explicitly
  writeFileSync(certPath, credentials.cert, { mode: 0o644 })

  return credentials
}
