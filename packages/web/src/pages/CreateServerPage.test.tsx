import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import type { ReactNode } from 'react'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../lib/api'
import { SIZES } from '../lib/requirements'
import { CreateServerPage } from './CreateServerPage'

// `Link` arrived with the page moving inside `AppShell` (rockysurf-k72k) — the shell's nav is
// the only thing here that routes, so an anchor is a faithful enough stand-in.
//
// `useSearchParams` arrived with the `?pack=` preselection (rockysurf-4d8h, issue #51). A
// hoisted, per-test-settable search string keeps every existing case working unchanged — they
// never set it, so `search.value` stays `''` and `searchParams.get('pack')` stays `null`.
const search = vi.hoisted(() => ({ value: '' }))
vi.mock('react-router', () => ({
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams(search.value), vi.fn()],
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}))
// The feed's subscription is exercised in the events tests; here it only has to exist, and
// mocking it keeps these cases free of a live EventSource. `connectionStatus` is the shell's.
vi.mock('../contexts/EventsContext', () => ({
  useEvents: () => ({ subscribe: () => () => {}, status: 'open', connectionStatus: 'connected' }),
}))
/**
 * Admin by default, and switchable per case (rockysurf-jn71). The empty Community shelf offers a
 * Pack Shop link to an admin and a sentence to everybody else, because `/admin/pack-shop` is
 * behind `AdminRoute` — so this mock has to be able to be both.
 */
const auth = vi.hoisted(() => ({ isAdmin: true }))
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', username: 'admin', isAdmin: auth.isAdmin }, logout: vi.fn() }),
}))
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }))

const price = (amount: number) => ({ amount, currency: 'USD', fetchedAt: '2026-08-11T00:00:00Z' })

const FAKE_PROVIDER: api.ProviderInfo = {
  id: 'fake',
  displayName: 'Fake Cloud',
  capabilities: {
    stop: true,
    ipStableAcrossStop: true,
    canInjectHostKeys: true,
    userDataMaxBytes: 32768,
    generatesUserData: true,
  },
  offerings: [
    { id: 'small-arm', cpu: 2, memoryGb: 2, diskGb: 40, arch: 'arm64', hourly: price(0.0168), available: true, region: 'fake-1' },
    { id: 'small-x86', cpu: 2, memoryGb: 2, diskGb: 40, arch: 'amd64', hourly: price(0.0208), available: true, region: 'fake-1' },
    { id: 'big-arm', cpu: 4, memoryGb: 8, diskGb: 80, arch: 'arm64', hourly: price(0.0672), available: true, region: 'fake-1' },
  ],
}

const packWith = (over: Partial<api.SurgePack>): api.SurgePack => ({
  packId: 'ai-agents',
  name: 'AI Agents',
  displayOrder: 1,
  enabled: true,
  tools: [{ toolId: 'claude-code', name: 'Claude Code', description: '', category: 'agent', url: '' }],
  requiresRepos: false,
  requiresRdp: false,
  // Shipped with the release, which is what every other case in this file is about — a pack the
  // picker files under Official (rockysurf-jn71).
  provenance: 'official',
  ...over,
})

/** A pack the operator installed from a registry: the Community shelf's inhabitant. */
const communityPack = (over: Partial<api.SurgePack> = {}): api.SurgePack =>
  packWith({
    packId: 'aider',
    name: 'Aider',
    displayOrder: 2,
    provenance: 'registry',
    tools: [{ toolId: 'aider', name: 'Aider', description: '', category: 'agent', url: '' }],
    ...over,
  })

function renderPage() {
  return render(<CreateServerPage />)
}

/** A second cloud, so the picker has something to pick between. */
const OTHER_PROVIDER: api.ProviderInfo = {
  ...FAKE_PROVIDER,
  id: 'other',
  displayName: 'Other Cloud',
  offerings: [
    { id: 'other-medium', cpu: 2, memoryGb: 4, diskGb: 60, arch: 'amd64', hourly: price(0.031), available: true, region: 'other-1' },
  ],
}

const setupWith = (providers: api.ProviderSetupState[]): api.SetupState => ({
  complete: true,
  needsProvider: false,
  providers,
})

beforeEach(() => {
  search.value = ''
  vi.spyOn(api, 'listProviders').mockResolvedValue([FAKE_PROVIDER])
  vi.spyOn(api, 'listSurgePacks').mockResolvedValue([packWith({})])
  vi.spyOn(api, 'getSetupState').mockResolvedValue(setupWith([]))
  vi.spyOn(api, 'createServer').mockResolvedValue({ serverId: 'srv-abc', name: 'dev-box', status: 'provisioning' })
  // The live token display's endpoint (rockysurf-18lq). Stubbed by default so a test about
  // anything else does not reach for a real fetch when a repository URL is typed.
  vi.spyOn(api, 'resolveRepositories').mockResolvedValue([])
  // The picker's endpoint (rockysurf-mh8f). Empty by default, which is the "nothing configured"
  // installation — and the state in which this page must look exactly as it did before.
  vi.spyOn(api, 'listConfiguredScopes').mockResolvedValue([])
})

afterEach(() => {
  vi.restoreAllMocks()
  auth.isAdmin = true
})

describe('resolving a size to a concrete offering before submit', () => {
  it('shows the resolved machine, its price, and the date of that price', async () => {
    renderPage()

    // The cheapest offering meeting "small" — shown BEFORE anything is submitted.
    const heading = await screen.findByRole('heading', { name: /small-arm/ })
    // Scoped to the plan card: the same price now also labels the "small" radio above it
    // (rockysurf-b1gr), so an unscoped query would match two elements and throw.
    const planCard = heading.closest('section')!
    expect(within(planCard).getByText(/\$0\.0168\/hr/)).toBeTruthy()
    // Prices ship bundled, so they carry the date they were read.
    expect(screen.getByText(/prices as of/i)).toBeTruthy()
  })

  it('labels the architecture, with arm64 first-class', async () => {
    renderPage()
    await screen.findByRole('heading', { name: /small-arm/ })
    expect(screen.getAllByText('ARM64').length).toBeGreaterThan(0)
  })

  it('re-resolves when the size changes', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: /small-arm/ })

    await user.click(screen.getByRole('radio', { name: /large/i }))
    expect(await screen.findByRole('heading', { name: /big-arm/ })).toBeTruthy()
  })

  it('re-resolves when the architecture changes', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: /small-arm/ })

    await user.click(screen.getByRole('radio', { name: /x86-64/i }))
    expect(await screen.findByRole('heading', { name: /small-x86/ })).toBeTruthy()
  })

  it('submits the offering the user was shown, not whatever core would pick', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: /small-arm/ })

    await user.click(screen.getByRole('button', { name: /create server/i }))

    await waitFor(() => expect(api.createServer).toHaveBeenCalled())
    expect(vi.mocked(api.createServer).mock.calls[0]?.[0]).toMatchObject({
      offeringId: 'small-arm',
      arch: 'arm64',
      provider: 'fake',
      size: 'small',
    })
  })

  it('says "sold out" rather than "unavailable" when stock is the problem', async () => {
    vi.mocked(api.listProviders).mockResolvedValue([
      { ...FAKE_PROVIDER, offerings: FAKE_PROVIDER.offerings.map((o) => ({ ...o, available: false })) },
    ])
    renderPage()

    expect(await screen.findByText(/sold out/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /create server/i })).toHaveProperty('disabled', true)
  })

  it('surfaces a catalogue read failure without breaking the page', async () => {
    vi.mocked(api.listProviders).mockResolvedValue([
      { ...FAKE_PROVIDER, offerings: [], offeringsError: 'rate limited' },
    ])
    renderPage()
    expect(await screen.findByText(/rate limited/)).toBeTruthy()
  })

  it('shows one aggregate notice when every offering came back unpriced (gh #100)', async () => {
    // The hosted price feed being unreachable is one condition, not a per-row mystery — and it
    // must not block creating: only the estimates are missing (ADR-0009).
    vi.mocked(api.listProviders).mockResolvedValue([
      { ...FAKE_PROVIDER, offerings: FAKE_PROVIDER.offerings.map((o) => ({ ...o, hourly: null })) },
    ])
    renderPage()

    expect(await screen.findByTestId('prices-unavailable')).toBeTruthy()
    expect(screen.getByRole('button', { name: /create server/i })).toHaveProperty('disabled', false)
  })

  it('does not show the unpriced notice while any offering carries a price', async () => {
    renderPage()
    await screen.findByRole('heading', { name: /small-arm/ })
    expect(screen.queryByTestId('prices-unavailable')).toBeNull()
  })
})

/**
 * Every size priced at once, not only the selected one (rockysurf-b1gr).
 *
 * The plan card prices whichever size is selected, which makes comparing the three a matter of
 * clicking each in turn and remembering the last number. Each option now carries the machine it
 * would land on, from the same resolver over the same catalogue at the same arch.
 */
