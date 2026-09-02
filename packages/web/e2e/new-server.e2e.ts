import { test, expect } from './fixtures'

/**
 * THE NEW SERVER PAGE (issue #310, flow 3) — the other end of the SSH-keys feature.
 *
 * A key saved in Settings is worth nothing until this page offers it, and the two halves are
 * wired through the config file and `/api/v1/ssh-keys` rather than through shared component
 * state. That seam is exactly the kind `CONTRIBUTING.md` says to test by booting the real
 * thing, and it is the kind a component test cannot see: both halves can be individually
 * correct while nothing carries the key from one to the other.
 *
 * NOTHING HERE CREATES A SERVER. The form is filled and inspected, never submitted — the BYO
 * host in the test configuration is a loopback port with no listener, deliberately.
 */
test.describe.configure({ mode: 'serial' })

const PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMW/yWwAIqnQ7MVCH1GsJrrJz/fsWF/5ikueikTduir rockysurf-ui-test@example.invalid'

/** Save a key through the real settings UI — this page's input has to come from somewhere. */
test('a key saved in Settings is offered by the New Server page', async ({ page, controlPlane }) => {
  await page.goto('/settings?section=ssh')
  const panel = page.locator('.settings-panel:not([hidden])')
  /* The standard add flow (rsui-9sc): Add key reveals a blank form, and the form's own button
     is the save — nothing goes near the footer. */
  await panel.getByRole('button', { name: 'Add key' }).click()
  await page.locator('#ssh\\.keys\\.new\\.name').fill('laptop')
  await page.locator('#ssh\\.keys\\.new\\.publicKey').fill(PUBLIC_KEY)
  await panel.getByRole('button', { name: 'Add this key' }).click()
  /* Waited on the file rather than the toast — the file is what the New Server page reads. */
  await expect.poll(() => controlPlane.readConfig()).toContain('name: laptop')

  await page.goto('/servers/new')
  /* The picker only exists once "Use my own public key" is chosen — a generated key needs no
     picker, and offering one beside "generate" would be two answers to one question. */
  await page.getByRole('radio', { name: /Use my own public key/ }).check()

  const picker = page.getByRole('combobox').filter({ has: page.getByRole('option', { name: 'laptop' }) })
  await expect(picker).toBeVisible()
  /* One saved key is not a choice, so the page makes it for you — and this asserts it made the
     right one rather than merely rendering a menu. */
  await expect(picker).toHaveValue('laptop')
})

test('a key can still be pasted here without saving it in Settings', async ({ page }) => {
  await page.goto('/servers/new')
  await page.getByRole('radio', { name: /Use my own public key/ }).check()

  /* The escape hatch the saved list must never take away: pick "paste a different key" and the
     box comes back. `docs/self-hosting.md` promises this in as many words. */
  const picker = page.getByRole('combobox').filter({ has: page.getByRole('option', { name: /Paste a different/ }) })
  await picker.selectOption('')

  const box = page.getByPlaceholder(/ssh-ed25519/)
  await expect(box).toBeVisible()
  await box.fill(PUBLIC_KEY)
  await expect(box).toHaveValue(PUBLIC_KEY)
  /* Pasting a public key is not an error state — no refusal appears for the right half. */
  await expect(page.getByText(/that is a PRIVATE key/i)).toHaveCount(0)
})

test('every pack on the chooser carries a mark, and the selected one is named', async ({ page }) => {
  await page.goto('/servers/new')

  /* The regression this catches is a chooser that renders rows with a hole where the icon
     should be — which reads as broken rather than as missing, and which `PackIcon` exists to
     prevent by always drawing either the image or a deterministic monogram. */
  const marks = page.locator('img.pack-icon, .pack-monogram')
  await expect(marks.first()).toBeVisible()
  const packs = page.getByRole('radio', { name: /Claude Code|Amp|Codex CLI/ })
  expect(await marks.count()).toBeGreaterThanOrEqual(await packs.count())

  await expect(page.getByText('Selected: Claude Code')).toBeVisible()
})
