import { readFileSync } from 'node:fs'
import { test, expect } from './fixtures'

/**
 * SETTINGS → BACKUP, driven in a real browser (issue #331).
 *
 * The whole feature is two cards and a file, so the browser suite drives exactly that: click
 * Download and read the artifact the browser saved; hand the artifact back through the file
 * picker and read the report the page renders. The round trip below is REAL — the restored
 * tool comes back from the same instance's own download, edited the way a second machine
 * would receive it.
 *
 * SERIAL, ONE INSTALLATION — a restore writes the configuration file (with this machine's
 * pinned paths kept, so restoring this instance's own artifact is a no-op write), and the
 * assertions build on one another.
 */
test.describe.configure({ mode: 'serial' })

test('the Backup tab shows both cards, the key warning, and no token notice for a tokenless file', async ({ page }) => {
  await page.goto('/settings?section=backup')

  const panel = page.locator('.settings-panel:not([hidden])')
  await expect(panel.getByRole('heading', { name: 'Back up this installation' })).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'Restore from a backup' })).toBeVisible()
  /* The one thing the operator must do themselves, said before the button is pressed. */
  await expect(panel.getByText('The encryption key is not in the backup, on purpose.')).toBeVisible()
  /* No tokens in this file — so no token warning. A notice about nothing trains people to
     skim past notices about something. */
  await expect(panel.locator('[data-backup-token-notice]')).toHaveCount(0)
})

test('Download hands over a real artifact: right magic, versioned, config included', async ({ page }) => {
  await page.goto('/settings?section=backup')

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download backup' }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/^rockysurf-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/)

  const artifact = JSON.parse(readFileSync((await download.path())!, 'utf8')) as {
    artifact: string
    formatVersion: number
    config: { text: string }
    users: unknown[]
  }
  expect(artifact.artifact).toBe('rockysurf-backup')
  expect(artifact.formatVersion).toBe(1)
  /* The instance's own file travelled — the BYO host it was booted with is in it. */
  expect(artifact.config.text).toContain('workshop')
  expect(artifact.users.length).toBeGreaterThan(0)
})

test('the round trip: a tool added to the artifact comes back through Restore, with a report', async ({ page }) => {
  await page.goto('/settings?section=backup')

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download backup' }).click(),
  ])
  const artifact = JSON.parse(readFileSync((await download.path())!, 'utf8')) as {
    tools: unknown[]
    [key: string]: unknown
  }

  /* What a second machine would receive: the same artifact, here carrying one personal tool
     this installation has never seen. */
  artifact.tools = [
    ...artifact.tools,
    {
      id: 'ui-roundtrip-tool',
      name: 'UI round-trip tool',
      description: 'arrived by restore',
      category: 'base',
      url: 'https://example.invalid',
      installScript: 'echo hello',
      setupScript: null,
      enabled: true,
      installOrder: 10,
      bootstrap: false,
      alwaysInstall: false,
      runAs: 'rocky',
      sourceFile: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
  ]

  const panel = page.locator('.settings-panel:not([hidden])')
  await panel.getByLabel('Backup file').setInputFiles({
    name: 'rockysurf-backup-roundtrip.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(artifact)),
  })
  await panel.getByRole('button', { name: 'Restore rockysurf-backup-roundtrip.json' }).click()

  const report = panel.locator('[data-restore-report]')
  await expect(report).toBeVisible()
  await expect(report).toContainText('Tools: 1 restored')
  /* The admin account in the artifact is this instance's own — matched, never duplicated. */
  await expect(report).toContainText('Accounts: 0 restored, 1 already here')
  await expect(report.locator('[data-restore-config]')).toContainText('Configuration restored')

  /* The tool is really in the installation, not merely in the report. */
  await page.goto('/admin/tools')
  await expect(page.getByText('UI round-trip tool')).toBeVisible()
})

test('a file that is not a backup is refused in place, with the filename in the sentence', async ({ page }) => {
  await page.goto('/settings?section=backup')

  const panel = page.locator('.settings-panel:not([hidden])')
  await panel.getByLabel('Backup file').setInputFiles({
    name: 'holiday-photos.json',
    mimeType: 'application/json',
    buffer: Buffer.from('this was never json'),
  })
  await panel.getByRole('button', { name: 'Restore holiday-photos.json' }).click()

  await expect(panel.locator('[data-restore-error]')).toContainText(
    'holiday-photos.json is not a Rocky Surf backup',
  )
  await expect(panel.locator('[data-restore-report]')).toHaveCount(0)
})
