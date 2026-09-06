import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './fixtures'

/**
 * THE ROCKY SURF SHOP TAB, IN A REAL BROWSER, AGAINST A REAL INSTALL PATH (issue #426, ADR-0028).
 *
 * This installation boots against the fixture shop in `control-plane.ts` (`registry: 'fixture'`
 * below): a registry directory answered from inside the binary's own process under an origin the
 * SSRF guard accepts, listing one community pack, the REAL packed `@rockysurf/provider-digitalocean`
 * and one provider entry whose digest is deliberately wrong. Nothing about the control plane is
 * stubbed and no request from the browser is intercepted: every click below reaches the shipped
 * routes, the shipped registry clients, the shipped tar reader and the shipped config write, and
 * the assertions read the config file and the data directory back from disk.
 *
 * WHY ITS OWN INSTALLATION. Installing a provider writes `providers.digitalocean` into the config
 * file and a package under `<dataDir>/providers`, and the restart that follows is a fact about
 * the whole process — no other file may share this history. `registry` is a worker option, so
 * naming it here is what gives this file its own worker and its own Rocky Surf.
 *
 * SERIAL, AND IN THIS ORDER: browse, refuse, install, restart, configure. Each test's first
 * assertion is about the state the previous one left.
 */
test.describe.configure({ mode: 'serial' })
test.use({ registry: 'fixture' })

const TRUST = "a provider runs with Rocky Surf's full access — install ones you trust."

test('is its own tab, and lists the fixture shop\'s pack and providers with everything a person reads before consenting', async ({ page, controlPlane }) => {
  await page.goto('/shop')

  await expect(page.getByRole('heading', { name: 'Rocky Surf Shop', level: 1 })).toBeVisible()
  const nav = page.getByRole('navigation', { name: 'Primary' })
  await expect(nav.getByRole('link', { name: 'Rocky Surf Shop' })).toHaveAttribute('aria-current', 'page')
  await expect(nav.getByRole('link', { name: 'Surge Packs' })).toHaveAttribute('href', '/packs')

  /* The pack half: the fixture shop's one pack, not installed yet, with Review as the only way in. */
  const pack = page.getByTestId('shop-pack-shop-fixture')
  await expect(pack.getByRole('heading', { name: 'Shop Fixture' })).toBeVisible()
  await expect(pack.getByRole('button', { name: 'Review' })).toBeVisible()
  await expect(page.getByTestId('shop-pack-installed-shop-fixture')).toHaveCount(0)

  /* The provider half: the DigitalOcean entry as the live shop lists it — name, description,
     version, the settings it will ask for, the capability answers in words, the sentence. */
  const card = page.getByTestId('provider-digitalocean')
  await expect(card.getByRole('heading', { name: 'DigitalOcean' })).toBeVisible()
  await expect(card.getByText('@rockysurf/provider-digitalocean')).toBeVisible()
  await expect(card).toContainText('DigitalOcean droplets over the public REST API')
  await expect(card.getByRole('button', { name: `Install ${controlPlane.shop!.digitaloceanVersion}` })).toBeVisible()
  const answers = page.getByTestId('provider-capabilities-digitalocean')
  await expect(answers).toContainText('Still billed at the running rate')
  await expect(answers).toContainText('Pushed to the cloud on save')
  await expect(answers).toContainText('Placed at create time')
  await expect(page.getByTestId('provider-settings-digitalocean')).toContainText('Token Environment Variable (a credential)')
  await expect(page.getByTestId('provider-settings-digitalocean')).toContainText('SSH allowed from')
  await expect(page.getByTestId('provider-trust-digitalocean')).toHaveText(TRUST)
  await expect(page.getByTestId('provider-installed-digitalocean')).toHaveCount(0)
})

test('refuses a listing whose digest does not match, in a sentence, and writes nothing under the data directory', async ({ page, controlPlane }) => {
  await page.goto('/shop')

  const stale = page.getByTestId('provider-stale')
  await stale.getByRole('button', { name: 'Install 0.0.0' }).click()

  /* The refusal names both digests, and it is the whole outcome: no restart notice, no package. */
  await expect(page.getByText(/does not match the digest the listing published for it/)).toBeVisible()
  await expect(page.getByTestId('providers-restart-notice')).toHaveCount(0)
  const providersDir = join(controlPlane.dataDir, 'providers')
  expect(existsSync(join(providersDir, 'node_modules', 'rockysurf-provider-nimbus'))).toBe(false)
  if (existsSync(join(providersDir, 'node_modules'))) {
    expect(readdirSync(join(providersDir, 'node_modules')).filter((name) => !name.startsWith('.'))).toEqual([])
  }
  expect(controlPlane.readConfig()).not.toContain('stale:')
})

