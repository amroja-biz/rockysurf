import { z } from 'zod'

/**
 * BYO provider configuration — the authoritative shape core's `providers.byo` section defers to.
 *
 * REGISTRATION FRICTION, the same one `provider-hetzner/src/config.ts` records: core defines
 * `providers.byo` itself, because the dependency lint forbids core from importing a concrete
 * provider and the types-only SDK cannot export a zod schema. So this schema and core's section
 * describe the same thing twice and can drift. Two consequences worth knowing before editing:
 *
 *  1. every field here must exist in core's `byoHostSchema` too, or an operator cannot set it —
 *     core's section is a `strictObject` and rejects what it has not heard of;
 *  2. every field core's section has must be accepted here, for the mirror-image reason.
 */

/**
 * One machine the operator already owns.
 *
 * Note which account is which, because BYO has two and confusing them is the mistake this
 * comment exists to prevent:
 *
 *  - `user` is the ADMIN login the PROVIDER claims the host with. It needs root, or passwordless
 *    sudo. Default `root`, which is what an operator's existing access usually is.
 *  - the account CORE later connects as is not configured here at all. It is
 *    {@link byoConfigSchema}'s `sshUser`, it defaults to `rocky` to match core's own
 *    `servers.ssh_user` default, and the provider CREATES it during `provision()` — that is the
 *    step that stands in for cloud-init on a provider with no pre-boot hook.
 */
export const byoHostSchema = z.strictObject({
  /** What the operator calls this box. Also its offering id, and its `listManaged()` identity. */
  name: z.string().trim().min(1),
  /** Hostname or IP core and the provider both connect to. */
  host: z.string().trim().min(1),
  /** The admin login the PROVIDER claims with — not the account core uses. */
  user: z.string().trim().min(1).default('root'),
  port: z.coerce.number().int().min(1).max(65535).default(22),
  /**
   * `SHA256:…` the host must present.
   *
   * Optional, and the difference is a security posture rather than a convenience:
   *
   *  - SUPPLIED — strict verification from the very first connection. The operator has read the
   *    fingerprint off the box itself, so there is no window in which core trusts an unverified
   *    key.
   *  - OMITTED — trust-on-first-use. The key seen on the first connection is recorded and pinned,
   *    and every later connection is strict against it. Weaker, because the first connection is
   *    unverified, and the UI should say so.
   *
   * A mismatch is refused either way, and is never retried: a box presenting a different key is
   * not the box the operator registered.
   */
  fingerprint: z.string().trim().min(1).optional(),
  /**
   * Private key file the provider authenticates to this host with. Falls back to the provider's
   * `identityFile`, then to the SSH agent named by `SSH_AUTH_SOCK`.
   *
   * A path, never key material: the file stays where the operator's own SSH already keeps it,
   * and nothing copies it into a config file or the database.
   */
  identityFile: z.string().trim().min(1).optional(),
})

export type ByoHost = z.output<typeof byoHostSchema>

export const byoConfigSchema = z.strictObject({
  hosts: z
    .array(byoHostSchema)
    .default([])
    // `hosts:` with every entry commented out parses as null — the same trap core's schema
    // absorbs, absorbed here too so the two agree on what an empty list looks like.
    .or(z.null().transform(() => [] as ByoHost[])),

  /**
   * Default private key for every host that does not name its own.
   *
   * Optional: with an SSH agent running, an operator who can already `ssh` to these boxes needs
   * no key configuration at all.
   */
  identityFile: z.string().trim().min(1).optional(),

  /**
   * The account core will connect as, which this provider creates on each host it claims.
   *
   * MUST match core's `servers.ssh_user`, whose default is `rocky` — core has no per-server
   * override, so a value that disagrees produces a box core cannot log into. It is settable
   * because an operator whose fleet standardises on another name should not have to fight the
   * default, not because it is routinely changed.
   */
  sshUser: z.string().trim().min(1).default('rocky'),

  /**
   * The `managed-by` tag value this provider owns. `validateSpec()` refuses a spec that
   * disagrees (ADR-0003, D3).
   */
  managedBy: z.string().trim().min(1).default('rockysurf'),

  /**
   * Region label reported on every offering. `Offering.region` is a required non-empty string
   * and hardware in a rack has no cloud region, so this names where it actually is.
   */
  region: z.string().trim().min(1).default('on-prem'),
})

export type ByoProviderConfig = z.output<typeof byoConfigSchema>

/** The parsed config plus the injection points tests and callers may override. */
export type ByoProviderInput = ByoProviderConfig & {
  /** Overrides the real ssh2 client. Tests use it; production never sets it. */
  connect?: import('./ssh.js').Connector
  /** Overrides `process.env.SSH_AUTH_SOCK` lookup. */
  agentSocket?: string
  connectTimeoutMs?: number
}
