---
KEY: surge-pack-image-budget
DATE: 2026-09-01
UPDATED: 2026-09-01
STATUS: active
SOURCE: session decision, after PR #287's first push broke the required Test check
---

Surge pack images (`packages/web/public/images/surge-packs/*.png`) are 256×256 PNGs, and the
whole set must stay well under 512 KB combined. `bundle-assets.test.ts` enforces the total
(`packages/web/src/bundle-assets.test.ts:146`, `toBeLessThan(512 * 1024)`) because these images
ship inside the SPA bundle — every one of them is downloaded by every visitor before the packs
page renders. The same file also caps the hero image at 400 KB and the band image at 150 KB.

The lesson behind it: a replacement Claude Code logo was dropped in at its source resolution,
1254×1254 and 1.7 MB, and the required Test check went red on every branch that touched the
file. The fix was one command — `sips -Z 256 <file>.png` on macOS — which brought it to 85 KB
and matched every sibling image. So when adding or replacing a pack image: resize to 256×256
first, then check the directory's total. At 256×256 a typical logo lands between 12 KB and
95 KB, which leaves comfortable headroom for the full set.

Do not "fix" a red bundle-assets test by raising the 512 KB limit; the budget is the point.
If the set legitimately outgrows it, the conversation is about serving pack images outside the
bundle, not about a bigger bundle.
