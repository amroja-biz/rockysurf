import { test, expect } from './fixtures'

/**
 * CONNECT GITHUB, AFTER THE CLIENT ID IS SAVED (issue #510).
 *
 * The bug this pins shipped with every unit test green: the save wrote the file and the config
 * store adopted it, but the GitHub routes were handed the booted config and the page never asked
 * again, so the button stayed disabled until a restart. Neither half is visible without the real
 * binary and the real page, which is why this is here and not only in a component test.
 *
 * Its own installation, because the first assertion is about one with no client ID — a file
 * sharing a worker with anything that saves one would pass or fail on the scheduler.
 */
test.use({ installation: 'github-connect' })

test('saving a client ID enables Connect GitHub without a restart or a reload', async ({ page, controlPlane }) => {
  await page.goto('/settings?section=github')

  const connect = page.getByRole('button', { name: 'Connect GitHub' })
  await expect(connect).toBeDisabled()

  await page.locator('#github\\.oauth\\.clientId').fill('Iv1.e2econnect000000')
  await page.getByRole('button', { name: 'Save to the file' }).click()

  await expect.poll(() => controlPlane.readConfig()).toContain('Iv1.e2econnect000000')
  /* No reload: the page has to notice by itself, which is half of what #510 was. */
  await expect(connect).toBeEnabled()
  await expect(page.locator('[data-github-setup]')).toHaveCount(0)
})
