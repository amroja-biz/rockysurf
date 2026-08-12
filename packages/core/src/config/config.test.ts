import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ConfigError,
  configSchema,
  expandTilde,
  interpolateEnv,
  loadConfig,
  MissingEnvVarsError,
  parseConfig,
  referencedEnvVars,
  referencedEnvVarsIn,
  resolveConfigPath,
  resolveConfigSource,
} from './index.js'

const FULL = `
server:
  port: \${PORT}
  publicUrl: "https://rocky.example.com"
  dataDir: "~/rockysurf-data"
auth:
  mode: github-device
github:
  pat: "\${GITHUB_PAT}"
providers:
  hetzner:
    enabled: true
    token: "\${HETZNER_TOKEN}"
    location: fsn1
  aws:
    enabled: true
    region: us-east-1
    sizes: [t4g.small, t4g.medium]
  byo:
    enabled: true
    hosts:
      - name: workshop
        host: 10.0.0.9
        user: rocky
        fingerprint: "SHA256:abc"
limits:
  maxServers: 12
  spendCap:
    amount: 40
    currency: eur
  createRatePerHour: 2
`

const ENV = {
  PORT: '8080',
  GITHUB_PAT: 'ghp_example',
  HETZNER_TOKEN: 'hz_example',
} satisfies NodeJS.ProcessEnv

/** Throw and return the ConfigError, so assertions can read `.message` and `.configPath`. */
function configErrorFrom(fn: () => unknown): ConfigError {
  try {
    fn()
  } catch (err) {
    if (err instanceof ConfigError) return err
    throw err
  }
  throw new Error('expected a ConfigError, but nothing was thrown')
}

describe('happy path', () => {
  it('loads a complete file into a fully-typed Config', () => {
    const config = parseConfig(FULL, 'test.yaml', ENV)

    expect(config.server.port).toBe(8080)
    expect(config.server.publicUrl).toBe('https://rocky.example.com')
    expect(config.auth.mode).toBe('github-device')
    expect(config.github.pat).toBe('ghp_example')

    expect(config.providers.hetzner).toMatchObject({ enabled: true, token: 'hz_example', location: 'fsn1' })
    expect(config.providers.aws).toMatchObject({ enabled: true, region: 'us-east-1' })
    expect(config.providers.aws.sizes).toEqual(['t4g.small', 't4g.medium'])
    expect(config.providers.byo.hosts).toHaveLength(1)

    expect(config.limits.maxServers).toBe(12)
    expect(config.limits.createRatePerHour).toBe(2)
    expect(config.limits.spendCap).toEqual({ amount: 40, currency: 'EUR' })
  })

  it('fills in per-host defaults', () => {
    const config = parseConfig(FULL, 'test.yaml', ENV)
    const host = config.providers.byo.hosts[0]
    expect(host).toMatchObject({ name: 'workshop', host: '10.0.0.9', user: 'rocky', port: 22 })
    expect(host?.fingerprint).toBe('SHA256:abc')
  })
})

describe('defaults materialize', () => {
  it('an empty file yields a complete config, not an empty object', () => {
    const config = parseConfig('', 'test.yaml', {})

    expect(config.server.port).toBe(3000)
    // Loopback, not 0.0.0.0 (rockysurf-pii7). A config nobody wrote must not put a process
    // holding cloud credentials and SSH private keys on the network.
    expect(config.server.host).toBe('127.0.0.1')
    expect(config.server.publicUrl).toBeUndefined()
    expect(config.auth.mode).toBe('local')
    expect(config.limits).toMatchObject({ maxServers: 5, createRatePerHour: 4 })
    expect(config.limits.spendCap).toBeUndefined()
  })

  it('every provider is present and disabled by default', () => {
    const config = parseConfig('', 'test.yaml', {})
    expect(config.providers.aws).toMatchObject({ enabled: false, region: 'us-east-1' })
    expect(config.providers.hetzner).toMatchObject({ enabled: false, location: 'fsn1' })
    expect(config.providers.byo).toMatchObject({ enabled: false, hosts: [] })
  })

  it('treats a section whose children are all commented out as defaults', () => {
    // Regression: `github:` with every child commented out parses as null, not as a missing
    // key, so .prefault({}) never fired and the section failed as "expected object, received
    // null". The shipped example config is exactly this shape, which is how it was caught.
    const config = parseConfig('github:\n  # pat: "x"\nauth:\nlimits:\n', 'test.yaml', {})
    expect(config.github.pat).toBeUndefined()
    expect(config.auth.mode).toBe('local')
    expect(config.limits.maxServers).toBe(5)
  })

  it('treats an explicitly empty section as defaults', () => {
    const config = parseConfig('limits: {}\nproviders: {}\n', 'test.yaml', {})
    expect(config.limits).toMatchObject({ maxServers: 5, createRatePerHour: 4 })
    expect(config.providers.aws.enabled).toBe(false)
  })

  it('treats an empty hosts list written as a bare key as an empty list', () => {
    const config = parseConfig('providers:\n  byo:\n    hosts:\n', 'test.yaml', {})
    expect(config.providers.byo.hosts).toEqual([])
  })

  it('a half-specified section keeps the defaults for the rest of its fields', () => {
    // The reason the schema uses .prefault({}) rather than .default({}): with .default(),
    // `limits: {}` would stay `{}` and maxServers would be undefined at runtime.
    const config = parseConfig('limits:\n  maxServers: 9\n', 'test.yaml', {})
    expect(config.limits.maxServers).toBe(9)
    expect(config.limits.createRatePerHour).toBe(4)
  })
})

