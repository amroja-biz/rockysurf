/**
 * Docker smoke test for the push executor (rockysurf-55fx.4).
 *
 *   pnpm --filter @rockysurf/core run smoke:push     # needs Docker; no cloud credentials
 *
 * Reprises the spike harness (`spike/verify-push-local.ts`, which ran this same path on real
 * AWS and Hetzner) against the PRODUCTION module, and deliberately keeps the install plan
 * trivial. The spike already proved that apt and npm work on a real box; what this proves is
 * the executor: strict host-key verification, sftp delivery with the right modes, a launcher
 * that outlives the SSH session, journal polling filtered by runId, and resume.
 *
 * WHAT IT CANNOT COVER: containers have no PID 1 systemd, so the `systemd-run` launcher takes
 * its nohup fallback here. That path is verified on real instances by the spike recordings and
 * belongs to the nightly real-cloud job (rockysurf-55fx.9).
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { AGENT_SCRIPT_PATH } from '../src/bootstrap/index.js'
import { completedSteps, pushBootstrap, waitForSsh, type PushTarget } from '../src/bootstrap/push.js'
import type { InstallPlan } from '../src/bootstrap/plan.js'
import { generateServerKeys, generateSshKeyPair } from '../src/ssh/keys.js'
import { HostKeyMismatchError } from '../src/bootstrap/push.js'

const IMAGE = 'rockysurf-push-smoke'
const CONTAINER = 'rockysurf-push-smoke-box'
const PORT = 2242
const SERVER_ID = 'srv-smoke00test'

const t0 = Date.now()
const say = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s] ${m}`)
const ok = (m: string) => say(`  PASS  ${m}`)

function sh(cmd: string, args: string[], stdin?: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d))
    p.stderr.on('data', (d) => (stderr += d))
    p.on('error', reject)
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    p.stdin.end(stdin ?? '')
  })
}

async function docker(args: string[], stdin?: string): Promise<string> {
  const r = await sh('docker', args, stdin)
  if (r.code !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')} failed: ${r.stderr.trim()}`)
  return r.stdout
}

const DOCKERFILE = `FROM ubuntu:24.04
RUN apt-get update -qq \\
 && apt-get install -y -qq --no-install-recommends openssh-server sudo procps jq ca-certificates \\
 && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_*
RUN mkdir -p /run/sshd
CMD ["sleep", "infinity"]
`

/** Two trivial steps: enough to exercise ordering, runAs dispatch, checks and resume. */
function plan(runId: string): InstallPlan {
  return {
    version: 1,
    serverId: SERVER_ID,
    mode: 'push',
    runId,
    steps: [
      {
        id: 'tool:alpha',
        reports: 'installing_tools',
        runAs: 'root',
        run: 'set -euo pipefail\nmkdir -p /opt/smoke\ndate +%s%N >> /opt/smoke/alpha.runs\ntouch /opt/smoke/alpha.done',
        check: 'test -f /opt/smoke/alpha.done',
      },
      {
        id: 'tool:beta',
        reports: 'ready',
        runAs: 'rocky',
        run: 'set -euo pipefail\nmkdir -p "$HOME/smoke"\ndate +%s%N >> "$HOME/smoke/beta.runs"\ntouch "$HOME/smoke/beta.done"',
        check: 'test -f "$HOME/smoke/beta.done"',
      },
    ],
  }
}