describe('pricing every size option, not only the selected one', () => {
  const labelFor = (size: string) => screen.getByTestId(`size-resolves-${size}`).textContent

  it('names the machine each size would land on, with its hourly price', async () => {
    renderPage()
    await screen.findByRole('heading', { name: /small-arm/ })

    expect(labelFor('small')).toBe('small-arm · $0.0168/hr')
    // "medium" wants 4 GB and only the big type here has it: a coarse catalogue rounds up, and
    // the label is what makes that visible without selecting medium to find out.
    expect(labelFor('medium')).toBe('big-arm · $0.0672/hr')
    expect(labelFor('large')).toBe('big-arm · $0.0672/hr')
  })

  it('says "price unknown" for a size that lands on an unpriced machine', async () => {
    // One unpriced type rather than a whole unreachable feed: the aggregate notice stays away,
    // and the label still names the machine instead of going blank or implying it is free.
    vi.mocked(api.listProviders).mockResolvedValue([
      {
        ...FAKE_PROVIDER,
        offerings: FAKE_PROVIDER.offerings.map((o) => (o.id === 'big-arm' ? { ...o, hourly: null } : o)),
      },
    ])
    renderPage()
    await screen.findByRole('heading', { name: /small-arm/ })

    expect(labelFor('large')).toBe('big-arm · price unknown')
    expect(screen.queryByTestId('prices-unavailable')).toBeNull()
  })

  it('degrades with the aggregate notice when the whole feed came back unpriced', async () => {
    // ADR-0009: an unreachable price feed is one condition, said once above the fieldset. The
    // labels below it must agree with that sentence rather than quoting numbers nobody has.
    vi.mocked(api.listProviders).mockResolvedValue([
      { ...FAKE_PROVIDER, offerings: FAKE_PROVIDER.offerings.map((o) => ({ ...o, hourly: null })) },
    ])
    renderPage()
    await screen.findByTestId('prices-unavailable')

    for (const size of SIZES) expect(labelFor(size)).toMatch(/· price unknown$/)
  })

  it('re-labels every option when the cloud changes', async () => {
    const user = userEvent.setup()
    vi.mocked(api.listProviders).mockResolvedValue([FAKE_PROVIDER, OTHER_PROVIDER])
    renderPage()

    // Nothing to price until a cloud is chosen — the labels are that cloud's answer.
    await screen.findByRole('radio', { name: 'Fake Cloud' })
    expect(screen.queryByTestId('size-resolves-small')).toBeNull()

    await user.click(screen.getByRole('radio', { name: 'Fake Cloud' }))
    await waitFor(() => expect(labelFor('small')).toBe('small-arm · $0.0168/hr'))

    await user.click(screen.getByRole('radio', { name: 'Other Cloud' }))
    await waitFor(() => expect(labelFor('small')).toBe('other-medium · $0.0310/hr'))
    // Other Cloud sells nothing meeting "large", so that option keeps its floor and gains no
    // machine. Saying why is the plan card's job, and only for the size actually selected.
    expect(screen.queryByTestId('size-resolves-large')).toBeNull()
  })

  it('resolves the labels at the chosen architecture, as the plan card does', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: /small-arm/ })

    await user.click(screen.getByRole('radio', { name: /x86-64/i }))
    await waitFor(() => expect(labelFor('small')).toBe('small-x86 · $0.0208/hr'))
    expect(screen.queryByTestId('size-resolves-large')).toBeNull()
  })
})

describe('pack metadata drives the conditional fields', () => {
  it('hides repositories and RDP when the pack asks for neither', async () => {
    renderPage()
    await screen.findByRole('heading', { name: /small-arm/ })

    expect(screen.queryByLabelText(/repositories/i)).toBeNull()
    expect(screen.queryByLabelText(/remote desktop password/i)).toBeNull()
  })

  it('shows the repository field only when the pack declares requiresRepos', async () => {
    vi.mocked(api.listSurgePacks).mockResolvedValue([packWith({ requiresRepos: true })])
    renderPage()
    expect(await screen.findByLabelText(/repositories/i)).toBeTruthy()
  })

  it('shows the RDP fields only when the pack declares requiresRdp', async () => {
    vi.mocked(api.listSurgePacks).mockResolvedValue([packWith({ requiresRdp: true })])
    renderPage()
    expect(await screen.findByLabelText(/^remote desktop password$/i)).toBeTruthy()
  })

  /**
   * A repository is asked for, never demanded (issue #90). The first submit with the list
   * empty offers a confirmation on the `createAnyway` pattern — the checkbox appears with its
   * reason on screen — and a confirmed resubmit creates the box with nothing cloned.
   */
  describe('submitting a repos-requiring pack with no repositories', () => {
    async function submitEmpty() {
      const user = userEvent.setup()
      vi.mocked(api.listSurgePacks).mockResolvedValue([packWith({ requiresRepos: true })])
      renderPage()
      await screen.findByLabelText(/repositories/i)
      await user.click(screen.getByRole('button', { name: /create server/i }))
      return user
    }

    it('offers a confirmation instead of creating', async () => {
      await submitEmpty()
      expect(await screen.findByText(/no repository is listed/i)).toBeTruthy()
      expect(screen.getByRole('checkbox', { name: /without a repository/i })).toBeTruthy()
      expect(api.createServer).not.toHaveBeenCalled()
    })

    it('does not offer the confirmation before a submit has raised the question', async () => {
      vi.mocked(api.listSurgePacks).mockResolvedValue([packWith({ requiresRepos: true })])
      renderPage()
      await screen.findByLabelText(/repositories/i)
      expect(screen.queryByRole('checkbox', { name: /without a repository/i })).toBeNull()
    })

    it('creates once confirmed, with no repositories field on the wire', async () => {
      const user = await submitEmpty()
      await user.click(await screen.findByRole('checkbox', { name: /without a repository/i }))
      await user.click(screen.getByRole('button', { name: /create server/i }))

      await waitFor(() => expect(api.createServer).toHaveBeenCalled())
      expect(vi.mocked(api.createServer).mock.calls[0]?.[0]).not.toHaveProperty('repositories')
    })

    it('withdraws the offer when a repository is added', async () => {
      const user = await submitEmpty()
      await screen.findByRole('checkbox', { name: /without a repository/i })

      await user.type(screen.getByLabelText(/repositories/i), 'https://github.com/a/b.git')
      await waitFor(() =>
        expect(screen.queryByRole('checkbox', { name: /without a repository/i })).toBeNull(),
      )
    })
  })

  it('sends repositories as a parsed list', async () => {
    const user = userEvent.setup()
    vi.mocked(api.listSurgePacks).mockResolvedValue([packWith({ requiresRepos: true })])
    renderPage()

    const field = await screen.findByLabelText(/repositories/i)
    await user.type(field, 'https://github.com/a/b.git\nhttps://github.com/c/d.git')
    await user.click(screen.getByRole('button', { name: /create server/i }))

    await waitFor(() => expect(api.createServer).toHaveBeenCalled())
    expect(vi.mocked(api.createServer).mock.calls[0]?.[0].repositories).toEqual([
      'https://github.com/a/b.git',
      'https://github.com/c/d.git',
    ])
  })

  /**
   * What the user sees when core's repository preflight refuses (rockysurf-k6xp).
   *
   * Two defects met here. Core's create route was the last caller of the bare `zValidator`, so
   * its 400s carried an OBJECT in `error`; and this page was the only one in the SPA reading
   * `err.message` instead of `err.detail`, so it rendered `ApiError`'s own status line. Between
   * them, a user who mistyped a repository URL got "API Error: 400 Bad Request" and no idea
   * which of the four URLs they had pasted was wrong.
   */
  describe('when core refuses a repository URL', () => {
    const refusal = () =>
      new api.ApiError(400, 'Bad Request', {
        error: 'https://github.com/a/typo.git was not found with the configured tokens (HTTP 404). Create it anyway by sending "createAnyway": true.',
        code: 'bad_request',
        issues: [{ path: 'repositories.1', message: 'https://github.com/a/typo.git was not found (HTTP 404).' }],
      })

    async function submitTwoRepos() {
      const user = userEvent.setup()
      vi.mocked(api.listSurgePacks).mockResolvedValue([packWith({ requiresRepos: true })])
      vi.mocked(api.createServer).mockRejectedValueOnce(refusal())
      renderPage()

      const field = await screen.findByLabelText(/repositories/i)
      await user.type(field, 'https://github.com/a/good.git\nhttps://github.com/a/typo.git')
      await user.click(screen.getByRole('button', { name: /create server/i }))
      return user
    }

    it("shows core's sentence rather than the status line", async () => {
      await submitTwoRepos()
      expect(await screen.findByText(/was not found with the configured tokens/)).toBeTruthy()
      // The bug, pinned: this is what the page used to render for every failed create.
      expect(screen.queryByText(/API Error: 400/)).toBeNull()
    })

    it('marks the URL that failed, and leaves the one that did not alone', async () => {
      await submitTwoRepos()
      const list = await screen.findByRole('alert')
      expect(list.textContent).toContain('https://github.com/a/typo.git')
      expect(list.textContent).not.toContain('https://github.com/a/good.git')
    })

    it('offers the override only after a refusal, and sends it when ticked', async () => {
      const user = await submitTwoRepos()
      await screen.findByRole('alert')

      const override = screen.getByRole('checkbox', { name: /create anyway/i })
      await user.click(override)
      await user.click(screen.getByRole('button', { name: /create server/i }))

      await waitFor(() => expect(vi.mocked(api.createServer).mock.calls.length).toBe(2))
      expect(vi.mocked(api.createServer).mock.calls[1]?.[0].createAnyway).toBe(true)
    })

    it('does not offer the override before anything has been refused', async () => {
      vi.mocked(api.listSurgePacks).mockResolvedValue([packWith({ requiresRepos: true })])
      renderPage()
      await screen.findByLabelText(/repositories/i)
      // A checkbox that is always there is a checkbox people tick without reading the reason.
      expect(screen.queryByRole('checkbox', { name: /create anyway/i })).toBeNull()
    })
  })

  it('refuses a short or mismatched RDP password', async () => {
    const user = userEvent.setup()
    vi.mocked(api.listSurgePacks).mockResolvedValue([packWith({ requiresRdp: true })])
    renderPage()

    const password = await screen.findByLabelText(/^remote desktop password$/i)
    await user.type(password, 'short')
    await user.click(screen.getByRole('button', { name: /create server/i }))
    expect(await screen.findByText(/^Remote desktop password must be at least 8 characters$/)).toBeTruthy()

    await user.clear(password)
    await user.type(password, 'long-enough-password')
    await user.type(screen.getByLabelText(/confirm password/i), 'different-password')
    await user.click(screen.getByRole('button', { name: /create server/i }))
    expect(await screen.findByText(/do not match/i)).toBeTruthy()
  })
})