describe('${ENV} interpolation', () => {
  it('substitutes from the environment', () => {
    expect(interpolateEnv('token: ${A}-${B}', { A: 'x', B: 'y' })).toBe('token: x-y')
  })

  it('names the missing variable', () => {
    const err = configErrorFrom(() => parseConfig('github:\n  pat: "${GITHUB_PAT}"\n', 'test.yaml', {}))
    expect(err.message).toContain('${GITHUB_PAT}')
    expect(err.message).toContain('test.yaml')
    expect(err.message).toContain('.env.example')
  })

  it('reports every missing variable at once, not just the first', () => {
    const err = configErrorFrom(() => parseConfig(FULL, 'test.yaml', { PORT: '3000' }))
    expect(err.message).toContain('${GITHUB_PAT}')
    expect(err.message).toContain('${HETZNER_TOKEN}')
  })

  it('throws MissingEnvVarsError carrying the names, for callers that want them', () => {
    try {
      interpolateEnv('${ONE} ${TWO} ${ONE}', {})
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(MissingEnvVarsError)
      expect((err as MissingEnvVarsError).vars).toEqual(['ONE', 'TWO'])
    }
  })

  it('treats an empty string as set — an empty token is a config choice, not a missing var', () => {
    expect(interpolateEnv('a: ${EMPTY}', { EMPTY: '' })).toBe('a: ')
  })

  it('leaves $${VAR} as a literal', () => {
    expect(interpolateEnv('pass: $${NOT_A_VAR}', {})).toBe('pass: ${NOT_A_VAR}')
    expect(referencedEnvVars('$${SKIP} ${REAL}')).toEqual(['REAL'])
  })

  it('ignores things that only look like references', () => {
    expect(interpolateEnv('a: ${} ${1BAD} $PLAIN', {})).toBe('a: ${} ${1BAD} $PLAIN')
  })

  it('does NOT substitute inside YAML comments', () => {
    // Regression: interpolation used to run over the raw file text, so a comment explaining
    // the ${VAR} syntax — or an optional setting commented out with its variable still in it —
    // demanded that the variable be set. The shipped example config is exactly that shape.
    const text = '# set github.pat to "${GITHUB_PAT}" to clone private repos\nserver:\n  port: 3000\n'
    expect(() => parseConfig(text, 'test.yaml', {})).not.toThrow()
    expect(parseConfig(text, 'test.yaml', {}).server.port).toBe(3000)
  })

  it('does not let a substituted value change the shape of the document', () => {
    // A token containing YAML-significant characters lands in the field, not in the grammar.
    const config = parseConfig('providers:\n  hetzner:\n    enabled: true\n    token: ${T}\n', 'test.yaml', {
      T: 'a#b: c',
    })
    expect(config.providers.hetzner.token).toBe('a#b: c')
  })

  it('an unquoted numeric reference still arrives as a number', () => {
    expect(parseConfig('server:\n  port: ${PORT}\n', 'test.yaml', { PORT: '8080' }).server.port).toBe(8080)
  })

  it('a quoted numeric reference is coerced, so both spellings work', () => {
    expect(parseConfig('server:\n  port: "${PORT}"\n', 'test.yaml', { PORT: '8080' }).server.port).toBe(8080)
  })
})

