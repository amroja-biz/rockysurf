import { describe, expect, it } from 'vitest'
import {
  aptFetchFailures,
  buildStepReports,
  classifyFailure,
  describeInstance,
  exitCodeOf,
  explainStep,
  keyLinesOf,
  stepLabel,
  stepPhase,
} from './failure-report.js'
import { NO_MATCHING_TOKEN_PREFIX } from './resolver.js'

/**
 * The classifier is tested against the logs the incidents actually left behind, not against
 * strings written to match the regexes. When a new failure shape turns up in the wild, its
 * log goes here first.
 */

/** Verbatim from the owner's box `srv-b32e8a790309`, 2026-08-26 02:28 UTC (issue #117). */
const APT_503_LOG = [
  'Reading package lists...',
  'Building dependency tree...',
  'Get:1 http://us-east-1.ec2.ports.ubuntu.com/ubuntu-ports noble/main arm64 binutils-common arm64 2.42-4ubuntu2.10 [239 kB]',
  'Err:1 http://us-east-1.ec2.ports.ubuntu.com/ubuntu-ports noble/main arm64 binutils arm64 2.42-4ubuntu2.10',
  '  503  Service Unavailable [IP: 34.204.201.143 80]',
  'E: Failed to fetch http://us-east-1.ec2.ports.ubuntu.com/ubuntu-ports/pool/main/b/binutils/binutils_2.42-4ubuntu2.10_arm64.deb  503  Service Unavailable [IP: 34.204.201.143 80]',
  'E: Failed to fetch http://us-east-1.ec2.ports.ubuntu.com/ubuntu-ports/pool/main/m/manpages/manpages-dev_6.7-2_all.deb  503  Service Unavailable [IP: 34.204.201.143 80]',
  'E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?',
].join('\n')

const AGENT_LOG = [
  '[02:28:10] ==> tool:build-essential (as root, arch=arm64)',
  '[02:28:54] --- tool:build-essential: FAILED (rc=100)',
].join('\n')

/**
 * Verbatim from Pack smoke on #179 and again on #187, both arm64 legs, 2026-08-27 (issue
 * #188). The box is on the GLOBAL mirror — the stock `ubuntu:24.04` image's own — so there is
 * no region to blame and nothing to swap: the archive's index names a `.deb` its pool no
 * longer has, and only the mirror catching up fixes it.
 */
const APT_404_LOG = [
  'Reading package lists...',
  'Err:1 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 perl-base arm64 5.38.2-3.2ubuntu0.4',
  '  404  Not Found [IP: 91.189.91.103 80]',
  'E: Failed to fetch http://ports.ubuntu.com/ubuntu-ports/pool/main/p/perl/perl-base_5.38.2-3.2ubuntu0.4_arm64.deb  404  Not Found [IP: 91.189.91.103 80]',
  'E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?',
].join('\n')

describe('what a step is', () => {
  it('reads the phase off the id prefix', () => {
    expect(stepPhase('tool:build-essential')).toBe('tool')
    expect(stepPhase('tool-setup:claude-code')).toBe('setup')
    expect(stepPhase('repo:my-app')).toBe('repo')
    expect(stepPhase('branding')).toBe('finishing')
    expect(stepPhase('supplied-key-only')).toBe('finishing')
  })

  it('names a tool by its display name and a repository by its URL, falling back to the id', () => {
    const labels = {
      toolName: (id: string) => (id === 'build-essential' ? 'Build Essential' : undefined),
      repoUrl: (dir: string) => (dir === 'my-app' ? 'https://github.com/acme/my-app' : undefined),
    }
    expect(stepLabel('tool:build-essential', labels)).toBe('Build Essential')
    expect(stepLabel('tool:gone', labels)).toBe('gone')
    expect(stepLabel('repo:my-app', labels)).toBe('https://github.com/acme/my-app')
    expect(stepLabel('repo:other', labels)).toBe('other')
    expect(stepLabel('tool-setup:build-essential', labels)).toBe('Build Essential (setup script)')
    expect(stepLabel('branding')).toBe('login banner')
  })
})

