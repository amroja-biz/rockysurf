import { test, expect } from './fixtures'

/**
 * SETTINGS → CREDENTIALS AT THE CLOUD (issue #450), IN A REAL BROWSER.
 *
 * Every Provider implements `validateCredentials()` — the cheapest authenticated call its cloud
 * offers, which also proves the configured region — and until this issue nothing in the product
 * called it: a wrong key, a wrong region or a missing permission first surfaced on the New Server
 * page, after the operator had left Settings. A save now names the Providers it switched on or
 * changed, the page makes one follow-up call, and the answer lands next to the section.
 *
 * WHY THIS FILE EXISTS AT ALL. The wiring is a save handler, a fetch and a block that renders on
 * a page with ten panels and one Save button — precisely the shape that has twice been green at
 * the component level while the page itself was unusable. So the loop is driven here: click Save,
 * read what the cloud said, fix the setting, click Save again, watch it go green.
 *
 * THE CLOUD IS THE FIXTURE PROVIDER (`e2e/fixtures/list-provider`, "Metal Cloud"), whose
 * credential is the private key it would log into its machines with. It refuses while no key path
 * is configured and passes once one is, so both answers a real cloud gives are driven with no
 * credential, no network call and no bill.
 */
test.describe.configure({ mode: 'serial' })

/* ITS OWN INSTALLATION (see `installation` in `fixtures.ts`). This file CHANGES the fixture
   provider's configuration — the whole point is that a saved setting changes the cloud's answer —
   and a file that shares an installation would inherit whichever half of that history ran first. */
test.use({ installation: 'verify-credentials' })

const KEY_PATH = '~/.ssh/id_ed25519'

const report = (page: import('@playwright/test').Page) => page.locator('.settings-sync-report')
const row = (page: import('@playwright/test').Page) => page.locator('[data-credential-provider="metalcloud"]')

test('a save on an enabled Provider shows the cloud’s refusal, verbatim, without leaving the page', async ({
  page,
  controlPlane,
}) => {
  await page.goto('/settings?section=providers.metalcloud')

  // No key path anywhere yet, so the fixture cloud has nothing to log in with. Any field in the
  // section is enough to ask the question — a region or a login is as much a part of "do these
  // credentials work" as the key is.
  await page.locator('#providers\\.metalcloud\\.machines\\.0\\.user').fill('root')
  await page.getByRole('button', { name: 'Save to the file' }).click()

  await expect(report(page).getByRole('heading', { name: 'Credentials at the cloud' })).toBeVisible()
  await expect(row(page)).toHaveAttribute('data-credential-status', 'failed')
  // The Provider's own sentence, unparaphrased, under the headline the New Server page prints for
  // the same taxonomy code — and the cloud's own code beside it.
  await expect(row(page)).toContainText('Cloud credential rejected')
  await expect(row(page)).toContainText('NoIdentityFile')
  await expect(row(page)).toContainText('no private key is configured for workshop')

  // The save was never blocked on the check: the file has the new value regardless.
  await expect.poll(() => controlPlane.readConfig()).toContain('user: root')
})

test('fixing the setting and saving again turns the same line green', async ({ page }) => {
  await page.goto('/settings?section=providers.metalcloud')

  await page.locator('#providers\\.metalcloud\\.identityFile').fill(KEY_PATH)
  await page.getByRole('button', { name: 'Save to the file' }).click()

  await expect(row(page)).toHaveAttribute('data-credential-status', 'verified')
  await expect(row(page)).toContainText('Credentials and region verified')
})

test('a save that touches no Provider asks no cloud anything', async ({ page }) => {
  await page.goto('/settings?section=limits')

  await page.locator('#limits\\.maxServers').fill('7')
  await page.getByRole('button', { name: 'Save to the file' }).click()

  // The block belongs to the clouds. A limit is not one, so nothing appears and no authenticated
  // call is spent.
  await expect(page.getByRole('heading', { name: 'Credentials at the cloud' })).toHaveCount(0)
})
