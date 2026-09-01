import { test, expect, signInThroughTheForm } from './fixtures'

/**
 * THE WALL EVERY EARLIER ATTEMPT AT BROWSER VERIFICATION STOPPED AT (owner instruction, #310).
 *
 * Rocky Surf has one password in front of it, and "I don't type the admin password" is the
 * reason UI regressions kept reaching main with a green gate: verification that cannot get past
 * the login page cannot see any page behind it. Every other file in this directory depends on
 * this working, so it is pinned here as its own subject rather than assumed as setup — if the
 * login form breaks, this is the test that says so, instead of nine unrelated ones timing out
 * on a page they never reached.
 *
 * The password is minted per instance and lives only in the temp directory that dies with it
 * (`control-plane.ts`); there is no fixture credential in this repository to leak.
 */
test.describe('signing in', () => {
  test.use({ signedIn: false })

  test('a visitor with no session is sent to the login page and can sign in from it', async ({
    page,
    controlPlane,
  }) => {
    /* Straight at an admin page, with nothing in the jar. The redirect is the contract. */
    await page.goto('/settings')
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByLabel('Admin password')).toBeVisible()

    await signInThroughTheForm(page, controlPlane.password)

    /* And the session actually opens the admin page it was refused a moment ago — the check
       that distinguishes "the form accepted the password" from "the cookie works". */
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  })

  test('the wrong password is refused, and nothing behind the login opens', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Admin password').fill('not-the-admin-password')
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page.getByRole('alert')).toHaveText('Incorrect password')
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0)

    /* A refusal that leaves a usable session would be the worst possible outcome and the
       easiest to miss, so it is asserted rather than inferred from the message. */
    await page.goto('/settings')
    await expect(page).toHaveURL(/\/login$/)
  })

  test('signing out ends the session, not just the page', async ({ page, controlPlane }) => {
    await signInThroughTheForm(page, controlPlane.password)
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page).toHaveURL(/\/login$/)

    /* The half that matters. Clearing the UI's own state would pass a check that only looked at
       this page; the session has to be dead on the server too, which a fresh navigation to a
       protected route is the honest way to ask. */
    await page.goto('/settings')
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByLabel('Admin password')).toBeVisible()
  })
})
