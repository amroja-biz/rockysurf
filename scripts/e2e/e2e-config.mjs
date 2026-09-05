/**
 * The `rockysurf.config.yaml` the real-cloud lifecycle run boots on — as a pure function.
 *
 * WHY THIS IS A MODULE OF ITS OWN (issue #343). This text used to be assembled inline in
 * `lifecycle.mjs`, tangled up with the network lookup that resolves the run's public address and
 * the file write that lands it in a temp directory, so the only thing that ever checked it was
 * the scheduled nightly — against a real cloud account, twenty minutes and one billing event
 * later. #327 added `securityGroupName` here to pin CI to its own SSH group; core's config
 * schema, which is a strict object and is what actually validates the file, had no such key. Both
 * AWS legs then died in two seconds on `Unrecognized key: "securityGroupName"` for two nights
 * running, having touched nothing at all.
 *
 * Split out so `packages/rockysurf/src/e2e-config.test.ts` can build the exact text for every
 * cloud and hand it to core's own loader on a pull request, in milliseconds, with no credential
 * and no network. The nightly is a poor place to discover that a config file is invalid: it is
 * the most expensive check in the project and the last one to run.
 *
 * NOTHING HERE MAY REACH THE NETWORK, THE FILESYSTEM OR THE ENVIRONMENT. Every value the text
 * needs arrives as an argument, which is what lets the test call it. The caller owns the
 * decisions — the public address in particular, which `lifecycle.mjs` resolves once, logs, and
 * writes down, because a firewall rule is a reviewable decision rather than an inference.
 */

/** The CI-only SSH group name, so the config the test builds names the group the nightly names. */
export { CI_SSH_SG_NAME } from './aws-ci-ssh-sg.mjs'

/** The same idea on DigitalOcean, plus the package name and region that leg boots on (#369). */
export { CI_FIREWALL_NAME, CI_REGION, DIGITALOCEAN_PACKAGE } from './digitalocean-ci-firewall.mjs'

/**
 * Build the config text for one cloud.
 *
 * @param {object} options
 * @param {'aws'|'azure'|'gcp'|'hetzner'|'digitalocean'} options.cloud
 * @param {number} options.port                 the port core listens on for this run
 * @param {string} options.dataDir              the run's scratch data directory
 * @param {string} [options.cidr]               `sshAllowedCidr`, already resolved by the caller
 * @param {string} [options.hetznerToken]       Hetzner only
 * @param {string} [options.gcpProject]         GCP only
 * @param {string} [options.gcpZone]            GCP only
 * @param {string} [options.azureSubscription]  Azure only
 * @param {string} [options.azureResourceGroup] Azure only
 * @param {string} [options.azureLocation]      Azure only
 * @param {string} [options.awsRegion]          AWS only
 * @param {string} [options.awsSecurityGroupName] AWS only — the SSH group this run may fill
 * @param {string} [options.awsProfile]         AWS only; omit for the default credential chain
 * @param {string} [options.digitaloceanPackage]      DigitalOcean only — the npm name to compose
 * @param {string} [options.digitaloceanRegion]       DigitalOcean only
 * @param {string} [options.digitaloceanFirewallName] DigitalOcean only — the CI-only firewall
 * @returns {string} the complete file, newline-terminated
 */
