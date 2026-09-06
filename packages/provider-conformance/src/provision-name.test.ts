import { describe, expect, it } from 'vitest'
import { assertProvisionNameFromServerId, ConformanceError } from './index.js'

/**
 * The name assertion's own tests (issue #409).
 *
 * Every case below is one a real provider produced: the create that sent the display name and
 * was refused by the cloud, the create that sent the serverId and was accepted, and the probe
 * written with a display name that could not have caught either.
 */

const SPEC = { serverId: 'do-skill-retest', name: 'DO skill retest 2' }

describe('assertProvisionNameFromServerId', () => {
  it('accepts a provider that names the instance for the serverId', () => {
    expect(() =>
      assertProvisionNameFromServerId(SPEC, [
        { name: SPEC.serverId, region: 'nyc3', tags: [`server-id:${SPEC.serverId}`] },
      ]),
    ).not.toThrow()
  })

  it('accepts a documented derivation of the serverId', () => {
    expect(() => assertProvisionNameFromServerId(SPEC, [{ name: `rockysurf-${SPEC.serverId}` }])).not.toThrow()
  })

  it('rejects a provider that sends the human display name', () => {
    expect(() => assertProvisionNameFromServerId(SPEC, [{ name: SPEC.name }])).toThrow(ConformanceError)
  })

  it('rejects the display name wherever it appears, not only in a field called name', () => {
    expect(() =>
      assertProvisionNameFromServerId(SPEC, [`POST /v2/droplets?hostname=${SPEC.name}`]),
    ).toThrow(/display name/)
  })

  it('rejects a provider that sent the serverId nowhere at all', () => {
    expect(() => assertProvisionNameFromServerId(SPEC, [{ name: 'box-1' }])).toThrow(/never sent/)
  })

  it('refuses a probe whose display name a hostname could hold, rather than passing it', () => {
    // This is the mistake the check exists to prevent: a spec whose two names are both
    // hostname-safe passes against a provider that sends either one.
    expect(() =>
      assertProvisionNameFromServerId({ serverId: 'box-1', name: 'box-1' }, [{ name: 'box-1' }]),
    ).toThrow(/display name a hostname could not hold/)
  })

  it('refuses to pass when nothing was captured', () => {
    expect(() => assertProvisionNameFromServerId(SPEC, [])).toThrow(/no requests were captured/)
  })
})
