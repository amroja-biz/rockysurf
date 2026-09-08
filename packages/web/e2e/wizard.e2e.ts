import { test, expect } from './fixtures'

/**
 * THE SETUP WIZARD, WALKED IN A REAL BROWSER (issue #474).
 *
 * The wizard is the first screen anybody meets, and the defect this file exists to prevent is
 * exactly the one the owner found in the published 0.1.0: a wizard that DESCRIBES setup instead
 * of performing it. Every other layer was green on that build — the page rendered, its tests
 * passed, and it could not set a cloud up.
 *
 * So this drives the whole thing: welcome, back and forward through every step, pick a cloud, read
 * the fields it drew from that Provider's own declaration, type into one, press the one button,
 * and then check the CONFIGURATION FILE THIS INSTALLATION BOOTED ON to prove the save was real.
 *
 * THE CLOUD IS THE PERSONAL-PROVIDER FIXTURE (`e2e/fixtures/personal-provider`, "Nimbus Cloud"),
 * which is switched off in the fixture config and declares the three shapes the wizard has to be
 * able to draw: a credential that takes a variable NAME, a plain string, and the two-act SSH
 * whitelist. No cloud is reached, no credential exists and nothing is billed.
 */
test.describe.configure({ mode: 'serial' })

/* ITS OWN INSTALLATION (see `installation` in `fixtures.ts`). This file SWITCHES A PROVIDER ON in
   the config file, which is the one thing every other file's assumptions are built on. */
test.use({ installation: 'wizard' })

const panel = (page: import('@playwright/test').Page) => page.locator('[data-cloud-panel="nimbus"]')

test('every step is reachable forwards and backwards, and the clouds are listed by name', async ({ page }) => {
  await page.goto('/setup')

  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible()
  await page.getByRole('button', { name: 'Get started' }).click()

  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible()
  // Back, on the step that used to be a one-way door.
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible()

  await page.getByRole('button', { name: 'Get started' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByRole('heading', { name: 'Choose your clouds' })).toBeVisible()

  // Every cloud this installation knows about, each with its own state under its name.
  await expect(page.getByTestId('cloud-list')).toContainText('Nimbus Cloud')
  await expect(page.locator('[data-cloud-state="nimbus"]')).toHaveText('Not set up yet')
})

test('picking a cloud draws its own settings fields, in place', async ({ page }) => {
  await page.goto('/setup')
  await page.getByRole('button', { name: 'Get started' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await page.locator('[data-cloud="nimbus"]').click()

  await expect(panel(page)).toBeVisible()
  // The steps that cannot happen in a browser, and nothing about a file or a repository path.
  await expect(page.getByTestId('cloud-instructions')).toBeVisible()
  await expect(panel(page)).not.toContainText('rockysurf.config.yaml')
  await expect(panel(page)).not.toContainText('docs/')

  // The labels the PROVIDER wrote, drawn by the Settings page's own controls.
  await expect(panel(page).getByLabel('Region')).toBeVisible()
  await expect(panel(page).getByLabel('API token variable')).toBeVisible()
  await expect(panel(page).getByRole('group', { name: 'SSH allowed from' })).toBeVisible()
  // Saving is what turns the cloud on, so there is no second control saying the same thing.
  await expect(panel(page).locator('[data-field="providers.nimbus.enabled"]')).toHaveCount(0)
})

test('saving writes the fields AND switches the cloud on, then says what the cloud answered', async ({
  page,
  controlPlane,
}) => {
  await page.goto('/setup')
  await page.getByRole('button', { name: 'Get started' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await page.locator('[data-cloud="nimbus"]').click()

  await panel(page).locator('#providers\\.nimbus\\.region').fill('sky-2')
  await panel(page).getByRole('button', { name: 'Save and turn on Nimbus Cloud' }).click()

  // THE FILE THIS INSTALLATION BOOTED ON, not a page that says it saved.
  await expect.poll(() => controlPlane.readConfig()).toContain('region: sky-2')
  await expect.poll(() => controlPlane.readConfig()).toMatch(/nimbus:[\s\S]*?enabled: true/)

  // And the answer is on this screen, without pressing anything else.
  await expect(page.getByTestId('check-result-nimbus')).toBeVisible()
})

test('the Done step reports the cloud that is on, and offers a Check and a way back', async ({ page }) => {
  await page.goto('/setup')
  await page.getByRole('button', { name: 'Get started' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()

  const row = page.locator('[data-summary-cloud="nimbus"]')
  await expect(row).toContainText('Nimbus Cloud')
  await page.getByTestId('check-done-nimbus').click()
  await expect(page.getByTestId('check-result-done-nimbus')).toBeVisible()

  // The step that used to say "the way the previous step described" now goes there.
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('heading', { name: 'Choose your clouds' })).toBeVisible()
})
