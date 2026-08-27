---
name: rockysurf-design
description: Use this skill to generate well-branded interfaces and assets for Rocky Surf, either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for protoyping.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.
If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.
If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.

## What is in here

| Path | What it is |
|---|---|
| `README.md` | The design guide: content fundamentals, visual foundations, iconography, the etched skin |
| `styles.css` | The global entry point — `@import` lines only |
| `tokens/` | Colours, type, spacing, borders, motion, and the etched skin's palette |
| `css/` | The product's stylesheet, split by concern |
| `components/` | Every component: `.prompt.md` usage note, plus `.jsx.txt` source and `.d.ts.txt` props contract |
| `assets/` | The logo painting, the favicon marks, the ten Surge Pack PNGs |
| `guidelines/` | 17 specimen cards — colours, type, spacing, radii, motion, iconography, the logo |
| `ui_kits/rockysurf-app/` | A click-through recreation of the control plane, with each screen mapped to the file it was read from |
| `ui_kits/etched/` | The two screens the etched skin landed on |
| `thumbnail.html.txt` | The system's tile |
| `github.md` | Which repository and commit this was built from, and what was updated |
| `handoff/` | Dropping the etched skin into `packages/web`: `etched.css`, `etched.tsx.txt`, and the rollout order |

## If you are implementing the etched skin

Read `handoff/README.md` first. Two rules the design depends on, which are easy to get wrong:

- **Caps label a field; they never carry a sentence.** A paragraph in letterspaced caps is
  unreadable, and it turns `sshAllowedCidr` into `SSHALLOWEDCIDR`.
- **A level needs its ceiling named beside it.** `Waterline` belongs on the spend cap and
  nowhere else. `Tally` exists because uptime has no ceiling and cannot honestly be a gauge.

And one rule about the codebase: **never edit `packages/web/src/App.css`.** The skin is an
additive attribute scope, and that property is what makes it safe to merge alongside other work.

## Note on the component source

Every `.jsx`, `.js`, `.d.ts` and `.html` file carries a `.txt` suffix (`Button.jsx.txt`,
`H-etched-screens.html.txt`) so that dropping this skill into a repo cannot make a build compile
it or a tool treat it as a page. Read them as ordinary source; strip the suffix to run or open
one. Relative paths inside them are unchanged, so a card or screen works as soon as it is
renamed back.

They are the design system's own build — plain React against CSS custom properties — and are
reference, not a package to import. For `packages/web`, the ported and typed versions are in
`handoff/etched.tsx.txt`.