export function buildConfigYaml({
  cloud,
  port,
  dataDir,
  cidr,
  hetznerToken,
  digitaloceanPackage,
  digitaloceanRegion,
  digitaloceanFirewallName,
  gcpProject,
  gcpZone,
  azureSubscription,
  azureResourceGroup,
  azureLocation,
  awsRegion,
  awsSecurityGroupName,
  awsProfile,
}) {
  const lines = [`server:`, `  port: ${port}`, `  dataDir: ${dataDir}`, `providers:`]

  if (cloud === 'hetzner') {
    lines.push(`  hetzner:`, `    enabled: true`, `    token: ${hetznerToken}`, `    location: fsn1`)
  } else if (cloud === 'digitalocean') {
    /*
     * THE ONLY SECTION HERE THAT IS NOT A SHIPPED PROVIDER (issue #369, ADR-0026).
     *
     * DigitalOcean is a PERSONAL provider: the composition root does not name it, so core reads
     * this section through the catchall, resolves `package` against `<dataDir>/providers`, and
     * hands everything else to the package's own hand-written schema. The run therefore has to
     * install the package into that directory before it starts core — `installPersonalProvider()`
     * in lifecycle.mjs does it, by extracting the packed tarball with plain `tar`, which is the
     * recipe docs/self-hosting.md gives a self-hoster and the one the shop's installer follows.
     *
     * NO `token` KEY, AND THAT IS DELIBERATE. The factory declares `credentialEnv: ['DIGITALOCEAN_TOKEN']`
     * (E18), so the composition root reads the token out of the environment when the field is
     * absent. Writing it here instead would work and would be worse twice over: it puts a live
     * credential in a file for no reason, and it would leave the personal-provider credential path
     * — the one thing about this provider's wiring that nothing else in CI exercises — unproven.
     *
     * `firewallName` is the CI-only name, for the reason spelled out in digitalocean-ci-firewall.mjs:
     * a DigitalOcean sync converges the whole object, so a nightly pointed at the provider's
     * default would replace a person's allow-list with a runner address that expires by lunchtime.
     */
    lines.push(
      `  digitalocean:`,
      `    enabled: true`,
      `    package: "${digitaloceanPackage}"`,
      `    region: ${digitaloceanRegion}`,
      `    firewallName: ${digitaloceanFirewallName}`,
      `    sshAllowedCidr: ${cidr}`,
    )
  } else if (cloud === 'gcp') {
    // NO `keyFile`, ever. The credential comes from the ambient ADC chain, which in CI is the
    // federated credential file `google-github-actions/auth` wrote from GitHub's own OIDC token
    // and locally is `gcloud auth application-default login`. There is no long-lived key in
    // either path, and the config schema has nowhere to put key material anyway.
    lines.push(
      `  gcp:`,
      `    enabled: true`,
      `    projectId: ${gcpProject}`,
      `    zone: ${gcpZone}`,
      `    sshAllowedCidr: ${cidr}`,
    )
  } else if (cloud === 'azure') {
    // NO SECRET, ever — the Azure config schema has nowhere to put one. The credential comes
    // from `CredentialChain`, which in CI is workload identity federation: the three standard
    // AZURE_* variables and a file holding GitHub's own OIDC token (gh issue #170).
    //
    // `allowAzureCli: false` IS LOAD-BEARING HERE, NOT HARDENING THEATRE. The nightly's sweep
    // step logs `az` in as the CI-ONLY identity on the same runner, so a chain permitted to fall
    // through to `az account get-access-token` could quietly run the lifecycle as the sweep
    // account — every check would pass and the run would prove nothing whatsoever about the role
    // this project publishes. It is also what the 2026-08-26 hand run set, for the same reason.
    lines.push(
      `  azure:`,
      `    enabled: true`,
      `    subscriptionId: ${azureSubscription}`,
      `    resourceGroup: ${azureResourceGroup}`,
      `    location: ${azureLocation}`,
      `    sshAllowedCidr: ${cidr}`,
      `    allowAzureCli: false`,
    )
  } else {
    lines.push(`  aws:`, `    enabled: true`, `    region: ${awsRegion}`)
    // Pin the nightly to its own SSH group (issue #326). Without this the provider defaults to
    // `rockysurf-ssh`, the group a real user's box would also use — and the `if: always()` sweep,
    // aimed at the CI group, would then clean a group the run never filled while the shared one
    // leaked. The sweep imports this same const, so the two can never name different groups.
    lines.push(`    securityGroupName: ${awsSecurityGroupName}`)
    // A named profile locally, the default credential chain in CI — where there is no
    // ~/.aws/config to name and the credentials arrive as environment variables. Set
    // ROCKYSURF_E2E_AWS_PROFILE to '' to force the chain.
    if (awsProfile) lines.push(`    profile: ${awsProfile}`)
    lines.push(`    sshAllowedCidr: ${cidr}`)
  }

  return `${lines.join('\n')}\n`
}
