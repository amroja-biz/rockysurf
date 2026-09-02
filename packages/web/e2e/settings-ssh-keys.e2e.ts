import { test, expect } from './fixtures'

/**
 * SETTINGS → SSH PUBLIC KEYS, THE LIST THAT BROKE TWICE — AND THEN GOT RE-SHAPED (issue #310,
 * flows from #302/#303/#305/#311, re-shaped by rsui-9sc).
 *
 * This section is the reason this whole layer exists. It shipped once rendering no controls at
 * all — two headings, a paragraph of prose describing an editor, and no editor — and shipped
 * again with a dirty-state interlock that disabled the button an operator reaches for at
 * exactly the moment they reach for it. Both times the unit tests, the component tests and the
 * real-HTTP API tests were green, because a list that renders nothing still renders, and a
 * disabled button is still in the DOM.
 *
 * THE THIRD FAILURE WAS THE ADD FLOW ITSELF (rsui-9sc). `Add` wrote a placeholder entry —
 * `my-laptop`, empty key — straight into the config file, so a first visit after one click
 * showed a saved-looking key nobody had saved, a further click minted `my-laptop 2`, and the
 * private-key warning repeated under every card. The owner's ruling: a cyan "Add key" button,
 * a BLANK form with no default name, an entry that exists only once it is typed and saved, and
 * the warning said once per page. Every test here drives that convention.
 *
 * So every assertion here is about what a person can DO and what a fresh page SHOWS: how many
 * cards exist before anything was added, is the control enabled, did the click take, is the
 * value in the file afterwards, is it still there after a reload. Nothing reaches into
 * component state.
 *
 * SERIAL, ONE INSTALLATION. Adding a key writes to `config.yaml`, so these tests share a
 * history — which is why the fresh-install assertions run FIRST, and why later tests name
 * their own entries and assert on those entries or on a before/after difference, never on a
 * total that a neighbour could change.
 */
test.describe.configure({ mode: 'serial' })

/**
 * A REAL ed25519 PUBLIC KEY, WITH A TRAILING COMMENT — which is what `ssh-keygen` writes and
 * therefore what anybody actually pastes. The comment is the part a naive validator drops or
 * chokes on, and `docs/self-hosting.md` tells people to paste the whole `.pub` line.
 *
 * A public key is published material: it is handed to the cloud in the clear on every create
 * and written into `authorized_keys` on the box. There is no secret in this file.
 */
const PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMW/yWwAIqnQ7MVCH1GsJrrJz/fsWF/5ikueikTduir rockysurf-ui-test@example.invalid'

/** A second real key, so the two-keys test asserts on entries it made itself. */
const SECOND_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKPXl2ZK3l5X9V4mC1uJ8N2Qw7YhT5cD9eF0gH1iJ2kL desktop'

/** Only the panel on screen. Every settings panel stays mounted; `hidden` is what moves. */
const openPanel = '.settings-panel:not([hidden])'

/**
 * A SAVED entry's card. The add form wears the same card styling but is not a saved key, and
 * "how many keys does the page claim exist" is exactly the number the owner found lying — so
 * every count in this file excludes the draft explicitly.
 */
const savedCard = '.settings-entry:not([data-list-draft])'

/**
 * THE FRESH-INSTALL STATE, PINNED FIRST (rsui-9sc acceptance criterion 1).
 *
 * The owner's report began "on first visit, the page shows what looks like an EXISTING key" —
 * so the first thing this suite asserts, against a control plane whose config has never
 * mentioned `ssh:`, is that there is NO key card, an empty-state sentence, and an Add key
 * button. This test must stay first in the file: the suite is serial and everything after it
 * writes keys into the same installation.
 */