describe('dataDir and tilde expansion', () => {
  it('expands ~ and ~/ against the home directory', () => {
    expect(expandTilde('~', '/home/test')).toBe('/home/test')
    expect(expandTilde('~/rockysurf', '/home/test')).toBe('/home/test/rockysurf')
  })

  it('leaves absolute paths and ~user alone', () => {
    expect(expandTilde('/var/lib/rockysurf', '/home/test')).toBe('/var/lib/rockysurf')
    expect(expandTilde('~other/data', '/home/test')).toBe('~other/data')
  })

  it('expands the ~/.rockysurf default to an absolute path', () => {
    const { dataDir } = parseConfig('', 'test.yaml', {}).server
    expect(isAbsolute(dataDir)).toBe(true)
    expect(dataDir).toBe(join(homedir(), '.rockysurf'))
    expect(dataDir).not.toContain('~')
  })

  it('expands a configured ~ path too', () => {
    const { dataDir } = parseConfig('server:\n  dataDir: "~/rockysurf-data"\n', 'test.yaml', {}).server
    expect(dataDir).toBe(join(homedir(), 'rockysurf-data'))
  })

  it('resolves a relative dataDir to an absolute path', () => {
    const { dataDir } = parseConfig('server:\n  dataDir: "./data"\n', 'test.yaml', {}).server
    expect(isAbsolute(dataDir)).toBe(true)
  })
})

describe('validation errors name the offending field', () => {
  it('rejects an invalid enum', () => {
    const err = configErrorFrom(() => parseConfig('auth:\n  mode: ldap\n', 'test.yaml', {}))
    expect(err.message).toContain('auth.mode')
    expect(err.message).toContain('test.yaml')
    expect(err.configPath).toBe('test.yaml')
  })

  it('rejects a bad type', () => {
    const err = configErrorFrom(() => parseConfig('server:\n  port: not-a-port\n', 'test.yaml', {}))
    expect(err.message).toContain('server.port')
  })

  it('rejects an out-of-range port', () => {
    const err = configErrorFrom(() => parseConfig('server:\n  port: 99999\n', 'test.yaml', {}))
    expect(err.message).toContain('server.port')
  })

  it('rejects an unknown provider key, naming it', () => {
    const err = configErrorFrom(() =>
      parseConfig('providers:\n  hetzner:\n    enabled: true\n    token: t\n    reigon: fsn1\n', 'test.yaml', {}),
    )
    expect(err.message).toContain('providers.hetzner.reigon')
  })

  it('rejects an unknown top-level key', () => {
    const err = configErrorFrom(() => parseConfig('serrver:\n  port: 3000\n', 'test.yaml', {}))
    expect(err.message).toContain('serrver')
  })

  it('rejects an unknown provider entirely', () => {
    const err = configErrorFrom(() => parseConfig('providers:\n  gcp:\n    enabled: true\n', 'test.yaml', {}))
    expect(err.message).toContain('providers.gcp')
  })

  it('ACCEPTS an enabled hetzner with no token — the credential may live in the secrets store', () => {
    // This used to be an error, and the error was a trap (rockysurf-55fx.12). The first-run
    // wizard stores credentials in the ENCRYPTED SECRETS STORE, which this schema cannot see,
    // so rejecting here made the state the wizard creates — provider on, credential elsewhere —
    // impossible to express, and a pasted token could never be turned on.
    //
    // Resolution moved to the composition root, which can see both sources: config file first,
    // then the store, and a clear boot-log line naming both when neither has one.
    const config = parseConfig('providers:\n  hetzner:\n    enabled: true\n', 'test.yaml', {})
    expect(config.providers.hetzner).toMatchObject({ enabled: true, location: 'fsn1' })
    expect(config.providers.hetzner.token).toBeUndefined()
  })

  it('accepts the AWS fields the provider actually requires', () => {
    // `sshAllowedCidr` was missing from this section until 55fx.12, which meant the AWS
    // provider's own schema rejected every section core could produce — it could not be
    // configured from this file at all.
    const config = parseConfig(
      'providers:\n  aws:\n    enabled: true\n    profile: dev\n    sshAllowedCidr: "203.0.113.4/32"\n',
      'test.yaml',
      {},
    )
    expect(config.providers.aws).toMatchObject({
      enabled: true,
      profile: 'dev',
      sshAllowedCidr: '203.0.113.4/32',
    })
  })

  it('catches an enabled byo with no hosts', () => {
    const err = configErrorFrom(() => parseConfig('providers:\n  byo:\n    enabled: true\n', 'test.yaml', {}))
    expect(err.message).toContain('providers.byo.hosts')
  })

  it('rejects a malformed publicUrl', () => {
    const err = configErrorFrom(() => parseConfig('server:\n  publicUrl: "not a url"\n', 'test.yaml', {}))
    expect(err.message).toContain('server.publicUrl')
  })

  it('rejects a non-ISO currency', () => {
    const err = configErrorFrom(() =>
      parseConfig('limits:\n  spendCap:\n    amount: 10\n    currency: dollars\n', 'test.yaml', {}),
    )
    expect(err.message).toContain('limits.spendCap.currency')
    expect(err.message).toContain('ISO 4217')
  })

  it('reports several problems in one message rather than one per run', () => {
    const err = configErrorFrom(() => parseConfig('auth:\n  mode: ldap\nlimits:\n  maxServers: -1\n', 'test.yaml', {}))
    expect(err.message).toContain('auth.mode')
    expect(err.message).toContain('limits.maxServers')
  })

  it('points at the example file so a stranger knows where to look', () => {
    const err = configErrorFrom(() => parseConfig('auth:\n  mode: ldap\n', 'test.yaml', {}))
    expect(err.message).toContain('rockysurf.config.example.yaml')
  })

  it('reports malformed YAML as a YAML problem, not a schema problem', () => {
    const err = configErrorFrom(() => parseConfig('server:\n  port: 3000\n bad indent\n', 'test.yaml', {}))
    expect(err.message).toContain('not valid YAML')
  })
})

