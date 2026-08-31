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
    expect(container.textContent).toContain('cp -r .agent-skills/create-surge-pack ~/.agent-skills/')
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

  /**
   * "Backing up your data" (rockysurf-prqc, issue #89). What is pinned is exactness — the
   * request was "tell the user EXACTLY what to back up" — and the sensitivity claim being
   * stated plainly rather than softened.
   */
  describe('the Backing up your data section', () => {
    const backupSection = () => {
      const { container } = renderHelp()
      return container.querySelector('section[id="backup"]')!
    }
    const backup = () => backupSection().textContent ?? ''

    it('names every file to back up, by filename', () => {
      const text = backup()
      expect(text).toContain('rockysurf.db')
      expect(text).toContain('secret.key')
      expect(text).toContain('rockysurf.config.yaml')
    })

    it('says where the data directory is, and how to confirm it for a running install', () => {
      const text = backup()
      expect(text).toContain('~/.rockysurf')
      expect(text).toContain('server.dataDir')
      expect(text).toContain('config:')
    })

    it('states plainly which of it is sensitive, and what it decrypts', () => {
      const text = backup()
      expect(text).toContain('sensitive')
      expect(text).toContain('SSH private key')
      expect(text).toContain('remote-desktop password')
    })

    it('says to stop the process first, and links the normative backup-and-restore doc', () => {
      const section = backupSection()
      expect(section.textContent).toContain('Stop Rocky Surf before copying the database')
      const link = [...section.querySelectorAll('a')].find((a) =>
        a.getAttribute('href')?.includes('self-hosting.md#backup-and-restore'),
      )
      expect(link, 'no link to the self-hosting backup-and-restore section').toBeTruthy()
    })
  })

  /**
   * "Enabling a cloud provider" (issue #112). The gap was that an operator had to leave the app
   * to learn a provider needed a resource group, a role and three config keys — so what is
   * pinned is the WIRING, not the prose: every shipped provider has a heading, every one links
   * its canonical `docs/providers/*.md` through `repoDocUrl`, and the keys the provider schemas
   * actually refuse to boot without are named. A key that stops being required is a test that
   * fails, which is the point.
   */
  describe('the Enabling a cloud provider section', () => {
    const providersSection = () => {
      const { container } = renderHelp()
      return container.querySelector('section[id="providers"]')!
    }
    const providers = () => providersSection().textContent ?? ''

    it('gives every shipped provider its own heading', () => {
      renderHelp()
      for (const name of [/^Hetzner$/, /^AWS$/, /^Azure$/, /^Google Cloud$/, /your own machines/i]) {
        expect(screen.getByRole('heading', { name }), `no heading for ${name}`).toBeTruthy()
      }
    })

    it('links each canonical provider doc, in the repository', () => {
      const section = providersSection()
      for (const doc of ['hetzner.md', 'aws.md', 'azure.md', 'gcp.md', 'byo.md']) {
        const link = [...section.querySelectorAll('a')].find(
          (a) => a.getAttribute('href') === `${GITHUB_URL}/blob/main/docs/providers/${doc}`,
        )
        expect(link, `no link to docs/providers/${doc}`).toBeTruthy()
      }
    })

    it('deep-links the matching Settings tab, which is what `?section=` is for', () => {
      const section = providersSection()
      const hrefs = [...section.querySelectorAll('a')].map((a) => a.getAttribute('href'))
      for (const id of [
        'providers.hetzner',
        'providers.aws',
        'providers.azure',
        'providers.gcp',
        'providers.byo.hosts',
      ]) {
        expect(hrefs, `no Settings deep link for ${id}`).toContain(`/settings?section=${id}`)
      }
    })

    it('names the keys the provider schemas refuse to boot without', () => {
      const text = providers()
      // packages/provider-*/src/config.ts: these are refusals, not defaults.
      expect(text).toContain('sshAllowedCidr')
      expect(text).toContain('allowAllCidr')
      expect(text).toContain('subscriptionId')
      expect(text).toContain('resourceGroup')
      expect(text).toContain('projectId')
    })

    it('states where credentials come from, and that they are not in the config file', () => {
      const text = providers()
      expect(text).toContain('Credentials do not live in the config file')
      // Config first, then the encrypted store (packages/rockysurf/src/compose.ts).
      expect(text).toContain('encrypted store')
      expect(text).toContain('AZURE_CLIENT_SECRET')
      expect(text).toContain('gcloud auth application-default login')
    })

    it('names the deployable role for each cloud that ships one', () => {
      const text = providers()
      expect(text).toContain('deploy/aws/iam-role.yaml')
      expect(text).toContain('deploy/azure/role.bicep')
      expect(text).toContain('./deploy/gcp/setup.sh')
    })

    it('gives the resource-group prerequisite and says why Rocky Surf will not make it', () => {
      const text = providers()
      expect(text).toContain('az group create')
      expect(text).toContain('cannot be scoped to a group that does not exist yet')
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
