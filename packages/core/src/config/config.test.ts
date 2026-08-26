import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  checkConfigText,
  ConfigError,
  configSchema,
  expandTilde,
  interpolateEnv,
  interpolateTreeLeniently,
  loadConfig,
  loadConfigLeniently,
  loadConfigWithSource,
  MissingEnvVarsError,
  parseConfig,
  parseConfigLenientlyRequiring,
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

  it('pricing defaults to the hosted feed, enabled (gh #100)', () => {
    // Out-of-the-box installs read the feed this repo's own price-feed workflow republishes;
    // an operator can mirror it (feedUrl) or opt out entirely (enabled: false, for air gaps).
    const config = parseConfig('', 'test.yaml', {})
    expect(config.pricing).toEqual({
      enabled: true,
      feedUrl: 'https://amroja-biz.github.io/rockysurf/prices/v1',
      refreshHours: 6,
    })
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

  it('parses a github.tokens list, lowercased and interpolated (rockysurf-ta7g)', () => {
    const config = parseConfig(
      'github:\n  pat: "ghp_fallback"\n  tokens:\n' +
        '    - owner: Acme\n      repo: Widgets\n      pat: "${ACME_PAT}"\n' +
        '    - host: Git.Example.COM\n      pat: "ghp_enterprise"\n',
      'test.yaml',
      { ACME_PAT: 'ghp_widgets' },
    )
    // Lowercased HERE so the box never has to: GitHub is case-insensitive about all three,
    // and the credential helper compares with `[ = ]`, which is not.
    expect(config.github.tokens).toEqual([
      { owner: 'acme', repo: 'widgets', pat: 'ghp_widgets' },
      { host: 'git.example.com', pat: 'ghp_enterprise' },
    ])
    expect(config.github.pat).toBe('ghp_fallback')
  })

  it('defaults github.tokens to empty, so an untouched config is unchanged', () => {
    expect(parseConfig('', 'test.yaml', {}).github.tokens).toEqual([])
  })

  it('refuses a token entry that names nothing, or a repo with no owner', () => {
    // A repo name alone matches nothing — there is no such thing as "any repository called
    // widgets" — and an entry with no scope at all is `github.pat` written at greater length,
    // which would otherwise silently outrank the fallback it duplicates.
    expect(() =>
      parseConfig('github:\n  tokens:\n    - repo: widgets\n      pat: "x"\n', 'test.yaml', {}),
    ).toThrow(/repo requires owner/)
    expect(() => parseConfig('github:\n  tokens:\n    - pat: "x"\n', 'test.yaml', {})).toThrow(
      /write it as github\.pat/,
    )
  })

  it('refuses two entries covering the same scope, which would tie and lose silently', () => {
    // Precedence is by specificity, so a duplicate ties and file order decides — meaning a
    // "rotation" done by pasting a new entry above the old one would appear to do nothing.
    expect(() =>
      parseConfig(
        'github:\n  tokens:\n    - owner: acme\n      pat: "old"\n    - owner: Acme\n      pat: "new"\n',
        'test.yaml',
        {},
      ),
    ).toThrow(/same host\/owner\/repo/)
  })

  it('accepts repo: "owner/name" as one string, producing the split form (rockysurf-ly2n)', () => {
    // The way a repository is named everywhere else — in a URL, in `gh repo clone`, on the
    // page you copied it from. It is split at parse time, so what comes out is byte for byte
    // what the two-line form produces, including the lowercasing.
    const config = parseConfig(
      'github:\n  tokens:\n    - repo: "Acme/Widgets"\n      pat: "${ACME_PAT}"\n',
      'test.yaml',
      { ACME_PAT: 'ghp_widgets' },
    )
    expect(config.github.tokens).toEqual([{ owner: 'acme', repo: 'widgets', pat: 'ghp_widgets' }])
  })

  it('revalidates each half of a one-string repo by the same character rules', () => {
    // The sugar must not become a hole in the rule that keeps `secrets.env` sourceable: the
    // halves land in exactly the fields they would have been written in, and are checked there.
    expect(() =>
      parseConfig('github:\n  tokens:\n    - repo: "a b/widgets"\n      pat: "x"\n', 'test.yaml', {}),
    ).toThrow(/owner may contain only/)
    expect(() =>
      parseConfig('github:\n  tokens:\n    - repo: "acme/wid gets"\n      pat: "x"\n', 'test.yaml', {}),
    ).toThrow(/repo may contain only/)
    // More than one slash is not a repository, and guessing which segment is the owner would
    // be inventing an answer the operator did not give.
    expect(() =>
      parseConfig('github:\n  tokens:\n    - repo: "acme/widgets/src"\n      pat: "x"\n', 'test.yaml', {}),
    ).toThrow(/exactly one slash/)
  })

  it('still requires owner for a repo written without a slash', () => {
    // Unchanged from ta7g, and deliberately so: the sugar is what you write INSTEAD of `owner`,
    // never a licence to omit it. Same rule, same message.
    expect(() =>
      parseConfig('github:\n  tokens:\n    - repo: widgets\n      pat: "x"\n', 'test.yaml', {}),
    ).toThrow(/repo requires owner/)
  })

  it('refuses a slashed repo alongside an owner, naming both readings', () => {
    // Two different owners for one token. Either could be meant, so the error quotes both
    // rather than silently preferring one — the wrong guess sends a token to the wrong account.
    expect(() =>
      parseConfig(
        'github:\n  tokens:\n    - owner: globex\n      repo: "acme/widgets"\n      pat: "x"\n',
        'test.yaml',
        {},
      ),
    ).toThrow(/repo "acme\/widgets" already names an owner.*acme\/widgets.*globex\/widgets/s)
  })

  it('treats the one-string and split forms as the same entry when checking duplicates', () => {
    // They ARE the same entry, so this must be the same refusal as writing it twice the long
    // way — otherwise the sugar would be a way to sneak a duplicate past the check, tie on
    // specificity, and leave the second token silently unused.
    expect(() =>
      parseConfig(
        'github:\n  tokens:\n' +
          '    - repo: "acme/widgets"\n      pat: "old"\n' +
          '    - owner: acme\n      repo: widgets\n      pat: "new"\n',
        'test.yaml',
        {},
      ),
    ).toThrow(/same host\/owner\/repo/)
  })

  it('refuses a scope that would break the shell that sources secrets.env', () => {
    // These values are written into `secrets.env`, which the box loads with `set -a; . file`.
    // A space or a quote would not be a bad match — it would be a broken source that takes
    // every other secret on the box down with it. Rejected at boot, in the file, by name.
    expect(() =>
      parseConfig('github:\n  tokens:\n    - owner: "a b"\n      pat: "x"\n', 'test.yaml', {}),
    ).toThrow(/owner may contain only/)
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

  /**
   * THE TWO ANSWERS TO ONE UNSET VARIABLE (rockysurf-1z5q).
   *
   * Boot asks "can this file run?" and an unset variable is genuinely no. A save asks "may this
   * file be written?" and an unset variable is the ORDINARY case, because the settings page asks
   * for a variable name and the variable is exported afterwards. Both readings go through this
   * one module, so the pair is asserted together — if the lenient path ever starts throwing, or
   * the boot path ever stops, the failure names the difference rather than a route.
   */
  describe('the lenient reading, for a caller that carries on', () => {
    it('leaves an unset reference exactly as written, and names it', () => {
      const { value, unset } = interpolateTreeLeniently({ github: { pat: '${PRIVATE_THING_PAT}' } }, {})
      expect(value).toEqual({ github: { pat: '${PRIVATE_THING_PAT}' } })
      expect(unset).toEqual(['PRIVATE_THING_PAT'])
    })

    it('still substitutes the variables that ARE set, in the same pass', () => {
      const { value, unset } = interpolateTreeLeniently(
        { a: '${SET}', b: '${UNSET}', c: '${SET}-${UNSET}' },
        { SET: 'here' },
      )
      expect(value).toEqual({ a: 'here', b: '${UNSET}', c: 'here-${UNSET}' })
      expect(unset).toEqual(['UNSET'])
    })

    it('keeps $${VAR} an escape rather than reporting it as unset', () => {
      const { value, unset } = interpolateTreeLeniently({ pass: '$${NOT_A_VAR}' }, {})
      expect(value).toEqual({ pass: '${NOT_A_VAR}' })
      expect(unset).toEqual([])
    })

    it('reports every unset name once, across the whole tree', () => {
      const { unset } = interpolateTreeLeniently(
        { a: '${ONE}', b: ['${TWO}', '${ONE}'], c: { d: '${TWO}' } },
        {},
      )
      expect(unset).toEqual(['ONE', 'TWO'])
    })

    it('does not change what BOOT does with the same document', () => {
      const err = configErrorFrom(() => parseConfig('github:\n  pat: "${PRIVATE_THING_PAT}"\n', 'test.yaml', {}))
      expect(err.message).toContain('${PRIVATE_THING_PAT}')
      expect(err.message).toContain('are not set')
    })
  })

  /**
   * THE CHECK THE SETTINGS ROUTE RUNS. Same YAML parse, same schema, one deliberate difference:
   * an unset variable is a warning that passes rather than an issue that refuses.
   */
  describe('checkConfigText', () => {
    const TOKENS = 'github:\n  tokens:\n    - repo: "acme/private-thing"\n      pat: "${PRIVATE_THING_PAT}"\n'

    it('passes a file whose only problem is a variable this environment lacks', () => {
      const checked = checkConfigText(TOKENS, {})
      expect(checked.ok).toBe(true)
      expect(checked.warnings.map((w) => w.variable)).toEqual(['PRIVATE_THING_PAT'])
      // Addressed to the field that references it, so the editor can put it on that control.
      expect(checked.warnings[0]?.path).toBe('github.tokens.0.pat')
      expect(checked.warnings[0]?.message).toContain('${PRIVATE_THING_PAT}')
      expect(checked.warnings[0]?.message).toContain('before the next restart')
    })

    it('withholds the parsed config while a variable is unset, rather than offering a fake one', () => {
      // The tree still holds `${PRIVATE_THING_PAT}` where a token belongs. Handing that back as a
      // Config would be offering a caller something that looks bootable and is not.
      const checked = checkConfigText(TOKENS, {})
      expect(checked.ok && checked.config).toBeUndefined()
      const set = checkConfigText(TOKENS, { PRIVATE_THING_PAT: 'ghp_real' })
      expect(set.warnings).toEqual([])
      expect(set.ok && set.config?.github.tokens[0]?.pat).toBe('ghp_real')
    })

    it('still refuses a structural mistake standing next to a warning', () => {
      // A bad `owner` and an unset variable in the same entry: one is a refusal, one is not.
      const checked = checkConfigText(
        'github:\n  tokens:\n    - owner: "not a name"\n      pat: "${PRIVATE_THING_PAT}"\n',
        {},
      )
      expect(checked.ok).toBe(false)
      expect(checked.ok === false && checked.issues.map((i) => i.path)).toContain('github.tokens.0.owner')
      expect(checked.warnings.map((w) => w.variable)).toEqual(['PRIVATE_THING_PAT'])
    })

    it('still refuses two entries covering one scope, warning or not', () => {
      const checked = checkConfigText(
        'github:\n  tokens:\n    - repo: "a/b"\n      pat: "${ONE}"\n    - repo: "a/b"\n      pat: "${TWO}"\n',
        {},
      )
      expect(checked.ok).toBe(false)
      expect(checked.ok === false && checked.issues.length).toBeGreaterThan(0)
    })

    it('still refuses bad YAML, with no warnings to soften it', () => {
      const checked = checkConfigText('github:\n  tokens: [\n', {})
      expect(checked.ok).toBe(false)
      expect(checked.ok === false && checked.issues[0]?.path).toBe('(file)')
      expect(checked.warnings).toEqual([])
    })

    /**
     * A reference standing where a NUMBER belongs. The substitution had nothing to put there,
     * so the schema sees a string and says "expected number" — about a field whose only real
     * problem is the warning already sitting on it. Reporting both would send the operator to
     * fix a field that is not broken.
     */
    it('does not also report a type error against a field that is waiting on a variable', () => {
      const checked = checkConfigText('server:\n  port: "${ROCKYSURF_PORT}"\n', {})
      expect(checked.ok).toBe(true)
      expect(checked.warnings.map((w) => w.path)).toEqual(['server.port'])
    })
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

/**
 * A COMMAND THAT READS PART OF THE CONFIG (rockysurf-dd9q).
 *
 * `rockysurf token` and `rockysurf mcp` are the two, and the environment they run in is not the
 * operator's: an MCP client launches `rockysurf mcp` from a `.mcp.json` with only the variables
 * that file sets. Boot's rule — every `${VAR}` the file names must be set — therefore made an
 * installation with one repository token in its config unable to serve MCP at all, and the
 * workaround was exporting dummy values for secrets the command never reads.
 */
describe('loading a config for a command that reads part of it', () => {
  const TOKENS =
    'server:\n  dataDir: "/srv/rocky"\nmcp:\n  scopes: [read, create]\n' +
    'github:\n  tokens:\n    - repo: "acme/private-thing"\n      pat: "${PRIVATE_THING_PAT}"\n'

  const requiring = (requires: Parameters<typeof parseConfigLenientlyRequiring>[1], text = TOKENS) =>
    parseConfigLenientlyRequiring(text, requires, 'test.yaml', {})

  it('reads the settings it names in an environment that sets none of the variables', () => {
    const config = requiring((c) => ({ 'server.dataDir': c.server.dataDir }))
    expect(config.server.dataDir).toBe('/srv/rocky')
    expect(config.mcp.scopes).toEqual(['read', 'create'])
  })

  // The whole point: boot still refuses the very file this just read, naming the variable.
  it('does not change what BOOT does with the same file', () => {
    const err = configErrorFrom(() => parseConfig(TOKENS, 'test.yaml', {}))
    expect(err.message).toContain('${PRIVATE_THING_PAT}')
  })

  it('refuses when a setting it DOES read is the one waiting on a variable', () => {
    const err = configErrorFrom(() =>
      requiring((c) => ({ 'server.dataDir': c.server.dataDir }), 'server:\n  dataDir: "${ROCKY_DATA}"\n'),
    )
    expect(err.message).toContain('${ROCKY_DATA}')
    // Named where it is written, so the operator does not have to find it.
    expect(err.message).toContain('server.dataDir')
  })

  /**
   * The residual the doc comment states rather than shades: a reference in a field the schema
   * must COERCE cannot survive lenient interpolation, because `${PORT}` left as written is not a
   * number and there is no `Config` to hand back. It stays fatal — but it is reported as the
   * variable it is, not as "expected number", which would send the operator to fix a field whose
   * only problem is the variable.
   */
  it('names the variable, not the type, when an unset one lands in a coerced field', () => {
    const err = configErrorFrom(() => requiring(() => ({}), 'server:\n  port: ${PORT}\n'))
    expect(err.message).toContain('${PORT}')
    expect(err.message).toContain('server.port')
    expect(err.message).not.toContain('expected number')
  })

  it('still refuses a file that is wrong for a reason no variable would fix', () => {
    const err = configErrorFrom(() =>
      requiring(() => ({}), 'server:\n  porrt: 3000\ngithub:\n  pat: "${SOME_PAT}"\n'),
    )
    expect(err.message).toContain('is not valid')
    expect(err.message).toContain('porrt')
  })

  it('still refuses a file that is not YAML at all', () => {
    expect(configErrorFrom(() => requiring(() => ({}), 'server: [\n')).message).toContain('not valid YAML')
  })

  // `$${VAR}` is an escape yielding the literal text `${VAR}`, which a scan of the RESULT cannot
  // tell from a reference nobody resolved. The unset list is what decides.
  it('does not mistake an escaped reference for an unresolved one', () => {
    const config = requiring((c) => ({ 'github.pat': c.github.pat }), 'github:\n  pat: "$${LITERAL}"\n')
    expect(config.github.pat).toBe('${LITERAL}')
  })

  it('finds a reference nested inside a value it reads, not just a bare one', () => {
    const err = configErrorFrom(() =>
      requiring(
        (c) => ({ 'github.tokens': c.github.tokens }),
        'github:\n  tokens:\n    - repo: "acme/thing"\n      pat: "${NESTED_PAT}"\n',
      ),
    )
    expect(err.message).toContain('${NESTED_PAT}')
  })

  it('reads the same file, from disk, that loadConfig would refuse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rockysurf-lenient-'))
    try {
      writeFileSync(join(dir, 'rockysurf.config.yaml'), TOKENS)
      const options = { argv: [], cwd: dir, home: dir, env: {} }
      expect(
        loadConfigLeniently({ ...options, requires: (c) => ({ 'mcp.scopes': c.mcp.scopes }) }).config.mcp.scopes,
      ).toEqual(['read', 'create'])
      expect(configErrorFrom(() => loadConfig(options)).message).toContain('${PRIVATE_THING_PAT}')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
    // Deliberately a name no cloud has. This test used `gcp` until `@rockysurf/provider-gcp`
    // landed (rockysurf-ev41.6) and it started asserting the opposite of what it meant — the
    // hazard of illustrating "unknown" with a real product's name on a roadmap that has more
    // providers on it.
    const err = configErrorFrom(() => parseConfig('providers:\n  nimbus:\n    enabled: true\n', 'test.yaml', {}))
    expect(err.message).toContain('providers.nimbus')
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
  it('accepts --config <path> and --config=<path>', () => {
    expect(resolveConfigPath({ argv: ['--config', '/etc/rs.yaml'], cwd: '/srv/app' })).toBe('/etc/rs.yaml')
    expect(resolveConfigPath({ argv: ['--config=/etc/rs.yaml'], cwd: '/srv/app' })).toBe('/etc/rs.yaml')
  })

  it('resolves a relative --config against cwd', () => {
    expect(resolveConfigPath({ argv: ['--config', 'conf/rs.yaml'], cwd: '/srv/app' })).toBe('/srv/app/conf/rs.yaml')
  })

  it('ignores unrelated arguments', () => {
    expect(resolveConfigPath({ argv: ['--verbose', '--config', '/etc/rs.yaml', '--port', '1'], cwd: '/srv/app' })).toBe(
      '/etc/rs.yaml',
    )
  })

  it('rejects --config with no value', () => {
    expect(() => resolveConfigPath({ argv: ['--config'], cwd: '/srv/app' })).toThrow(ConfigError)
    expect(() => resolveConfigPath({ argv: ['--config', '--verbose'], cwd: '/srv/app' })).toThrow(ConfigError)
  })

  /**
   * THE SEARCH ORDER (rockysurf-8wgm), driven against real directories because every tier below
   * the flag is a question about what exists on disk.
   *
   * `home` is always passed. Defaulting it to the real `homedir()` is right for the product and
   * wrong for a test: a test that let it default would read — and its conclusions would depend
   * on — whatever config file the person running it happens to keep in their own home.
   */
  describe('the search order', () => {
    let root: string
    let cwd: string
    let home: string

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'rockysurf-order-'))
      cwd = join(root, 'work')
      home = join(root, 'home')
      mkdirSync(cwd, { recursive: true })
      mkdirSync(join(home, '.rockysurf'), { recursive: true })
    })

    afterEach(() => {
      rmSync(root, { recursive: true, force: true })
    })

    const cwdFile = () => join(cwd, 'rockysurf.config.yaml')
    const homeFile = () => join(home, '.rockysurf', 'config.yaml')

    it('takes ./rockysurf.config.yaml when it is there', () => {
      writeFileSync(cwdFile(), 'server:\n  port: 4321\n')
      expect(resolveConfigSource({ argv: [], cwd, home })).toMatchObject({
        path: cwdFile(),
        explicit: false,
        origin: 'cwd',
      })
    })

    it('takes ~/.rockysurf/config.yaml when the working directory has none', () => {
      writeFileSync(homeFile(), 'server:\n  port: 4322\n')
      expect(resolveConfigSource({ argv: [], cwd, home })).toMatchObject({
        path: homeFile(),
        explicit: false,
        origin: 'home',
      })
      expect(loadConfig({ argv: [], cwd, home, env: {} }).server.port).toBe(4322)
    })

    /**
     * MIGRATION, stated as a test. Someone who already runs this from a checkout with a config
     * beside it must keep loading THAT file after the home tier exists — otherwise a home file
     * written for one instance silently reconfigures every other directory's.
     */
    it('prefers the working directory over the home file when both exist', () => {
      writeFileSync(cwdFile(), 'server:\n  port: 4321\n')
      writeFileSync(homeFile(), 'server:\n  port: 4322\n')
      expect(resolveConfigSource({ argv: [], cwd, home }).path).toBe(cwdFile())
      expect(loadConfig({ argv: [], cwd, home, env: {} }).server.port).toBe(4321)
    })

    it('lets --config beat both of them', () => {
      const named = join(root, 'elsewhere.yaml')
      writeFileSync(named, 'server:\n  port: 4323\n')
      writeFileSync(cwdFile(), 'server:\n  port: 4321\n')
      writeFileSync(homeFile(), 'server:\n  port: 4322\n')
      expect(resolveConfigSource({ argv: ['--config', named], cwd, home })).toMatchObject({
        path: named,
        explicit: true,
        origin: 'flag',
      })
      expect(loadConfig({ argv: ['--config', named], cwd, home, env: {} }).server.port).toBe(4323)
    })

    /**
     * NO CIRCULARITY. `server.dataDir` defaults to `~/.rockysurf`, which is the directory the
     * home config file sits in — so it is tempting to describe the config as living in the data
     * directory. It does not: `dataDir` is a SETTING, and this file is what sets it. A home
     * config that points `dataDir` somewhere else entirely is still found at the literal
     * `~/.rockysurf/config.yaml`, because resolution never reads a config to find a config.
     */
    it('finds the home file at the literal ~/.rockysurf, whatever dataDir says', () => {
      const elsewhere = join(root, 'data-somewhere-else')
      writeFileSync(homeFile(), `server:\n  dataDir: ${JSON.stringify(elsewhere)}\n  port: 4324\n`)
      const loaded = loadConfigWithSource({ argv: [], cwd, home, env: {} })
      expect(loaded.source.path).toBe(homeFile())
      expect(loaded.config.server.dataDir).toBe(elsewhere)
      expect(loaded.config.server.port).toBe(4324)
    })

    it('reports no file at all, and points at the home file as the one to create', () => {
      const source = resolveConfigSource({ argv: [], cwd, home })
      expect(source).toEqual({
        path: homeFile(),
        explicit: false,
        origin: 'none',
        searched: [cwdFile(), homeFile()],
      })
    })

    /**
     * rockysurf-nb6e: `boot({ configPath })` was accepted by the type system and dropped on the
     * floor, and resolution then fell back to `process.argv` — invisible for the real binary,
     * and a test that thought it had named a scratch file reaching the operator's real one.
     */
    it('honours a programmatic configPath, over argv and over both searched files', () => {
      const named = join(root, 'programmatic.yaml')
      writeFileSync(named, 'server:\n  port: 4325\n')
      writeFileSync(cwdFile(), 'server:\n  port: 4321\n')
      writeFileSync(join(root, 'from-argv.yaml'), 'server:\n  port: 4326\n')

      expect(resolveConfigSource({ configPath: named, argv: ['--config', join(root, 'from-argv.yaml')], cwd, home })).toMatchObject(
        { path: named, explicit: true, origin: 'flag' },
      )
      expect(loadConfig({ configPath: named, argv: [], cwd, home, env: {} }).server.port).toBe(4325)
      // Relative, against cwd — the same rule `--config` follows.
      expect(resolveConfigSource({ configPath: 'rel.yaml', cwd, home }).path).toBe(join(cwd, 'rel.yaml'))
      // And it is explicit, so a typo is fatal rather than a silent fall back to defaults.
      const err = configErrorFrom(() => loadConfig({ configPath: join(root, 'absent.yaml'), cwd, home, env: {} }))
      expect(err.message).toContain('no config file at')
    })
  })
})

describe('loadConfig from disk', () => {
  let dir: string
  /** A home with no config file in it, so these cases never depend on the real one. */
  let home: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'rockysurf-config-'))
    home = mkdtempSync(join(tmpdir(), 'rockysurf-home-'))
    writeFileSync(join(dir, 'rockysurf.config.yaml'), 'server:\n  port: 4321\n')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  it('reads the default filename from cwd', () => {
    expect(loadConfig({ argv: [], cwd: dir, home, env: {} }).server.port).toBe(4321)
  })

  /**
   * rockysurf-cf51. The two halves of "a missing file" — and they are genuinely different
   * events, which is why `resolveConfigSource` reports which one happened.
   */
  it('starts on defaults when there is no config file anywhere', () => {
    const empty = join(dir, 'nope')
    const notices: string[] = []
    const config = loadConfig({ argv: [], cwd: empty, home, env: {}, notice: (m) => notices.push(m) })

    // The defaults a first run gets: the documented port, loopback, and a data directory in the
    // operator's home rather than in whatever directory npx happened to be run from.
    expect(config.server.port).toBe(3000)
    expect(config.server.host).toBe('127.0.0.1')
    expect(config.server.dataDir).toBe(join(homedir(), '.rockysurf'))

    // ...and it says so, naming BOTH places it looked (rockysurf-8wgm) — the second of which is
    // the one a save from the settings page would create.
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain(join(empty, 'rockysurf.config.yaml'))
    expect(notices[0]).toContain(join(home, '.rockysurf', 'config.yaml'))
    expect(notices[0]).toContain('defaults')
  })

  /**
   * CHANGED BY rockysurf-8wgm, deliberately. cf51 asserted silence here, and silence was right
   * when there was one place a config file could be. With three, "it started" no longer implies
   * "it read the file I edited", so a start names the file — in one line.
   */
  it('names the file it loaded, in one line', () => {
    const notices: string[] = []
    loadConfig({ argv: [], cwd: dir, home, env: {}, notice: (m) => notices.push(m) })
    expect(notices).toEqual([`config: ${join(dir, 'rockysurf.config.yaml')}`])
  })

  it('still refuses a --config path with nothing at it, and names the path', () => {
    const missing = join(dir, 'nope', 'rockysurf.config.yaml')
    const err = configErrorFrom(() => loadConfig({ argv: ['--config', missing], cwd: dir, home, env: {} }))
    expect(err.message).toContain('no config file at')
    expect(err.message).toContain(missing)
    expect(err.message).toContain('--config')
  })

  it('reports whether the operator named the file', () => {
    expect(resolveConfigSource({ argv: [], cwd: dir, home })).toMatchObject({
      path: join(dir, 'rockysurf.config.yaml'),
      explicit: false,
      origin: 'cwd',
    })
    expect(resolveConfigSource({ argv: ['--config', 'rs.yaml'], cwd: '/srv/app', home })).toMatchObject({
      path: '/srv/app/rs.yaml',
      explicit: true,
      origin: 'flag',
    })
    expect(resolveConfigSource({ argv: ['--config=/etc/rs.yaml'], cwd: '/srv/app', home })).toMatchObject({
      path: '/etc/rs.yaml',
      explicit: true,
      origin: 'flag',
    })
  })
})

