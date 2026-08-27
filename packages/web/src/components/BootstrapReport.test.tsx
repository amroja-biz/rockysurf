import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { BootstrapReport as Report } from '../lib/api'
import { BootstrapReport, warningsSummary } from './BootstrapReport'

/**
 * The account of a failed bootstrap (ADR-0010). What matters: the three questions are answered
 * in order — what failed, why, what happened to the machine — the whole log is there but
 * collapsed, and a repository that did not clone is a warning on a box that is otherwise fine.
 */

const FAILED: Report = {
  failure: {
    stepId: 'tool:build-essential',
    phase: 'tool',
    label: 'Build Essential',
    exitCode: 100,
    cause: 'apt-mirror',
    summary:
      "Build Essential could not be installed: Ubuntu's package mirror for this region would not serve a file the install needs — http://us-east-1.ec2.ports.ubuntu.com/x.deb answered HTTP 503. Rocky Surf already retried the step once on the global mirror and got the same answer.",
    keyLines: ['E: Failed to fetch http://us-east-1.ec2.ports.ubuntu.com/x.deb  503  Service Unavailable', 'E: Unable to fetch some archives'],
    log: 'Reading package lists...\nE: Failed to fetch http://us-east-1.ec2.ports.ubuntu.com/x.deb  503  Service Unavailable\nE: Unable to fetch some archives',
    logComplete: true,
    instance: 'terminated',
    instanceNote: 'Rocky Surf terminated the machine, so it is not billing.',
  },
  warnings: [],
}

const WITH_WARNING: Report = {
  warnings: [
    {
      stepId: 'repo:my-app',
      phase: 'repo',
      label: 'https://github.com/acme/my-app',
      cause: 'git-not-found',
      summary: 'The repository https://github.com/acme/my-app could not be cloned onto the box: git reports the repository does not exist or is not visible from the box.',
      keyLines: ["fatal: repository 'https://github.com/acme/my-app/' not found"],
      log: "Cloning into 'my-app'...\nfatal: repository 'https://github.com/acme/my-app/' not found",
      logComplete: false,
    },
  ],
}

describe('a failure', () => {
  it('answers what, why and what happened to the machine, in that order, with the log collapsed', () => {
    render(<BootstrapReport report={FAILED} />)
    const card = screen.getByTestId('bootstrap-failure')
    expect(card.getAttribute('role')).toBe('alert')
    expect(card.textContent).toContain('Setup failed: Build Essential')
    expect(card.textContent).toContain('tool:build-essential')
    expect(card.textContent).toContain('exited with code 100')

    const text = card.textContent ?? ''
    expect(text.indexOf('What failed')).toBeLessThan(text.indexOf('Why'))
    expect(text.indexOf('Why')).toBeLessThan(text.indexOf('The machine'))
    expect(text).toContain('would not serve a file the install needs')
    expect(text).toContain('E: Unable to fetch some archives')
    expect(text).toContain('not billing')

    const details = card.querySelector('details')
    expect(details, 'the full log is there').toBeTruthy()
    expect(details!.hasAttribute('open'), 'but collapsed').toBe(false)
    expect(details!.textContent).toContain('complete')
  })

  /**
   * The summary is prose built in core (`bootstrap/failure-report.ts`); what this asserts is
   * that the card puts the whole of it in front of the user unbroken — the URL included, which
   * is the one fact in a broken-mirror report they can act on (#188). A long URL that the card
   * truncated or split would take the actionable part of the advice with it.
   */
  it('shows a broken mirror’s URL and the advice to test it, whole', () => {
    const url = 'http://ports.ubuntu.com/ubuntu-ports/pool/main/p/perl/perl-base_5.38.2-3.2ubuntu0.4_arm64.deb'
    const summary =
      `Build Essential could not be installed: Ubuntu's package archive would not serve a file the install needs — ${url} answered HTTP 404. ` +
      'Rocky Surf already retried the step once, waiting first, and got the same answer. ' +
      "The mirror's package index is naming files it is no longer serving — this is a fault on the mirror side, not in your pack or your settings, and it usually clears within the hour. " +
      `Check it yourself — \`curl -I ${url}\` answering 200 means the mirror has caught up — then create the server again.`
    render(
      <BootstrapReport
        report={{ ...FAILED, failure: { ...FAILED.failure!, summary, keyLines: [`E: Failed to fetch ${url}  404  Not Found`] } }}
      />,
    )
    const text = screen.getByTestId('bootstrap-failure').textContent ?? ''
    expect(text).toContain(url)
    expect(text).toContain('not in your pack or your settings')
    expect(text).toContain(`curl -I ${url}`)
    expect(text).toContain('create the server again')
  })
})

describe('a warning', () => {
  it('names the repository that is not on the box and how to get it there, as a status not an alert', () => {
    render(<BootstrapReport report={WITH_WARNING} />)
    expect(screen.queryByTestId('bootstrap-failure')).toBeNull()
    const card = screen.getByTestId('bootstrap-warning')
    expect(card.getAttribute('role')).toBe('status')
    expect(card.textContent).toContain('Not on this box: https://github.com/acme/my-app')
    expect(card.textContent).toContain('git clone https://github.com/acme/my-app')
    expect(card.querySelector('details')!.textContent).toContain('last lines only')
  })

  it('summarises to one line for a card', () => {
    expect(warningsSummary(WITH_WARNING)).toBe('1 repository did not clone')
    expect(warningsSummary(FAILED)).toBeNull()
    expect(warningsSummary(undefined)).toBeNull()
  })
})

describe('nothing to say', () => {
  it('renders nothing for an empty report', () => {
    const { container } = render(<BootstrapReport report={{ warnings: [] }} />)
    expect(container.innerHTML).toBe('')
  })
})
