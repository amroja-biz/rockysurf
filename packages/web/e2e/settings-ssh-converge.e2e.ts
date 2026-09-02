import { test, expect } from './fixtures'

/**
 * SETTINGS → SSH ACCESS AT THE CLOUD, THE KEEP-OR-REMOVE PROMPT (issue #309).
 *
 * The one browser-level proof that the converge flow actually works when a person clicks it —
 * component tests were green twice while this page was unusable, so the new controls are driven
 * here, in a real browser, against the real click handlers, confirm dialog and follow-up request.
 *
 * A cloud that reports a stamped-but-unlisted network (`removable`) is a state only a real cloud
 * produces — the e2e control plane runs BYO only and never talks to one — so the sync route's
 * RESPONSE is stubbed to that shape. Everything downstream of the response is the real product:
 * the report renders, the Keep/Remove buttons are the page's own, the confirmation is the page's
 * one modal, and REMOVE issues a genuine second POST carrying the operator's confirmation. What is
 * asserted is what a person can see and do, and the exact request their click produces.
 */
test.describe.configure({ mode: 'serial' })

const EXTRA = '192.0.2.0/24'

/** The first push returns one stamped extra to adopt; the confirmed removal returns it gone. */
async function stubSync(page: import('@playwright/test').Page, onBody: (body: unknown) => void) {
  await page.route('**/api/v1/network/ssh-access/sync', async (route) => {
    const raw = route.request().postData()
    const body = raw ? JSON.parse(raw) : undefined
    onBody(body)
    const revoked = Boolean((body as { revoke?: unknown } | undefined)?.revoke)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        synced: [
          {
            provider: 'aws',
            status: revoked ? 'updated' : 'unchanged',
            applied: ['203.0.113.7/32'],
            reported: revoked ? [] : [EXTRA],
            removable: revoked ? [] : [EXTRA],
            detail: revoked
              ? `rockysurf-ssh now allows 203.0.113.7/32. Removed ${EXTRA} at your request.`
              : `rockysurf-ssh already allowed 203.0.113.7/32. ${EXTRA} is no longer in your list.`,
          },
        ],
      }),
    })
  })
}

test('a stamped extra is offered keep-or-remove after a push', async ({ page }) => {
  const bodies: unknown[] = []
  await stubSync(page, (b) => bodies.push(b))

  await page.goto('/settings?section=ssh')
  await page.getByRole('button', { name: 'Push SSH access to the clouds' }).click()

  const report = page.locator('.settings-sync-report')
  await expect(report.getByRole('heading', { name: 'SSH access at the cloud' })).toBeVisible()

  const block = page.locator('[data-sync-removable="aws"]')
  await expect(block).toBeVisible()
  await expect(block.locator(`[data-removable-cidr="${EXTRA}"]`)).toContainText(EXTRA)
  await expect(block.getByRole('button', { name: 'Keep in list' })).toBeEnabled()
  await expect(block.getByRole('button', { name: 'Remove from aws' })).toBeEnabled()

  // The first push carried no confirmation — a plain, additive sync.
  expect(bodies).toEqual([undefined])
})

test('Remove asks for confirmation, then posts the operator’s revoke set', async ({ page }) => {
  const bodies: unknown[] = []
  await stubSync(page, (b) => bodies.push(b))

  await page.goto('/settings?section=ssh')
  await page.getByRole('button', { name: 'Push SSH access to the clouds' }).click()

  const block = page.locator('[data-sync-removable="aws"]')
  await expect(block).toBeVisible()
  await block.getByRole('button', { name: 'Remove from aws' }).click()

  // The page's one confirmation modal — never a silent side effect.
  const dialog = page.getByRole('dialog', { name: `Remove ${EXTRA} from aws?` })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('revokes the rule')

  await dialog.getByRole('button', { name: 'Remove from the cloud' }).click()

  // A genuine second POST goes out, carrying exactly the confirmed removal for this cloud.
  await expect.poll(() => bodies.length).toBeGreaterThanOrEqual(2)
  expect(bodies[bodies.length - 1]).toEqual({ revoke: { aws: [EXTRA] } })

  // And the extra is gone from the re-rendered report.
  await expect(page.locator('[data-sync-removable="aws"]')).toHaveCount(0)
})

test('Keep adds the network to the list rather than revoking it', async ({ page }) => {
  const syncBodies: unknown[] = []
  await stubSync(page, (b) => syncBodies.push(b))

  // Capture the settings save that Keep issues, without letting it touch the real file — Keep's
  // job is to ADD to sshAllowedCidr, and the request body is where that is observable.
  const saves: unknown[] = []
  await page.route('**/api/v1/settings', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    saves.push(JSON.parse(route.request().postData() ?? '{}'))
    // Fulfil enough that the page does not throw; the assertion is on the request, not the reload.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ applied: [], restartRequired: [] }),
    })
  })

  await page.goto('/settings?section=ssh')
  await page.getByRole('button', { name: 'Push SSH access to the clouds' }).click()

  const block = page.locator('[data-sync-removable="aws"]')
  await expect(block).toBeVisible()
  await block.getByRole('button', { name: 'Keep in list' }).click()

  await expect.poll(() => saves.length).toBeGreaterThanOrEqual(1)
  const changes = (saves[0] as { changes?: { path: string[]; value: unknown }[] }).changes ?? []
  const added = changes.find((c) => c.path.join('.') === 'providers.aws.sshAllowedCidr')
  expect(added?.value).toContain(EXTRA)
  // Keep never revokes: no sync body ever carried a revoke set.
  expect(syncBodies.some((b) => Boolean((b as { revoke?: unknown } | undefined)?.revoke))).toBe(false)
})
