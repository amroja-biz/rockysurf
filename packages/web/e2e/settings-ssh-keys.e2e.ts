import { test, expect } from './fixtures'

/**
 * SETTINGS → SSH PUBLIC KEYS, THE LIST THAT BROKE TWICE (issue #310, flows from #302/#303/#305).
 *
 * This section is the reason this whole layer exists. It shipped once rendering no controls at
 * all — two headings, a paragraph of prose describing an editor, and no editor — and shipped
 * again with a dirty-state interlock that disabled the button an operator reaches for at
 * exactly the moment they reach for it. Both times the unit tests, the component tests and the
 * real-HTTP API tests were green, because a list that renders nothing still renders, and a
 * disabled button is still in the DOM.
 *
 * So every assertion here is about what a person can DO: is the control enabled, did the click
 * take, is the value in the file afterwards, is it still there after a reload. Nothing reaches
 * into component state.
 *
 * SERIAL, ONE INSTALLATION. `Add` writes to `config.yaml` immediately — it is its own save, not
 * a pending edit — so these tests share a history rather than a blank file. Each one therefore
 * names its own entry and asserts on that entry, or on a before/after difference, never on a
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

/** Only the panel on screen. Every settings panel stays mounted; `hidden` is what moves. */
const openPanel = '.settings-panel:not([hidden])'

test('a pasted public key saves, reaches the file, and survives a reload', async ({ page, controlPlane }) => {
  await page.goto('/settings?section=ssh')
  const panel = page.locator(openPanel)
  await expect(panel.getByRole('heading', { name: 'Your public keys' })).toBeVisible()

  await panel.getByRole('button', { name: 'Add', exact: true }).click()
  const name = page.locator('#ssh\\.keys\\.0\\.name')
  const key = page.locator('#ssh\\.keys\\.0\\.publicKey')
  await expect(name).toBeVisible()

  await name.fill('laptop')
  await key.fill(PUBLIC_KEY)

  /* THE ASSERTION THE OWNER ASKED FOR IN SO MANY WORDS: a valid single edit leaves the save
     button usable. It is checked before the click, because "the click did nothing" and "the
     button was disabled" look identical afterwards. */
  const save = page.getByRole('button', { name: 'Save to the file' })
  await expect(save).toBeEnabled()
  await save.click()

  /* The file, not the page. A settings editor that convinces itself it saved is the exact
     failure this layer is for, and `config.yaml` is the thing the operator actually keeps. */
  await expect.poll(() => controlPlane.readConfig()).toContain('name: laptop')
  expect(controlPlane.readConfig()).toContain('rockysurf-ui-test@example.invalid')

  /* And it comes BACK. The value is long enough that the YAML writer folds it across three
     lines, so this is also the check that a folded scalar is read back as the one-line key
     `authorized_keys` needs — a round trip no assertion on the in-memory form would make. */
  await page.reload()
  await expect(page.locator('#ssh\\.keys\\.0\\.name')).toHaveValue('laptop')
  await expect(page.locator('#ssh\\.keys\\.0\\.publicKey')).toHaveValue(PUBLIC_KEY)
})

test('a private key is refused where it is pasted, and never reaches the file', async ({ page, controlPlane }) => {
  await page.goto('/settings?section=ssh')
  const panel = page.locator(openPanel)
  await panel.getByRole('button', { name: 'Add', exact: true }).click()
  const key = page.locator('#ssh\\.keys\\.1\\.publicKey')
  await expect(key).toBeVisible()

  await page.locator('#ssh\\.keys\\.1\\.name').fill('pasted-the-wrong-file')
  await key.fill('-----BEGIN OPENSSH PRIVATE KEY-----')
  await page.getByRole('button', { name: 'Save to the file' }).click()

  /* Inline, beside the box that caused it — the refusal has to be where the person is looking,
     not in a toast that has already faded by the time they read it. */
  await expect(panel.getByText(/that is a PRIVATE key/i)).toBeVisible()

  /* The half that matters more than the message. */
  expect(controlPlane.readConfig()).not.toContain('PRIVATE KEY')
})

test('a saved key can be removed, and the file loses it', async ({ page, controlPlane }) => {
  await page.goto('/settings?section=ssh')
  const panel = page.locator(openPanel)

  /* The entry the refused save left behind — `Add` had already written its blank to the file,
     and the paste that followed was rejected whole, so it is still called `my-laptop`. Nothing
     is pending now, which is the state Remove is meant to work in. */
  const entry = panel.locator('.settings-entry').filter({ has: page.getByRole('heading', { name: 'my-laptop' }) })
  await entry.getByRole('button', { name: 'Remove' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click()

  await expect.poll(() => controlPlane.readConfig()).not.toContain('name: my-laptop')
  /* The neighbour is untouched: a remove that took the wrong entry would also pass a test that
     only checked the removed one is gone. */
  expect(controlPlane.readConfig()).toContain('name: laptop')
  await expect(panel.locator('.settings-entry')).toHaveCount(1)
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * THE REPRODUCTION. This is the acceptance criterion of issue #310.
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `test.fail()` means "this is expected to fail" — Playwright RUNS it and the run is green only
 * when the test fails. That is deliberate and it is the whole point: a `fixme` would be skipped,
 * would assert nothing, and would prove nothing about the bug being present. This executes
 * against the broken behaviour on every CI run and stays green while the bug is there.
 *
 * WHEN THE FIX (#311, for #302/#303/#305) MERGES, THIS TEST STARTS PASSING — and Playwright
 * reports "expected to fail but passed", which turns the `UI (browser)` job RED. That is the
 * intended signal, not an accident: it is what forces somebody to come here and delete the
 * `test.fail()` line, converting the reproduction into an ordinary regression test. Deleting
 * that one line is the entire follow-up.
 *
 * WHAT IS BROKEN, on the commit this was written against:
 *
 *   `listSection` computes ONE `blocked` flag from "does this list have any pending edit" and
 *   uses it to disable Add and Remove together, and the blank entry it appends carries a
 *   constant name. So the moment you type a name into the key you just added, the buttons
 *   beside it go dead with "Save or discard your other changes to this list first" — and a
 *   second Add is refused outright by the schema, because the two blanks share a name.
 *
 * Both halves are asserted, in the order an operator meets them.
 */
test('adding a second key is not blocked by an edit to the first', async ({ page, controlPlane }) => {
  test.fail()

  await page.goto('/settings?section=ssh')
  const panel = page.locator(openPanel)
  const add = panel.getByRole('button', { name: 'Add', exact: true })
  const entries = panel.locator('.settings-entry')
  const before = await entries.count()

  /* One: a valid, single, in-progress edit must not disable the controls next to it. Renaming
     the entry you have just added is the most ordinary thing there is to do in this list. */
  await add.click()
  await expect(entries).toHaveCount(before + 1)
  await page.locator(`#ssh\\.keys\\.${before}\\.name`).fill('desktop')
  await expect(add).toBeEnabled()

  /* Two: and a second key can actually be added. Two machines is the reason the list is a list;
     an installation that can hold exactly one saved key did not need one. */
  await add.click()
  await expect(entries).toHaveCount(before + 2)
  await page.locator(`#ssh\\.keys\\.${before + 1}\\.name`).fill('yubikey')
  await page.locator(`#ssh\\.keys\\.${before + 1}\\.publicKey`).fill(PUBLIC_KEY)
  await page.getByRole('button', { name: 'Save to the file' }).click()

  await expect.poll(() => controlPlane.readConfig()).toContain('name: yubikey')
  expect(controlPlane.readConfig()).toContain('name: desktop')
})
