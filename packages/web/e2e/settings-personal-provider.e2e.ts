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

  /* The provider's OWN fields, drawn from its declaration (ADR-0027): a secret box wearing the
     declared label that takes a variable NAME and never shows the value, a plain string, and the
     two-act SSH whitelist control — for a provider no block in the SPA has ever heard of. */
  const token = page.locator('#providers\\.nimbus\\.token')
  await expect(token).toBeVisible()
  await expect(page.locator('label[for="providers.nimbus.token"]')).toHaveText('API token variable')
  await expect(token).toHaveValue('NIMBUS_TOKEN')
  await expect(page.getByText('nimbus-fixture-token')).toHaveCount(0)
  await expect(page.locator('#providers\\.nimbus\\.region')).toHaveValue('sky-1')
  const cidr = page.locator('[data-field="providers.nimbus.sshAllowedCidr"]')
  await expect(cidr.getByRole('group')).toBeVisible()
  await expect(cidr.getByText('None set.', { exact: false })).toBeVisible()
  await expect(cidr.getByRole('button', { name: 'Add' })).toBeVisible()
  /* The checkbox is the list's, never a bare leftover of its own. */
  await expect(page.locator('#providers\\.nimbus\\.allowAllCidr')).toHaveCount(0)
  /* And what the provider wrote for the operator, at the head of its panel. */
  await expect(page.locator('[data-advisory="providers.nimbus"]')).toHaveText('Nimbus is a fixture: its machines exist only in memory.')
})

/**
 * WHERE A PROVIDER COMES FROM, SAID WHERE ONE IS CONFIGURED (issue #394).
 *
 * The app used to list and install providers on the Surge Packs page. It does not any more —
 * installing one is a command-line step — so what is left is a pointer, and it belongs on the
 * provider tabs of this page because this is where a provider is configured once it loads. In a
 * browser because the claim is that a person on a provider tab can see and follow it.
 */
test('every provider tab points at the shop for a provider Rocky Surf did not ship', async ({ page }) => {
  await page.goto('/settings?section=providers.nimbus')

  const pointer = page.locator('[data-provider-shop-pointer]:visible')
  await expect(pointer).toHaveCount(1)
  await expect(pointer).toContainText('installed from the command line')
  await expect(pointer.getByRole('link', { name: /providers section of the Rocky Surf Shop/ })).toHaveAttribute(
    'href',
    'https://github.com/amroja-biz/rockysurf-shop#providers',
  )

  /* And on a provider that DID ship, because the instruction is the same wherever it is read. */
  await page.goto('/settings?section=providers.byo')
  await expect(page.locator('[data-provider-shop-pointer]:visible')).toHaveCount(1)

  /* Never on one of core's own sections: they have nothing to do with providers. */
  await page.goto('/settings?section=server')
  await expect(page.locator('[data-provider-shop-pointer]:visible')).toHaveCount(0)
})

test('switching it on from the panel puts it in the registry without a restart', async ({ page, controlPlane }) => {
  await page.goto('/settings?section=providers.nimbus')
  await page.locator('#providers\\.nimbus\\.enabled').check()
  await page.getByRole('button', { name: 'Save to the file' }).click()

  await expect.poll(() => controlPlane.readConfig()).toMatch(/nimbus:[\s\S]*enabled: true/)

  /* The factory was loaded at boot, so the config change alone composes a live provider. */
  const providers = await page.request.get('/api/v1/providers')
  expect(providers.ok()).toBe(true)
  const body = (await providers.json()) as { id: string; displayName: string; advisories?: string[] }[]
  expect(body.map((p) => [p.id, p.displayName])).toContainEqual(['nimbus', 'Nimbus Cloud'])
  expect(body.find((p) => p.id === 'nimbus')?.advisories).toEqual(['A stopped Nimbus machine keeps its address, and nothing here is billed.'])
})

test('the New Server page shows what the provider wrote for the person creating there', async ({ page }) => {
  await page.goto('/servers/new')
  /* Two providers now, so the page offers a choice; pick the personal one. */
  await page.getByTestId('provider-choice').getByLabel('Nimbus Cloud').check()
  await expect(page.getByTestId('provider-advisory')).toHaveText('A stopped Nimbus machine keeps its address, and nothing here is billed.')
})
