import { test, expect } from './fixtures'

/**
 * A PERSONAL PROVIDER'S PANEL, IN A REAL BROWSER (ADR-0026).
 *
 * The control plane this suite boots names `e2e/fixtures/personal-provider` by path in its config,
 * disabled. That gives the Settings page a section core has never hand-written a block for, whose
 * only rows come from `settings/inventory.ts`. The two claims worth a browser: the panel exists
 * and has controls (the exact regression this suite was created for), and switching the provider
 * on from that panel puts it in the registry without a restart, because the package was loaded at
 * boot whether or not it was enabled.
 *
 * Serial, and LAST to enable: once Nimbus is on, this worker's installation has two providers.
 */
test.describe.configure({ mode: 'serial' })

test('a personal provider has a panel with controls, titled by the name its package gives it', async ({ page }) => {
  await page.goto('/settings?section=providers.nimbus')

  await expect(page.getByRole('heading', { name: 'Nimbus Cloud' })).toBeVisible()
  /* The sentence is said twice on purpose — at the section's head and under the package box —
     so this asserts it is on the page, not that it appears exactly once. */
  await expect(page.getByText("runs with Rocky Surf's full access — install ones you trust").first()).toBeVisible()

  const enabled = page.locator('#providers\\.nimbus\\.enabled')
  await expect(enabled).toBeVisible()
  await expect(enabled).not.toBeChecked()

  const pkg = page.locator('#providers\\.nimbus\\.package')
  await expect(pkg).toBeVisible()
  await expect(pkg).toHaveValue(/fixtures\/personal-provider$/)
  await expect(page.locator('[data-restart-required="providers.nimbus.package"]')).toContainText('restart')

  /* The provider's own fields are not drawn — the page has no inventory for them yet — and the
     masked token never reaches the DOM in any form. */
  await expect(page.locator('#providers\\.nimbus\\.token')).toHaveCount(0)
  await expect(page.getByText('nimbus-fixture-token')).toHaveCount(0)
})

test('switching it on from the panel puts it in the registry without a restart', async ({ page, controlPlane }) => {
  await page.goto('/settings?section=providers.nimbus')
  await page.locator('#providers\\.nimbus\\.enabled').check()
  await page.getByRole('button', { name: 'Save to the file' }).click()

  await expect.poll(() => controlPlane.readConfig()).toMatch(/nimbus:[\s\S]*enabled: true/)

  /* The factory was loaded at boot, so the config change alone composes a live provider. */
  const providers = await page.request.get('/api/v1/providers')
  expect(providers.ok()).toBe(true)
  const ids = ((await providers.json()) as { id: string; displayName: string }[]).map((p) => [p.id, p.displayName])
  expect(ids).toContainEqual(['nimbus', 'Nimbus Cloud'])
})
