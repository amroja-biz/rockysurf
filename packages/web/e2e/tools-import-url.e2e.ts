import { test, expect } from './fixtures'

/**
 * IMPORTING A TOOL FROM A URL, IN A REAL BROWSER (issue #299).
 *
 * The wiring tests prove the button POSTs `{ url }`; this proves the affordance is actually
 * usable on the page and that the address travels all the way to core's SSRF guard and back —
 * the class of thing the "component tests passed while the page was unusable" rule exists for.
 *
 * The refusal is the deterministic end-to-end signal: a loopback address is screened by the
 * guard before any socket opens, so no network is touched, and the page surfaces the guard's own
 * words. A tool fetched from a private address is exactly what must never install silently.
 */
test('the URL box imports through the guard, and the guard refusal reaches the page', async ({ page }) => {
  await page.goto('/admin/tools')

  const box = page.getByLabel('Tool file URL')
  await expect(box).toBeVisible()

  const button = page.getByRole('button', { name: 'Import from URL' })
  // Disabled while empty — nothing to import, so nothing to submit.
  await expect(button).toBeDisabled()

  await box.fill('http://127.0.0.1:9/tool.yaml')
  await expect(button).toBeEnabled()
  await button.click()

  // Core fetched it through the SSRF guard, which refused the loopback address — and the page
  // shows that reason rather than a vague failure. This is the whole round trip in a browser.
  await expect(page.getByText(/not a public address/i)).toBeVisible()
})