describe('classifying the cause', () => {
  it('recognises the regional-mirror 503 outage', () => {
    expect(classifyFailure(APT_503_LOG)).toBe('apt-mirror')
  })

  it('recognises a mirror mid-sync', () => {
    expect(classifyFailure("E: Failed to fetch http://ports.ubuntu.com/x.deb  File has unexpected size (1 != 2). Mirror sync in progress? [IP: 1.2.3.4 80]")).toBe('apt-mirror')
  })

  it('calls an apt DNS failure a network problem, not a mirror one', () => {
    expect(classifyFailure('E: Failed to fetch http://archive.ubuntu.com/x  Could not resolve host: archive.ubuntu.com')).toBe('network')
  })

  it('recognises the clone script’s own no-token diagnosis as an auth failure', () => {
    const log = `Cloning into '/home/rocky/private-thing'...\nfatal: could not read Username for 'https://github.com': terminal prompts disabled\n${NO_MATCHING_TOKEN_PREFIX}github.com/acme/private-thing; this box carries no GitHub tokens\n`
    expect(classifyFailure(log)).toBe('git-auth')
  })

  it('recognises a repository that does not exist', () => {
    expect(classifyFailure("Cloning into 'x'...\nremote: Repository not found.\nfatal: repository 'https://github.com/acme/x/' not found")).toBe('git-not-found')
  })

  it('recognises GitHub’s unauthenticated rate limit', () => {
    expect(classifyFailure('curl: (22) The requested URL returned error: 403\nhttps://api.github.com/repos/x/y/releases/latest\nAPI rate limit exceeded for 203.0.113.1')).toBe('github-rate-limit')
  })

  it('puts disk-full ahead of whatever the step was doing at the time', () => {
    expect(classifyFailure('E: Failed to fetch x\nE: Write error - write (28: No space left on device)')).toBe('disk-full')
  })

  it('has an honest answer for a script that just exited non-zero', () => {
    expect(classifyFailure('Installing to /home/rocky/.local/bin...\nError: bd was installed but is not in PATH')).toBe('unknown')
  })
})

describe('the decisive lines', () => {
  it('picks apt’s verdict lines and drops the progress noise, without duplicates', () => {
    const lines = keyLinesOf(APT_503_LOG)
    expect(lines[0]).toMatch(/^E: Failed to fetch .*binutils/)
    expect(lines.at(-1)).toBe('E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?')
    expect(lines.some((l) => l.startsWith('Get:1'))).toBe(false)
  })

  it('falls back to the last three lines when nothing looks like a verdict', () => {
    expect(keyLinesOf('one\ntwo\nthree\nfour')).toEqual(['two', 'three', 'four'])
  })

  it('strips colour codes — a report is read as text', () => {
    expect(keyLinesOf('[0;31mError:[0m bd was installed but is not in PATH')).toEqual(['Error: bd was installed but is not in PATH'])
  })

  it('reads the exit code off the agent log, last occurrence wins', () => {
    expect(exitCodeOf('tool:build-essential', AGENT_LOG)).toBe(100)
    expect(exitCodeOf('tool:other', AGENT_LOG)).toBeUndefined()
    expect(exitCodeOf('tool:x', '--- tool:x: FAILED (rc=1)\n--- tool:x: FAILED (rc=7)')).toBe(7)
  })
})