/**
 * A classified cloud provider failure reads as a headline plus detail, not one raw dump
 * (issue #127). Core's `fail()` (`servers/routes.ts`) forwards a create-time provider refusal
 * with `code` on the nine-code taxonomy (ADR-0003) and the cloud's own `providerCode` verbatim
 * — this pins that the page actually reads both, rather than dumping the whole diagnostic
 * string (method, path, code, and the cloud's own multi-line paragraph) into one `<p>`.
 */
describe('when a cloud provider refuses the create', () => {
  const azureQuotaRefusal = () =>
    new api.ApiError(403, 'Forbidden', {
      error:
        "azure PUT /subscriptions/6845f60d-cdf4/resourceGroups/RockySurfResourceGroup/providers/Microsoft.Compute/virtualMachines/srv-1: OperationNotAllowed: Operation could not be completed as it results in exceeding approved standardBpsv2Family Cores quota.\nAdditional details - Current Limit: 0, Current Usage: 0, Additional Required: 2. Submit a request for Quota increase at https://aka.ms/ProdportalCRP/",
      code: 'quota',
      providerCode: 'OperationNotAllowed',
      retryable: false,
    })

  async function submitAndFail() {
    const user = userEvent.setup()
    vi.mocked(api.createServer).mockRejectedValueOnce(azureQuotaRefusal())
    renderPage()
    await screen.findByRole('heading', { name: /small-arm/ })
    await user.click(screen.getByRole('button', { name: /create server/i }))
    return user
  }

  it('shows a plain-language headline derived from the taxonomy code, and the cloud code beside it', async () => {
    await submitAndFail()
    const notice = await screen.findByTestId('provider-error-notice')
    expect(within(notice).getByText(/cloud quota exceeded/i)).toBeTruthy()
    expect(within(notice).getAllByText(/OperationNotAllowed/)).not.toHaveLength(0)
  })

  it('keeps the raw diagnostic as a separate, line-preserving detail block rather than one paragraph', async () => {
    await submitAndFail()
    const notice = await screen.findByTestId('provider-error-notice')
    // Structured, not a single <p> holding everything (the bug this issue fixed): a headline
    // paragraph plus a <pre> for the machine output, each their own element.
    const detail = notice.querySelector('pre.provider-error-detail')
    expect(detail).toBeTruthy()
    expect(detail!.textContent).toContain('Current Limit: 0, Current Usage: 0')
    // The multi-line ARM message keeps its own line break rather than being flattened into one
    // run of text — `textContent` still concatenates it, so this checks the source string
    // rather than layout.
    expect(detail!.textContent).toContain('\n')
  })

  it('does not fall back to the flat, unstyled paragraph the old page rendered', async () => {
    await submitAndFail()
    await screen.findByTestId('provider-error-notice')
    // The old rendering: `<p className="error">{err.detail}</p>` with nothing else on the page
    // holding the message. Once the structured notice exists, that bare paragraph must not.
    const flatParagraphs = screen.queryAllByText((_, el) => el?.tagName === 'P' && el.className === 'error')
    expect(flatParagraphs).toHaveLength(0)
  })
})

/**
 * OFFICIAL AND COMMUNITY (rockysurf-jn71).
 *
 * The picker used to be one flat list mixing the packs that shipped in the tarball with the ones
 * the operator installed from a registry, because the public pack list carried nothing that told
 * them apart — `provenance` is the field this bead added to say so, derived in core.
 *
 * The case that matters most here is the third one. A tab control over a radio group is a way to
 * lose a selection quietly: switch shelf, and either the checked radio disappears or the new
 * shelf's first card takes its place, and the server gets built from software nobody chose. So
 * the selection is asserted through the `createServer` argument rather than through the DOM.
 *
 * Every case settles on a `findBy*` for a specific element and then asserts synchronously. No
 * `waitFor` around a mock's call count and no timeouts — the shape that made
 * `SettingsPage.wiring.test.tsx` flaky (rockysurf-zn33).
 */
