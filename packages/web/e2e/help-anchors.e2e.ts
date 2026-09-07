import { test, expect } from './fixtures'

/**
 * HELP PAGE NAVIGATION AND FRAGMENT LINKS (issues #344 and #364).
 *
 * The original bug (#344): the dashboard's stale-servers notice links to `/help#stale-servers`,
 * and the section exists — `HelpPage.tsx` has always had it — but nothing scrolled to it. A
 * `<Link>` click is a client-side navigation React Router does not scroll for, and a `#anchor`
 * typed straight into the address bar is a real navigation the browser tries to scroll for too
 * early, before this SPA has rendered the target. Only a real browser, not a component test, can
 * see either failure — the DOM node is present either way, just not in view.
 *
 * What #364 added: the page is now a sidebar with one panel showing at a time, so a fragment has
 * to do two things rather than one — open the panel that holds the target, then scroll to it. A
 * component test can see the panel open; only this file can see that the page actually scrolled,
 * and that the sidebar drives the same mechanism the incoming links do.
 */
test.describe.configure({ mode: 'serial' })

test('clicking the stale-servers notice link lands on its section, not the top of Help', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Why, and how to check' }).click()

  await expect(page).toHaveURL(/\/help#stale-servers$/)
  await expect(page.getByRole('heading', { name: 'Checking for stale servers' })).toBeInViewport()
  // The fragment opened the panel that holds it, and only that panel.
  await expect(page.getByRole('tab', { name: 'Servers', selected: true })).toBeVisible()
  await expect(page.locator('#agents')).toBeHidden()
  // The page did scroll — not merely "the target happens to render near the top".
  await expect(page.getByRole('heading', { name: 'Servers', level: 2 })).not.toBeInViewport()
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

test('the sidebar switches sections, and the fragment follows it (#364)', async ({ page }) => {
  await page.goto('/help')

  // The page opens on the first step of the sequence the sidebar is ordered by (#441).
  await expect(page.getByRole('tab', { name: 'Start here', selected: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Start here' })).toBeVisible()

  await page.getByRole('tab', { name: 'Cloud Providers' }).click()

  await expect(page).toHaveURL(/\/help#providers$/)
  await expect(page.getByRole('heading', { name: 'Cloud Providers' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Hetzner' })).toBeVisible()
  await expect(page.locator('#start')).toBeHidden()
})

/**
 * START HERE AND ALL DOCUMENTATION (issue #441). The owner's report was about finding things:
 * the order read as random, and the documentation panel carried a subset of the documentation.
 * A component test sees the markup; only this file sees that a reader who opens Help lands on
 * Start here and can walk the setup from it by clicking.
 */
test('Start here walks the setup, one click per step (#441)', async ({ page }) => {
  await page.goto('/help')

  const start = page.locator('#start')
  await expect(start.getByRole('link', { name: 'Cloud Providers' })).toBeVisible()

  await start.getByRole('link', { name: 'Servers', exact: true }).click()

  await expect(page).toHaveURL(/\/help#servers$/)
  await expect(page.getByRole('tab', { name: 'Servers', selected: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Create a server' })).toBeVisible()
})

test('All documentation lists every audience the README groups documents by (#441)', async ({
  page,
}) => {
  await page.goto('/help#docs')

  const docs = page.locator('#docs')
  await expect(page.getByRole('heading', { name: 'All documentation' })).toBeVisible()
  for (const audience of ['Operators', 'Surge Pack authors', 'Contributors', 'The maintainer']) {
    await expect(docs.getByRole('heading', { name: audience })).toBeVisible()
  }
  // The documents renamed in #439 are here under their new paths, opening on GitHub.
  for (const path of [
    'docs/writing-a-surge-pack.md',
    'docs/surge-pack-contract.md',
    'docs/contributing/TESTING.md',
    'docs/contributing/RELEASING.md',
  ]) {
    await expect(docs.locator(`a[href$="/blob/main/${path}"]`)).toHaveAttribute('target', '_blank')
  }
})

test('the MCP section gives the steps and the scope table (#364)', async ({ page }) => {
  await page.goto('/help#mcp')

  await expect(page.getByRole('heading', { name: 'Install the MCP server' })).toBeInViewport()
  // The two environment variables the MCP server actually reads, in a copyable block.
  await expect(page.getByText('ROCKYSURF_TOKEN').first()).toBeVisible()
  await expect(page.getByText('ROCKYSURF_URL').first()).toBeVisible()

  // The scope table is the answer to "my agent has no create_server", so it has to be readable.
  const table = page.locator('.help-table')
  await expect(table).toBeVisible()
  await expect(table.getByRole('row')).toHaveCount(5) // a header row and the four scopes
  await expect(table.getByRole('cell', { name: 'create_server' })).toBeVisible()
})
