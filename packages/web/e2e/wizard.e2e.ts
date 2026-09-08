import { test, expect } from './fixtures'

/**
 * THE SETUP WIZARD, WALKED IN A REAL BROWSER (issue #474).
 *
 * The wizard is the first screen anybody meets, and the defect this file exists to prevent is
 * exactly the one the owner found in the published 0.1.0: a wizard that DESCRIBES setup instead
 * of performing it. Every other layer was green on that build — the page rendered, its tests
 * passed, and it could not set a cloud up.
 *
 * So this drives the whole thing: welcome, back and forward through every step, pick a cloud, read
 * the fields it drew from that Provider's own declaration, type into one, press the one button,
 * and then check the CONFIGURATION FILE THIS INSTALLATION BOOTED ON to prove the save was real.
 *
 * THE CLOUD IS THE PERSONAL-PROVIDER FIXTURE (`e2e/fixtures/personal-provider`, "Nimbus Cloud"),
 * which is switched off in the fixture config and declares the three shapes the wizard has to be
 * able to draw: a credential that takes a variable NAME, a plain string, and the two-act SSH
 * whitelist. No cloud is reached, no credential exists and nothing is billed.
 */
test.describe.configure({ mode: 'serial' })

/* ITS OWN INSTALLATION (see `installation` in `fixtures.ts`). This file SWITCHES A PROVIDER ON in
   the config file, which is the one thing every other file's assumptions are built on. */
test.use({ installation: 'wizard' })

const panel = (page: import('@playwright/test').Page) => page.locator('[data-cloud-panel="nimbus"]')

test('every step is reachable forwards and backwards, and the clouds are listed by name', async ({ page }) => {
  await page.goto('/setup')

  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible()
  await page.getByRole('button', { name: 'Get started' }).click()

  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible()
  // Back, on the step that used to be a one-way door.
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible()

  await page.getByRole('button', { name: 'Get started' }).click()
  await page.getByRole('button', { name: 'Next' }).click()

  // The SSH-key question, which is skippable and goes back like every other step.
  await expect(page.getByRole('heading', { name: 'Your SSH key' })).toBeVisible()
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible()
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByRole('heading', { name: 'Choose your clouds' })).toBeVisible()

  // Every cloud this installation knows about, each with its own state under its name.
  await expect(page.getByTestId('cloud-list')).toContainText('Nimbus Cloud')
  await expect(page.locator('[data-cloud-state="nimbus"]')).toHaveText('Not set up yet')
})

test('picking a cloud draws its own settings fields, in place', async ({ page }) => {
  await page.goto('/setup')
  await page.getByRole('button', { name: 'Get started' }).click()
  // Your account, then Your SSH key — both passed through without answering.
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await page.locator('[data-cloud="nimbus"]').click()

  await expect(panel(page)).toBeVisible()
  // The steps that cannot happen in a browser, and nothing about a file or a repository path.
  await expect(page.getByTestId('cloud-instructions')).toBeVisible()
  await expect(panel(page)).not.toContainText('rockysurf.config.yaml')
  await expect(panel(page)).not.toContainText('docs/')

  // The labels the PROVIDER wrote, drawn by the Settings page's own controls.
  await expect(panel(page).getByLabel('Region')).toBeVisible()
  await expect(panel(page).getByLabel('API token variable')).toBeVisible()
  await expect(panel(page).getByRole('group', { name: 'SSH allowed from' })).toBeVisible()
  // Saving is what turns the cloud on, so there is no second control saying the same thing.
  await expect(panel(page).locator('[data-field="providers.nimbus.enabled"]')).toHaveCount(0)
})

test('saving writes the fields AND switches the cloud on, then says what the cloud answered', async ({
  page,
  controlPlane,
}) => {
  await page.goto('/setup')
  await page.getByRole('button', { name: 'Get started' }).click()
  // Your account, then Your SSH key — both passed through without answering.
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await page.locator('[data-cloud="nimbus"]').click()

  await panel(page).locator('#providers\\.nimbus\\.region').fill('sky-2')
  await panel(page).getByRole('button', { name: 'Save and turn on Nimbus Cloud' }).click()

  // THE FILE THIS INSTALLATION BOOTED ON, not a page that says it saved.
  await expect.poll(() => controlPlane.readConfig()).toContain('region: sky-2')
  await expect.poll(() => controlPlane.readConfig()).toMatch(/nimbus:[\s\S]*?enabled: true/)

  // And the answer is on this screen, without pressing anything else.
  await expect(page.getByTestId('check-result-nimbus')).toBeVisible()
})

test('the Done step reports the cloud that is on, and offers a Check and a way back', async ({ page }) => {
  await page.goto('/setup')
  await page.getByRole('button', { name: 'Get started' }).click()
  // Your account, then Your SSH key — both passed through without answering.
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()

  const row = page.locator('[data-summary-cloud="nimbus"]')
  await expect(row).toContainText('Nimbus Cloud')
  await page.getByTestId('check-done-nimbus').click()
  await expect(page.getByTestId('check-result-done-nimbus')).toBeVisible()

  // The step that used to say "the way the previous step described" now goes there.
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('heading', { name: 'Choose your clouds' })).toBeVisible()
})

/**
 * THE THREE THINGS A FIRST-CONTACT TEST FOUND, in the browser they were found in.
 *
 * An engineer was handed the rebuilt wizard and watched setting a cloud up. Each of these is a
 * property of the real page rather than of a component test: a button that is off, a button that
 * is gone, and a sentence under a box.
 */
