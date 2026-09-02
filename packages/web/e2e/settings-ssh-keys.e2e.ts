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
 * THE REGRESSION TEST FOR THE SSH-LIST SAVE BUG (#302/#303/#305, fixed by #311).
 *
 * This was written as a REPRODUCTION, against the broken behaviour, and it is kept here now
 * that the behaviour is fixed — which is the whole point of having written it that way. It
 * carried `test.fail()` while the bug was live (Playwright runs such a test and the suite is
 * green only while it fails, so the bug was pinned by something that executed rather than by a
 * skipped note). #311 landed, the test started passing, the job went red on purpose, and that
 * line came off. What is left guards the fix.
 *
 * WHAT WENT WRONG, and what each assertion below now holds in place. `listSection` used to
 * append a blank entry carrying a CONSTANT name, and to compute ONE `blocked` flag from "does
 * this list have any pending edit" which disabled Add and Remove together. Two defects, asserted
 * here in order of how objectively they fail rather than in the order a hand meets them:
 *
 *   1. A SECOND `Add` WAS REFUSED OUTRIGHT. Both blanks were born with the same name, the schema
 *      rejected the pair with `two saved SSH keys share a name`, the write came back 400, and
 *      the list still held exactly one entry — with nothing on screen saying so. A count rather
 *      than a matter of style, which is why it is asserted first: while the bug was live this
 *      was the assertion that actually ran. #311 numbers new entries generically.
 *   2. AND THE CONTROLS BESIDE A VALID EDIT WENT DEAD. Typing a name into the entry you had just
 *      added disabled Add and Remove with "Save or discard your other changes to this list
 *      first" — for renaming the key you were in the middle of adding.
 *
 * The footer `Save to the file` button was NOT one of the defects, which is worth keeping on the
 * record because the issue's own wording pointed at it: no valid single edit was ever found that
 * disabled it, either by driving the page here or by the author of the fix. The dead controls
 * were the list's own Add and Remove. Do not "restore" an interlock on that button.
 *
 * THE SAME TRAP WAS LATENT IN `registry.sources` AND `providers.byo.hosts` — same uniqueness
 * rule, same constant placeholder. #311's generic numbering covers all three; only this list has
 * a test, and the other two are worth a pass if this suite is ever widened.
 */
test('adding a second key is not blocked by an edit to the first', async ({ page, controlPlane }) => {
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
