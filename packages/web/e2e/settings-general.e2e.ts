import { test, expect } from './fixtures'

/**
 * SETTINGS, THE ORDINARY SCALAR FIELDS (issue #310, flow 2).
 *
 * The SSH list is where the two regressions landed; this is the rest of the page, and it is
 * here because the same machinery draws it. A settings editor has exactly two jobs — put what
 * you typed into the file, and tell you when what you typed will not take effect until a
 * restart — and neither is observable from a component test that never writes a file.
 */
test.describe.configure({ mode: 'serial' })

test('a scalar setting is written to the file and read back after a reload', async ({ page, controlPlane }) => {
  await page.goto('/settings?section=limits')

  const maxServers = page.locator('#limits\\.maxServers')
  await expect(maxServers).toBeVisible()
  /* Not the default (5), so a file that never changed cannot pass this by coincidence. */
  await maxServers.fill('3')

  const save = page.getByRole('button', { name: 'Save to the file' })
  await expect(save).toBeEnabled()
  await save.click()

  await expect.poll(() => controlPlane.readConfig()).toContain('maxServers: 3')

  await page.reload()
  await expect(page.locator('#limits\\.maxServers')).toHaveValue('3')
})

test('a setting that needs a restart says so, and one that does not stays quiet', async ({ page }) => {
  /* The half that is easy to get right, and the half that is easy to get wrong: this note used
     to be printed unconditionally, which told everybody that nothing they were about to do
     would work yet (issue #264). Asserting only its presence would let that regression back in,
     so the absence is asserted on a field in the same page that applies immediately. */
  await page.goto('/settings?section=server')
  await expect(page.locator('[data-restart-required="server.port"]')).toContainText('Takes effect after a restart')

  await page.goto('/settings?section=limits')
  await expect(page.locator('#limits\\.maxServers')).toBeVisible()
  await expect(page.locator('[data-restart-required="limits.maxServers"]')).toHaveCount(0)
})

test('discarding changes leaves the file alone', async ({ page, controlPlane }) => {
  await page.goto('/settings?section=limits')
  const before = controlPlane.readConfig()

  await page.locator('#limits\\.createRatePerHour').fill('99')
  await page.getByRole('button', { name: 'Discard changes' }).click()

  await expect(page.getByRole('button', { name: 'Save to the file' })).toBeDisabled()
  expect(controlPlane.readConfig()).toBe(before)
})
