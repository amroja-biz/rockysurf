import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { GITHUB_URL } from '../lib/links'
import { HELP_ANCHORS, HelpPage, panelForAnchor } from './HelpPage'

/**
 * The help page (rockysurf-n0zr.3, reorganized in issue #364). Prose is free to improve; what is
 * pinned is what a reader navigates by and what must stay true: the MCP section names the real
 * environment variables, the real default scopes and the real tools, every anchor this page has
 * ever answered to still resolves and opens the panel holding it, and the doc links point into
 * the public repository.
 *
 * WHY SO MANY ASSERTIONS READ `container.textContent` RATHER THAN `getByRole`. Every panel is
 * mounted and all but one carries `hidden`, exactly as on Settings — so the DOM holds the whole
 * page while the accessibility tree holds only the open panel. A role query therefore sees one
 * panel at a time, which is the point of the page and is asserted directly further down.
 */

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', username: 'admin', isAdmin: true }, logout: vi.fn() }),
}))
vi.mock('../contexts/EventsContext', () => ({
  useEvents: () => ({ subscribe: () => () => {}, connectionStatus: 'connected' }),
}))

/** Render the page as a reader arrives at it — optionally through a fragment link. */
function renderHelp(anchor?: string) {
  return render(
    <MemoryRouter initialEntries={[anchor ? `/help#${anchor}` : '/help']}>
      <HelpPage />
    </MemoryRouter>,
  )
}

