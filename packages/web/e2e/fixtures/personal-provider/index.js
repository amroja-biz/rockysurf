/**
 * "Nimbus" — a personal provider the browser suite loads by PATH (ADR-0026).
 *
 * Plain JavaScript with no dependencies, because that is what the loader has to cope with: a
 * package that resolves its own copy of nothing, exports a factory the way `docs/writing-a-provider.md`
 * says, and declares `simulatedInstances` so a server created on it needs no machine. It is not
 * a workspace package and is never built; `control-plane.ts` names its directory in the config
 * it boots on, disabled, so the Settings page has a personal panel to draw and the New Server
 * page is unchanged until a test switches it on.
 */

const OFFERINGS = [
  { id: 'n-small', cpu: 2, memoryGb: 4, arch: 'amd64', hourly: null, available: true, region: 'sky-1' },
]

const instances = new Map()

/** @type {import('@rockysurf/provider-sdk').ProviderFactory<Record<string, unknown>>} */
const factory = {
  id: 'nimbus',
  displayName: 'Nimbus Cloud',
  credentialField: 'token',
  credentialEnv: ['NIMBUS_TOKEN'],
  configSchema: {
    parse(input) {
      if (input === null || typeof input !== 'object') throw new Error('nimbus: config must be an object')
      const config = /** @type {Record<string, unknown>} */ (input)
      if (typeof config.token !== 'string' || config.token === '') {
        throw Object.assign(new Error('nimbus: token is required'), {
          issues: [{ path: ['token'], message: 'token is required: set providers.nimbus.token to "${NIMBUS_TOKEN}"' }],
        })
      }
      return config
    },
  },
  createProvider(config) {
    return {
      id: 'nimbus',
      displayName: 'Nimbus Cloud',
      capabilities: {
        stop: true,
        ipStableAcrossStop: true,
        canInjectHostKeys: false,
        userDataMaxBytes: 0,
        generatesUserData: false,
        simulatedInstances: true,
      },
      async validateCredentials() {},
      async validateSpec() {},
      async listOfferings() {
        return OFFERINGS.map((o) => ({ ...o, region: String(config.region ?? o.region) }))
      },
      async provision(spec) {
        const id = `n-${instances.size + 1}`
        instances.set(id, { state: 'running', serverId: spec.serverId })
        return { data: { id }, initial: { state: 'running', publicIp: '203.0.113.42' } }
      },
      async describe(data) {
        const found = instances.get(String(data.id))
        return found ? { state: found.state, publicIp: '203.0.113.42' } : { state: 'terminated' }
      },
      async terminate(data) {
        instances.delete(String(data.id))
      },
      async listManaged() {
        return [...instances.entries()].map(([id, row]) => ({
          kind: 'instance',
          providerNativeId: id,
          ownership: 'server-owned',
          serverId: row.serverId,
        }))
      },
      async stop(data) {
        const found = instances.get(String(data.id))
        if (found) found.state = 'stopped'
      },
      async start(data) {
        const found = instances.get(String(data.id))
        if (found) found.state = 'running'
      },
    }
  },
}

export default factory
