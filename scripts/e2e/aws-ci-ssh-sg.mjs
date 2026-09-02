/**
 * The one place the nightly's SSH security-group name is written (issue #326).
 *
 * The nightly resolves a fresh GitHub-runner IP each run and authorizes it for SSH; by the
 * "provision never revokes" contract nothing takes it back, so an `if: always()` sweep clears
 * the strays afterwards (scripts/e2e/aws-ssh-sweep.mjs). That only works if the group the
 * lifecycle FILLS and the group the sweep CLEANS are the same one. Naming it in two places once
 * let them drift — the config defaulted to `rockysurf-ssh` while the sweep was meant for the CI
 * group — so the sweep emptied a group the run never touched and the real one leaked.
 *
 * This const removes that failure mode structurally: both scripts/e2e/lifecycle.mjs
 * (writeConfig, as the AWS `securityGroupName`) and scripts/e2e/aws-ssh-sweep.mjs (as its
 * SG-name default) import it, so they cannot name different groups. It is deliberately a
 * CI-only name, distinct from the provider's `rockysurf-ssh` default, so the nightly never
 * shares a group — or a sweep — with a real user's box.
 */
export const CI_SSH_SG_NAME = 'rockysurf-nightly-ssh'