describe('HelpPage', () => {
  it('opens on Start here, the first step of the sequence (#441)', () => {
    renderHelp()
    expect(screen.getByRole('heading', { name: 'Start here' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Start here', selected: true })).toBeTruthy()
  })

  /**
   * THE SIDEBAR ORDER (issue #441). The owner's words were that the old order was "somewhat
   * confusing and in a seemingly random order". What replaced it is the sequence a reader goes
   * through, so the order is the feature and belongs in a test rather than in a comment alone.
   */
  it('lists the sections in the order a reader goes through them', () => {
    const { container } = renderHelp()
    const labels = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)
    expect(labels).toEqual([
      'Start here',
      'Cloud Providers',
      'Servers',
      'Surge Packs and tools',
      'Private repositories',
      'MCP & Skills',
      'Costs and caps',
      'Settings',
      'Backups',
      'Glossary',
      'All documentation',
    ])
  })

  /**
   * START HERE (issue #441). It is an index, so what is pinned is that it indexes: it numbers
   * the setup in order and every step reaches its panel by the fragment mechanism the rest of
   * the page already uses. Its prose is free to improve, and it must state no fact of its own —
   * that part is a review rule, not something a test can see.
   */
  describe('the Start here section', () => {
    const start = () => {
      const { container } = renderHelp()
      return container.querySelector('section[id="start"]')!
    }

    it('numbers the setup: a Provider, a Server and its Surge Pack, repositories, then MCP', () => {
      const steps = [...start().querySelectorAll('.help-steps > li')].map((li) => li.textContent ?? '')
      expect(steps).toHaveLength(4)
      expect(steps[0]).toContain('Configure a cloud Provider')
      expect(steps[1]).toContain('Create a Server, choosing a Surge Pack')
      expect(steps[2]).toContain('Optional: Connect private repositories')
      expect(steps[3]).toContain('Connect your coding agent over MCP')
    })

    it('links every step, and the closing pointer, to the panel that covers it', () => {
      const hrefs = [...start().querySelectorAll('a')].map((a) => a.getAttribute('href'))
      for (const panel of ['providers', 'servers', 'packs', 'repositories', 'agents', 'costs', 'backup']) {
        expect(hrefs, `Start here does not link #${panel}`).toContain(`/help#${panel}`)
      }
    })

    it('opens the panel it points at, so the links are not decorative', () => {
      // The same mechanism the dashboard's own /help#... links use: the fragment picks the panel.
      for (const panel of ['providers', 'servers', 'packs', 'repositories', 'agents', 'costs', 'backup']) {
        expect(panelForAnchor(panel)).toBe(panel)
      }
    })
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

  it('answers "my agent says there is no create_server tool" before it is asked (#353)', () => {
    // The owner hit this and it read as a bug worth filing. The page must name the tool, say
    // the absence is the default scope grant, and point at where the scope is granted — a
    // paragraph that says only "create is opt-in" does not connect to the symptom.
    const { container } = renderHelp()
    const text = container.textContent ?? ''
    expect(text).toContain('create_server')
    expect(text).toContain('not a bug')
    expect(container.querySelector('a[href="/settings?section=mcp"]')).toBeTruthy()
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
    expect(container.textContent).toContain('cp -r .agents/skills/create-surge-pack ~/.agents/skills/')
  })

  it('says plainly that extending Rocky Surf needs a clone, not just the npm package', () => {
    // The npm package (`packages/rockysurf/package.json` `files`) ships only `dist` and
    // `README.md` — no skills, no smoke harness. A reader who only ran `npx rockysurf` has
    // nothing to extend Rocky Surf with until they clone.
    const { container } = renderHelp()
    const text = container.textContent ?? ''
    expect(text).toContain('To extend Rocky Surf with your own Surge Packs or Providers, clone the repository.')
    expect(text).toContain('git clone https://github.com/amroja-biz/rockysurf')
    expect(text).toContain('pnpm install && pnpm -r build')
    expect(text).toContain('Install Docker if you plan to create a Surge Pack')
    expect(text).toContain('Writing your own Provider does not need Docker')
  })

  it('gives MCP setup for Codex CLI beside Claude Code, not Claude Code alone', () => {
    // Owner ruling: Rocky Surf must not read as overfit to one coding agent. Claude Code and
    // Codex CLI are the two representative examples, each with user/global scope and project
    // scope, so a reader of either agent finds a ready command.
    const { container } = renderHelp()
    const text = container.textContent ?? ''
    expect(text).toContain('codex mcp add rockysurf')
    expect(text).toContain('~/.codex/config.toml')
    expect(text).toContain('.codex/config.toml')
    expect(text).toContain('claude mcp add --scope user')
    expect(text).not.toContain('In Claude Code, restart the session')
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

    /**
     * Both halves are live since issue #264, and the page has to say so about BOTH — the client
     * ID and a pasted PAT used to be the restart half, and a reader who took that on trust would
     * now be restarting for nothing.
     */
    it('says that neither half needs a restart, and where each credential lives', () => {
      const text = gitAuth()
      expect(text).not.toContain('restart Rocky Surf')
      // The client ID goes to the config file, which is now re-read when Settings saves it.
      expect(text).toContain('the button works straight away, with no restart')
      // A pasted PAT goes to the same file, and is read when a box is created.
      expect(text).toContain('It applies to the next server you create, with no restart.')
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
   * to learn a provider needed a resource group, a role and three required settings — so what is
   * pinned is the WIRING, not the prose: every shipped provider has a heading, every one links
   * its canonical `docs/providers/*.md` through `repoDocUrl`, and the settings the provider
   * schemas actually refuse to boot without are named. A setting that stops being required is a
   * test that fails, which is the point.
   *
   * THOSE SETTINGS ARE ASSERTED BY THEIR SETTINGS-PAGE LABEL, not by their config key (owner
   * review, 2026-09-07). The steps a reader follows are steps on the Settings page, so naming a
   * required field there by its YAML key sent them looking for a control that does not carry
   * that name. The labels are declared in each provider package's `src/index.ts`, so this still
   * pins the help page to what the providers themselves say. `sshAllowedCidr` and
   * `allowAllCidr` keep their key form as well, because the SSH block explains the file and
   * because `sshAllowedCidr` is the name the startup refusal prints.
   */
  describe('the Enabling a cloud provider section', () => {
    const providersSection = () => {
      const { container } = renderHelp('providers')
      return container.querySelector('section[id="providers"]')!
    }
    const providers = () => providersSection().textContent ?? ''

    it('gives every shipped provider its own heading', () => {
      renderHelp('providers')
      for (const name of [/^Hetzner$/, /^AWS$/, /^Azure$/, /^Google Cloud$/]) {
        expect(screen.getByRole('heading', { name }), `no heading for ${name}`).toBeTruthy()
      }
    })

    it('links each canonical provider doc, in the repository', () => {
      const section = providersSection()
      for (const doc of ['hetzner.md', 'aws.md', 'azure.md', 'gcp.md']) {
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
      ]) {
        expect(hrefs, `no Settings deep link for ${id}`).toContain(`/settings?section=${id}`)
      }
    })

    it('names the settings the provider schemas refuse to boot without', () => {
      const text = providers()
      // packages/provider-*/src/config.ts: these are refusals, not defaults. Named here by the
      // labels packages/provider-*/src/index.ts declares for them.
      expect(text).toContain('sshAllowedCidr')
      expect(text).toContain('allowAllCidr')
      expect(text).toContain('SSH allowed from')
      expect(text).toContain('Subscription id')
      expect(text).toContain('Resource group')
      expect(text).toContain('Project id')
    })

    it('gives every cloud the same shape, so no section assumes another was read first', () => {
      // The owner's review of 2026-09-07: a help page is written for someone with no prior
      // knowledge of Rocky Surf. Each cloud states what to do in the cloud first, then what to
      // set on the Settings page, and both halves are labelled the same way everywhere.
      const text = providers()
      for (const cloud of ['Hetzner', 'AWS', 'Azure', 'Google Cloud']) {
        expect(text, `${cloud} has no Settings steps`).toContain(`Then, in Settings → ${cloud}:`)
      }
      expect(text).toContain('Before you start, in Hetzner:')
      expect(text).toContain('Before you start, in Azure:')
      expect(text).toContain('Before you start, in Google Cloud:')
      // The old "Config:" summary lines, which named keys with no context, are gone from every
      // cloud that has been through this review.
      for (const id of ['hetzner', 'aws', 'azure', 'gcp']) {
        const block = providersSection().querySelector(`section[id="${id}"]`)!
        expect(block.textContent, `#${id} still has a Config: line`).not.toContain('Config:')
      }
    })

    /**
     * THE SCOPED GRANT IS RECOMMENDED, NOT A PREREQUISITE (owner correction, 2026-09-07). Rocky
     * Surf uses each cloud's ordinary credential chain, and the owner runs AWS today on an
     * administrator SSO profile with no role at all — so a section that opened with "Before you
     * start, create the role" told a new reader to do work the product does not require. What
     * belongs under "Before you start" is only what the code genuinely needs to already exist:
     * Azure's resource group (the provider never creates one), Google Cloud's project and
     * Compute Engine API, Hetzner's project and token.
     */
    it('presents the least-privilege grant as recommended, not as a prerequisite', () => {
      const text = providers()
      expect(text).toContain('Recommended: a dedicated role')
      expect(text).toContain('Recommended: a dedicated identity and roles')
      expect(text).toContain('Recommended: a dedicated service account')
      // The minimum working credential is stated first, per cloud.
      expect(text).toContain('An administrator SSO profile works with no further setup')
      expect(text).toContain('as a subscription Owner or Contributor works with no further setup')
      expect(text).toContain('as a project owner works with no further setup')
      expect(text).toContain('A token on the project you already use works with no further setup')
      // And the AWS Profile step no longer assumes the reader created the role.
      expect(text).toContain('otherwise the profile you sign in with')
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

  /**
   * THE SIDEBAR AND THE FRAGMENTS (issue #364). The page moved from one long column to a panel
   * per section, so two things have to hold at once: every sidebar entry opens a panel, and
   * every `id` this page has ever answered to still resolves — other pages, the repository's
   * documentation and the MCP tool descriptions all link here by fragment.
   */
  describe('the sidebar and the fragment links', () => {
    it('gives every sidebar tab a panel of its own', () => {
      const { container } = renderHelp()
      const tabs = [...container.querySelectorAll('[role="tab"]')]
      expect(tabs.length).toBeGreaterThan(5)
      for (const tab of tabs) {
        const id = tab.getAttribute('aria-controls')!
        expect(container.querySelector(`section[id="${id}"]`), `#${id} has no panel`).toBeTruthy()
      }
    })

    it('resolves every anchor it publishes, and opens the panel that holds it', () => {
      for (const anchor of HELP_ANCHORS) {
        const panel = panelForAnchor(anchor)
        const { container, unmount } = renderHelp(anchor)
        expect(container.querySelector(`[id="${anchor}"]`), `#${anchor} is not in the DOM`).toBeTruthy()
        const open = container.querySelector(`section[id="${panel}"]`)!
        expect(open.hasAttribute('hidden'), `#${anchor} did not open the ${panel} panel`).toBe(false)
        expect(open.contains(container.querySelector(`[id="${anchor}"]`))).toBe(true)
        unmount()
      }
    })

    /**
     * The two fragments other pages link by name, spelled out rather than left to the loop
     * above: `StaleServersNotice` and `BackupReminder` both point here, and the browser suite
     * (`e2e/help-anchors.e2e.ts`) proves the scroll. This proves the panel.
     */
    it.each([
      ['stale-servers', 'servers'],
      ['backup', 'backup'],
    ])('opens %s inside the %s panel, as the pages linking it expect', (anchor, panel) => {
      expect(panelForAnchor(anchor)).toBe(panel)
      const { container } = renderHelp(anchor)
      expect(container.querySelector(`section[id="${panel}"]`)!.hasAttribute('hidden')).toBe(false)
    })

    it('shows one panel at a time', () => {
      const { container } = renderHelp('costs')
      const open = [...container.querySelectorAll('.help-panel')].filter((p) => !p.hasAttribute('hidden'))
      expect(open.map((p) => p.id)).toEqual(['costs'])
    })

    it('falls back to the first panel for a fragment it does not know', () => {
      expect(panelForAnchor('no-such-thing')).toBe('start')
    })
  })

  /**
   * ALL DOCUMENTATION (issue #441). The owner's complaint about the panel this replaced was
   * that it was "very confusing because it contains only a subset of the full documentation".
   * The fix is only worth anything if it stays complete, so the test reads the README's own
   * documentation table and requires every path in it to be linked here. A document added to
   * the README and forgotten here fails this test rather than quietly recreating the subset.
   */
  describe('the All documentation section', () => {
    // Resolved from the package root, not `import.meta.url`: under jsdom that is an http URL,
    // not a file one, and `fileURLToPath` rejects it.
    const readmePath = join(process.cwd(), '../../README.md')
    /** Every `docs/…`-style path the README's documentation table links, in table order. */
    const readmeDocPaths = () => {
      const readme = readFileSync(readmePath, 'utf8')
      const table = readme.slice(readme.indexOf('| Document | Audience |'))
      return [...table.matchAll(/^\|\s*\[`([^`]+)`\]/gm)].map((match) => match[1])
    }

    it('links every document the README lists, and the per-cloud Provider pages', () => {
      const { container } = renderHelp('docs')
      const panel = container.querySelector('section[id="docs"]')!
      const hrefs = [...panel.querySelectorAll('a')].map((a) => a.getAttribute('href'))
      const fromReadme = readmeDocPaths()
      expect(fromReadme.length).toBeGreaterThan(8)
      for (const path of fromReadme) {
        expect(hrefs, `All documentation does not link ${path}`).toContain(
          `${GITHUB_URL}/blob/main/${path}`,
        )
      }
      for (const cloud of ['hetzner', 'aws', 'azure', 'gcp']) {
        expect(hrefs, `no Provider page for ${cloud}`).toContain(
          `${GITHUB_URL}/blob/main/docs/providers/${cloud}.md`,
        )
      }
      expect(hrefs.at(-1), 'the repository is not the last link').toBe(GITHUB_URL)
    })

    it('groups them under the README audiences, with the repository last', () => {
      const { container } = renderHelp('docs')
      const panel = container.querySelector('section[id="docs"]')!
      const headings = [...panel.querySelectorAll('h3')].map((h) => h.textContent)
      expect(headings).toEqual([
        'Your coding agent',
        'Operators',
        'Surge Pack authors',
        'Contributors',
        'The maintainer',
        'Everything else',
      ])
    })
  })

  /**
   * The MCP scope table (issue #364). The mapping is a contract with
   * `packages/rockysurf/src/mcp/tools.ts`: a tool that moves to another scope, or a scope that
   * stops existing, must not leave this page teaching the old grant.
   */
  it('maps every MCP scope to the tools it actually offers', () => {
    const { container } = renderHelp()
    const rows = [...container.querySelectorAll('.help-table tbody tr')].map(
      (row) => row.textContent ?? '',
    )
    expect(rows).toHaveLength(4)
    const byScope = (scope: string) => rows.find((row) => row.startsWith(scope)) ?? ''
    for (const tool of ['list_servers', 'get_server', 'get_ssh_command', 'list_providers', 'get_provider', 'list_offerings', 'list_packs', 'list_ssh_keys']) {
      expect(byScope('read'), `read is missing ${tool}`).toContain(tool)
    }
    expect(byScope('stop')).toContain('stop_server')
    expect(byScope('stop')).toContain('start_server')
    expect(byScope('create')).toContain('create_server')
    expect(byScope('terminate')).toContain('terminate_server')
  })

  /** The only install path the repository documents for a skill (`.agents/skills/README.md`). */
  it('gives both documented skill destinations, and the restart that picks one up', () => {
    const { container } = renderHelp()
    const skills = container.querySelector('section[id="skills"]')!.textContent ?? ''
    expect(skills).toContain('cp -r .agents/skills/create-surge-pack ~/.agents/skills/')
    expect(skills).toContain('<your-project>/.agents/skills/')
    expect(skills).toContain('Restart the agent session')
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
