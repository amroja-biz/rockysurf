import { test, expect } from './fixtures'

/**
 * DERIVING A PACK (issue #310, flow 4; the marks are issue #295).
 *
 * The two marks are the case worth driving in a browser rather than asserting on a function.
 * They are derived in the page from the list it already has, they land on OPPOSITE CORNERS of
 * the same icon so that a card can carry both, and each one names the pack it is about. A unit
 * test on `forksByParent` proves the relationship; only this proves that a person who forks an
 * official pack then SEES which card is the copy and which card was copied.
 */
test.describe.configure({ mode: 'serial' })

const SOURCE = 'Claude Code (ai-coding-agents)'

/**
 * THE PAGE IS CALLED SURGE PACKS, AND IT IS ONLY ABOUT PACKS (issue #394).
 *
 * ADR-0028 retitled it "Shop" and gave it a fourth tab, Providers; the owner's ruling reverses
 * both. This is pinned in a browser rather than on the navbar component test because the ruling
 * is about what a person reads at the top of the window and along the nav, and because the tab
 * strip has to be checked for what is ABSENT — a component test that renders three tabs proves
 * nothing about a fourth arriving from somewhere else on the page.
 */
test('is titled Surge Packs, has three tabs, and offers nothing about providers', async ({ page }) => {
  await page.goto('/packs')

  await expect(page.getByRole('heading', { name: 'Surge Packs', level: 1 })).toBeVisible()
  const nav = page.getByRole('navigation', { name: 'Primary' })
  await expect(nav.getByRole('link', { name: 'Surge Packs' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Shop' })).toHaveCount(0)

  const tabs = page.getByRole('tab')
  await expect(tabs).toHaveText(['Official', 'Community', 'Personal'])
  await expect(page.getByRole('tab', { name: 'Providers' })).toHaveCount(0)
})

/**
 * ISSUE #397: PERSONAL POINTS AT THE SKILL THAT WRITES A PACK, not only at the packs it already
 * holds. Asserted here rather than only in a component test because the point is what a person
 * lands on when they open this tab in a real browser — the banner text and the link's exact
 * target, both.
 */
test('the Personal tab banners the create-surge-pack skill', async ({ page }) => {
  await page.goto('/packs?tab=personal')

  const banner = page.getByTestId('personal-create-surge-pack-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toHaveText(
    "If you're creating a Surge Pack for a new harness, use the create-surge-pack skill.",
  )

  const link = banner.getByRole('link', { name: 'create-surge-pack' })
  await expect(link).toHaveAttribute(
    'href',
    'https://github.com/amroja-biz/rockysurf/tree/main/.agents/skills/create-surge-pack',
  )
  await expect(link).toHaveAttribute('target', '_blank')
})

test('a pack derived from an official one lands on Personal wearing the delta', async ({ page }) => {
  await page.goto('/packs?tab=personal')
  await expect(page.getByText('No personal packs yet.')).toBeVisible()

  await page.getByRole('button', { name: 'New Surge Pack' }).click()
  await page.getByRole('button', { name: /Start from an existing pack/ }).click()

  const panel = page.getByTestId('pack-from-existing-panel')
  await expect(panel).toBeVisible()
  await panel.getByTestId('from-existing-source').selectOption({ label: SOURCE })

  /* The form seeds itself from the source — the name it proposes is what the fork will be
     called, and taking it rather than typing one keeps this about the derive flow. */
  const form = page.getByTestId('pack-form')
  await expect(form.getByRole('textbox').first()).toHaveValue('Claude Code (copy)')
  await form.getByRole('button', { name: 'Save', exact: true }).click()

  /* On Personal, and marked as a derivative. The label is the assertion, not the glyph: "∆"
     alone would pass with the mark pointing at the wrong parent. */
  const fork = page.getByRole('img', { name: 'Your personal version of Claude Code' })
  await expect(fork).toBeVisible()
  await expect(page.getByText('Claude Code (copy)')).toBeVisible()
})

test('and the official pack it came from gets its own, different mark', async ({ page }) => {
  await page.goto('/packs?tab=official')

  /* The other corner, the other glyph, the other sentence. On an official card this must never
     read as "this was altered" — nothing alters an official pack — so it names the copy. */
  await expect(page.getByRole('img', { name: 'Personal version: Claude Code (copy)' })).toBeVisible()

  /* And it is genuinely the parent's card that carries it, not every card on the shelf.
     `:visible` because every tab panel stays mounted and only `hidden` moves — an unscoped
     count here would also see the Personal shelf's own delta and prove nothing. */
  await expect(page.locator('.pack-icon-copies:visible')).toHaveCount(1)
  await expect(page.locator('.pack-icon-delta:visible')).toHaveCount(0)
})

/**
 * SAVING AN EDIT RETURNS TO THE PACK'S OWN TAB (issue #342), not wherever the detail page
 * happened to be reached from. This continues the fork created above — a Personal (`local`)
 * pack, database-backed and therefore editable — because editing needs a pack Edit is actually
 * offered on; a file-backed official pack is read-only (see the "ported from the admin
 * surge-packs page" describe in `PacksPage.test.tsx`).
 */
test('editing a Personal pack lands back on the Personal tab, not Official', async ({ page }) => {
  await page.goto('/packs?tab=personal')
  await page.getByTestId('pack-card-ai-coding-agents-copy').click()

  await page.getByRole('button', { name: 'Edit' }).click()
  const form = page.getByTestId('pack-form')
  await expect(form).toBeVisible()

  // Any real edit — Display order is the field the issue's own screenshot shows.
  await form.getByLabel('Display order').fill('42')
  await form.getByRole('button', { name: 'Save', exact: true }).click()

  // Back on the LIST, Personal tab specifically — not the detail page, and not Official, which
  // is where a save with no tab memory would silently default to. `toBeVisible` is the proof:
  // every tab panel stays mounted (`hidden`, not unmounted — see the page's own docblock), so
  // the card being VISIBLE, not merely present, is what says Personal is the active panel.
  await expect(page).toHaveURL(/\/packs\?tab=personal/)
  await expect(page.getByTestId('pack-card-ai-coding-agents-copy')).toBeVisible()
})