describe('the Surge Pack picker splits official packs from contributed ones', () => {
  const bothPacks = () => vi.mocked(api.listSurgePacks).mockResolvedValue([packWith({}), communityPack()])

  /** Renders with both shelves populated and waits for the tabs to exist. */
  async function renderTabs() {
    const user = userEvent.setup()
    bothPacks()
    renderPage()
    await screen.findByRole('tab', { name: 'Official' })
    return user
  }

  it('renders exactly two tabs, with the active one marked and the other off the tab order', async () => {
    await renderTabs()

    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Official', 'Community'])
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('false')
    // Roving tabindex: Tab moves past the control, not through it.
    expect(tabs[0]!.getAttribute('tabindex')).toBe('0')
    expect(tabs[1]!.getAttribute('tabindex')).toBe('-1')
    // Both tabs drive the one panel, and it names the tab it is currently showing.
    const panel = screen.getByRole('tabpanel')
    expect(tabs.map((t) => t.getAttribute('aria-controls'))).toEqual([panel.id, panel.id])
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0]!.id)
  })

  it('shows only the official pack on the Official tab', async () => {
    await renderTabs()

    expect(screen.getByRole('radio', { name: /AI Agents/ })).toBeTruthy()
    expect(screen.queryByRole('radio', { name: /Aider/ })).toBeNull()
  })

  it('shows only the contributed pack once Community is chosen', async () => {
    const user = await renderTabs()

    await user.click(screen.getByRole('tab', { name: 'Community' }))

    expect(screen.getByRole('radio', { name: /Aider/ })).toBeTruthy()
    expect(screen.queryByRole('radio', { name: /AI Agents/ })).toBeNull()
    expect(screen.getByRole('tab', { name: 'Community' }).getAttribute('aria-selected')).toBe('true')
  })

  it('submits the pack that was chosen, even from the other tab', async () => {
    // THE anti-silent-loss criterion. A tab switch must move what is on screen and nothing else:
    // it is the same failure rockysurf-va2l fixed for the provider picker, except here the thing
    // decided by list order would be which software gets installed on the box.
    const user = await renderTabs()

    await user.click(screen.getByRole('tab', { name: 'Community' }))
    await user.click(screen.getByRole('radio', { name: /Aider/ }))
    await user.click(screen.getByRole('tab', { name: 'Official' }))

    // Back on Official, the community card is not even rendered — and the choice still stands.
    expect(screen.queryByRole('radio', { name: /Aider/ })).toBeNull()
    expect((screen.getByRole('radio', { name: /AI Agents/ }) as HTMLInputElement).checked).toBe(false)

    await user.click(screen.getByRole('button', { name: /create server/i }))

    // The feed replacing the form is the settle point; the argument is the assertion.
    await screen.findByText(/launching the machine/i)
    expect(vi.mocked(api.createServer).mock.calls[0]?.[0].packId).toBe('aider')
  })

  it('names the selected pack on the tab that does not contain it', async () => {
    const user = await renderTabs()

    await user.click(screen.getByRole('tab', { name: 'Community' }))
    await user.click(screen.getByRole('radio', { name: /Aider/ }))
    expect(screen.getByTestId('pack-selected').textContent).toContain('Aider')

    await user.click(screen.getByRole('tab', { name: 'Official' }))
    expect(screen.getByTestId('pack-selected').textContent).toContain('Aider')
  })

  it('opens on the tab holding the preselected pack, not on Official by rule', async () => {
    // An installation whose only enabled pack is a contributed one. Opening on Official would
    // paint a shelf that does not contain the checked radio.
    const user = userEvent.setup()
    vi.mocked(api.listSurgePacks).mockResolvedValue([communityPack()])
    renderPage()

    const community = await screen.findByRole('tab', { name: 'Community' })
    expect(community.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('radio', { name: /Aider/ })).toBeTruthy()

    // ...and the Official shelf is still offered, saying why it is empty rather than showing a gap.
    await user.click(screen.getByRole('tab', { name: 'Official' }))
    expect(screen.getByTestId('official-empty')).toBeTruthy()
  })

  describe('with nothing contributed installed', () => {
    /**
     * `/packs` is member-reachable (rockysurf-4d8h, issue #51), unlike the admin-only
     * `/admin/pack-shop` it replaced — so this link is offered to a member and an admin alike,
     * a deliberate behaviour change from the admin-gated sentence it used to show.
     */
    it('still offers the Community tab, and points everyone at the Surge Packs page', async () => {
      // Hiding the empty shelf would remove the feature from the installs that most need it: on
      // a fresh install nobody ever learns the catalogue exists.
      const user = userEvent.setup()
      renderPage()
      await screen.findByRole('tab', { name: 'Official' })

      await user.click(screen.getByRole('tab', { name: 'Community' }))

      const empty = screen.getByTestId('community-empty')
      expect(empty.textContent).toContain('No community packs are installed')
      expect(within(empty).getByRole('link').getAttribute('href')).toBe('/packs')
    })

    it('offers the same link to a member, who can now reach it', async () => {
      auth.isAdmin = false
      const user = userEvent.setup()
      renderPage()
      await screen.findByRole('tab', { name: 'Official' })

      await user.click(screen.getByRole('tab', { name: 'Community' }))

      const empty = screen.getByTestId('community-empty')
      expect(within(empty).getByRole('link').getAttribute('href')).toBe('/packs')
    })
  })

  it('moves between tabs with the arrow keys, activating as it goes', async () => {
    const user = await renderTabs()

    await user.click(screen.getByRole('tab', { name: 'Official' }))
    await user.keyboard('{ArrowRight}')

    expect(screen.getByRole('tab', { name: 'Community' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('radio', { name: /Aider/ })).toBeTruthy()
    // Focus follows the activation, which is what makes the next arrow press work.
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Community' }))

    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('tab', { name: 'Official' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('radio', { name: /AI Agents/ })).toBeTruthy()
  })

  it('shows no tabs at all when the installation has no packs', async () => {
    // Nothing to sort into shelves, and the sentence that says how to get one is the message
    // that belongs here.
    vi.mocked(api.listSurgePacks).mockResolvedValue([])
    renderPage()

    expect(await screen.findByText(/No Surge Packs are available yet/)).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
  })
})

/**
 * `?pack=<packId>` PRESELECTION (rockysurf-4d8h, issue #51).
 *
 * Arriving from a pack's "Launch a server with this pack" button. The existing selection rule
 * — lowest `displayOrder` wins absent a request, and the tab follows whichever pack ends up
 * selected — is untouched; the query parameter only supplies a different STARTING pack. Naming
 * one that is not on offer (absent, or disabled) must be stated rather than silently swallowed.
 */
describe('?pack= preselects a Surge Pack from the URL', () => {
  const bothPacksAvailable = () => vi.mocked(api.listSurgePacks).mockResolvedValue([packWith({}), communityPack()])

  it('checks the named pack\'s radio and names it as selected', async () => {
    search.value = 'pack=aider'
    bothPacksAvailable()
    renderPage()

    const radio = (await screen.findByRole('radio', { name: /Aider/ })) as HTMLInputElement
    await waitFor(() => expect(radio.checked).toBe(true))
    expect(screen.getByTestId('pack-selected').textContent).toContain('Aider')
  })

  it('opens the picker on the Community tab when the named pack is a community one', async () => {
    search.value = 'pack=aider'
    bothPacksAvailable()
    renderPage()

    const community = await screen.findByRole('tab', { name: 'Community' })
    expect(community.getAttribute('aria-selected')).toBe('true')
  })

  it('states, rather than swallows, a pack that is not on offer — and falls back to the usual pack', async () => {
    search.value = 'pack=does-not-exist'
    bothPacksAvailable()
    renderPage()

    const notice = await screen.findByTestId('pack-preselect-missing')
    expect(notice.textContent).toContain('does-not-exist')
    // The usual lowest-displayOrder pack still gets preselected — nothing about the fallback
    // rule changes because the request could not be honoured.
    expect(screen.getByRole('radio', { name: /AI Agents/ })).toHaveProperty('checked', true)
  })

  it('states a disabled pack the same way a missing one is stated', async () => {
    search.value = 'pack=aider'
    vi.mocked(api.listSurgePacks).mockResolvedValue([packWith({}), communityPack({ enabled: false })])
    renderPage()

    const notice = await screen.findByTestId('pack-preselect-missing')
    expect(notice.textContent).toContain('aider')
  })

  it('behaves exactly as before when there is no ?pack= at all', async () => {
    bothPacksAvailable()
    renderPage()

    await screen.findByRole('tab', { name: 'Official' })
    expect(screen.queryByTestId('pack-preselect-missing')).toBeNull()
    expect(screen.getByRole('radio', { name: /AI Agents/ })).toHaveProperty('checked', true)
  })

  it('submits the create request with the preselected packId', async () => {
    const user = userEvent.setup()
    search.value = 'pack=aider'
    bothPacksAvailable()
    renderPage()

    await screen.findByRole('radio', { name: /Aider/ })
    await user.click(screen.getByRole('button', { name: /create server/i }))

    await waitFor(() => expect(api.createServer).toHaveBeenCalled())
    expect(vi.mocked(api.createServer).mock.calls[0]?.[0].packId).toBe('aider')
  })
})

describe('capability flags drive provider-specific controls', () => {
  it('warns about trust-on-first-use when the provider cannot inject host keys', async () => {
    vi.mocked(api.listProviders).mockResolvedValue([
      { ...FAKE_PROVIDER, capabilities: { ...FAKE_PROVIDER.capabilities, canInjectHostKeys: false } },
    ])
    renderPage()
    expect(await screen.findByText(/trusted on sight/i)).toBeTruthy()
  })

  it('says nothing about host keys when the provider can inject them', async () => {
    renderPage()
    await screen.findByRole('heading', { name: /small-arm/ })
    expect(screen.queryByText(/trusted on sight/i)).toBeNull()
  })

  it('warns when the provider cannot stop servers', async () => {
    vi.mocked(api.listProviders).mockResolvedValue([
      { ...FAKE_PROVIDER, capabilities: { ...FAKE_PROVIDER.capabilities, stop: false } },
    ])
    renderPage()
    expect(await screen.findByText(/cannot be stopped/i)).toBeTruthy()
  })

  it('hides the provider picker when there is only one', async () => {
    renderPage()
    await screen.findByRole('heading', { name: /small-arm/ })
    expect(screen.queryByRole('radio', { name: 'Fake Cloud' })).toBeNull()
  })
})

/**
 * The SSH key fieldset (issue #41).
 *
 * The two radios used to read as mutually exclusive — "Generate a key for me" versus "Use my
 * own public key" — when picking the second option also gets the user the first: Rocky Surf's
 * key is appended, never substituted, because push bootstrap installs everything over its own
 * SSH connection. This checks the disclosure appears only where it is needed.
 */
describe('the SSH key fieldset explains itself when a key is provided (issue #41)', () => {
  it('states that Rocky Surf also authorizes a key of its own once "Use my own public key" is picked', async () => {
    renderPage()
    await screen.findByRole('heading', { name: /small-arm/ })

    expect(screen.queryByText(/Rocky Surf also authorizes a key of its own/)).toBeNull()

    await userEvent.click(screen.getByRole('radio', { name: /Use my own public key/ }))
    expect(await screen.findByText(/Rocky Surf also authorizes a key of its own/)).toBeTruthy()
  })

  it('says nothing extra while "Generate a key for me" is selected', async () => {
    renderPage()
    await screen.findByRole('heading', { name: /small-arm/ })
    expect(screen.queryByText(/Rocky Surf also authorizes a key of its own/)).toBeNull()
  })
})

/**
 * Choosing the cloud (rockysurf-va2l).
 *
 * The bug the owner reported was a create page with no cloud choice on a two-cloud config, and
 * a server that silently landed on whichever provider came first. These cases pin both halves:
 * the choice exists and reaches the request, and the single-provider page is unchanged.
 */
describe('choosing which cloud to create on', () => {
  const bothProviders = () => vi.mocked(api.listProviders).mockResolvedValue([FAKE_PROVIDER, OTHER_PROVIDER])

  it('offers every loaded provider once more than one is configured', async () => {
    bothProviders()
    renderPage()

    expect(await screen.findByRole('radio', { name: 'Fake Cloud' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Other Cloud' })).toBeTruthy()
  })

  it('preselects nothing, so the cloud is chosen by a person and not by list order', async () => {
    bothProviders()
    renderPage()

    const first = (await screen.findByRole('radio', { name: 'Fake Cloud' })) as HTMLInputElement
    expect(first.checked).toBe(false)
    expect((screen.getByRole('radio', { name: 'Other Cloud' }) as HTMLInputElement).checked).toBe(false)
    // With no cloud chosen there is no plan to price, and no server to create.
    expect(screen.getByRole('button', { name: /create server/i })).toHaveProperty('disabled', true)
  })

  it('re-resolves the plan against the chosen cloud, and sends that choice', async () => {
    const user = userEvent.setup()
    bothProviders()
    renderPage()

    await user.click(await screen.findByRole('radio', { name: 'Fake Cloud' }))
    expect(await screen.findByRole('heading', { name: /small-arm/ })).toBeTruthy()

    // The plan card is the provider's answer, so switching clouds must change it — a stale
    // card would quote one cloud's price for another cloud's machine.
    await user.click(screen.getByRole('radio', { name: 'Other Cloud' }))
    expect(await screen.findByRole('heading', { name: /other-medium/ })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /create server/i }))
    await waitFor(() => expect(api.createServer).toHaveBeenCalled())
    expect(vi.mocked(api.createServer).mock.calls[0]?.[0]).toMatchObject({
      provider: 'other',
      offeringId: 'other-medium',
    })
  })

  it('names the sole cloud rather than saying nothing, when there is only one', async () => {
    renderPage()
    expect((await screen.findByTestId('sole-provider')).textContent).toContain('Fake Cloud')
  })

  it('reports a configured provider that did not load, in the provider words', async () => {
    vi.mocked(api.getSetupState).mockResolvedValue(
      setupWith([
        { id: 'fake', displayName: 'Fake Cloud', enabled: true, configured: true, source: 'config', loaded: true },
        {
          id: 'absent',
          displayName: 'Absent Cloud',
          enabled: true,
          configured: false,
          source: 'none',
          loaded: false,
          unavailableReason: 'sshAllowedCidr is required',
        },
      ]),
    )
    renderPage()

    const notice = await screen.findByTestId('providers-unavailable')
    expect(notice.textContent).toContain('Absent Cloud')
    expect(notice.textContent).toContain('sshAllowedCidr is required')
  })

  it('says nothing when every enabled provider loaded', async () => {
    vi.mocked(api.getSetupState).mockResolvedValue(
      setupWith([
        { id: 'fake', displayName: 'Fake Cloud', enabled: true, configured: true, source: 'config', loaded: true },
      ]),
    )
    renderPage()
    await screen.findByRole('heading', { name: /small-arm/ })
    expect(screen.queryByTestId('providers-unavailable')).toBeNull()
  })

  it('still creates when the setup endpoint fails — the diagnosis is advisory', async () => {
    vi.mocked(api.getSetupState).mockRejectedValue(new Error('setup unavailable'))
    renderPage()
    expect(await screen.findByRole('heading', { name: /small-arm/ })).toBeTruthy()
  })
})

describe('the live provisioning feed replaces the form after create', () => {
  it('shows the step list once the server exists', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: /small-arm/ })

    await user.click(screen.getByRole('button', { name: /create server/i }))

    expect(await screen.findByText(/launching the machine/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /create server/i })).toBeNull()
  })
})

