import { test, expect } from './fixtures'

/**
 * THE PROVIDERS TAB OF THE SHOP, IN A REAL BROWSER (ADR-0028, issue #374).
 *
 * TWO HALVES, AND THE SPLIT IS DELIBERATE.
 *
 * The FIRST half drives the real page against a fixture registry served by the browser's own
 * network layer. It cannot be served from a local HTTP server instead: every registry fetch
 * this control plane makes goes through the SSRF guard, which refuses any host resolving to a
 * loopback or private address — so a registry on `127.0.0.1` is refused before a socket opens,
 * by design, and weakening that to make a test easier would be weakening the control the guard
 * exists for. The fixture below is the shape `packages/web/e2e/fixtures/personal-provider`
 * publishes: the same id, the same package name, the same declared settings and the same
 * capability answers the Nimbus fixture's factory carries.
 *
 * The SECOND half takes the interception away and asks the REAL control plane, so the tab is
 * proved to be wired to core rather than to a stub: this installation runs with
 * `registry.enabled: false` (see `control-plane.ts`), and the tab says so in those words.
 *
 * The install path that actually writes a package and a config line is covered end to end, with
 * a real temporary data directory and a real config file, by
 * `packages/core/src/providers/shop-routes.test.ts`.
 */

const TRUST = "a provider runs with Rocky Surf's full access — install ones you trust."

const LISTING = {
  enabled: true,
  sources: [{ name: 'Rocky Surf Pack Shop', url: 'https://example.test/shop', trust: 'community' }],
  trustSentence: TRUST,
  shelves: [
    {
      source: { name: 'Rocky Surf Pack Shop', url: 'https://example.test/shop', trust: 'community' },
      fetchedAt: '2026-09-04T00:00:00.000Z',
      failure: null,
      providers: [
        {
          providerId: 'nimbus',
          name: 'Nimbus Cloud',
          description: 'A fixture cloud: everything it does is in memory, nothing is billed.',
          version: '1.2.0',
          package: 'rockysurf-provider-nimbus',
          tarball: 'https://example.test/shop/artifacts/nimbus-1.2.0.tgz',
          sha256: 'a'.repeat(64),
          settings: [
            { name: 'token', label: 'API token variable', kind: 'secret' },
            { name: 'region', label: 'Region', kind: 'string' },
            { name: 'sshAllowedCidr', label: 'SSH allowed from', kind: 'sshCidrList' },
          ],
          capabilities: {
            stop: true,
            ipStableAcrossStop: true,
            canInjectHostKeys: false,
            generatesUserData: false,
            userDataMaxBytes: 0,
            managesSshAccess: true,
            simulatedInstances: true,
          },
          sourceName: 'Rocky Surf Pack Shop',
          trust: 'community',
          installed: false,
          installedVersion: null,
        },
      ],
    },
  ],
}

const withListing = (installed: boolean, installedVersion: string | null) => ({
  ...LISTING,
  shelves: [{ ...LISTING.shelves[0]!, providers: [{ ...LISTING.shelves[0]!.providers[0]!, installed, installedVersion }] }],
})

test('the tab lists a provider with its capability answers, its settings and the trust sentence', async ({ page }) => {
  await page.route('**/api/v1/admin/provider-registry*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LISTING) }),
  )

  await page.goto('/packs?tab=providers')

  /* The page is the Shop now, and Providers is one of its tabs. */
  await expect(page.getByRole('heading', { name: 'Shop', level: 1 })).toBeVisible()
  const card = page.getByTestId('provider-nimbus')
  await expect(card.getByRole('heading', { name: 'Nimbus Cloud' })).toBeVisible()
  await expect(card.getByText('rockysurf-provider-nimbus')).toBeVisible()

  /* The capability answers, before anything is installed. */
  const answers = page.getByTestId('provider-capabilities-nimbus')
  await expect(answers).toContainText('Not billed for compute')
  await expect(answers).toContainText('Pushed to the cloud on save')
  await expect(answers).toContainText('Simulated')

  /* What it will ask to be configured with, including which field is a credential. */
  await expect(page.getByTestId('provider-settings-nimbus')).toContainText('API token variable (a credential)')
  await expect(page.getByTestId('provider-settings-nimbus')).toContainText('SSH allowed from')

  /* VERBATIM. Not a paraphrase, not a link to one — the exact sentence, on the entry. */
  await expect(page.getByTestId('provider-trust-nimbus')).toHaveText(TRUST)
})

test('installing sends only the address, and the page then says a restart is what is left', async ({ page }) => {
  let installed = false
  await page.route('**/api/v1/admin/provider-registry*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(installed ? withListing(true, '1.2.0') : LISTING),
    }),
  )

  const posted: string[] = []
  await page.route('**/api/v1/admin/provider-registry/*/*/install', (route) => {
    posted.push(new URL(route.request().url()).pathname)
    /* The body is empty: an install names the provider and nothing else, so nothing the browser
       holds can decide which artifact core fetches. */
    expect(route.request().postData()).toBeFalsy()
    installed = true
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        providerId: 'nimbus',
        package: 'rockysurf-provider-nimbus',
        version: '1.2.0',
        trustSentence: TRUST,
        restartRequired: true,
        restartReason:
          'A provider package is loaded when Rocky Surf starts. Restart it to load ' +
          'rockysurf-provider-nimbus, then configure nimbus on the Settings page.',
      }),
    })
  })

  await page.goto('/packs?tab=providers')
  await page.getByRole('button', { name: 'Install 1.2.0' }).click()

  await expect(page.getByTestId('providers-restart-notice')).toContainText('Restart it to load')
  expect(posted).toEqual(['/api/v1/admin/provider-registry/Rocky%20Surf%20Pack%20Shop/nimbus/install'])

  /* And the entry now reads as installed, with Remove beside it. */
  await expect(page.getByTestId('provider-installed-nimbus')).toContainText('version 1.2.0')
  await expect(page.getByRole('button', { name: 'Reinstall' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Remove' })).toBeVisible()
})

test('removing asks first, naming the package and the config section it would delete', async ({ page }) => {
  await page.route('**/api/v1/admin/provider-registry*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(withListing(true, '1.2.0')) }),
  )
  let removed = false
  await page.route('**/api/v1/admin/personal-providers/nimbus', (route) => {
    removed = true
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        providerId: 'nimbus',
        removed: 'rockysurf-provider-nimbus',
        restartRequired: true,
        restartReason: 'nimbus is still loaded in this running process. Restart Rocky Surf to unload it.',
      }),
    })
  })

  await page.goto('/packs?tab=providers')

  /* Dismissed: nothing is deleted on a click alone. */
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('rockysurf-provider-nimbus')
    expect(dialog.message()).toContain('providers.nimbus')
    void dialog.dismiss()
  })
  await page.getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByTestId('providers-restart-notice')).toHaveCount(0)
  expect(removed).toBe(false)

  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByTestId('providers-restart-notice')).toContainText('Restart Rocky Surf to unload it')
})

/**
 * The wiring, with nothing intercepted. This installation boots with `registry.enabled: false`,
 * so the tab's answer comes from the real route, the real client and the real config file.
 */
test('with nothing stubbed, the tab reports what the real control plane says', async ({ page }) => {
  await page.goto('/packs?tab=providers')
  await expect(page.getByTestId('providers-registry-disabled')).toBeVisible()
  await expect(page.getByTestId('providers-trust-sentence')).toHaveText(TRUST)
})