/** Parse without interpolating, to inspect what the document references. */
function parseYamlForTest(text: string): unknown {
  return parseYaml(text)
}

/**
 * One provider block from the example config, with every commented-out OPTION turned on.
 *
 * An option is a line whose key sits at the section's own indent (exactly four spaces once the
 * `# ` is stripped) and starts lowercase — which keeps prose out: `# NOTE: arm64 …` starts
 * uppercase, a pasted URL or nested `hosts:` list entry sits deeper. The residual constraint
 * this puts on the example file's PROSE: a comment line must not open with a lowercase
 * `word: ` (reflow the sentence), or it is read as an option and fails loudly here as an
 * unrecognized key — the acceptable direction of error, since this test exists to catch the
 * silent one. Where the file offers a key twice — the example shows `sshAllowedCidr` as both
 * a `/32` and the open-to-the-world form — the last one wins, which is the more permissive of
 * the two and therefore the one worth proving parses.
 */
function extractProviderBlock(yaml: string, provider: string): { yaml: string; options: Map<string, string> } {
  const lines = yaml.split('\n')
  const start = lines.findIndex((line) => line.trimEnd() === `  ${provider}:`)
  if (start === -1) throw new Error(`no ${provider} block in the example config`)

  const kept = new Map<string, string>()
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    // The block ends at the next key indented less deeply than its own contents.
    if (line.trim() !== '' && !line.startsWith('    ')) break

    const option = /^ {4}(?:# ?)?([a-z][a-zA-Z0-9]*):\s+(\S.*)$/.exec(line)
    if (!option) continue
    kept.set(option[1] ?? '', (option[2] ?? '').replace(/\s+#.*$/, ''))
  }

  return {
    yaml: [`  ${provider}:`, ...[...kept].map(([key, value]) => `    ${key}: ${value}`)].join('\n'),
    options: kept,
  }
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

  /**
   * THE p5jr SHAPE, CHECKED FOR EVERY PROVIDER SECTION.
   *
   * A provider section here is a `strictObject`, so a field the provider accepts and this
   * schema omits is not merely undocumented — it is unusable, and the operator's error names an
   * unrecognized key rather than the real problem. That is exactly what a missing `allowAllCidr`
   * did to the AWS section: three documents told operators to write a line core then refused —
   * and this test, then pointed at gcp alone, was the one mechanism built to catch it
   * (rockysurf-p5jr). So every provider block now gets parsed with EVERY commented option
   * turned on, and every documented key must survive into the parsed section.
   */
  it('accepts every provider block with every documented option turned on', () => {
    for (const provider of ['hetzner', 'aws', 'azure', 'gcp', 'byo'] as const) {
      const { yaml, options } = extractProviderBlock(exampleConfig, provider)
      const config = parseConfig(
        `providers:\n${yaml}`,
        `${provider} block from rockysurf.config.example.yaml`,
        { HETZNER_TOKEN: 'hz_example' },
      )
      expect(options.size, `the ${provider} block documents no options at all`).toBeGreaterThan(1)
      const parsed: Record<string, unknown> = config.providers[provider]
      for (const key of options.keys()) {
        expect(parsed[key], `${provider}.${key} is documented in the example config but lost in parsing`).toBeDefined()
      }
    }
  })

  it('accepts the gcp block with every documented option turned on', () => {
    const { yaml: uncommented } = extractProviderBlock(exampleConfig, 'gcp')
    const config = parseConfig(
      `providers:\n${uncommented}`,
      'gcp block from rockysurf.config.example.yaml',
      {},
    )

    expect(config.providers.gcp).toMatchObject({
      // `false` is what the file ships, and turning it on is the operator's decision — what
      // this test is about is that every other field is ACCEPTED.
      enabled: false,
      projectId: 'my-project-123456',
      zone: 'us-central1-a',
      sshAllowedCidr: '0.0.0.0/0',
      allowAllCidr: true,
      managedBy: 'rockysurf',
      firewallRuleName: 'rockysurf-ssh',
      network: 'default',
      bootDiskGb: 20,
      bootDiskType: 'pd-balanced',
      imageProject: 'ubuntu-os-cloud',
      imageFamilyPrefix: 'ubuntu-2404-lts',
    })
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

/**
 * `preferences.tiers` — the saved machine type per size, per cloud (issue #124).
 *
 * Three properties, and each is a way this could have gone wrong: an installation that has
 * never heard of the block still parses; a typo in a cloud's name is an error rather than a
 * setting that silently does nothing; and a preference the operator's own allowlist would
 * refuse is caught at boot rather than falling back on every create for a year.
 */
describe('saved machine types (issue #124)', () => {
  it('defaults to nothing saved, so an installation that never used it is unaffected', () => {
    const config = configSchema.parse({})
    expect(config.preferences.tiers.aws).toEqual({})
    expect(config.preferences.tiers.gcp.small).toBeUndefined()
  })

  it('reads a saved type for a size on a cloud', () => {
    const config = parseConfig(
      `
preferences:
  tiers:
    aws:
      small: t4g.medium
      large: c7g.2xlarge
`,
      'test.yaml',
      {},
    )
    expect(config.preferences.tiers.aws.small).toBe('t4g.medium')
    expect(config.preferences.tiers.aws.large).toBe('c7g.2xlarge')
    expect(config.preferences.tiers.aws.medium).toBeUndefined()
  })

  it('accepts the section written bare, with every size commented out', () => {
    // The trap `section()` exists for: YAML parses a key with no children as `null`, and all
    // three of omitted / `{}` / bare mean "nothing saved".
    const config = parseConfig('preferences:\n  tiers:\n    aws:\n', 'test.yaml', {})
    expect(config.preferences.tiers.aws).toEqual({})
  })

  it('refuses a cloud it has never heard of, rather than ignoring the line', () => {
    expect(() => parseConfig('preferences:\n  tiers:\n    awz:\n      small: t4g.small\n', 'test.yaml', {})).toThrow(
      ConfigError,
    )
  })

  it('refuses a size it has never heard of', () => {
    expect(() =>
      parseConfig('preferences:\n  tiers:\n    aws:\n      enormous: x1e.32xlarge\n', 'test.yaml', {}),
    ).toThrow(ConfigError)
  })

  /**
   * THE PAIRING CHECK. `providers.<cloud>.sizes` narrows every catalogue before anything
   * resolves against it, so a preference outside that list can never be chosen — the resolver
   * would fall back on every create, silently, forever. Caught at boot with the fix named.
   */
  it('refuses a saved type the operator own allowlist excludes, and says how to fix it', () => {
    let message = ''
    try {
      parseConfig(
        `
providers:
  aws:
    sizes: ["t4g.small", "t4g.medium"]
preferences:
  tiers:
    aws:
      small: m7g.large
`,
        'test.yaml',
        {},
      )
    } catch (err) {
      message = (err as ConfigError).message
    }
    expect(message).toContain('preferences.tiers.aws.small')
    expect(message).toContain('providers.aws.sizes')
  })

  it('accepts a saved type that IS in the allowlist', () => {
    const config = parseConfig(
      `
providers:
  aws:
    sizes: ["t4g.small", "t4g.medium"]
preferences:
  tiers:
    aws:
      small: t4g.medium
`,
      'test.yaml',
      {},
    )
    expect(config.preferences.tiers.aws.small).toBe('t4g.medium')
  })

  it('says nothing about a cloud with no allowlist, which offers everything', () => {
    const config = parseConfig('preferences:\n  tiers:\n    gcp:\n      large: c4a-standard-4\n', 'test.yaml', {})
    expect(config.preferences.tiers.gcp.large).toBe('c4a-standard-4')
  })
})
