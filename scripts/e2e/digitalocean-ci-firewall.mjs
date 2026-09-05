/**
 * The one place the nightly's DigitalOcean firewall name is written (issue #369).
 *
 * WHY THE NIGHTLY MAY NOT USE THE PROVIDER'S DEFAULT NAME. On DigitalOcean the cloud firewall is
 * a WHOLE OBJECT Rocky Surf owns and rewrites: an inbound rule is `{ protocol, ports, sources }`
 * with no name and no description, so authorship cannot live on the rule and lives on the object
 * instead (ADR-0021's amendment, S2). `syncSshAccess()` therefore converges the object named here
 * to exactly the configured list, in one `PUT`, and anything else that was on it is gone.
 *
 * That is correct behaviour and it is also why the nightly must not point at `rockysurf-ssh`, the
 * provider's default. A run resolves the GitHub runner's address fresh every morning; if it
 * converged the object a person's own Rocky Surf owns, it would replace their allow-list with a
 * runner IP that stops existing an hour later — locking them out of every droplet in the account
 * at once. The AWS leg learned the shared-object version of this in #326/#327 and the fix is the
 * same shape: a CI-only name, written once, imported by everything that touches it.
 *
 * `scripts/e2e/e2e-config.mjs` writes it into the config the run boots on, `scripts/e2e/lifecycle.mjs`
 * builds the audit provider with it, and `packages/rockysurf/src/e2e-config.test.ts` asserts the
 * config still carries it — so the three cannot drift apart.
 *
 * It is a DIFFERENT KIND of isolation from the AWS group's, and the difference is worth stating:
 * the AWS sweep empties its group afterwards, because provision there never revokes. Here nothing
 * needs emptying — the object is converged whole on every sync — so this name exists purely to
 * keep the nightly's converge off an object a human owns.
 */
export const CI_FIREWALL_NAME = 'rockysurf-nightly-ssh'

/**
 * The npm name the nightly installs under the run's `<dataDir>/providers`.
 *
 * DigitalOcean is a PERSONAL provider (ADR-0026): the composition root does not name it, so the
 * nightly has to install it the way a self-hoster does before core can compose it. Written here
 * so the config text, the installer and the test all say the same string.
 */
export const DIGITALOCEAN_PACKAGE = '@rockysurf/provider-digitalocean'

/**
 * The region the nightly creates droplets in.
 *
 * There is no default in the provider, deliberately — a guessed region creates billable machines
 * somewhere nobody chose — so the run states one. `nyc3` carries the full Basic size catalogue and
 * is the region DigitalOcean's own examples use.
 */
export const CI_REGION = 'nyc3'
