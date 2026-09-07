/**
 * "Metal Cloud" — the provider the browser suite boots ENABLED, loaded by PATH (ADR-0026).
 *
 * WHY THE SUITE NEEDS ONE. The New Server page has nothing to draw without a provider that
 * offers machines, and every shipped cloud reaches a real API for its offerings — a credential
 * this suite must not have, a network call CI must not depend on, and a bill. This fixture's
 * machine types are the entries named in the config file `control-plane.ts` writes, so the page
 * renders a complete, honest picker and no packet leaves the machine. Nothing here is ever
 * dialled: no test in this suite creates a server on it.
 *
 * WHY IT DECLARES A LIST. `ProviderSettingList` (ADR-0027) is the shape a provider whose
 * configuration is a repeated sub-object needs, and no provider Rocky Surf ships declares one
 * (issue #446). Declaring it here is what keeps the renderer that draws it — `genericList` in
 * `SettingsPage.tsx`, built from `settings/inventory.ts` — covered in a real browser.
 *
 * NO DEPENDENCIES, plain JavaScript, never built: the loader has to cope with a package that
 * resolves its own copy of nothing.
 */

const machinesOf = (config) => (Array.isArray(config.machines) ? config.machines : [])

/** @type {import('@rockysurf/provider-sdk').ProviderFactory<Record<string, unknown>>} */
const factory = {
  id: 'metalcloud',
  displayName: 'Metal Cloud',
  /**
   * THE PANEL, DECLARED (ADR-0027): one plain string field and one LIST, which is the reason
   * this fixture exists in the shape it does. The labels below are what the browser suite
   * asserts, so a declaration the page ignored would fail there rather than nowhere.
   *
   * `offering.allowlist: false` because the machine types ARE the entries listed below, so a
   * second allowlist over them would be a control for a config key that does not exist.
   */
  settings: {
    title: 'Metal Cloud',
    help: 'A fixture cloud for the browser suite: its machines are the entries below and nothing is billed.',
    fields: [
      {
        name: 'identityFile',
        kind: 'string',
        label: 'Default private key path',
        example: '~/.ssh/id_ed25519',
        help: 'A path to the private key used for every machine below — never the key itself.',
      },
    ],
    lists: [
      {
        name: 'machines',
        label: 'Machines',
        help: 'The machines this fixture offers. Enabling the provider above requires at least one.',
        itemFields: [
          { name: 'name', label: 'Name', kind: 'string', help: 'What this machine is called in the UI.' },
          { name: 'host', label: 'Address', kind: 'string', help: 'The hostname or IP address.' },
          { name: 'user', label: 'Admin login', kind: 'string', help: 'The admin login, which needs passwordless sudo.' },
          { name: 'port', label: 'SSH port', kind: 'number', help: 'The SSH port, when it is not 22.' },
          { name: 'fingerprint', label: 'Host key fingerprint', kind: 'string', help: 'Optional; supplying it verifies even the first connection.' },
          { name: 'identityFile', label: 'Private key path', kind: 'string', help: 'A key for this machine alone. A path, never the key itself.' },
        ],
        add: { noun: 'machine', example: { name: 'build-box', host: '10.0.0.1' }, required: ['name', 'host'] },
        labelField: 'name',
        empty: 'None yet. Enabling this provider requires at least one machine.',
      },
    ],
    offering: { noun: 'machine', example: 'workshop', label: 'Metal Cloud', allowlist: false },
  },
  configSchema: {
    parse(input) {
      if (input === null || typeof input !== 'object') throw new Error('metalcloud: config must be an object')
      const config = /** @type {Record<string, unknown>} */ (input)
      if (machinesOf(config).length === 0) {
        throw Object.assign(new Error('metalcloud: at least one machine is required'), {
          issues: [{ path: ['machines'], message: 'list at least one machine under providers.metalcloud.machines' }],
        })
      }
      return config
    },
  },
  createProvider(config) {
    const machines = machinesOf(config)
    return {
      id: 'metalcloud',
      displayName: 'Metal Cloud',
      capabilities: {
        /* A machine this provider did not create is not one it may power off. */
        stop: false,
        ipStableAcrossStop: true,
        canInjectHostKeys: false,
        userDataMaxBytes: 0,
        generatesUserData: false,
        simulatedInstances: true,
      },
      /**
       * A CREDENTIAL CHECK THAT CAN FAIL, ON PURPOSE (issue #450).
       *
       * The Settings page proves an enabled Provider's credentials after a save, and the browser
       * suite has to drive both answers a real cloud gives — accepted and rejected — without a
       * credential, a network call or a bill. This fixture's credential is the private key it
       * would log in with, so it refuses when no key path is configured for a machine and passes
       * once one is: the operator flips between the two states from the Settings page itself,
       * which is exactly the loop the issue is about.
       *
       * The refusal is a `ProviderError` by CONTRACT rather than by construction — an `Error`
       * named `ProviderError` carrying one of the nine frozen codes, which `isProviderError`
       * accepts (see `provider-sdk/src/errors.ts`) — because this fixture takes no dependencies.
       */
      async validateCredentials() {
        const unreachable = machines
          .filter((machine) => !machine.identityFile && !config.identityFile)
          .map((machine) => String(machine.name))
        if (unreachable.length > 0) {
          throw Object.assign(
            new Error(
              `metalcloud: no private key is configured for ${unreachable.join(', ')} — set a default ` +
                'private key path, or one on the machine itself',
            ),
            { name: 'ProviderError', code: 'auth', providerCode: 'NoIdentityFile' },
          )
        }
      },
      async validateSpec() {},
      /** One offering per configured machine — the same idea as a cloud's machine-type catalogue. */
      async listOfferings() {
        return machines.map((machine) => ({
          id: String(machine.name),
          cpu: 2,
          memoryGb: 4,
          arch: 'amd64',
          /* Unknown, never free: nobody has told this fixture what its machines cost. */
          hourly: null,
          available: true,
        }))
      },
      async provision(spec) {
        return { data: { id: spec.offeringId }, initial: { state: 'running', publicIp: '203.0.113.9' } }
      },
      async describe(data) {
        return machines.some((machine) => String(machine.name) === String(data.id))
          ? { state: 'running', publicIp: '203.0.113.9' }
          : { state: 'terminated' }
      },
      async terminate() {},
      async listManaged() {
        return []
      },
    }
  },
}

export default factory