test('installs a community pack after the disclosure, and it lands on Surge Packs → Community', async ({ page }) => {
  await page.goto('/shop')

  await page.getByTestId('shop-pack-shop-fixture').getByRole('button', { name: 'Review' }).click()
  /* The disclosure, before consent: the same panel the Community sub-tab uses (ADR-0006). */
  const disclosure = page.getByRole('dialog', { name: 'Review Shop Fixture' })
  await expect(disclosure).toBeVisible()
  await expect(disclosure).toContainText('from Fixture Shop')
  await expect(disclosure.getByTestId('unresolved-tools')).toHaveCount(0)
  await disclosure.getByRole('button', { name: 'Install Shop Fixture' }).click()

  /* Installed now, and the card says where it went. */
  await expect(page.getByTestId('shop-pack-installed-shop-fixture')).toContainText('Installed')
  await page.getByTestId('shop-pack-installed-shop-fixture').getByRole('link', { name: /Surge Packs/ }).click()
  await expect(page.getByRole('heading', { name: 'Surge Packs', level: 1 })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Community' })).toHaveAttribute('aria-selected', 'true')
  await page.getByTestId('community-filter-installed').click()
  await expect(page.getByTestId('pack-card-shop-fixture')).toBeVisible()

  /* And the sub-tab points back at the Shop tab. */
  await expect(page.getByTestId('community-shop-link').getByRole('link', { name: 'Rocky Surf Shop' })).toHaveAttribute(
    'href',
    '/shop',
  )
})

test('installs the DigitalOcean provider — the real packed artifact — and says a restart is what is left', async ({ page, controlPlane }) => {
  const version = controlPlane.shop!.digitaloceanVersion
  await page.goto('/shop')
  await page.getByTestId('provider-digitalocean').getByRole('button', { name: `Install ${version}` }).click()

  /* The notice names the package and points at Settings; the card now reads as installed. */
  await expect(page.getByTestId('providers-restart-notice')).toContainText('Restart it to load @rockysurf/provider-digitalocean')
  await expect(page.getByTestId('providers-restart-notice')).toContainText('configure digitalocean on the Settings page')
  const installed = page.getByTestId('provider-installed-digitalocean')
  await expect(installed).toContainText(`Installed, version ${version}`)
  await expect(installed).toContainText('restart is needed')
  await expect(installed.getByRole('link', { name: /Settings/ })).toHaveAttribute('href', '/settings?section=providers.digitalocean')
  await expect(page.getByRole('button', { name: 'Reinstall' })).toBeVisible()

  /* On disk: the package where the loader will look for it, and the two config lines. */
  const packageDir = join(controlPlane.dataDir, 'providers', 'node_modules', '@rockysurf', 'provider-digitalocean')
  expect(existsSync(join(packageDir, 'package.json'))).toBe(true)
  expect(existsSync(join(packageDir, 'dist', 'index.js'))).toBe(true)
  expect(controlPlane.readConfig()).toMatch(/digitalocean:\n\s+package: "?@rockysurf\/provider-digitalocean"?\n\s+enabled: true/)
})

test('after the restart, the provider has its own panel on Settings, built from what the package declares', async ({ page, controlPlane }) => {
  /* What the operator does with the notice. The same port, the same config file, the same data
     directory — and now a package the loader finds and imports. */
  await controlPlane.restart()

  await page.goto('/settings?section=providers.digitalocean')
  await expect(page.getByRole('heading', { name: 'DigitalOcean' })).toBeVisible()
  await expect(page.locator('#providers\\.digitalocean\\.enabled')).toBeChecked()
  await expect(page.locator('#providers\\.digitalocean\\.package')).toHaveValue('@rockysurf/provider-digitalocean')
  /* The provider's OWN fields, from its declaration (ADR-0027) — the proof that the package was
     loaded rather than merely named. */
  await expect(page.locator('#providers\\.digitalocean\\.token')).toBeVisible()
  await expect(page.locator('[data-field="providers.digitalocean.sshAllowedCidr"]').getByRole('group')).toBeVisible()
  /* And the sentence, on this panel — scoped to the visible panel because every provider panel
     carries it and the others are mounted hidden. */
  await expect(page.locator('.settings-panel:visible').getByText(/runs with Rocky Surf's full access/).first()).toBeVisible()
})
