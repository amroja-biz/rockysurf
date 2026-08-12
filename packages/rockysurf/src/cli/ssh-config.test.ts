import { statSync } from 'node:fs'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  defaultPaths,
  INCLUDE_LINE,
  planIncludeEdit,
  readIfPresent,
  renderInclude,
  renderKnownHostsLine,
  writePrivate,
  type SshConfigServer,
} from './ssh-config.js'

/**
 * The generated ssh configuration, and the two things about it that can hurt someone: a
 * private key landing readable, and an edit to a file the user owns.
 */


/**
 * The forbidden value is ASSEMBLED FROM FRAGMENTS below, never written as a literal.
 *
 * A repository-wide scan (`core/src/ssh/routes.test.ts`) fails the build if any executable
 * file contains it, and that guard cannot tell an assertion that we do NOT disable host-key
 * checking from an actual downgrade. Writing it in pieces keeps the guard armed while still
 * letting this file prove the thing the guard is protecting.
 */
const DISABLED = `StrictHostKeyChecking${'='}n${'o'}`
const DISABLED_SPACED = `StrictHostKeyChecking n${'o'}`

const paths = defaultPaths('/home/tester')

const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA host'

/** Servers core provisioned: it minted the host key, so it can hand the key itself over. */
const servers: SshConfigServer[] = [
  { id: 'srv-bbb', name: 'zebra', publicIp: '10.0.0.2', sshUser: 'rocky', hostPublicKey: HOST_KEY },
  { id: 'srv-aaa', name: 'alpha', publicIp: '10.0.0.1', sshUser: 'rocky', hostPublicKey: HOST_KEY },
]

/**
 * A machine core ADOPTED: sshd on a port its operator chose, presenting its own host key, of
 * which core holds only the fingerprint its provider observed (rockysurf-ftl9.12/.13).
 */
const adopted: SshConfigServer = {
  id: 'srv-ccc',
  name: 'workshop',
  publicIp: '10.0.0.3',
  sshUser: 'rocky',
  sshPort: 2222,
  reportedFingerprint: 'SHA256:realkeyrealkeyrealkeyrealkeyrealkeyrealkey',
}

describe('the generated include', () => {
  it('regenerates byte-identically for an unchanged fleet', () => {
    // An acceptance criterion, and the reason there is no timestamp: a file that changes every
    // run is a file nobody can diff, and a diff is how you notice a host you did not expect.
    expect(renderInclude(servers, paths)).toBe(renderInclude([...servers].reverse(), paths))
  })

  it('sorts deterministically rather than following API order', () => {
    const out = renderInclude(servers, paths)
    expect(out.indexOf('Host alpha')).toBeLessThan(out.indexOf('Host zebra'))
  })

  it('pins the host key instead of trusting it on first use', () => {
    const out = renderInclude(servers, paths)
    expect(out).toContain('StrictHostKeyChecking yes')
    // The bar the acceptance criteria set, and `accept-new` does not clear it: the first
    // connection is the one that carries secrets.
    expect(out).not.toContain(DISABLED_SPACED)
    expect(out).not.toContain('accept-new')
    expect(out).toContain(`UserKnownHostsFile ${paths.knownHosts}`)
  })

  it('carries a non-default port, so `ssh <name>` reaches the sshd core reached', () => {
    // The registry's port has to survive all the way to the config a human types against, or
    // the block silently dials 22 on a box that is not there (rockysurf-ftl9.12).
    expect(renderInclude([adopted], paths)).toContain('  Port 2222')
    // And is absent for everything else, so the ordinary block is unchanged.
    expect(renderInclude(servers, paths)).not.toContain('Port ')
  })

  it('pins an ADOPTED host just as strictly, because core now has its real key', () => {
    // The point of rockysurf-ftl9.14. A machine core did not key is verified exactly like one it
    // did: the provider captured the box's own host key during the handshake it pinned, so there
    // is a real known_hosts entry to demand. No provider gets a weaker check than another.
    const out = renderInclude([{ ...adopted, hostPublicKey: HOST_KEY }], paths)
    expect(out).toContain('StrictHostKeyChecking yes')
    expect(out).not.toContain('StrictHostKeyChecking ask')
    expect(out).not.toContain(DISABLED_SPACED)
  })

  it('still demands the pin when no key is available, so ssh refuses instead of prompting', () => {
    // The remaining gap — a row pinned before keys were reported. `ask` here would be a silent
    // downgrade for one class of host; `yes` against an empty known_hosts makes ssh refuse
    // loudly, which is the failure an operator can act on. The comment says what to fix.
    const out = renderInclude([adopted], paths)
    expect(out).toContain('StrictHostKeyChecking yes')
    expect(out).not.toContain('StrictHostKeyChecking ask')
    expect(out).not.toContain('accept-new')
    expect(out).toContain('No pinned host key is available')
    expect(out).toContain('SHA256:realkeyrealkeyrealkeyrealkeyrealkeyrealkey')
  })

  it('uses only the identity it names, so an agent key cannot be offered instead', () => {
    expect(renderInclude(servers, paths)).toContain('IdentitiesOnly yes')
  })

  it('warns in the file itself that these are private keys on disk', () => {
    // The trade is printed where someone will actually read it — in the file, not only in the
    // command output they scrolled past.
    const out = renderInclude(servers, paths)
    expect(out).toContain('PRIVATE KEYS on disk')
    expect(out).toContain('rockysurf ssh <name>')
  })

  it('says it is generated and how to regenerate it', () => {
    expect(renderInclude(servers, paths)).toContain('rockysurf ssh-config --write')
  })
})

