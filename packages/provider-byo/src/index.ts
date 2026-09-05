/**
 * `@rockysurf/provider-byo` — the machines the operator already has.
 *
 * The enterprise story, and the only provider with no cloud API behind it: the "API" is sshd on
 * a box that was running before Rocky Surf existed. What that removes is most of a provider —
 * there is nothing to create, nothing to bill, nothing to power-cycle — and what it leaves is a
 * REGISTRY of hosts plus a CLAIM: `provision()` takes a registered host, prepares it, and marks
 * it held; `terminate()` gives it back.
 *
 * Three consequences, each visible in the capabilities and each honest about a limitation:
 *
 *  - **`generatesUserData: false`.** No pre-boot hook, so core renders no `#cloud-config` and
 *    `provision()` does over SSH what cloud-init does before boot: create the account core will
 *    connect as, install core's authorized keys, grant passwordless sudo. Everything after that
 *    is the push bootstrap both clouds already run, which is what makes BYO a subset of the
 *    existing mechanism rather than a second one.
 *  - **`canInjectHostKeys: false`,** which follows: with no user-data there is nowhere to put a
 *    host key before first contact. The key is learned instead — trust-on-first-use inside this
 *    package, pinned from then on, mismatch refused — and what core receives is a fingerprint to
 *    verify strictly, not a trust decision to make. See `ssh.ts`.
 *  - **`stop: false`.** Core does not own the power state of a machine it did not create. Per
 *    ADR-0003 (A2) both methods still exist and both throw.
 *
 * `terminate()` NEVER runs anything on the host. It is the operator's machine; releasing a claim
 * is bookkeeping, not demolition.
 */

export {
  byoConfigSchema,
  byoHostSchema,
  type ByoHost,
  type ByoProviderConfig,
  type ByoProviderInput,
} from './config.js'

export {
  assertSafeAccount,
  buildPrepareScript,
  parseHostFacts,
  PROBE_SCRIPT,
  type HostFacts,
} from './prepare.js'

export {
  asByoData,
  BYO_CAPABILITIES,
  BYO_PROVIDER_ID,
  makeByoProvider,
  type ByoData,
} from './provider.js'

export {
  connectOverSsh,
  fingerprintFromBlob,
  HostKeyMismatchError,
  scriptCommand,
  shellQuote,
  toProviderError,
  type ConnectOptions,
  type Connector,
  type ExecResult,
  type HostConnection,
} from './ssh.js'

import type { ProviderFactory } from '@rockysurf/provider-sdk'
import { byoConfigSchema, type ByoProviderConfig } from './config.js'
import { BYO_PROVIDER_ID, makeByoProvider } from './provider.js'

/**
 * The package's default export. `createProvider` is synchronous and side-effect free — it opens
 * no connection and reads no key file — so core can load this provider and show its identity
 * before anything has been asked of the operator's machines. Reachability is proven separately,
 * by `validateCredentials()`.
 */
export const byoProviderFactory: ProviderFactory<ByoProviderConfig> = {
  id: BYO_PROVIDER_ID,
  displayName: 'Bring your own hosts',
  configSchema: byoConfigSchema,
  createProvider: (config) => makeByoProvider(config),
  /**
   * THE SETTINGS PANEL, DECLARED HERE (ADR-0027, issue #370) — and the first shipped provider to
   * declare a LIST. `hosts` is the shape `ProviderSettingList` was written for: a card per entry,
   * an Add form that reveals blank, and six boxes that each need their own sentence rather than
   * the list's repeated six times. The prose moved verbatim out of core's `settings/fields.ts`,
   * its `SETTINGS_LISTS` entry and the SPA's hand-written block, all three of which are gone.
   *
   * `offering.allowlist: false` because BYO has no `sizes` key and should not grow one: its
   * machine types ARE the hosts listed below, so an allowlist over them is the list itself.
   * `offering.label` because the panel is titled "Your own machines" and its sentences say
   * "whenever you ask your own machines for a small box".
   *
   * NO CREDENTIAL FIELD, for the third distinct reason among these providers: there is no cloud
   * API to authenticate to. `identityFile` is a PATH to a key the operator's own SSH already
   * holds — never key material — and with an agent running it is not needed at all.
   */
  settings: {
    title: 'Your own machines',
    help:
      'Machines you already have, managed over SSH. Claiming one creates a `rocky` account on it with ' +
      'passwordless sudo; releasing it hands it back to the pool and undoes nothing on your machine.',
    fields: [
      {
        name: 'identityFile',
        kind: 'string',
        label: 'Default private key path',
        example: '~/.ssh/id_ed25519',
        help:
          'A path to the private key used to log in to every host below — never the key itself, which ' +
          'stays where your own SSH keeps it. Leave it unset to use your SSH agent: if you can already ' +
          '`ssh` to these machines, that is usually enough.',
      },
    ],
    lists: [
      {
        name: 'hosts',
        label: 'Hosts',
        help: 'The machines Rocky Surf may claim. Enabling the provider above requires at least one.',
        itemFields: [
          {
            name: 'name',
            label: 'Name',
            kind: 'string',
            help: 'What you will call this machine in the UI. It is also how a new server picks the host.',
          },
          { name: 'host', label: 'Address', kind: 'string', help: 'The hostname or IP address Rocky Surf connects to.' },
          {
            name: 'user',
            label: 'Admin login',
            kind: 'string',
            help:
              'The admin login Rocky Surf claims the machine with; it needs root or passwordless sudo. This ' +
              'is not the account it later connects as — that one is `rocky`, and it is created for you.',
          },
          { name: 'port', label: 'SSH port', kind: 'number', help: 'The SSH port, when it is not 22.' },
          {
            name: 'fingerprint',
            label: 'Host key fingerprint',
            kind: 'string',
            help:
              'Optional host key fingerprint, from `ssh-keyscan` piped through `ssh-keygen -lf`. Supplying it ' +
              'means even the first connection is verified; omit it to trust the key on first connect.',
          },
          {
            /**
             * A PATH, never key material — the schema says so at its declaration and it is worth
             * repeating here, because it is the one field in this panel that could be mistaken
             * for a secret. The key stays where the operator's own SSH keeps it.
             */
            name: 'identityFile',
            label: 'Private key path',
            kind: 'string',
            help: 'A private key for this machine alone, overriding the default above. A path, never the key itself.',
          },
        ],
        // `user` and `port` have schema defaults and the rest are optional, so the form only
        // insists on the two things a host cannot be reached without.
        add: { noun: 'host', example: { name: 'build-box', host: '10.0.0.1' }, required: ['name', 'host'] },
        labelField: 'name',
        empty: 'None yet. Enabling this provider requires at least one host.',
      },
    ],
    offering: { noun: 'host', example: 'the-nuc-under-the-desk', label: 'your own machines', allowlist: false },
  },
}

export default byoProviderFactory
