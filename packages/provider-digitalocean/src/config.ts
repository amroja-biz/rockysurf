import { normalizeSshCidrs, opensSshToTheInternet, type ConfigSchema } from '@rockysurf/provider-sdk'

/**
 * DigitalOcean provider configuration, validated by hand.
 *
 * WHY NOT ZOD, WHICH EVERY SHIPPED PROVIDER USES. This package is the reference PERSONAL provider
 * (ADR-0026): it is extracted under `<dataDir>/providers` by an operator or by the provider shop,
 * and the shop's installer never runs `npm install` — it refuses an install whose manifest
 * declares a runtime dependency that does not resolve from the install directory. So this package
 * declares no runtime dependencies at all, and the one validator it would otherwise carry is
 * written out below instead. The SDK's `ConfigSchema<T>` is structurally `{ parse(input): T }`
 * exactly so this is a supported choice rather than a workaround.
 *
 * The contract a hand-written schema still has to keep, because core and conformance both lean on
 * it:
 *
 *  - **Strict.** An unknown key is an error, not a shrug. That is what turns `regoin: nyc3` into a
 *    boot message naming the key instead of a provider that silently created droplets in the
 *    wrong place. (`enabled`, `package` and `sizes` never arrive here — the composition root
 *    strips core's three fields before this is called.)
 *  - **Idempotent.** `parse(parse(x))` must succeed: conformance re-parses a valid config with one
 *    field substituted, and core re-parses on every config reload.
 *  - **Instructions, not diagnoses.** Every message below is the thing to do. The operator sees
 *    this text on the Settings page and in the boot log, and it is the whole of their debugging
 *    experience.
 */

/** An IPv4 CIDR block: four octets and a prefix length. */
const CIDR_V4 = /^(\d{1,3}\.){3}\d{1,3}\/(3[0-2]|[12]?\d)$/