describe('acceptance criteria a reviewer can grep for', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  const sources = [
    read('./CreateServerPage.tsx'),
    read('../components/ProvisioningFeed.tsx'),
    read('../lib/requirements.ts'),
  ].join('\n')
  // Comments explain at length WHY there are no provider-id conditionals; prose is not code.
  const code = sources.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('contains no provider-id conditionals', () => {
    for (const literal of ['aws', 'hetzner', 'byo']) {
      expect(code).not.toMatch(new RegExp(`['"\`]${literal}['"\`]`))
    }
    expect(code).not.toMatch(/provider\.id\s*===/)
    expect(code).not.toMatch(/providerId\s*===\s*['"]/)
  })

  it('contains no pack-id hardcodes, which is what it replaced', () => {
    expect(code).not.toContain('open-claw')
    expect(code).not.toMatch(/packId\s*===\s*['"]/)
  })

  it('carries neither the spot radio nor the billing gate', () => {
    expect(code).not.toMatch(/spotInstance|canCreateServer|billingGate/)
  })

  it('drives provider-specific UI from capabilities only', () => {
    expect(code).toMatch(/capabilities\.canInjectHostKeys/)
    expect(code).toMatch(/capabilities\.stop/)
  })
})

/**
 * THE LIVE TOKEN DISPLAY (rockysurf-18lq).
 *
 * What is being checked here is the page's half of the contract: that it asks core, that it asks
 * once per URL rather than once per keystroke, and that it renders each of the states core can
 * report as a DIFFERENT sentence. The states themselves — which token wins, whether a repository
 * is public, whether the config file has drifted — are decided in core and proved there, against
 * a real forge (`core/src/git/resolve.test.ts`). Restating that logic here would be the second
 * implementation this feature exists to avoid.
 */
describe('live per-repository token resolution', () => {
  const reposPack = () => vi.mocked(api.listSurgePacks).mockResolvedValue([packWith({ requiresRepos: true })])

  const resolution = (over: Partial<api.RepositoryResolution>): api.RepositoryResolution => ({
    url: 'https://github.com/acme/widgets',
    live: { kind: 'none' },
    reachable: 'ok',
    ...over,
  })

  async function typeRepos(text: string) {
    const user = userEvent.setup()
    reposPack()
    renderPage()
    const field = await screen.findByLabelText(/repositories/i)
    await user.type(field, text)
    return field
  }

  it('names the token and the scope a matching repository will use', async () => {
    vi.mocked(api.resolveRepositories).mockResolvedValue([
      resolution({ live: { kind: 'scoped', scope: 'github.com/acme/widgets', envVar: 'ACME_PAT', envVarSet: true } }),
    ])
    await typeRepos('https://github.com/acme/widgets')

    const line = await screen.findByTestId('repo-resolutions')
    await waitFor(() => expect(line.textContent).toContain('ACME_PAT'), { timeout: 3000 })
    expect(line.textContent).toContain('github.com/acme/widgets')
    expect(line.textContent).toContain('opens with')
  })

  it('says a repository is public when core reached it with no token', async () => {
    // The one answer a browser could never work out for itself, which is why the endpoint exists.
    vi.mocked(api.resolveRepositories).mockResolvedValue([
      resolution({ url: 'https://github.com/torvalds/linux', live: { kind: 'none' }, reachable: 'ok' }),
    ])
    await typeRepos('https://github.com/torvalds/linux')

    const line = await screen.findByTestId('repo-resolutions')
    await waitFor(() => expect(line.textContent).toContain('public repository'), { timeout: 3000 })
    expect(line.textContent).toContain('no token needed')
  })

  it('distinguishes the instance-wide fallback from a scoped token', async () => {
    vi.mocked(api.resolveRepositories).mockResolvedValue([resolution({ live: { kind: 'fallback' } })])
    await typeRepos('https://github.com/acme/widgets')

    const line = await screen.findByTestId('repo-resolutions')
    await waitFor(() => expect(line.textContent).toContain('instance-wide'), { timeout: 3000 })
    expect(line.textContent).toContain('github.pat')
  })

  it('shows core’s refusal, and offers Settings when nothing matched', async () => {
    vi.mocked(api.resolveRepositories).mockResolvedValue([
      resolution({
        reachable: 'refused',
        code: 'no_matching_token',
        reason: 'No configured token matches https://github.com/acme/widgets, so the box would clone it anonymously.',
      }),
    ])
    await typeRepos('https://github.com/acme/widgets')

    expect(await screen.findByText(/No configured token matches/, undefined, { timeout: 3000 })).toBeTruthy()
    expect(screen.getByRole('link', { name: /Add one in Settings/i }).getAttribute('href')).toBe('/settings')
  })

  it('does NOT offer Settings for a refusal adding a token would not fix', async () => {
    // A typo is not a missing token, and a link that reads as the remedy for both would send
    // people to edit configuration over a URL they mistyped.
    vi.mocked(api.resolveRepositories).mockResolvedValue([
      resolution({
        url: 'https://github.com/acme/widgts',
        reachable: 'refused',
        code: 'not_found',
        reason: 'It was not found with the configured tokens (HTTP 404).',
      }),
    ])
    await typeRepos('https://github.com/acme/widgts')

    await screen.findByText(/was not found with the configured tokens/, undefined, { timeout: 3000 })
    expect(screen.queryByRole('link', { name: /Add one in Settings/i })).toBeNull()
  })

  it('says a token is waiting on a restart rather than saying there is none (rockysurf-1z5q)', async () => {
    // The state that made the old wording a lie: the operator has just added the entry in
    // Settings, and this process has not read it yet.
    vi.mocked(api.resolveRepositories).mockResolvedValue([
      resolution({
        url: 'https://github.com/acme/private-thing',
        live: { kind: 'none' },
        pending: { kind: 'scoped', scope: 'github.com/acme/private-thing', envVar: 'ACME_PAT', envVarSet: false },
        reachable: 'refused',
        code: 'no_matching_token',
        reason: 'No configured token matches it.',
      }),
    ])
    await typeRepos('https://github.com/acme/private-thing')

    const line = await screen.findByTestId('repo-resolutions')
    await waitFor(() => expect(line.textContent).toContain('has not restarted since it was added'), { timeout: 3000 })
    expect(line.textContent).toContain('ACME_PAT')
    // ...and the sharper half: that restart will FAIL, which is the honest version of refusing.
    expect(line.textContent).toContain('will refuse to start')
  })

  it('says nothing about a restart when the variable is exported', async () => {
    vi.mocked(api.resolveRepositories).mockResolvedValue([
      resolution({
        pending: { kind: 'scoped', scope: 'github.com/acme/widgets', envVar: 'ACME_PAT', envVarSet: true },
      }),
    ])
    await typeRepos('https://github.com/acme/widgets')

    const line = await screen.findByTestId('repo-resolutions')
    await waitFor(() => expect(line.textContent).toContain('has not restarted since it was added'), { timeout: 3000 })
    expect(line.textContent).not.toContain('will refuse to start')
  })

  it('asks once per URL, not once per keystroke', async () => {
    vi.mocked(api.resolveRepositories).mockResolvedValue([resolution({ live: { kind: 'fallback' } })])
    await typeRepos('https://github.com/acme/widgets')

    await screen.findByText(/instance-wide/, undefined, { timeout: 3000 })
    // One URL typed one character at a time. Without the debounce this is one request per
    // character, each of them an outbound probe from core to a forge.
    expect(vi.mocked(api.resolveRepositories).mock.calls).toHaveLength(1)
    expect(vi.mocked(api.resolveRepositories).mock.calls[0]?.[0]).toEqual(['https://github.com/acme/widgets'])
  })

  it('stays quiet, and keeps the form usable, when the check itself fails', async () => {
    // Advisory only: the create route runs the same check for real, and a display that could
    // take the form down with it would be worse than one that is sometimes silent.
    vi.mocked(api.resolveRepositories).mockRejectedValue(new Error('network'))
    await typeRepos('https://github.com/acme/widgets')

    await waitFor(() => expect(api.resolveRepositories).toHaveBeenCalled(), { timeout: 3000 })
    expect(screen.getByRole('button', { name: /create server/i })).toBeTruthy()
  })
})

/**
 * PICKING A CONFIGURED REPOSITORY (rockysurf-mh8f).
 *
 * The owner's correction: the Settings entries already NAME repositories, so retyping them here is
 * the failure. These cases pin the page's half — that it draws chips from whatever core serves,
 * that a click puts the canonical URL in the field and the rockysurf-18lq annotation follows it
 * unchanged, and that the three kinds of entry which do NOT name a repository are stated rather
 * than offered. Which entries exist, what they are called and which of them names a URL are all
 * decided in core and proved there (`core/src/git/resolve.test.ts`).
 */
describe('the configured-repository picker', () => {
  const reposPack = () => vi.mocked(api.listSurgePacks).mockResolvedValue([packWith({ requiresRepos: true })])

  const repoScope = (over: Partial<api.ConfiguredScope> = {}): api.ConfiguredScope => ({
    kind: 'repository',
    scope: 'github.com/acme/private-thing',
    label: 'acme/private-thing',
    url: 'https://github.com/acme/private-thing',
    state: 'live',
    ...over,
  })

  async function renderWith(scopes: api.ConfiguredScope[]) {
    const user = userEvent.setup()
    reposPack()
    vi.mocked(api.listConfiguredScopes).mockResolvedValue(scopes)
    renderPage()
    await screen.findByLabelText(/repositories/i)
    return user
  }

  it('offers each configured repository as a chip, named the way Settings names it', async () => {
    await renderWith([repoScope(), repoScope({ scope: 'github.com/acme/widgets', label: 'acme/widgets', url: 'https://github.com/acme/widgets' })])

    expect(await screen.findByRole('button', { name: /acme\/private-thing/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /acme\/widgets/ })).toBeTruthy()
  })

  it('inserts the canonical URL on click, and the live resolution follows it', async () => {
    // The composition the bead asks for: a picked repository is annotated by exactly the same
    // path as a typed one, because a pick is nothing but text arriving in the textarea.
    vi.mocked(api.resolveRepositories).mockResolvedValue([
      {
        url: 'https://github.com/acme/private-thing',
        live: { kind: 'scoped', scope: 'github.com/acme/private-thing', envVar: 'ACME_PAT', envVarSet: true },
        reachable: 'ok',
      },
    ])
    const user = await renderWith([repoScope()])

    await user.click(await screen.findByRole('button', { name: /acme\/private-thing/ }))

    const field = screen.getByLabelText(/repositories/i) as HTMLTextAreaElement
    expect(field.value).toBe('https://github.com/acme/private-thing')

    const lines = await screen.findByTestId('repo-resolutions')
    await waitFor(() => expect(lines.textContent).toContain('ACME_PAT'), { timeout: 3000 })
    expect(lines.textContent).toContain('opens with')
    expect(vi.mocked(api.resolveRepositories).mock.calls[0]?.[0]).toEqual(['https://github.com/acme/private-thing'])
  })

  it('appends to what is already there on its own line, rather than replacing it', async () => {
    const user = await renderWith([repoScope()])

    const field = await screen.findByLabelText(/repositories/i)
    await user.type(field, 'https://github.com/torvalds/linux')
    await user.click(screen.getByRole('button', { name: /acme\/private-thing/ }))

    expect((field as HTMLTextAreaElement).value).toBe(
      'https://github.com/torvalds/linux\nhttps://github.com/acme/private-thing',
    )
  })

  it('adds a repository once, and says so rather than offering a click that does nothing', async () => {
    const user = await renderWith([repoScope()])

    const chip = await screen.findByRole('button', { name: /acme\/private-thing/ })
    await user.click(chip)
    // The chip stays in place and goes flat, so the list keeps its shape as the operator works
    // down it — and there is no second click to add a duplicate line.
    await waitFor(() => expect(screen.getByRole('button', { name: /acme\/private-thing/ })).toHaveProperty('disabled', true))
    expect(screen.getByRole('button', { name: /added/ })).toBeTruthy()

    const field = screen.getByLabelText(/repositories/i) as HTMLTextAreaElement
    expect(field.value).toBe('https://github.com/acme/private-thing')
  })

  it('reads "added" off the field, so a URL typed by hand disables its chip too', async () => {
    // The dedupe is a fact about the box's contents, not a memory of which chips were clicked.
    // An operator who pasted the URL before noticing the picker must not be offered it again.
    const user = await renderWith([repoScope()])

    await user.type(await screen.findByLabelText(/repositories/i), 'https://github.com/acme/private-thing')
    await waitFor(() => expect(screen.getByRole('button', { name: /acme\/private-thing/ })).toHaveProperty('disabled', true))
  })

  it('states an account, a forge and the fallback instead of offering them as buttons', async () => {
    // The design call this bead had to make. An account entry names an ACCOUNT and v0.1 cannot
    // list what is under one, so a chip inserting `https://github.com/acme/` would put a line in
    // the box that is not a repository — the picker manufacturing the refusal it exists to avoid.
    await renderWith([
      { kind: 'account', scope: 'github.com/acme/*', label: 'acme', envVar: 'ACME_PAT', state: 'live' },
      { kind: 'host', scope: 'git.example.com/*/*', label: 'git.example.com', state: 'live' },
      { kind: 'fallback', scope: '*', envVar: 'GITHUB_PAT', state: 'live' },
    ])

    const context = await screen.findByTestId('repo-picker-context')
    expect(context.textContent).toContain('acme')
    expect(context.textContent).toContain('any repository under this account')
    expect(context.textContent).toContain('anything on this forge')
    expect(context.textContent).toContain('github.pat')
    expect(context.textContent).toContain('ACME_PAT')
    // Not one of them is clickable, because not one of them names a URL to insert.
    expect(screen.queryByRole('button', { name: /acme/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /git\.example\.com/ })).toBeNull()
    // ...and with no chips above it, this list is not "also" anything.
    expect(screen.queryByText(/Also configured/)).toBeNull()
    expect(screen.getByText(/^Configured, but naming no single repository/)).toBeTruthy()
  })

  it('offers a repository the config file holds and the process has not read, marked as such', async () => {
    // The moment the picker exists for: the entry was saved in Settings a minute ago. It is a
    // real repository, so it is still worth inserting — the per-URL line then says the rest.
    await renderWith([repoScope({ state: 'pending', envVar: 'ACME_PAT', envVarSet: false })])

    const chip = await screen.findByRole('button', { name: /acme\/private-thing/ })
    expect(chip.textContent).toContain('after a restart')
    expect(chip).toHaveProperty('disabled', false)
  })

  it('shows no picker at all when nothing is configured', async () => {
    await renderWith([])
    expect(screen.queryByTestId('repo-picker')).toBeNull()
  })

  it('shows no picker when the only credential is the instance-wide fallback', async () => {
    // The hint above this field already says that private repositories use `github.pat`. A panel
    // repeating it would be new chrome earning nothing.
    await renderWith([{ kind: 'fallback', scope: '*', envVar: 'GITHUB_PAT', state: 'live' }])
    expect(screen.queryByTestId('repo-picker')).toBeNull()
  })

  it('keeps the form usable when the picker’s own read fails', async () => {
    reposPack()
    vi.mocked(api.listConfiguredScopes).mockRejectedValue(new Error('network'))
    renderPage()

    expect(await screen.findByLabelText(/repositories/i)).toBeTruthy()
    expect(screen.queryByTestId('repo-picker')).toBeNull()
    expect(screen.getByRole('button', { name: /create server/i })).toBeTruthy()
  })

  it('renders nothing from a scope beyond its name, its URL and its variable', async () => {
    /*
     * The never-a-value rule, on this end (rockysurf-18lq's assertions are core-side, where the
     * payload is built). `ConfiguredScope` has no field a token could travel in and core never
     * reads `pat` — so this pins the OTHER half: that the page renders named fields rather than
     * whatever arrived. A `JSON.stringify(scope)` or a spread into an attribute fails here.
     */
    await renderWith([{ ...repoScope(), pat: 'ghp_a_token_that_must_never_render' } as api.ConfiguredScope])

    const picker = await screen.findByTestId('repo-picker')
    expect(picker.outerHTML).not.toContain('ghp_a_token_that_must_never_render')
    expect(picker.textContent).toContain('acme/private-thing')
  })
})

/**
 * THE MACHINE TYPE PICKER — issue #24 PR 1 (rockysurf-kh3u).
 *
 * A size is a floor; this disclosure is the honest way to name an exact machine instead. The
 * cases that matter most: picking a row must OMIT `size` from the request rather than send the
 * literal `'custom'` (core derives that server-side), picking one must visibly deselect the Size
 * radios above it, and a sold-out row must be disabled rather than pickable.
 */
describe('the machine type picker', () => {
  const MANY_PROVIDER: api.ProviderInfo = {
    ...FAKE_PROVIDER,
    offerings: [
      { id: 'small-arm', cpu: 2, memoryGb: 2, diskGb: 40, arch: 'arm64', hourly: price(0.0168), available: true, region: 'fake-1' },
      { id: 'small-x86', cpu: 2, memoryGb: 2, diskGb: 40, arch: 'amd64', hourly: price(0.0208), available: true, region: 'fake-1' },
      { id: 'big-arm', cpu: 4, memoryGb: 8, diskGb: 80, arch: 'arm64', hourly: price(0.0672), available: true, region: 'fake-1' },
      { id: 'sold-out-type', cpu: 8, memoryGb: 16, arch: 'amd64', hourly: price(0.15), available: false, region: 'fake-1' },
      {
        id: 'no-quota-type',
        cpu: 8,
        memoryGb: 32,
        arch: 'amd64',
        hourly: price(0.3),
        available: false,
        unavailableReason: 'no core quota for standardBpsv2Family in eastus (approved limit is 0)',
        region: 'fake-1',
      },
      { id: 'unpriced-type', cpu: 16, memoryGb: 32, arch: 'arm64', hourly: null, available: true, region: 'fake-2' },
    ],
  }

  // "Available only" defaults to checked (issue #153), so a case that wants to see an
  // unavailable row on screen has to say so explicitly rather than getting one by accident.
  async function openPicker(provider: api.ProviderInfo = MANY_PROVIDER, { showUnavailable = false } = {}) {
    const user = userEvent.setup()
    vi.mocked(api.listProviders).mockResolvedValue([provider])
    renderPage()
    // The form is fully loaded once the submit button exists — generic across fixtures, unlike
    // waiting for a specific offering's heading, which the render-cap fixture below has none of.
    await screen.findByRole('button', { name: /create server/i })
    await user.click(screen.getByRole('button', { name: /choose a specific machine type/i }))
    if (showUnavailable) await user.click(screen.getByRole('checkbox', { name: /available only/i }))
    return user
  }

  it('lists every offering from the resolved provider, capped and searchable', async () => {
    await openPicker(MANY_PROVIDER, { showUnavailable: true })

    expect(screen.getByRole('cell', { name: 'small-arm' })).toBeTruthy()
    expect(screen.getByRole('cell', { name: 'big-arm' })).toBeTruthy()
    expect(screen.getByRole('cell', { name: 'sold-out-type' })).toBeTruthy()
  })

  it('filters the table as the search box is typed into', async () => {
    const user = await openPicker()

    await user.type(screen.getByLabelText(/search machine types/i), 'big-arm')

    expect(screen.getByRole('cell', { name: 'big-arm' })).toBeTruthy()
    expect(screen.queryByRole('cell', { name: 'small-arm' })).toBeNull()
  })

  it('says "price unknown" rather than blank or $0 for an unpriced offering', async () => {
    await openPicker()
    expect(screen.getByText(/price unknown/i)).toBeTruthy()
  })

  it('disables a sold-out row rather than letting it be picked', async () => {
    await openPicker(MANY_PROVIDER, { showUnavailable: true })

    const row = screen.getByRole('cell', { name: 'sold-out-type' }).closest('tr')!
    expect(within(row).getByText(/sold out right now/i)).toBeTruthy()
    expect(within(row).queryByRole('button', { name: /^select$/i })).toBeNull()
  })

  it('states the reason as text, not as a page-level warning banner (issue #113)', async () => {
    await openPicker(MANY_PROVIDER, { showUnavailable: true })

    // `.warning` is a block notice — border, background, a rem of horizontal padding — and an
    // inline span inside a table cell wearing it painted that box outside the table, over the
    // rows above and below. The colour is what carries the meaning in a cell; the box was only
    // ever leaking.
    const row = screen.getByRole('cell', { name: 'sold-out-type' }).closest('tr')!
    const reason = within(row).getByText(/sold out right now/i)
    expect(reason.classList.contains('warning')).toBe(false)
    expect(reason.classList.contains('unavailable')).toBe(true)
  })

  it("shows the provider's own reason instead of \"sold out\" when it gives one (issue #116)", async () => {
    await openPicker(MANY_PROVIDER, { showUnavailable: true })

    const row = screen.getByRole('cell', { name: 'no-quota-type' }).closest('tr')!
    expect(within(row).getByText(/no core quota for standardBpsv2Family in eastus/i)).toBeTruthy()
    expect(within(row).queryByText(/sold out right now/i)).toBeNull()
    expect(within(row).queryByRole('button', { name: /^select$/i })).toBeNull()
  })

  it('selecting a row posts offeringId and arch and OMITS size entirely', async () => {
    const user = await openPicker()

    const row = screen.getByRole('cell', { name: 'big-arm' }).closest('tr')!
    await user.click(within(row).getByRole('button', { name: /^select$/i }))

    await user.click(screen.getByRole('button', { name: /create server/i }))

    await waitFor(() => expect(api.createServer).toHaveBeenCalled())
    const sent = vi.mocked(api.createServer).mock.calls[0]?.[0]
    expect(sent).toMatchObject({ offeringId: 'big-arm', arch: 'arm64' })
    // THE ASSERTION THE BEAD ASKS FOR: not merely that `size` is absent from a `toMatchObject`
    // partial match, but that the key is not present on the request object at all.
    expect(Object.prototype.hasOwnProperty.call(sent, 'size')).toBe(false)
  })

  it('deselects the Size radios once a machine type is picked', async () => {
    const user = await openPicker()

    expect((screen.getByRole('radio', { name: /small/i }) as HTMLInputElement).checked).toBe(true)

    const row = screen.getByRole('cell', { name: 'big-arm' }).closest('tr')!
    await user.click(within(row).getByRole('button', { name: /^select$/i }))

    expect((screen.getByRole('radio', { name: /small/i }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('radio', { name: /^large/i }) as HTMLInputElement).checked).toBe(false)
  })

  it('re-selecting a Size radio clears the machine-type pick and sends size again', async () => {
    const user = await openPicker()

    const row = screen.getByRole('cell', { name: 'big-arm' }).closest('tr')!
    await user.click(within(row).getByRole('button', { name: /^select$/i }))
    expect(within(row).getByRole('button', { name: /^selected$/i })).toBeTruthy()

    await user.click(screen.getByRole('radio', { name: /large/i }))
    // The pick itself is gone — the row goes back to offering itself, not showing "selected".
    expect(within(row).getByRole('button', { name: /^select$/i })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /create server/i }))

    await waitFor(() => expect(api.createServer).toHaveBeenCalled())
    const sent = vi.mocked(api.createServer).mock.calls[0]?.[0]
    // `size` is back in the request — omitted only while a machine type is picked.
    expect(sent).toMatchObject({ size: 'large' })
  })

  it('shows the picked machine in the resolved-offering summary, keyed off its own id', async () => {
    const user = await openPicker()

    const row = screen.getByRole('cell', { name: 'big-arm' }).closest('tr')!
    await user.click(within(row).getByRole('button', { name: /^select$/i }))

    expect(await screen.findByRole('heading', { name: /big-arm/ })).toBeTruthy()
  })

  it('switching provider clears the machine-type pick', async () => {
    const OTHER = { ...MANY_PROVIDER, id: 'other', displayName: 'Other Cloud' }
    const user = userEvent.setup()
    vi.mocked(api.listProviders).mockResolvedValue([MANY_PROVIDER, OTHER])
    renderPage()
    await user.click(await screen.findByRole('radio', { name: MANY_PROVIDER.displayName }))
    await user.click(screen.getByRole('button', { name: /choose a specific machine type/i }))

    const row = screen.getByRole('cell', { name: 'big-arm' }).closest('tr')!
    await user.click(within(row).getByRole('button', { name: /^select$/i }))
    expect(await screen.findByRole('heading', { name: /big-arm/ })).toBeTruthy()

    await user.click(screen.getByRole('radio', { name: 'Other Cloud' }))
    // Back to the size-driven plan — a machine type named on the cloud just left behind
    // cannot still be what gets created.
    expect(screen.queryByRole('heading', { name: /big-arm/ })).toBeNull()
  })

  it('caps rendered rows and says how many more a narrower search would show', async () => {
    const many: api.ProviderInfo = {
      ...FAKE_PROVIDER,
      offerings: Array.from({ length: 60 }, (_, i) => ({
        id: `type-${String(i).padStart(2, '0')}`,
        cpu: 2,
        memoryGb: 2,
        arch: 'amd64' as const,
        hourly: price(0.01),
        available: true,
        region: 'fake-1',
      })),
    }
    await openPicker(many)

    expect(screen.getByText(/more — refine your search/i)).toBeTruthy()
  })

  it('placeholder describes what the search actually matches — type and region (issue #151)', async () => {
    await openPicker()

    expect(screen.getByPlaceholderText(/search by type or region/i)).toBeTruthy()
  })

  describe('the "Available only" checkbox (issue #153)', () => {
    it('is checked by default and hides rows with available:false', async () => {
      await openPicker()

      const checkbox = screen.getByRole('checkbox', { name: /available only/i }) as HTMLInputElement
      expect(checkbox.checked).toBe(true)
      expect(screen.getByRole('cell', { name: 'small-arm' })).toBeTruthy()
      expect(screen.queryByRole('cell', { name: 'sold-out-type' })).toBeNull()
      expect(screen.queryByRole('cell', { name: 'no-quota-type' })).toBeNull()
    })

    it('shows a count of unavailable rows the checkbox is hiding', async () => {
      await openPicker()

      // MANY_PROVIDER has two unavailable offerings: sold-out-type and no-quota-type.
      expect(screen.getByTestId('machine-picker-hidden-count').textContent).toBe('2 unavailable hidden')
    })

    it('unchecking reveals the hidden rows and drops the count; re-checking hides them again', async () => {
      const user = await openPicker(MANY_PROVIDER, { showUnavailable: true })

      expect(screen.getByRole('cell', { name: 'sold-out-type' })).toBeTruthy()
      expect(screen.queryByTestId('machine-picker-hidden-count')).toBeNull()

      await user.click(screen.getByRole('checkbox', { name: /available only/i }))

      expect(screen.queryByRole('cell', { name: 'sold-out-type' })).toBeNull()
      expect(screen.getByTestId('machine-picker-hidden-count').textContent).toBe('2 unavailable hidden')
    })

    it('shows no count when nothing is hidden', async () => {
      await openPicker(FAKE_PROVIDER)

      expect(screen.queryByTestId('machine-picker-hidden-count')).toBeNull()
    })

    it('never hides the saved/preferred type, even though it is unavailable (#152 tier preference)', async () => {
      const withUnavailablePreference: api.ProviderInfo = {
        ...MANY_PROVIDER,
        tierPreferences: { small: 'no-quota-type' },
      }
      await openPicker(withUnavailablePreference)

      // The row stays, with the same reason the Size fieldset's note above already gives —
      // hiding it here would make that note point at nothing visible in this table.
      const row = screen.getByRole('cell', { name: 'no-quota-type' }).closest('tr')!
      expect(within(row).getByText(/no core quota for standardBpsv2Family in eastus/i)).toBeTruthy()
      // An unavailable row with no preference tied to it is still hidden as normal.
      expect(screen.queryByRole('cell', { name: 'sold-out-type' })).toBeNull()
    })
  })
})

/* ------------------------------------------------------- saved machine types (issue #124) */

/**
 * THE SAME TYPES COME UP EVERY TIME, which is the issue in one sentence.
 *
 * Two halves, and both are here: the picker HONOURS what core sent, and the page can SAVE a new
 * one without the user going anywhere. The saving half writes the config file through the same
 * guarded settings route the Settings page uses — read for the mtime, then save against it —
 * so what is checked is the path it names and the guard it presents, not just that a button
 * exists.
 */
describe('a saved machine type on the New Server page (issue #124)', () => {
  const WITH_SAVED: api.ProviderInfo = { ...FAKE_PROVIDER, tierPreferences: { small: 'big-arm' } }

  const settingsView = (mtimeMs: number | null = 1234): api.SettingsView => ({
    file: { path: '/home/rocky/.rockysurf/config.yaml', exists: true, mtimeMs },
    values: {},
    defaults: {},
    fields: [],
    sections: [],
    lists: [],
    drifted: false,
    restartHint: 'Changes apply after a restart.',
  })

  it('resolves small to the saved type instead of the cheapest that fits', async () => {
    vi.mocked(api.listProviders).mockResolvedValue([WITH_SAVED])
    renderPage()

    // `small-arm` is cheaper and meets the floor; `big-arm` is what this user asked for.
    expect(await screen.findByRole('heading', { name: /big-arm/ })).toBeTruthy()
    expect(screen.getByTestId('size-resolves-small').textContent).toContain('big-arm')
    expect(screen.getByTestId('size-preferred-small').textContent).toMatch(/saved/i)
  })

  it('submits the saved type, so the machine created is the one shown', async () => {
    const user = userEvent.setup()
    vi.mocked(api.listProviders).mockResolvedValue([WITH_SAVED])
    renderPage()
    await screen.findByRole('heading', { name: /big-arm/ })

    await user.click(screen.getByRole('button', { name: /create server/i }))
    await waitFor(() => expect(api.createServer).toHaveBeenCalled())
    expect(vi.mocked(api.createServer).mock.calls[0]?.[0]).toMatchObject({ offeringId: 'big-arm', size: 'small' })
  })

  it('leaves a size with nothing saved exactly as it was', async () => {
    vi.mocked(api.listProviders).mockResolvedValue([WITH_SAVED])
    renderPage()
    await screen.findByRole('heading', { name: /big-arm/ })

    // `large` has no saved type, so it still resolves the way it always did.
    expect(screen.getByTestId('size-resolves-large').textContent).toContain('big-arm')
    expect(screen.queryByTestId('size-preferred-large')).toBeNull()
  })

  it('falls back and SAYS WHY when the saved type is unavailable', async () => {
    vi.mocked(api.listProviders).mockResolvedValue([
      {
        ...FAKE_PROVIDER,
        tierPreferences: { small: 'quota-type' },
        offerings: [
          ...FAKE_PROVIDER.offerings,
          {
            id: 'quota-type',
            cpu: 4,
            memoryGb: 8,
            arch: 'arm64',
            hourly: price(0.09),
            available: false,
            unavailableReason: 'no core quota for standardBpsv2Family in eastus (approved limit is 0)',
            region: 'fake-1',
          },
        ],
      },
    ])
    renderPage()

    // Not a refusal — the create still works, on the ordinary default.
    expect(await screen.findByRole('heading', { name: /small-arm/ })).toBeTruthy()
    const note = screen.getByTestId('tier-preference-note').textContent ?? ''
    expect(note).toContain('quota-type')
    // The provider's own reason (#139), not a generic "sold out": the cure is a portal request.
    expect(note).toContain('no core quota')
    expect(note).toContain('small-arm')

    // ...and it goes away once a machine type is picked by hand, because that overrides every
    // size: a sentence about what `small` would have resolved to answers nothing then.
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /choose a specific machine type/i }))
    await user.click(within(screen.getByRole('cell', { name: 'big-arm' }).closest('tr')!).getByRole('button', { name: /^select$/i }))
    expect(screen.queryByTestId('tier-preference-note')).toBeNull()
  })

  it('offers to remember a machine type once one has been picked by hand', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('button', { name: /create server/i })

    // Nothing to remember until the user has picked something.
    expect(screen.queryByTestId('remember-tier')).toBeNull()

    await user.click(screen.getByRole('button', { name: /choose a specific machine type/i }))
    await user.click(within(screen.getByRole('cell', { name: 'big-arm' }).closest('tr')!).getByRole('button', { name: /^select$/i }))

    const remember = screen.getByTestId('remember-tier')
    expect(remember.textContent).toContain('big-arm')
    expect(remember.textContent).toContain('Fake Cloud')
  })

  it('writes the preference to the config file, guarded by the mtime it just read', async () => {
    const user = userEvent.setup()
    const get = vi.spyOn(api, 'getSettings').mockResolvedValue(settingsView(99))
    const put = vi.spyOn(api, 'saveSettings').mockResolvedValue({ ...settingsView(100), saved: true })

    renderPage()
    await screen.findByRole('button', { name: /create server/i })
    await user.click(screen.getByRole('button', { name: /choose a specific machine type/i }))
    await user.click(within(screen.getByRole('cell', { name: 'big-arm' }).closest('tr')!).getByRole('button', { name: /^select$/i }))

    await user.click(within(screen.getByTestId('remember-tier')).getByRole('button', { name: /^medium$/i }))

    await waitFor(() => expect(put).toHaveBeenCalled())
    expect(get).toHaveBeenCalled()
    // The concurrency token is the whole reason the settings route is safe to write through.
    expect(put.mock.calls[0]?.[0]).toBe(99)
    expect(put.mock.calls[0]?.[1]).toEqual([
      { path: ['preferences', 'tiers', 'fake', 'medium'], value: 'big-arm' },
    ])
  })

  it('applies what was just saved to the page it was saved from', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'getSettings').mockResolvedValue(settingsView())
    vi.spyOn(api, 'saveSettings').mockResolvedValue({ ...settingsView(), saved: true })

    renderPage()
    await screen.findByRole('button', { name: /create server/i })
    await user.click(screen.getByRole('button', { name: /choose a specific machine type/i }))
    await user.click(within(screen.getByRole('cell', { name: 'big-arm' }).closest('tr')!).getByRole('button', { name: /^select$/i }))
    await user.click(within(screen.getByTestId('remember-tier')).getByRole('button', { name: /^small$/i }))

    // `/providers` is fetched once, so without this the person who just saved a preference would
    // be the only one still looking at the old default.
    await waitFor(() => expect(screen.getByTestId('size-resolves-small').textContent).toContain('big-arm'))
    expect(screen.getByTestId('size-preferred-small')).toBeTruthy()
  })

  it('does not offer the button to someone who may not write the config file', async () => {
    // `/api/v1/settings` is admin-only. A control that always 403s is worse than no control.
    auth.isAdmin = false
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('button', { name: /create server/i })
    await user.click(screen.getByRole('button', { name: /choose a specific machine type/i }))
    await user.click(within(screen.getByRole('cell', { name: 'big-arm' }).closest('tr')!).getByRole('button', { name: /^select$/i }))

    expect(screen.queryByTestId('remember-tier')).toBeNull()
  })
})