describe('config path resolution', () => {
  it('defaults to ./rockysurf.config.yaml', () => {
    expect(resolveConfigPath([], '/srv/app')).toBe(join('/srv/app', 'rockysurf.config.yaml'))
  })

  it('accepts --config <path> and --config=<path>', () => {
    expect(resolveConfigPath(['--config', '/etc/rs.yaml'], '/srv/app')).toBe('/etc/rs.yaml')
    expect(resolveConfigPath(['--config=/etc/rs.yaml'], '/srv/app')).toBe('/etc/rs.yaml')
  })

  it('resolves a relative --config against cwd', () => {
    expect(resolveConfigPath(['--config', 'conf/rs.yaml'], '/srv/app')).toBe('/srv/app/conf/rs.yaml')
  })

  it('ignores unrelated arguments', () => {
    expect(resolveConfigPath(['--verbose', '--config', '/etc/rs.yaml', '--port', '1'], '/srv/app')).toBe('/etc/rs.yaml')
  })

  it('rejects --config with no value', () => {
    expect(() => resolveConfigPath(['--config'], '/srv/app')).toThrow(ConfigError)
    expect(() => resolveConfigPath(['--config', '--verbose'], '/srv/app')).toThrow(ConfigError)
  })
})

describe('loadConfig from disk', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'rockysurf-config-'))
    writeFileSync(join(dir, 'rockysurf.config.yaml'), 'server:\n  port: 4321\n')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads the default filename from cwd', () => {
    expect(loadConfig({ argv: [], cwd: dir, env: {} }).server.port).toBe(4321)
  })

  /**
   * rockysurf-cf51. The two halves of "a missing file" — and they are genuinely different
   * events, which is why `resolveConfigSource` reports which one happened.
   */
  it('starts on defaults when there is no file at the DEFAULT location', () => {
    const empty = join(dir, 'nope')
    const notices: string[] = []
    const config = loadConfig({ argv: [], cwd: empty, env: {}, notice: (m) => notices.push(m) })

    // The defaults a first run gets: the documented port, loopback, and a data directory in the
    // operator's home rather than in whatever directory npx happened to be run from.
    expect(config.server.port).toBe(3000)
    expect(config.server.host).toBe('127.0.0.1')
    expect(config.server.dataDir).toBe(join(homedir(), '.rockysurf'))

    // ...and it says so, naming the path where a file would be read.
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain(join(empty, 'rockysurf.config.yaml'))
    expect(notices[0]).toContain('defaults')
  })

  it('says nothing at all when a config file was found', () => {
    const notices: string[] = []
    loadConfig({ argv: [], cwd: dir, env: {}, notice: (m) => notices.push(m) })
    expect(notices).toEqual([])
  })

  it('still refuses a --config path with nothing at it, and names the path', () => {
    const missing = join(dir, 'nope', 'rockysurf.config.yaml')
    const err = configErrorFrom(() => loadConfig({ argv: ['--config', missing], cwd: dir, env: {} }))
    expect(err.message).toContain('no config file at')
    expect(err.message).toContain(missing)
    expect(err.message).toContain('--config')
  })

  it('reports whether the operator named the file', () => {
    expect(resolveConfigSource([], '/srv/app')).toEqual({
      path: join('/srv/app', 'rockysurf.config.yaml'),
      explicit: false,
    })
    expect(resolveConfigSource(['--config', 'rs.yaml'], '/srv/app')).toEqual({
      path: '/srv/app/rs.yaml',
      explicit: true,
    })
    expect(resolveConfigSource(['--config=/etc/rs.yaml'], '/srv/app')).toEqual({
      path: '/etc/rs.yaml',
      explicit: true,
    })
  })
})