/** A DigitalOcean VPC id is a UUID. */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * A firewall name DigitalOcean will accept, and one an operator can recognise as Rocky Surf's.
 *
 * The name is the ONLY proof of authorship this cloud offers (ADR-0021's whole-object amendment),
 * so it is a configured value with a default rather than something derived: an operator who runs
 * two installations against one account needs two names, and `syncSshAccess()` converges exactly
 * the object this names and nothing else.
 */
export const DEFAULT_FIREWALL_NAME = 'rockysurf-ssh'

/** DigitalOcean's Ubuntu 24.04 LTS image slug. */
export const DEFAULT_IMAGE = 'ubuntu-24-04-x64'

export interface DigitaloceanProviderConfig {
  /** Personal access token, read/write. Never stored anywhere by Rocky Surf (issue #280). */
  token: string
  /** The region every droplet is created in — `nyc3`, `fra1`, `lon1`. */
  region: string
  /** The base image. Overridable because pack authors may want a different Ubuntu LTS. */
  image: string
  /** The networks allowed to reach port 22, normalized. `undefined` only with `allowAllCidr`. */
  sshAllowedCidr: string[] | undefined
  /** The second act of the two-act guard around `0.0.0.0/0`. */
  allowAllCidr: boolean
  /** The name of the one firewall object this provider owns and converges. */
  firewallName: string
  /** The `managed-by` tag value this provider owns and refuses to disagree with. */
  managedBy: string
  /** Optional VPC. DigitalOcean puts a droplet in the region's default VPC when this is absent. */
  vpcUuid?: string
}

export interface ConfigIssue {
  path: string[]
  message: string
}

/**
 * What a rejected config throws.
 *
 * `issues` is not decoration: the composition root's `describeConfigError` reads that array when
 * it is present and joins every problem into the sentence an operator sees, so a file with three
 * mistakes in it reports three rather than the first.
 */
export class DigitaloceanConfigError extends Error {
  override readonly name = 'DigitaloceanConfigError'
  readonly issues: ConfigIssue[]

  constructor(issues: ConfigIssue[]) {
    super(issues.map((issue) => issue.message).join(' '))
    this.issues = issues
  }
}

const KNOWN_KEYS = [
  'token',
  'region',
  'image',
  'sshAllowedCidr',
  'allowAllCidr',
  'firewallName',
  'managedBy',
  'vpcUuid',
] as const

function parseConfig(input: unknown): DigitaloceanProviderConfig {
  const issues: ConfigIssue[] = []
  const fail = (path: string[], message: string) => issues.push({ path, message })

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new DigitaloceanConfigError([
      { path: [], message: 'the providers.digitalocean section must be a block of settings.' },
    ])
  }
  const raw = input as Record<string, unknown>

  for (const key of Object.keys(raw)) {
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
      fail([key], `providers.digitalocean.${key} is not a setting this provider has — remove it. Its settings are ${KNOWN_KEYS.join(', ')}.`)
    }
  }

  const requiredString = (key: string, instruction: string): string => {
    const value = raw[key]
    if (typeof value !== 'string' || value.trim().length === 0) {
      fail([key], instruction)
      return ''
    }
    return value.trim()
  }

  const optionalString = (key: string, fallback: string): string => {
    const value = raw[key]
    if (value === undefined) return fallback
    if (typeof value !== 'string' || value.trim().length === 0) {
      fail([key], `providers.digitalocean.${key} must be a non-empty string when it is set.`)
      return fallback
    }
    return value.trim()
  }

  const token = requiredString(
    'token',
    'a DigitalOcean personal access token is required: write `token: "${DIGITALOCEAN_TOKEN}"` in the config file, or export DIGITALOCEAN_TOKEN and restart.',
  )
  const region = requiredString(
    'region',
    'providers.digitalocean.region is required: name the region droplets are created in, e.g. "nyc3". There is no default — a guessed region creates billable machines somewhere nobody chose.',
  )
  const image = optionalString('image', DEFAULT_IMAGE)
  const firewallName = optionalString('firewallName', DEFAULT_FIREWALL_NAME)
  const managedBy = optionalString('managedBy', 'rockysurf')

  let vpcUuid: string | undefined
  if (raw['vpcUuid'] !== undefined) {
    const value = raw['vpcUuid']
    if (typeof value !== 'string' || !UUID.test(value.trim())) {
      fail(['vpcUuid'], 'providers.digitalocean.vpcUuid must be a VPC UUID. Leave it out and droplets go in the region\'s default VPC.')
    } else {
      vpcUuid = value.trim()
    }
  }

  let allowAllCidr = false
  if (raw['allowAllCidr'] !== undefined) {
    if (typeof raw['allowAllCidr'] !== 'boolean') {
      fail(['allowAllCidr'], 'providers.digitalocean.allowAllCidr must be true or false.')
    } else {
      allowAllCidr = raw['allowAllCidr']
    }
  }

  /*
   * A LIST, required, with NO default (ADR-0021). A bare string is read as a list of one so an
   * older file keeps loading; an empty list is refused, because a whitelist allowing nothing is a
   * lockout dressed as a setting. Normalized with the SDK's helper rather than by hand: the list
   * is diffed against what the cloud reports, and two providers disagreeing about whether
   * ` 10.0.0.0/8 ` and `10.0.0.0/8` are one entry shows up as a change that never converges.
   */
  let sshAllowedCidr: string[] | undefined
  const rawCidr = raw['sshAllowedCidr']
  if (rawCidr !== undefined) {
    const entries = typeof rawCidr === 'string' ? [rawCidr] : rawCidr
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string')) {
      fail(['sshAllowedCidr'], 'providers.digitalocean.sshAllowedCidr must be a CIDR block or a list of them, e.g. ["203.0.113.7/32"].')
    } else {
      const normalized = normalizeSshCidrs(entries as string[])
      const bad = normalized.filter((entry) => !CIDR_V4.test(entry))
      if (bad.length > 0) {
        fail(['sshAllowedCidr'], `sshAllowedCidr entries must be IPv4 CIDR blocks, e.g. "203.0.113.7/32" — ${bad.join(', ')} ${bad.length === 1 ? 'is not one' : 'are not'}.`)
      } else if (normalized.length === 0) {
        fail(['sshAllowedCidr'], 'sshAllowedCidr must name at least one network. An empty list would leave SSH reachable from nowhere, which is never what an edit to this setting intends — add the replacement before removing the last entry.')
      } else {
        sshAllowedCidr = normalized
      }
    }
  }

  if (sshAllowedCidr === undefined && !allowAllCidr && !issues.some((issue) => issue.path[0] === 'sshAllowedCidr')) {
    fail(
      ['sshAllowedCidr'],
      'sshAllowedCidr is required: state which network may reach SSH, e.g. "203.0.113.7/32". To open SSH to the whole internet, set allowAllCidr: true as well — deliberately.',
    )
  }

  if (sshAllowedCidr !== undefined && opensSshToTheInternet(sshAllowedCidr) && !allowAllCidr) {
    fail(
      ['sshAllowedCidr'],
      '0.0.0.0/0 additionally requires allowAllCidr: true. Opening SSH to the internet is two decisions, not one. ANY entry in the list being 0.0.0.0/0 opens SSH to the whole internet — the other entries do not narrow it.',
    )
  }

  if (issues.length > 0) throw new DigitaloceanConfigError(issues)

  return {
    token,
    region,
    image,
    sshAllowedCidr,
    allowAllCidr,
    firewallName,
    managedBy,
    ...(vpcUuid !== undefined ? { vpcUuid } : {}),
  }
}

/** The `ConfigSchema<DigitaloceanProviderConfig>` the factory hands to core. */
export const digitaloceanConfigSchema: ConfigSchema<DigitaloceanProviderConfig> = { parse: parseConfig }

/**
 * The CIDRs the shared firewall will actually authorize, after both guards have passed.
 *
 * The `?? ['0.0.0.0/0']` is not a default for the setting — the schema refuses a config that omits
 * `sshAllowedCidr` unless `allowAllCidr: true` is present, so the only way to reach that branch is
 * to have asked for the whole internet, twice, in writing.
 */
export function resolveSshCidrs(config: DigitaloceanProviderConfig): string[] {
  return config.sshAllowedCidr ?? ['0.0.0.0/0']
}
