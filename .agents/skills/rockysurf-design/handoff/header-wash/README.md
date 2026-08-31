# Handoff: header cloud wash

## Overview

The new brand lockup in the top-left of the control plane is an opaque raster
plate — a crop of the logo painting with the teal wordmark on it — and its
rectangular edge reads as stuck onto the header bar.

The fix does not touch the lockup. It extends the same painting across the
whole header at low opacity, fading out to the right, and screens the lockup
into it. The imagery never ends, so there is no edge to notice.

Four treatments were explored; this is the one chosen. The others are in
`Header Logo Blending.dc.html` in the design project if you want to see what
was rejected and why.

## About the design files

`header-wash.preview.html` in this folder is a **design reference** — an HTML
prototype of the intended result, not production code. It reproduces the
header standalone so you can see the target.

That said, this particular change is unusually literal: the whole
implementation is the CSS in `header-wash.css`, written against the real
selectors in `packages/web/src/App.css`. Append it and it works. No component
changes.

## Fidelity

**High-fidelity.** Exact values, ready to paste.

## What to change

Three things, in this order.

### 1. Add the asset

`clouds-band.png` (1600×340) → `packages/web/public/assets/clouds-band.png`

It is the top 170px of `docs/media/logo.png` (800×600), resampled 2× for
retina. Re-export it from the source painting if you prefer; the crop is
`(0, 0, 800, 170)` scaled to 1600×340.

It ships here as a 1.1 MB PNG. Run it through a lossy encoder or export WebP
at quality 80 before committing — it is a night sky at 62% opacity and nothing
about it needs lossless.

### 2. Append the CSS

Contents of `header-wash.css` → end of `packages/web/src/App.css`, after the
existing `.app-header` block.

### 3. Nothing in AppShell.tsx

The existing markup already provides every hook the CSS needs:
`.app-header`, `.app-header > nav`, `.app-header-right`, `.app-brand img`.

## Design values

| What | Value | Why |
|---|---|---|
| Band image | `/assets/clouds-band.png`, `1500px auto`, position `-30px 34%` | Puts the painting's lighthouse glow under the mark and the moon past the last nav link |
| Band opacity | `0.62` | On `--rs-surface` (#161b22). The design mockups sit on #1d1b26, which is what the screenshot of the live app samples to; if the live bar is that lighter value, 0.55 matches the mockups |
| Band blend | `mix-blend-mode: screen` | Screen against an opaque dark ground annihilates the painting's night and keeps only lit pixels — this is what removes the rectangle, not the mask |
| Band mask | `linear-gradient(90deg, #000 0%, .62 46%, .28 72%, transparent 94%)` | Depth by gradation rather than blur, so the engraving stays crisp |
| Vertical wash | `--rs-surface` at 0.55 → 0 (42%) → 0.82 | Keeps the top edge and the `border-bottom` hairline clean |
| Mark filter | `contrast(1.6)` | Holds the teal lettering once the darks are screened away |
| Mark mask | `radial-gradient(115% 125% at 38% 50%, #000 46%, transparent 94%)` | Dissolves the plate corners |
| Breakpoint | band hidden below 768px | The nav wraps to a second row there and the fade lands under the links |

No new colour, type, spacing or radius values are introduced. The wash reads
`--rs-surface`; the hairline and padding are the existing `.app-header` rules.

## Things that will bite

- **The header background must stay opaque.** Screen composites against
  whatever is behind it. `.app-header` already sets
  `background: var(--rs-surface)`, so this holds — but do not make the bar
  translucent, or sticky with a `backdrop-filter`, without re-checking it.
- **The mark must stay one raster with a dark ground.** Screen is what removes
  its plate. If the lockup is ever replaced with a transparent PNG or an SVG,
  delete `mix-blend-mode`, `filter` and the mask from `.app-brand img` — the
  transparency already does that job and the contrast lift will only wreck the
  teal.
- **Relative colour syntax.** `rgb(from var(--rs-surface) r g b / …)` needs
  Chrome 119 / Safari 16.4 / Firefox 128. For older support, write the stops as
  `rgba(22, 27, 34, …)` and keep them in sync with the token by hand.
- **The etched skin.** Under `data-rs-skin="etched"` the ground becomes the
  painting's night, which is lighter than #161b22 and closer to the band
  itself. The wash reads weaker there — check it, or drop the opacity to about
  0.5 under that selector.
- **This is a deliberate exception to a stated rule.** The design system says
  flat backgrounds and no imagery in the app beyond 40px pack tiles. One bar is
  the exception; worth a comment saying so. If it spreads to cards or the page
  ground, the rule is gone rather than bent.

## Assets

| File | Source |
|---|---|
| `clouds-band.png` | Cropped and resampled from `docs/media/logo.png` in this repo |
| The lockup in the preview | Cropped out of the screenshot of the running app — it is screen-resolution and for illustration only. The real lockup is already in your app |

## Files

- `header-wash.css` — the implementation
- `clouds-band.png` — the asset
- `header-wash.preview.html` — visual target, reference only