test('a fresh install shows zero key cards, an empty-state line, and an Add key button', async ({ page }) => {
  await page.goto('/settings?section=ssh')
  const panel = page.locator(openPanel)
  await expect(panel.getByRole('heading', { name: 'Your public keys' })).toBeVisible()

  await expect(panel.locator(savedCard)).toHaveCount(0)
  await expect(panel.getByText('None yet.', { exact: false })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Add key' })).toBeEnabled()
})

/** The warning is section-level news, said once — not a paragraph under every card. */
test('the private-key warning appears exactly once on the page', async ({ page }) => {
  await page.goto('/settings?section=ssh')
  const panel = page.locator(openPanel)
  await expect(panel.getByRole('heading', { name: 'Your public keys' })).toBeVisible()
  await expect(panel.getByText('Never paste a private key', { exact: false })).toHaveCount(1)
})

test('Add key reveals one blank form — no default name, and nothing written yet', async ({
  page,
  controlPlane,
}) => {
  await page.goto('/settings?section=ssh')
  const panel = page.locator(openPanel)
  await panel.getByRole('button', { name: 'Add key' }).click()

  /* One form, empty boxes. A default name is how the phantom `my-laptop` entry got into the
     owner's file, so the name box being EMPTY is the assertion, not a nicety. */
  await expect(panel.locator('[data-list-draft="ssh.keys"]')).toHaveCount(1)
  await expect(page.locator('#ssh\\.keys\\.new\\.name')).toHaveValue('')
  await expect(page.locator('#ssh\\.keys\\.new\\.publicKey')).toHaveValue('')

  /* A form is not a saved entry: no card, no Remove button — disabled or otherwise. */
  await expect(panel.locator(savedCard).filter({ has: page.getByRole('button', { name: 'Remove' }) })).toHaveCount(0)
  expect(controlPlane.readConfig()).not.toContain('ssh:')

  /* And Cancel walks it back without writing anything. */
  await panel.getByRole('button', { name: 'Cancel' }).click()
  await expect(panel.locator('[data-list-draft="ssh.keys"]')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Add key' })).toBeVisible()
})

test('a typed key saves through the form, shows exactly one card, and survives a reload', async ({
  page,
  controlPlane,
}) => {
  await page.goto('/settings?section=ssh')
  const panel = page.locator(openPanel)
  await panel.getByRole('button', { name: 'Add key' }).click()

  await page.locator('#ssh\\.keys\\.new\\.name').fill('laptop')
  await page.locator('#ssh\\.keys\\.new\\.publicKey').fill(PUBLIC_KEY)

  /* The form's own button is the save — checked enabled before the click, because "the click
     did nothing" and "the button was disabled" look identical afterwards. */
  const save = panel.getByRole('button', { name: 'Add this key' })
  await expect(save).toBeEnabled()
  await save.click()

  /* The file, not the page. A settings editor that convinces itself it saved is the exact
     failure this layer is for, and `config.yaml` is the thing the operator actually keeps. */
  await expect.poll(() => controlPlane.readConfig()).toContain('name: laptop')
  expect(controlPlane.readConfig()).toContain('rockysurf-ui-test@example.invalid')

  /* EXACTLY ONE CARD, and the form is gone (rsui-9sc acceptance criterion 3). The owner's
     report was that saving spawned another pre-filled card — `my-laptop 2` — so the page
     permanently looked one key richer than the file. */
  await expect(panel.locator(savedCard)).toHaveCount(1)
  await expect(panel.locator('[data-list-draft="ssh.keys"]')).toHaveCount(0)

  /* And it comes BACK. The value is long enough that the YAML writer folds it across three
     lines, so this is also the check that a folded scalar is read back as the one-line key
     `authorized_keys` needs — a round trip no assertion on the in-memory form would make. */
  await page.reload()
  await expect(page.locator('#ssh\\.keys\\.0\\.name')).toHaveValue('laptop')
  await expect(page.locator('#ssh\\.keys\\.0\\.publicKey')).toHaveValue(PUBLIC_KEY)
  await expect(page.locator(openPanel).locator(savedCard)).toHaveCount(1)
})

test('a private key is refused where it is pasted, and never reaches the file', async ({ page, controlPlane }) => {
  await page.goto('/settings?section=ssh')
  const panel = page.locator(openPanel)
  await panel.getByRole('button', { name: 'Add key' }).click()

  await page.locator('#ssh\\.keys\\.new\\.name').fill('pasted-the-wrong-file')
  await page.locator('#ssh\\.keys\\.new\\.publicKey').fill('-----BEGIN OPENSSH PRIVATE KEY-----')
  await panel.getByRole('button', { name: 'Add this key' }).click()

  /* Inline, beside the box that caused it — the refusal has to be where the person is looking,
     not in a toast that has already faded by the time they read it. */
  await expect(panel.getByText(/that is a PRIVATE key/i)).toBeVisible()

  /* The half that matters more than the message. */
  expect(controlPlane.readConfig()).not.toContain('PRIVATE KEY')
  expect(controlPlane.readConfig()).not.toContain('pasted-the-wrong-file')

  /* The refused draft leaves no card behind — close it so the next test starts clean. */
  await expect(panel.locator(savedCard)).toHaveCount(1)
  await panel.getByRole('button', { name: 'Cancel' }).click()
})

/**
 * THE SECOND KEY (the #311 regression, re-pinned for the form flow).
 *
 * The old Add wrote a constant placeholder name, the schema requires names to be unique, and
 * core refused the second Add with `two saved SSH keys share a name` — forever. A list of your
 * SSH keys that can hold exactly one key did not need to be a list. The form flow has no
 * placeholder to collide on — the person names each key — so this asserts two adds make two
 * cards, and that editing one of them never disables the controls beside it (the OTHER half of
 * #311: Add and the footer Save stay usable while an edit is pending; only Remove waits,
 * because removing renumbers).
 */
test('a second key adds cleanly, and an edit in progress never disables Add', async ({ page, controlPlane }) => {
  await page.goto('/settings?section=ssh')
  const panel = page.locator(openPanel)
  await panel.getByRole('button', { name: 'Add key' }).click()
  await page.locator('#ssh\\.keys\\.new\\.name').fill('desktop')
  await page.locator('#ssh\\.keys\\.new\\.publicKey').fill(SECOND_KEY)
  await panel.getByRole('button', { name: 'Add this key' }).click()

  await expect.poll(() => controlPlane.readConfig()).toContain('name: desktop')
  expect(controlPlane.readConfig()).toContain('name: laptop')
  await expect(panel.locator(savedCard)).toHaveCount(2)

  /* Renaming a saved entry leaves Add usable — the interlock that shipped broken said "save or
     discard your other changes" to the person in the middle of adding. */
  await page.locator('#ssh\\.keys\\.0\\.name').fill('laptop-renamed')
  await expect(panel.getByRole('button', { name: 'Add key' })).toBeEnabled()
  const footerSave = page.getByRole('button', { name: 'Save to the file' })
  await expect(footerSave).toBeEnabled()

  /* Put the name back rather than saving it — later tests assert on `laptop`. */
  await page.locator('#ssh\\.keys\\.0\\.name').fill('laptop')
})

/** The duplicate-name refusal happens at the form, in words, before anything is sent. */
test('a duplicate name is refused at the form', async ({ page, controlPlane }) => {
  await page.goto('/settings?section=ssh')
  const panel = page.locator(openPanel)
  await panel.getByRole('button', { name: 'Add key' }).click()
  await page.locator('#ssh\\.keys\\.new\\.name').fill('laptop')
  await page.locator('#ssh\\.keys\\.new\\.publicKey').fill(PUBLIC_KEY)
  await panel.getByRole('button', { name: 'Add this key' }).click()

  await expect(panel.getByText(/already a key called/)).toBeVisible()
  await expect(panel.locator(savedCard)).toHaveCount(2)
  expect(controlPlane.readConfig().split('name: laptop').length - 1).toBe(1)
  await panel.getByRole('button', { name: 'Cancel' }).click()
})

test('a saved key can be removed, and the file loses it', async ({ page, controlPlane }) => {
  await page.goto('/settings?section=ssh')
  const panel = page.locator(openPanel)

  const entry = panel.locator(savedCard).filter({ has: page.getByRole('heading', { name: 'desktop' }) })
  await entry.getByRole('button', { name: 'Remove' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click()

  await expect.poll(() => controlPlane.readConfig()).not.toContain('name: desktop')
  /* The neighbour is untouched: a remove that took the wrong entry would also pass a test that
     only checked the removed one is gone. */
  expect(controlPlane.readConfig()).toContain('name: laptop')
  await expect(panel.locator(savedCard)).toHaveCount(1)
})
