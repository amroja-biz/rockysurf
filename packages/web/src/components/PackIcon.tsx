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

export function PackIcon({ pack, size }: { pack: PackIconPack; size?: 'large' }): React.JSX.Element {
  const [imageFailed, setImageFailed] = useState(false)
  const showImage = Boolean(pack.imageUrl) && !imageFailed

  if (showImage) {
    return (
      <img
        className={`pack-icon ${size === 'large' ? 'pack-icon--large' : ''}`}
        src={pack.imageUrl}
        alt=""
        loading="lazy"
        onError={() => setImageFailed(true)}
      />
    )
  }

  const theme = pack.theme && THEME_PATTERN.test(pack.theme) && THEME_ALLOWLIST.has(pack.theme) ? pack.theme : hashAccent(pack.packId)

  return (
    <span
      className={`pack-monogram ${theme} ${size === 'large' ? 'pack-monogram--large' : ''}`}
      data-testid={`pack-monogram-${pack.packId}`}
    >
      {monogramOf(pack.name)}
    </span>
  )
}
