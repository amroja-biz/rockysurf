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

  /**
   * GIT AUTH (rockysurf-7fyf.3). What is pinned is the setup an operator would otherwise get
   * wrong, and the two facts about the shipped code that a reader plans around: the Client ID
   * needs a restart and the connected token does not. Prose around them is free to improve.
   */
  describe('the Git Auth section', () => {
    const gitAuth = () => {
      const { container } = renderHelp()
      return container.querySelector('section[id="git-auth"]')!.textContent ?? ''
    }

    it('names the setup step people miss, and the one they do not need a secret for', () => {
      const text = gitAuth()
      expect(text).toContain('Enable Device Flow')
      // By the checkbox's own name, and the answer to the form's required-but-unused URLs.
      expect(text).toContain('Expire user access tokens')
      expect(text).toContain('http://localhost:3000')
      // The device flow uses no client secret, which is why the Client ID is safe in a file.
      expect(text).toContain('public')
      expect(text).toContain('no client secret')
    })

    it('says which half needs a restart and which does not', () => {
      const text = gitAuth()
      // The Client ID goes to the config file, read once at boot.
      expect(text).toContain('restart Rocky Surf')
      // The connected token goes to the encrypted store, read at create.
      expect(text).toContain('immediately')
      expect(text).toContain('stored encrypted')
    })

    it('states the precedence a reader plans their repositories around', () => {
      const text = gitAuth()
      expect(text).toContain('cloned anonymously')
      expect(text).toContain('fails for private ones')
    })

    it('does not let Connect GitHub be read as a way to sign in', () => {
      expect(gitAuth()).toContain('not a way to sign in to Rocky Surf')
    })

    it('says disconnecting is not revoking', () => {
      const text = gitAuth()
      expect(text).toContain('forget it')
      expect(text).toContain('separate step')
    })
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

  /**
   * Two claims, and they were one until the Git Auth section (rockysurf-7fyf.3) added the first
   * off-repository links this page has: github.com's own OAuth App settings, which is where the
   * setup it describes actually happens and cannot be linked anywhere else.
   *
   * So the rule splits rather than loosens. Every documentation link still points into the public
   * repository; anything else must be on the short allowlist below, which is what keeps this from
   * degrading into "any external link is fine".
   */
  const ALLOWED_NON_REPO_LINKS = [
    'https://github.com/settings/applications/new',
    'https://github.com/settings/applications',
  ]

  it('external links do not leak an opener', () => {
    const { container } = renderHelp()
    const external = [...container.querySelectorAll('main a[target="_blank"]')]
    expect(external.length).toBeGreaterThan(4)
    for (const link of external) {
      expect(link.getAttribute('rel'), `${link.getAttribute('href')} has no rel`).toContain('noreferrer')
    }
  })

  it('leaves the repository the only place documentation is linked from', () => {
    const { container } = renderHelp()
    const external = [...container.querySelectorAll('main a[target="_blank"]')]
    const offRepo = external
      .map((link) => link.getAttribute('href')!)
      .filter((href) => !href.startsWith(GITHUB_URL))
    const unexpected = offRepo.filter((href) => !ALLOWED_NON_REPO_LINKS.includes(href))
    expect(unexpected, 'a link left the repository without being on the allowlist').toEqual([])
    // The repository links are still the bulk of them, so the allowlist cannot quietly become
    // the rule.
    expect(external.length - offRepo.length).toBeGreaterThan(4)
  })
})
