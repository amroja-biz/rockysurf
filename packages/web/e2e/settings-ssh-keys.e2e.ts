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
 * WHAT IS BROKEN, on the commit this was written against. `listSection` appends a blank entry
 * carrying a CONSTANT name, and computes ONE `blocked` flag from "does this list have any
 * pending edit" which disables Add and Remove together. That is two defects, and they are
 * asserted here in order of how objectively they fail rather than in the order a hand meets
 * them:
 *
 *   1. A SECOND `Add` IS REFUSED OUTRIGHT. Both blanks are born with the same name, the schema
 *      rejects the pair with `two saved SSH keys share a name`, the write comes back 400, and
 *      the list still holds exactly one entry. Nothing on screen says so. This is the hardest
 *      failure to argue with — a count, not a matter of style — so it is asserted first, and it
 *      is therefore the one that actually runs while the bug is present.
 *   2. AND THE CONTROLS BESIDE A VALID EDIT GO DEAD. Type a name into the entry you just added
 *      and Add and Remove are disabled with "Save or discard your other changes to this list
 *      first" — for renaming the key you are in the middle of adding.
 *
 * The footer `Save to the file` button is NOT one of the defects, which is worth writing down
 * because the issue's own wording points at it: no valid single edit was ever found that
 * disabled it, either by driving the page here or by the author of the fix. The dead controls
 * are the list's own Add and Remove.
 *
 * THE SAME TRAP IS LATENT IN `registry.sources` AND `providers.byo.hosts` — same uniqueness
 * rule, same constant placeholder. #311 numbers new entries generically in `listSection`, so
 * one fix covers all three; only this list has a test, and the other two are worth a pass if
 * this suite is ever widened.
 */
test('adding a second key is not blocked by an edit to the first', async ({ page, controlPlane }) => {
  test.fail()

  await page.goto('/settings?section=ssh')
  const panel = page.locator(openPanel)
  const add = panel.getByRole('button', { name: 'Add', exact: true })
  const entries = panel.locator('.settings-entry')
  const before = await entries.count()

  /* One: two Adds make two entries. Two machines is the reason the list is a list at all — an
     installation that can hold exactly one saved key did not need one. Asserted on the count
     rendered, because the refusal behind this is a 400 the page never mentions. */
  await add.click()
  await expect(entries).toHaveCount(before + 1)
  await add.click()
  await expect(entries).toHaveCount(before + 2)

  /* Two: and naming one of them does not disable the controls beside it. */
  await page.locator(`#ssh\\.keys\\.${before}\\.name`).fill('desktop')
  await expect(add).toBeEnabled()

  /* Three: the pair survives the round trip to the file, which is the point of all of it. */
  await page.locator(`#ssh\\.keys\\.${before + 1}\\.name`).fill('yubikey')
  await page.locator(`#ssh\\.keys\\.${before + 1}\\.publicKey`).fill(PUBLIC_KEY)
  await page.getByRole('button', { name: 'Save to the file' }).click()

  await expect.poll(() => controlPlane.readConfig()).toContain('name: yubikey')
  expect(controlPlane.readConfig()).toContain('name: desktop')
})
