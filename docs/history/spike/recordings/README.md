# Two-cloud recorded lifecycle (rockysurf-d0no.7)

Capstone run of the spike: the REAL push-mode bootstrap against real instances on both
clouds, recorded with `script(1)`. Both runs exited 0 with **29 checks passed, 0 failed**.

| file | what it is |
|---|---|
| `aws-lifecycle.txt` | full transcript, AWS EC2 `t4g.small` (**arm64**), us-east-1 |
| `hetzner-lifecycle.txt` | full transcript, Hetzner `cpx12` (**amd64**), fsn1 |
| `capability-differences.md` | exit question (3): every AWS/Hetzner divergence and how it was expressed |

These runs are not reproducible from this repository any more. `rockysurf-oaw1` deleted the
spike's sources — the harness was `spike/verify-two-cloud.ts`, driven as
`AWS_PROFILE=sandbox AWS_REGION=us-east-1 npx tsx verify-two-cloud.ts aws` and the Hetzner
equivalent, each creating and destroying one real billable server. The transcripts below are
therefore the record rather than a recipe. Its successor, which does run, is
`scripts/e2e/lifecycle.mjs` — the nightly real-cloud workflow drives it against both clouds.

Both runs pushed the same snapshot of the spike's `bootstrap/agent.sh`, sha256
`f95e76695ba05d308bfd4dc61510eff69e19a25a16fc7aa4bc29d263d57cff44`, taken before the first
run and passed via `SPIKE_AGENT_SCRIPT`. That file was being extended concurrently (the
callback branch, `rockysurf-d0no.6`) and did change during these runs, so pinning it is what
makes the two transcripts comparable to each other rather than to whatever was on disk at the
moment each read it.

## What these runs prove that the local docker harness could not

1. **cloud-init consumed core's #cloud-config for real.** On both clouds the box reported
   `status: done`, and `/var/lib/cloud/instance/user-data.txt` matched what core sent
   **byte-for-byte** (2130B AWS, 2138B Hetzner). It created `rocky` with sudo, installed
   core's authorized key, and carried no `runcmd`/`bootcmd` — the document is inert.
2. **Host-key pinning is real, not trust-on-first-use.** The box came up already presenting
   the ed25519 host key core minted before the server existed, so the very FIRST connection —
   the one carrying the secrets file — was verified against a known key. The negative case was
   exercised too: a wrong fingerprint was rejected in under a second rather than retried.
3. **The `systemd-run` launcher.** Containers have no PID 1 systemd, so this path was
   unverified until now. On both clouds the agent ran in a transient
   `rockysurf-bootstrap.service` unit with live output over `journalctl -f`.
4. **`claude --version` → `2.1.228 (Claude Code)` over SSH as `rocky`, on both
   architectures**, from one identical plan: node v24.19.0 on arm64 (AWS) and amd64
   (Hetzner). The only arch-aware line in the plan is the `$ARCH` → Node tarball mapping.
5. **Zero orphans**, audited per cloud and confirmed independently afterwards.

## NAT / topology claim, validated on a real network

Core for these runs is a laptop behind NAT with no public address, no port forward, and no
listener. **Every connection was outbound from core**: HTTPS to the provider APIs, then one
SSH connection to the box. Nothing ever connected *to* core, and the box was never given a
core URL — `plan.mode` is `push`, so `callbackUrl` goes unused. This is the first real-network
demonstration of the claim; before this it held only by construction in a docker harness.

## Timings

| phase | AWS (arm64) | Hetzner (amd64) |
|---|---|---|
| provision | 3s | 1s |
| boot to running | 8s | 11s |
| wait for SSH (pinned) | 23s | 26s |
| cloud-init evidence | 2s | 3s |
| push bootstrap (3 steps) | 31s | 35s |
| terminate | 0s | 1s |
| orphan sweep | 68s | 0s |
| **total** | **138s** | **81s** |

The sweep asymmetry is the interesting number: EC2 sits in `shutting-down` for ~60s before it
is genuinely reaped, while Hetzner drops the server (and its owned SSH key) almost
immediately. Provisioning-to-usable-box is otherwise near-identical on the two clouds.

## New findings from these runs

- **Same Ubuntu 24.04, different images.** Hetzner's `ubuntu-24.04` ships without `jq`, so
  `agent.sh` hit its `jq missing — bootstrapping it before the plan can be parsed` path;
  Canonical's AWS AMI has it and that branch never ran. The agent handled it, but it means
  **"Ubuntu 24.04" is not a contract about installed packages** — anything the agent needs
  before it can parse its own plan has to be bootstrapped defensively, per image.
- **The reap wait is the whole difference in teardown cost.** `listManaged()` on AWS reports
  clean the moment the instance flips to `shutting-down`, so a zero-orphan claim built only
  on the provider interface would pass ~60s before the resources actually stop existing.
  The AWS sweep therefore goes behind the interface to raw `DescribeInstances`/`DescribeVolumes`.
- **`wait-for-ssh` dominates time-to-usable on both clouds** (23-26s of an 81-138s run), and
  it is nearly all cloud-init regenerating host keys and starting sshd. Early auth failures
  and `ECONNREFUSED` during that window are normal; the retry policy in `push.ts` is what
  makes them non-fatal, and a mismatched host key is the one error it never retries.