test('a Region that does not look like one is refused at the box, with Save off until it is fixed', async ({ page }) => {
  await page.goto('/setup')
  await page.getByRole('button', { name: 'Get started' }).click()
  // Your account, then Your SSH key — both passed through without answering.
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await page.locator('[data-cloud="nimbus"]').click()

  const region = panel(page).locator('#providers\\.nimbus\\.region')
  await region.fill('sandbox')
  // On blur, in the Provider's own words — assembled by core from the declaration, not by the SPA,
  // which holds no regular expression and no cloud's name.
  await region.blur()
  await expect(panel(page).locator('[data-shape-problem]')).toHaveText(
    'That does not look like a Nimbus Cloud region, for example sky-1.',
  )
  await expect(page.getByRole('button', { name: 'Save and turn on Nimbus Cloud' })).toBeDisabled()
  // And the reason the button is off is on the screen, not only in the developer's head.
  await expect(page.getByTestId('shape-problems')).toContainText('Region')

  await region.fill('sky-2')
  await expect(panel(page).locator('[data-shape-problem]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save and turn on Nimbus Cloud' })).toBeEnabled()
})

test('the SSH allow-list offers to find the address, instead of sending the reader to a terminal', async ({ page }) => {
  await page.goto('/setup')
  await page.getByRole('button', { name: 'Get started' }).click()
  // Your account, then Your SSH key — both passed through without answering.
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await page.locator('[data-cloud="nimbus"]').click()

  // Beside Add, inside the allow-list's own control. The help says "your own address as a /32 is
  // the usual answer"; this is how the reader finds out what that is without leaving the page.
  const useMyIp = page.getByTestId('use-my-ip-nimbus')
  await expect(useMyIp).toBeVisible()
  await useMyIp.click()

  /*
    EITHER OUTCOME PASSES, deliberately. The browser and the server are the same machine here, so
    the socket is loopback and core falls through to a public what-is-my-address service, which a
    given machine may or may not be able to reach. The rule being pinned is the one that matters:
    the button always ends by SAYING something — the address it found, or why it could not. It
    never fills nothing in silence.
  */
  await expect(page.locator('[data-my-ip-note="nimbus"], [data-my-ip-error="nimbus"]')).toBeVisible({ timeout: 15_000 })
})

test('a cloud that has just said yes is not asked to prove it twice', async ({ page }) => {
  await page.goto('/setup')
  await page.getByRole('button', { name: 'Get started' }).click()
  // Your account, then Your SSH key — both passed through without answering.
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await page.locator('[data-cloud="nimbus"]').click()

  // The save runs the check itself and prints the green line. A full-sized "Check Nimbus Cloud"
  // button under that reads as "did I not just do this?", which is what the tester asked out loud.
  await panel(page).getByRole('button', { name: 'Save and turn on Nimbus Cloud' }).click()
  await expect(page.getByTestId('check-result-nimbus')).toContainText('Nimbus Cloud is ready')
  await expect(page.getByRole('button', { name: 'Check Nimbus Cloud' })).toHaveCount(0)

  // The way to ask again is still there, at the size of the job it is still for.
  const again = page.getByTestId('check-nimbus')
  await expect(again).toHaveText('Check again')
  await again.click()
  await expect(page.getByTestId('check-result-nimbus')).toContainText('Nimbus Cloud is ready')
})

/**
 * THE SSH-KEY QUESTION, ASKED ONCE INSTEAD OF AT EVERY CREATE.
 *
 * Both answers already worked and neither was ever asked, so the first-time user met the question
 * on the form that creates a billable machine. What is proved here is that the wizard's form is
 * the SETTINGS list's form — the save lands in `ssh.keys` in the configuration file this
 * installation booted on — and that a private key is refused with core's own sentence.
 */
test('the SSH-key step saves a public key into the config file, and refuses the private half', async ({
  page,
  controlPlane,
}) => {
  const PUBLIC_KEY =
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIN7VQ0Zq1r6VJ5eBK4cQKcO0uYQ1n4jvVYQ8Gk2r1TxA browser-suite'

  await page.goto('/setup')
  await page.getByRole('button', { name: 'Get started' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByRole('heading', { name: 'Your SSH key' })).toBeVisible()

  // The other answer first: it asks for nothing and says where the private half comes from.
  await page.getByTestId('key-generate').click()
  await expect(page.getByTestId('key-generate-explainer')).toContainText('a fresh key for each Server')

  await page.getByTestId('key-paste').click()
  await expect(page.getByTestId('key-paste-form')).toContainText('cat ~/.ssh/id_ed25519.pub')

  // THE PREDICTABLE MISTAKE, refused by the config file's own validator with the parser's words.
  await page.locator('#ssh\\.keys\\.new\\.name').fill('browser-suite')
  await page.locator('#ssh\\.keys\\.new\\.publicKey').fill('-----BEGIN OPENSSH PRIVATE KEY-----')
  await page.getByRole('button', { name: 'Add this key' }).click()
  await expect(page.locator('[data-field="ssh.keys.new.publicKey"]')).toContainText('that is a PRIVATE key')

  await page.locator('#ssh\\.keys\\.new\\.publicKey').fill(PUBLIC_KEY)
  await page.getByRole('button', { name: 'Add this key' }).click()

  /*
    THE FILE THIS INSTALLATION BOOTED ON, not a page that says it saved. The key's own blob rather
    than the whole line: the YAML writer folds a line this long across three of them, which is a
    fact about the serializer and not about whether the key was saved.
  */
  await expect.poll(() => controlPlane.readConfig()).toContain('name: browser-suite')
  await expect.poll(() => controlPlane.readConfig()).toContain(PUBLIC_KEY.split(' ')[1]!)
  await expect(page.getByTestId('saved-keys')).toContainText('browser-suite')
})