describe('the URLs apt could not fetch', () => {
  it('names each one once, with the status and whether the host is a regional mirror', () => {
    const found = aptFetchFailures(APT_503_LOG)
    expect(found).toHaveLength(2)
    expect(found[0]).toEqual({
      url: 'http://us-east-1.ec2.ports.ubuntu.com/ubuntu-ports/pool/main/b/binutils/binutils_2.42-4ubuntu2.10_arm64.deb',
      status: '503',
      regional: true,
    })
    expect(found[1]?.url).toContain('manpages-dev_6.7-2_all.deb')
  })

  it('calls the bare global archive hosts what they are, not regional mirrors', () => {
    expect(aptFetchFailures(APT_404_LOG)[0]).toEqual({
      url: 'http://ports.ubuntu.com/ubuntu-ports/pool/main/p/perl/perl-base_5.38.2-3.2ubuntu0.4_arm64.deb',
      status: '404',
      regional: false,
    })
    const global = 'E: Failed to fetch http://archive.ubuntu.com/ubuntu/pool/main/x/x.deb  404  Not Found'
    expect(aptFetchFailures(global)[0]?.regional).toBe(false)
    const security = 'E: Failed to fetch http://security.ubuntu.com/ubuntu/pool/main/x/x.deb  503  Service Unavailable'
    expect(aptFetchFailures(security)[0]?.regional).toBe(false)
  })

  it('deduplicates, counts an index warning, and stops at the limit', () => {
    const log = [
      'W: Failed to fetch http://ports.ubuntu.com/ubuntu-ports/dists/noble/InRelease  503',
      'E: Failed to fetch http://ports.ubuntu.com/a.deb  404  Not Found',
      'E: Failed to fetch http://ports.ubuntu.com/a.deb  404  Not Found',
      'E: Failed to fetch http://ports.ubuntu.com/b.deb  404  Not Found',
    ].join('\n')
    expect(aptFetchFailures(log).map((f) => f.url)).toEqual([
      'http://ports.ubuntu.com/ubuntu-ports/dists/noble/InRelease',
      'http://ports.ubuntu.com/a.deb',
      'http://ports.ubuntu.com/b.deb',
    ])
    expect(aptFetchFailures(log, 1)).toHaveLength(1)
  })

  it('finds nothing in a log that never got as far as a fetch', () => {
    expect(aptFetchFailures('E: Unable to locate package nosuchthing')).toEqual([])
  })
})