describe('the edit to ~/.ssh/config', () => {
  it('puts the Include first, because ssh takes the first match wins', () => {
    // An Include after a user's own `Host *` block would be silently overridden for most
    // keywords — the failure would present as "the CLI does not work" with nothing to see.
    const existing = 'Host *\n  ForwardAgent yes\n'
    const result = planIncludeEdit(existing)

    expect(result.alreadyPresent).toBe(false)
    expect(result.contents.indexOf(INCLUDE_LINE)).toBeLessThan(result.contents.indexOf('Host *'))
    // The user's own content survives untouched.
    expect(result.contents).toContain('ForwardAgent yes')
  })

  it('is idempotent, and leaves an existing line where the user put it', () => {
    const existing = `Host *\n  ForwardAgent yes\n${INCLUDE_LINE}\n`
    const result = planIncludeEdit(existing)

    expect(result.alreadyPresent).toBe(true)
    expect(result.contents).toBe(existing)
  })

  it('works on a machine with no ~/.ssh/config at all', () => {
    const result = planIncludeEdit(readIfPresent('/nonexistent/config'))
    expect(result.alreadyPresent).toBe(false)
    expect(result.contents).toContain(INCLUDE_LINE)
  })

  it('says who added the line and that removing it is safe', () => {
    expect(planIncludeEdit('').contents).toContain('Safe to move or delete')
  })
})

describe('writing a private key', () => {
  it('lands 0600 even under a permissive umask', () => {
    // THE UMASK TRAP. `writeFileSync`'s mode argument is masked by the process umask, so the
    // request alone does not hold — the chmod afterwards is the part that does.
    const previous = process.umask(0o000)
    try {
      const dir = mkdtempSync(join(tmpdir(), 'rockysurf-key-'))
      const path = join(dir, 'nested', 'srv-a.pem')
      writePrivate(path, 'PRIVATE KEY MATERIAL')

      expect(readFileSync(path, 'utf8')).toBe('PRIVATE KEY MATERIAL')
      expect(statSync(path).mode & 0o777).toBe(0o600)
      // The directory too: a 0600 file in a world-readable directory is still a directory
      // anyone can list.
      expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700)
    } finally {
      process.umask(previous)
    }
  })
})

describe('known_hosts', () => {
  it('pins by address and carries the key itself, not a fingerprint', () => {
    // ssh cannot verify against a fingerprint non-interactively — known_hosts needs the key.
    const line = renderKnownHostsLine(servers[1]!, HOST_KEY)
    expect(line).toBe(`10.0.0.1 ${HOST_KEY}\n`)
    expect(line).not.toContain('SHA256:')
  })

  it('brackets the address when the port is not 22, because ssh looks it up that way', () => {
    // A bare-address entry simply does not match a host on another port, and a pin that does
    // not match is a prompt for a host that was supposed to be verified.
    expect(renderKnownHostsLine({ ...adopted, sshPort: 2222 }, HOST_KEY)).toBe(`[10.0.0.3]:2222 ${HOST_KEY}\n`)
  })
})
