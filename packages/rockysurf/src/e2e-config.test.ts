import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadConfig } from '@rockysurf/core'
import { awsConfigSchema } from '@rockysurf/provider-aws'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * THE CONFIG FILE THE REAL-CLOUD NIGHTLY BOOTS ON, VALIDATED ON A PULL REQUEST.
 *
 * `scripts/e2e/lifecycle.mjs` writes a `rockysurf.config.yaml` and starts the shipped binary on
 * it. Until issue #343 nothing checked that file until the scheduled nightly ran it against a
 * real cloud account: #327 added `securityGroupName` to the AWS section so CI would fill its own
 * SSH group instead of the one a real user's box shares, core's schema — a strict object, and the
 * thing that actually validates the file — had no such key, and both AWS legs died in two seconds
 * on `Unrecognized key: "securityGroupName"` for two nights running, having touched nothing.
 *
 * The nightly is the most expensive check in the project and the last one to run. "Is this file
 * even valid" belongs here instead: milliseconds, no credential, no network, and red on the pull
 * request that breaks it.
 *
 * THIS PACKAGE, AND NOT CORE, because the second half of the check needs both core's schema and a
 * concrete provider's, and this is the one package allowed to import both (the composition root —
 * `scripts/check-core-deps.mjs`).
 *
 * The e2e module is imported at RUN time from a path built here rather than with a static
 * `import`: it lives outside this package, and this package's `tsc` type-checks everything under
 * `src` against its own module resolution, which does not reach the repository's scripts. The
 * same reason `bin.e2e.test.ts` reaches for the repository root the way it does.
 */

const e2eConfigPath = fileURLToPath(new URL('../../../scripts/e2e/e2e-config.mjs', import.meta.url))
const e2eConfig = (await import(pathToFileURL(e2eConfigPath).href)) as {
  buildConfigYaml: (options: Record<string, unknown>) => string
  CI_SSH_SG_NAME: string
}

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/**
 * Validate config text exactly as the binary does: through the real loader, from a real file.
 *
 * `loadConfig` is the function `boot()` calls, so a file this accepts is a file the nightly's
 * `rockysurf` process starts on — which is the whole claim these tests make. An empty `env`
 * keeps `${VAR}` interpolation from reaching the machine running the suite.
 */
function validate(text: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'rockysurf-e2e-config-'))
  tempDirs.push(dir)
  const configPath = join(dir, 'rockysurf.config.yaml')
  writeFileSync(configPath, text)
  loadConfig({ configPath, env: {} })
}

/** The arguments a run supplies, with every cloud's fields filled — the builder picks its own. */
const RUN = {
  port: 3287,
  dataDir: '/tmp/rockysurf-e2e/data',
  cidr: '203.0.113.7/32',
  // Not a credential and not shaped like one: the real token is read at run time from the
  // operator's own file and never appears in this repository.
  hetznerToken: 'not-a-real-token',
  gcpProject: 'rockysurf-ci',
  gcpZone: 'us-central1-a',
  azureSubscription: '00000000-0000-0000-0000-000000000000',
  azureResourceGroup: 'rockysurf-ci-rg',
  azureLocation: 'westus3',
  awsRegion: 'us-east-1',
  awsSecurityGroupName: e2eConfig.CI_SSH_SG_NAME,
  awsProfile: '',
}

describe('the config file the real-cloud lifecycle writes', () => {
  for (const cloud of ['aws', 'azure', 'gcp', 'hetzner'] as const) {
    it(`is one core will boot on — ${cloud}`, () => {
      expect(() => validate(e2eConfig.buildConfigYaml({ ...RUN, cloud }))).not.toThrow()
    })
  }

  it('still names the CI-only SSH group on the AWS leg, and validates with it', () => {
    // The regression itself (#343). The isolation #327 added is only real if the file carrying it
    // gets past validation — a run that never starts fills no group at all.
    const text = e2eConfig.buildConfigYaml({ ...RUN, cloud: 'aws' })
    expect(text).toContain(`securityGroupName: ${e2eConfig.CI_SSH_SG_NAME}`)
    expect(e2eConfig.CI_SSH_SG_NAME).toBe('rockysurf-nightly-ssh')
    expect(() => validate(text)).not.toThrow()
  })

  it('names a profile when the run resolves one, and omits the key when it does not', () => {
    expect(e2eConfig.buildConfigYaml({ ...RUN, cloud: 'aws', awsProfile: 'rockysurf-e2e' })).toContain(
      'profile: rockysurf-e2e',
    )
    expect(e2eConfig.buildConfigYaml({ ...RUN, cloud: 'aws' })).not.toContain('profile:')
  })
})

/**
 * Injected by the composition root from the `pricing` section, never written by an operator, so
 * core's `providers.aws` deliberately has nowhere to put them. See `pricingExtras` in compose.ts.
 */
const INJECTED = new Set(['pricesUrl', 'pricesRefreshHours'])

/** One legal value per operator-settable AWS field, as an operator would write it. */
const EVERY_AWS_FIELD: Record<string, string> = {
  region: 'us-east-1',
  profile: 'rockysurf',
  sshAllowedCidr: '203.0.113.7/32',
  allowAllCidr: 'false',
  managedBy: 'rockysurf',
  securityGroupName: 'rockysurf-nightly-ssh',
  rootVolumeGb: '20',
  amiParameterPrefix: '/aws/service/canonical/ubuntu/server/24.04/stable/current',
}

describe('core’s config file accepts every field the AWS provider accepts', () => {
  it('has a value for every field the provider declares, so this cannot go stale', () => {
    const declared = Object.keys(awsConfigSchema.shape).filter((key) => !INJECTED.has(key))
    expect(Object.keys(EVERY_AWS_FIELD).sort()).toEqual(declared.sort())
  })

  it('validates a section using all of them at once', () => {
    // The property #343 broke, stated directly: this strict object is what reads the operator's
    // file, so a field only the provider knows about is not undocumented — it is unusable, and
    // the error names an unrecognized key rather than the real problem.
    const section = Object.entries(EVERY_AWS_FIELD).map(([key, value]) => `    ${key}: ${value}`)
    const text = ['providers:', '  aws:', '    enabled: true', ...section, ''].join('\n')
    expect(() => validate(text)).not.toThrow()
  })
})
