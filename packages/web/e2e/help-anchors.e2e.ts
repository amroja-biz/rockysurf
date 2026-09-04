import { test, expect } from './fixtures'

/**
 * HELP PAGE FRAGMENT LINKS LAND ON THEIR SECTION (issue #344).
 *
 * The dashboard's stale-servers notice links to `/help#stale-servers`, and the section exists —
 * `HelpPage.tsx` has always had it — but nothing scrolled to it: a `<Link>` click is a
 * client-side navigation React Router does not scroll for, and a `#anchor` typed straight into
 * the address bar is a real navigation the browser tries to scroll for too early, before this
 * SPA has rendered the target. Only a real browser, not a component test, can see either
 * failure — the DOM node is present either way, just not in view.
 *
 * Both paths are covered here, and a second link (`/help#backup`) proves the fix is the general
 * `useScrollToHash` mechanism rather than something special-cased for stale-servers.
 */
test.describe.configure({ mode: 'serial' })

test('clicking the stale-servers notice link lands on its section, not the top of Help', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Why, and how to check' }).click()

  await expect(page).toHaveURL(/\/help#stale-servers$/)
  await expect(page.getByRole('heading', { name: 'Checking for stale servers' })).toBeInViewport()
  // The page did scroll — not merely "the target happens to render near the top".
  await expect(
    page.getByRole('heading', { name: /give the power of rocky surf to your coding agents/i }),
  ).not.toBeInViewport()
})

test('a directly typed URL with the fragment lands on the same section', async ({ page }) => {
  // A fresh navigation, not an in-app click — this is the other half of the bug: the browser's
  // own scroll-on-load fires before the SPA has rendered `#stale-servers` into the DOM.
  await page.goto('/help#stale-servers')

  await expect(page.getByRole('heading', { name: 'Checking for stale servers' })).toBeInViewport()
})

test('a different /help fragment link works the same way, unrelated to stale-servers', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Backing up your data' }).click()

  await expect(page).toHaveURL(/\/help#backup$/)
  await expect(page.getByRole('heading', { name: 'Backing up your data' })).toBeInViewport()
})
