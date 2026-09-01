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