describe('the explanation', () => {
  it('tells the user the mirror was down, that the fallback was tried, and that it is not their fault', () => {
    const report = explainStep({
      stepId: 'tool:build-essential',
      captured: { log: APT_503_LOG, complete: true },
      agentLog: AGENT_LOG,
      labels: { toolName: () => 'Build Essential' },
    })
    expect(report.cause).toBe('apt-mirror')
    expect(report.exitCode).toBe(100)
    expect(report.summary).toContain('Build Essential could not be installed')
    expect(report.summary).toContain('HTTP 503')
    expect(report.summary).toContain("Ubuntu's package mirror for this region")
    expect(report.summary).toContain('not a problem with your pack or your settings')
    // The regional case is the one where the retry had somewhere else to go.
    expect(report.summary).toContain('retried the step once on the global mirror')
    expect(report.logComplete).toBe(true)
  })

  it('names the URL that would not serve, and tells the user to test it and create again (#188)', () => {
    const report = explainStep({
      stepId: 'tool:build-essential',
      captured: { log: APT_404_LOG, complete: true },
      agentLog: AGENT_LOG,
      labels: { toolName: () => 'Build Essential' },
    })
    const url = 'http://ports.ubuntu.com/ubuntu-ports/pool/main/p/perl/perl-base_5.38.2-3.2ubuntu0.4_arm64.deb'

    expect(report.cause).toBe('apt-mirror')
    // The URL, so the user has the one fact they can check for themselves.
    expect(report.summary).toContain(url)
    expect(report.summary).toContain('HTTP 404')
    // The mirror is the culprit, not the pack.
    expect(report.summary).toContain('not in your pack or your settings')
    // Not "for this region": the box is on the global archive and there is no region to blame.
    expect(report.summary).not.toContain('for this region')
    // What to do, in order: test it, then create again.
    expect(report.summary).toContain(`curl -I ${url}`)
    expect(report.summary).toContain('create the server again')
    // And it says the retry already happened, so nobody thinks one more click would have done
    // it — here with the wait, because on the global archive there was no mirror to switch to.
    expect(report.summary).toContain('already retried the step once, waiting first')
    // The same two options the retry notice offered while the second attempt ran (#205):
    // wait, or another provider — in the same words, so the notice and the report agree.
    expect(report.summary).toContain('You can wait and create the server again then, or launch it on another provider now.')
  })

  it('counts the other files without listing them', () => {
    const report = explainStep({
      stepId: 'tool:build-essential',
      captured: { log: APT_503_LOG, complete: true },
      labels: { toolName: () => 'Build Essential' },
    })
    expect(report.summary).toContain('(and 1 more file)')
    expect(report.summary).not.toContain('manpages-dev')
  })

  it('falls back to the outage sentence when no line named a URL', () => {
    const report = explainStep({
      stepId: 'tool:build-essential',
      captured: { log: 'E: Unable to fetch some archives, maybe run apt-get update?', complete: true },
      labels: { toolName: () => 'Build Essential' },
    })
    expect(report.cause).toBe('apt-mirror')
    expect(report.summary).toContain('was not serving packages')
    expect(report.summary).not.toContain('curl -I')
    expect(report.summary).toContain('or launch it on another provider now')
  })

  it('surfaces the clone script’s no-token sentence whole and leaves git’s stderr in the log (rockysurf-ldo1)', () => {
    const sentence = `${NO_MATCHING_TOKEN_PREFIX}github.com/acme/private-thing; this box carries no GitHub tokens — add a matching token or a fallback pat in Settings, then create again`
    const report = explainStep({
      stepId: 'repo:private-thing',
      captured: { log: `Cloning into '/home/rocky/private-thing'...\nfatal: could not read Username for 'https://github.com': terminal prompts disabled\n${sentence}\n`, complete: false },
      labels: { repoUrl: () => 'https://github.com/acme/private-thing' },
    })
    expect(report.phase).toBe('repo')
    expect(report.summary).toContain('https://github.com/acme/private-thing could not be cloned')
    expect(report.summary).toContain(sentence)
    expect(report.summary).not.toContain('could not read Username')
    expect(report.log).toContain('could not read Username')
  })

  it('treats exit code 124 as a timeout whatever the log says', () => {
    const report = explainStep({
      stepId: 'tool:slow',
      captured: { log: 'Downloading...', complete: true },
      agentLog: '--- tool:slow: FAILED (rc=124)',
    })
    expect(report.cause).toBe('timeout')
    expect(report.summary).toContain('time limit')
  })

  it('says exactly what happened to the machine', () => {
    expect(describeInstance('terminated')).toContain('not billing')
    expect(describeInstance('terminate-failed', 'provider is down')).toContain('provider is down')
    expect(describeInstance('terminate-failed', 'provider is down')).toContain('may still be billing')
    expect(describeInstance('kept', 'custom')).toBe('custom')
  })
})

describe('from the journal', () => {
  const journal = {
    status: 'failed' as const,
    step: 'tool:node',
    failedStep: 'tool:node',
    logTail: 'npm ERR! code E404',
    steps: [
      { id: 'repo:a', status: 'failed', logTail: "fatal: repository 'https://x/a' not found" },
      { id: 'tool:node', status: 'failed' },
    ],
  }

  it('separates the failure from the warnings, and prefers the captured log to the journal tail', () => {
    const { failure, warnings } = buildStepReports({
      journal,
      stepLogs: { 'tool:node': { log: 'npm ERR! code E404\nnpm ERR! 404 Not Found', complete: true } },
    })
    expect(failure?.stepId).toBe('tool:node')
    expect(failure?.log).toContain('404 Not Found')
    expect(failure?.logComplete).toBe(true)
    expect(warnings.map((w) => w.stepId)).toEqual(['repo:a'])
    expect(warnings[0]?.cause).toBe('git-not-found')
    expect(warnings[0]?.logComplete).toBe(false)
  })

  it('has no failure for a plan that completed, only warnings', () => {
    const { failure, warnings } = buildStepReports({ journal: { ...journal, status: 'done', failedStep: undefined } })
    expect(failure).toBeUndefined()
    expect(warnings.map((w) => w.stepId)).toEqual(['repo:a', 'tool:node'])
  })
})
