import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { GITHUB_URL } from '../lib/links'
import { HelpPage } from './HelpPage'

/**
 * The help page (rockysurf-n0zr.3). Prose is free to improve; what is pinned is what a reader
 * navigates by and what must stay true: the agents callout leads, the MCP snippet names the
 * real environment variables and the real default scopes, every table-of-contents entry lands
 * on a section that exists, and the doc links point into the public repository.
 */

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', username: 'admin', isAdmin: true }, logout: vi.fn() }),
}))
vi.mock('../contexts/EventsContext', () => ({
  useEvents: () => ({ subscribe: () => () => {}, connectionStatus: 'connected' }),
}))

function renderHelp() {
  return render(
    <MemoryRouter initialEntries={['/help']}>
      <HelpPage />
    </MemoryRouter>,
  )
}

describe('HelpPage', () => {
  it('leads with the agents callout, by the words the owner asked for', () => {
    renderHelp()
    expect(
      screen.getByRole('heading', { name: /give the power of rocky surf to your coding agents/i }),
    ).toBeTruthy()
  })

  it('shows the real MCP wiring: both env vars, the mint command, and the config-owned scopes', () => {
    // These are contracts, not copy. MCP_TOKEN_ENV / MCP_BASE_URL_ENV are the names the server
    // reads (packages/rockysurf/src/mcp/server.ts), and [read, stop] is the shipped default —
    // a help page that drifts from any of them teaches a setup that does not work.
    const { container } = renderHelp()
    const text = container.textContent ?? ''
    expect(text).toContain('ROCKYSURF_TOKEN')
    expect(text).toContain('ROCKYSURF_URL')
    expect(text).toContain('[read, stop]')
    expect(text).toContain('budget-capped, not sandboxed')
  })

  it('mints the token with a command that works before v0.1.0 is on npm (rockysurf-lsi1)', () => {
    // The owner caught the first version teaching `rockysurf token` — a command npm cannot
    // supply until the packages are published. The page must show the checkout form and say
    // out loud why, the same honesty the README's quickstart carries.
    const { container } = renderHelp()
    const text = container.textContent ?? ''
    expect(text).toContain('node packages/rockysurf/dist/bin.js token')
    expect(text).toContain('until v0.1.0 is on npm')
    // The launch-shape JSON stays, with the pre-npm substitution beside it.
    expect(text).toContain('"command": "node"')
  })

  it('tells an outsider how to take the skills with them', () => {
    const { container } = renderHelp()
    expect(container.textContent).toContain('cp -r .claude/skills/creating-surge-packs ~/.claude/skills/')
  })

  it('every table-of-contents entry lands on a section that exists', () => {
    const { container } = renderHelp()
    const tocLinks = [...container.querySelectorAll('.help-toc a')]
    expect(tocLinks.length).toBeGreaterThan(5)
    for (const link of tocLinks) {
      const id = link.getAttribute('href')!.replace(/^#/, '')
      expect(container.querySelector(`section[id="${id}"]`), `#${id} has no section`).toBeTruthy()
    }
  })

  it('doc links point into the repository, and external links do not leak an opener', () => {
    const { container } = renderHelp()
    const external = [...container.querySelectorAll('main a[target="_blank"]')]
    expect(external.length).toBeGreaterThan(4)
    for (const link of external) {
      expect(link.getAttribute('href')).toMatch(new RegExp(`^${GITHUB_URL}`))
      expect(link.getAttribute('rel')).toContain('noreferrer')
    }
  })
})