/** Parse without interpolating, to inspect what the document references. */
function parseYamlForTest(text: string): unknown {
  return parseYaml(text)
}

describe('the shipped example files', () => {
  // The example config is the first artifact a stranger copies, so it is worth a test: a
  // schema change that forgets to update it would otherwise ship a file that cannot boot.
  const exampleConfig = readFileSync(
    fileURLToPath(new URL('../../../../rockysurf.config.example.yaml', import.meta.url)),
    'utf8',
  )
  const exampleEnv = readFileSync(fileURLToPath(new URL('../../../../.env.example', import.meta.url)), 'utf8')

  it('rockysurf.config.example.yaml is valid against the schema', () => {
    const config = parseConfig(exampleConfig, 'rockysurf.config.example.yaml', { HETZNER_TOKEN: 'hz_example' })
    expect(config.server.port).toBe(3000)
    expect(config.auth.mode).toBe('local')
    expect(config.limits).toMatchObject({ maxServers: 5, createRatePerHour: 4 })
  })

  it('ships a quickstart that turns Hetzner on and nothing else', () => {
    const { providers } = parseConfig(exampleConfig, 'example', { HETZNER_TOKEN: 'hz_example' })
    expect(providers.hetzner).toMatchObject({ enabled: true, token: 'hz_example', location: 'fsn1' })
    expect(providers.aws.enabled).toBe(false)
    expect(providers.byo.enabled).toBe(false)
  })

  it('documents every variable it references in .env.example', () => {
    // Tree-level, so this counts variables the config actually USES, not ones merely named in
    // a comment. .env.example may document more than the example config references.
    const referenced = referencedEnvVarsIn(parseYamlForTest(exampleConfig))
    expect(referenced.length).toBeGreaterThan(0)
    for (const name of referenced) {
      expect(exampleEnv, `${name} is referenced by the example config but absent from .env.example`).toContain(name)
    }
  })

  it('gives a stranger who forgot the token an error that names it', () => {
    const err = configErrorFrom(() => parseConfig(exampleConfig, 'rockysurf.config.yaml', {}))
    expect(err.message).toContain('${HETZNER_TOKEN}')
    expect(err.message).toContain('.env.example')
  })

  // The container seed, which differs from the example on exactly the three settings a
  // container forces. `host` is the one with a failure mode nobody would guess: bind the
  // default loopback in there and the published port reaches nothing, while the healthcheck —
  // which also runs inside the container — still passes (rockysurf-pii7).
  it('docker/rockysurf.config.yaml seeds a container that is actually reachable', () => {
    const seed = readFileSync(fileURLToPath(new URL('../../../../docker/rockysurf.config.yaml', import.meta.url)), 'utf8')
    const config = parseConfig(seed, 'docker/rockysurf.config.yaml', {})

    expect(config.server.host).toBe('0.0.0.0')
    expect(config.server.port).toBe(3000)
    expect(config.server.dataDir).toBe('/data')
  })
})

describe('schema is directly usable', () => {
  it('parses an object without going through YAML', () => {
    const config = configSchema.parse({ server: { port: 5000 } })
    expect(config.server.port).toBe(5000)
    expect(config.auth.mode).toBe('local')
  })
})
