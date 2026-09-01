import { useState } from 'react'

/**
 * A pack's mark: its `imageUrl` when it has one, otherwise a deterministic monogram tile
 * (rockysurf-4d8h). Every third-party pack has no image until its author adds one, and on a
 * card-based page a hole where the mark should be reads as broken — so unlike the two older
 * call sites this replaces (`AdminSurgePacksPage.tsx`'s table, `CreateServerPage.tsx`'s radio
 * rows, both of which hid a failed image with `display:none`), a card here always carries a
 * mark.
 *
 * DETERMINISTIC means a pack looks the same on every reload and in every test: the monogram is
 * the first letters of the first two words of `name` (or its first two characters, for a
 * one-word name), coloured by a stable hash of `packId` — never `Math.random`, never index.
 *
 * `theme` is contributor-supplied data (a pack file, or the admin form), so it earns its accent
 * only by exact membership in the six-value allowlist below; anything else — a typo, an attempt
 * to name a class this page never declared — is ignored and the hash decides instead.
 */

const THEME_ALLOWLIST = new Set([
  'theme-orange',
  'theme-blue',
  'theme-green',
  'theme-purple',
  'theme-red',
  'theme-slate',
])
const THEME_PATTERN = /^theme-[a-z0-9-]{1,24}$/

/** The six accents a hash of `packId` picks between, when `theme` names none of them. */
const HASH_ACCENTS = ['theme-orange', 'theme-blue', 'theme-green', 'theme-purple', 'theme-red', 'theme-slate']

function hashAccent(packId: string): string {
  let hash = 0
  for (let i = 0; i < packId.length; i++) {
    hash = (hash * 31 + packId.charCodeAt(i)) | 0
  }
  return HASH_ACCENTS[Math.abs(hash) % HASH_ACCENTS.length]!
}

function monogramOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase()
  const one = words[0] ?? ''
  return one.slice(0, 2).toUpperCase()
}

export interface PackIconPack {
  packId: string
  name: string
  imageUrl?: string
  theme?: string
}

/**
 * TWO MARKS THAT MEAN OPPOSITE THINGS, and therefore look different (issue #295).
 *
 * They are not one fact seen from two sides — they are two facts, and a single card can carry
 * both. A pack forked from another, which somebody has since forked again, is a derivative AND
 * has a personal version of its own.
 *
 *  - `DerivativeMark` — the owner-ruled bright delta, TOP RIGHT. "This pack is a copy of
 *    another, and the artwork it is wearing is that pack's." Solid and bright because it is the
 *    one that qualifies what you are looking at: the icon is borrowed, and this says so.
 *  - `CopiesMark` — a quieter outlined mark, BOTTOM RIGHT, with a different glyph. "A personal
 *    version of this pack exists." It qualifies nothing about the card it sits on; the pack is
 *    exactly what it appears to be. On an official pack it must never read as "this was
 *    altered" — nothing alters an official pack.
 *
 * OPPOSITE CORNERS, so no precedence rule is needed and neither can hide the other. Both are
 * decoration: nothing here filters, disables or intercepts a click, so an official pack with a
 * fork stays exactly as selectable as one without. Each caller passes the sentence to read,
 * because only the page knows which pack the mark is about.
 *
 * A MARK ON THE ICON, NOT A SECOND BADGE. The card deliberately spends itself on the mark, the
 * name and one badge (issue #192).
 */
function DerivativeMark({ label }: { label: string }): React.JSX.Element {
  return (
    <span className="pack-icon-delta" role="img" aria-label={label} title={label}>
      ∆
    </span>
  )
}

function CopiesMark({ label }: { label: string }): React.JSX.Element {
  return (
    <span className="pack-icon-copies" role="img" aria-label={label} title={label}>
      ⧉
    </span>
  )
}

export function PackIcon({
  pack,
  size,
  derivativeMark,
  copiesMark,
}: {
  pack: PackIconPack
  size?: 'large'
  /**
   * "This pack is a copy of another" — the bright delta, top right. Undefined for no delta.
   */
  derivativeMark?: string
  /**
   * "A personal version of this pack exists" — the quieter outlined mark, bottom right.
   * Independent of `derivativeMark`: a fork that has itself been forked shows both.
   */
  copiesMark?: string
}): React.JSX.Element {
  const [imageFailed, setImageFailed] = useState(false)
  const showImage = Boolean(pack.imageUrl) && !imageFailed

  // No wrapper at all when there is nothing to position, so every unmarked call site renders
  // exactly what it did before these marks existed — same element, same testids.
  const marked = derivativeMark !== undefined || copiesMark !== undefined
  const withMark = (icon: React.JSX.Element): React.JSX.Element =>
    !marked ? (
      icon
    ) : (
      <span className={`pack-icon-marked ${size === 'large' ? 'pack-icon-marked--large' : ''}`}>
        {icon}
        {derivativeMark !== undefined && <DerivativeMark label={derivativeMark} />}
        {copiesMark !== undefined && <CopiesMark label={copiesMark} />}
      </span>
    )

  if (showImage) {
    return withMark(
      <img
        className={`pack-icon ${size === 'large' ? 'pack-icon--large' : ''}`}
        src={pack.imageUrl}
        alt=""
        loading="lazy"
        onError={() => setImageFailed(true)}
      />,
    )
  }

  const theme = pack.theme && THEME_PATTERN.test(pack.theme) && THEME_ALLOWLIST.has(pack.theme) ? pack.theme : hashAccent(pack.packId)

  return withMark(
    <span
      className={`pack-monogram ${theme} ${size === 'large' ? 'pack-monogram--large' : ''}`}
      data-testid={`pack-monogram-${pack.packId}`}
    >
      {monogramOf(pack.name)}
    </span>,
  )
}