async function main(): Promise<void> {
  const keys = generateServerKeys(SERVER_ID)

  say(`building ${IMAGE}`)
  const build = await sh('docker', ['build', '-q', '-t', IMAGE, '-'], DOCKERFILE)
  if (build.code !== 0) throw new Error(`image build failed: ${build.stderr.trim()}`)

  await sh('docker', ['rm', '-f', CONTAINER])
  await docker(['run', '-d', '--name', CONTAINER, '-p', `127.0.0.1:${PORT}:22`, IMAGE, 'sleep', 'infinity'])

  // Stands in for cloud-init: the user, the authorized key, and the PINNED host key. This is
  // the only exec into the container; everything after it is the real code path.
  await docker([
    'exec',
    CONTAINER,
    'bash',
    '-c',
    [
      'set -e',
      'useradd -m -s /bin/bash rocky',
      "usermod -p '*' rocky", // sshd with UsePAM off refuses password-locked accounts
      "echo 'rocky ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/rocky && chmod 440 /etc/sudoers.d/rocky",
      'mkdir -p /home/rocky/.ssh && chmod 700 /home/rocky/.ssh',
      'mkdir -p /etc/ssh/sshd_config.d',
      "printf 'PasswordAuthentication no\\nPubkeyAuthentication yes\\nUsePAM no\\n' > /etc/ssh/sshd_config.d/smoke.conf",
    ].join('\n'),
  ])
  await docker(['exec', '-i', CONTAINER, 'bash', '-c', 'cat > /home/rocky/.ssh/authorized_keys'], `${keys.user.publicKey}\n`)
  await docker(['exec', '-i', CONTAINER, 'bash', '-c', 'cat > /etc/ssh/ssh_host_ed25519_key'], keys.host.privateKey)
  await docker(['exec', '-i', CONTAINER, 'bash', '-c', 'cat > /etc/ssh/ssh_host_ed25519_key.pub'], `${keys.host.publicKey}\n`)
  await docker([
    'exec',
    CONTAINER,
    'bash',
    '-c',
    'chown -R rocky:rocky /home/rocky/.ssh && chmod 600 /home/rocky/.ssh/authorized_keys && chmod 600 /etc/ssh/ssh_host_ed25519_key',
  ])
  await docker(['exec', '-d', CONTAINER, '/usr/sbin/sshd', '-D', '-e'])
  say(`box up on 127.0.0.1:${PORT}`)

  const target: PushTarget = {
    host: '127.0.0.1',
    port: PORT,
    user: 'rocky',
    privateKey: keys.user.privateKey,
    hostKeyFingerprint: keys.host.fingerprint,
  }

  try {
    /* ---- conformance #15: a wrong pin is refused, and refused fast. ---- */
    const impostor = generateSshKeyPair('impostor')
    let rejected = false
    try {
      const bad = await waitForSsh({ ...target, hostKeyFingerprint: impostor.fingerprint }, { timeoutMs: 20_000 })
      bad.end()
    } catch (err) {
      rejected = err instanceof HostKeyMismatchError
    }
    assert.ok(rejected, 'a wrong host-key fingerprint must be rejected, not retried into a timeout')
    ok('wrong host-key fingerprint rejected (no trust-on-first-use)')

    /* ---- the push ---- */
    const client = await waitForSsh(target, { timeoutMs: 60_000 })
    ok('waitForSsh connected with the pinned host key verified')

    const agentScript = readFileSync(AGENT_SCRIPT_PATH, 'utf8')
    const first = await pushBootstrap(client, {
      target,
      plan: plan('run-one'),
      agentScript,
      secrets: { SMOKE_TOKEN: 'not-a-real-token' },
      pollIntervalMs: 1000,
      stallTimeoutMs: 120_000,
      onState: (s) => say(`  state | step=${s.step} status=${s.status}`),
    })

    say(`launcher used: ${first.launcher}`)
    assert.equal(first.state.status, 'done', `plan did not complete: ${first.state.logTail ?? ''}`)
    assert.deepEqual(completedSteps(first.state).sort(), ['tool:alpha', 'tool:beta'])
    ok(`plan completed in ${(first.durationMs / 1000).toFixed(0)}s, both steps done`)

    /* ---- conformance #12: the secrets file is 0600, and no callback.env exists. ---- */
    const modes = await docker(['exec', CONTAINER, 'stat', '-c', '%a %n', '/var/lib/rockysurf/secrets.env'])
    assert.ok(modes.trim().startsWith('600'), `secrets.env must be 0600, got ${modes.trim()}`)
    const callbackEnv = await sh('docker', ['exec', CONTAINER, 'test', '-e', '/var/lib/rockysurf/callback.env'])
    assert.notEqual(callbackEnv.code, 0, 'push mode must leave NO core credential on the box')
    ok('secrets.env is 0600 and no callback.env exists (push leaves core no credential on the box)')

    /* ---- resume: a second push skips completed steps. ---- */
    const before = await docker(['exec', CONTAINER, 'cat', '/opt/smoke/alpha.runs'])
    const second = await pushBootstrap(client, {
      target,
      plan: plan('run-two'),
      agentScript,
      pollIntervalMs: 1000,
      stallTimeoutMs: 120_000,
    })
    assert.equal(second.state.status, 'done')
    assert.deepEqual(second.skipped.sort(), ['tool:alpha', 'tool:beta'], 'both steps should already have been done')

    const after = await docker(['exec', CONTAINER, 'cat', '/opt/smoke/alpha.runs'])
    // The counter file is the evidence: a re-run of the step body would append a line.
    assert.equal(after, before, 'a skipped step must not execute its body again')
    ok('re-push skipped both steps; the step body did not run a second time')

    /* ---- conformance #4: each PUSH gets its own run id, and the journal carries it. ---- */
    // The push mints the id rather than reusing the plan's: two pushes of one plan are two
    // attempts, and sharing an id would let the second accept the first's terminal journal —
    // exactly the bug run ids exist to prevent.
    assert.notEqual(second.runId, first.runId, 'each push must mint its own run id')
    const journal = JSON.parse(await docker(['exec', CONTAINER, 'cat', '/var/lib/rockysurf/state.json'])) as {
      runId: string
    }
    assert.equal(journal.runId, second.runId, 'the agent must stamp the run id of the push it is serving')
    ok(`journal carries this push's runId (${second.runId.slice(0, 8)}…), so a stale run cannot be read as this one`)

    client.end()
    say('ALL PUSH SMOKE CHECKS PASSED')
    say('NOT COVERED HERE: the systemd-run launcher (containers have no PID 1 systemd) — that')
    say('path is exercised by the nightly real-cloud job, rockysurf-55fx.9.')
  } finally {
    if (!process.argv.includes('--keep')) await sh('docker', ['rm', '-f', CONTAINER])
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
