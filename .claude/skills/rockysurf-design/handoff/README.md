# Implementing the etched skin in `packages/web`

Two new files, two one-line edits, and nothing existing is rewritten.

| File | What it is |
|---|---|
| `etched.css` | The whole skin. Every rule is scoped under `[data-rs-skin='etched']`. |
| `etched.tsx.txt` | The nine etched parts, typed, reading `Server` and `lib/format` from your tree. Parked as `.txt` so this project's compiler leaves it alone — the copy below renames it. |

```
cp handoff/etched.css       packages/web/src/etched.css
cp handoff/etched.tsx.txt   packages/web/src/components/etched.tsx
```

Then two lines:

```diff
  // packages/web/src/App.tsx
  import './App.css'
+ import './etched.css'      // must come after App.css
```

```diff
  <!-- packages/web/index.html -->
- <html lang="en">
+ <html lang="en" data-rs-skin="etched">
```

That is the entire switch. **Remove the attribute and the app is byte-for-byte what it is
today.** Remove the import and the skin is gone.

## Why this cannot overwrite anyone's work

The repository moved while this was being designed, so the design was built to not care.

- **`App.css` is never edited.** The skin re-declares the *same token names* App.css already
  owns — `--rs-bg`, `--rs-surface`, `--rs-heading`, `--rs-link` — under an attribute selector.
  Anything that reads a token follows the skin for free, including components written after
  this was designed.
- **No component file is replaced.** `etched.tsx` adds nine new exports. `StatusBadge`,
  `ProvisioningFeed` and the rest stay exactly as they are, and keep working, until someone
  changes a call site on purpose.
- **Merge conflicts are structurally impossible** on the two new files, and are one line each
  on `App.tsx` and `index.html`.

The one thing to check before merging: whether `--rs-*` are still the token names in
`App.css`. If a refactor renamed them, update the block at the top of `etched.css` and nothing
else.

## What changed upstream since the design was read

Read at tree `1eb29bfed693` (2026-08-26 12:17Z); re-checked at `e5094d70a75e` (18:40Z). In
those six hours:

- `App.css` grew 51 KB → 63.9 KB
- **New components**: `ProviderErrorNotice`, `StaleServersNotice`, `Tabs.tsx`
- **New lib**: `serverActions.ts`, `format.test.ts`, and `format.ts` grew 5.7 KB → 7.6 KB
- **Substantially grown pages**: `HelpPage` 22→38 KB, `SettingsPage` 61→78 KB, `DashboardPage`
  12→20 KB, `ServerDetailPage` 31→37 KB, `CreateServerPage` 67→75 KB
- **New classes** the design system has not seen: `.tier-preference`,
  `.provider-group-heading`, `.provider-group-count`, `.server-card-error`,
  `.machine-picker-filter`, `.provider-error-*`, `.stale-servers-notice-*`,
  `.historical-notice`, `.settings-layout`, `.settings-nav`, `.settings-panels`,
  `.settings-panel`, `.tab-marker`

`etched.css` already covers the ones with an obvious reading — `.stale-servers-notice` and
`.historical-notice` as yellow advisories, `.server-card-error` as a red one,
`.provider-group-heading` as a cut label, `.settings-panel` as a lit surface. The rest inherit
the palette through tokens and will look correct without a rule.

**The recreation in `ui_kits/rockysurf-app/` is now behind by these changes.** It documents the
app as of 12:17Z. Treat it as a reference for the design language, not as a current spec.

## Rolling it out

The skin alone gets you most of the way — palette, illumination, squared corners, cut labels,
outline buttons — with no component changes at all. The etched parts are then adopted one call
site at a time, in this order:

1. **`<EtchedDefs />` into `AppShell`**, once, above `<main>`. Nothing renders differently; the
   hatch patterns simply become available.
2. **`Lamp` for `StatusBadge`** in `DashboardPage` and `ServerDetailPage`. It keeps
   `data-status` and `data-transition`, so anything reading the DOM is unaffected.
3. **`Beacon` for the `.step-list` rail** in `ProvisioningFeed` and `ServerDetailPage`'s
   `ProvisioningTimeline`. It reads `STEP_ORDER` and `STEP_LABELS` from `lib/format` rather
   than carrying a third copy, and it still emits `.step`/`.step-<state>`/`data-state`.
4. **`Tally` beside the uptime value** on the card and the detail page. Beside, never instead
   of — see the note below.
5. **`Moon` + `Waterline` on the spend cap** in `CostsPage` / `SpendCapBanner`. These two
   hardcode `#f85149` / `#d29922` / `#3fb950` inline, so they need a real edit to follow the
   skin at all; doing that work and adopting the moon are the same change.
6. **`Shore` for `.empty`**, `Swell` for the dividers, `Plate` for `.server-card`'s frame —
   cosmetic, last, and each independently revertable.

## Two rules the design depends on

**Caps label a field; they never carry a sentence.** A paragraph in letterspaced caps is
unreadable, and it turns `sshAllowedCidr` into `SSHALLOWEDCIDR`. `etched.css` explicitly opts
`.field-help`, `.size-detail`, `.hint`, `.muted`, `.price-note` and `.provider-error-detail`
back out. Any new prose class needs adding to that list.

**A level needs its ceiling named beside it.** `Waterline` belongs on the spend cap and nowhere
else; `Tally` exists because uptime has no ceiling and therefore cannot honestly be drawn as a
gauge. If either shows up on a value without a stated maximum, it is decoration.

## Tests that will need updating

Not broken by the CSS — only by adopting the parts:

- `Lamp` renders its own label. Assertions on `StatusBadge`'s text still pass (`Running`,
  `Stopping…` are unchanged), but anything matching the `.status-badge` *class* will need
  `.lamp` added.
- `Beacon` keeps `.step`, `.step-<state>` and `data-state`, so `navbar.test.tsx` and the
  wiring tests should be unaffected. Verify rather than assume.
- Nothing in `etched.css` changes markup, so no snapshot should move while the attribute is
  absent — which is a good CI guard: run the suite once with the attribute off to prove the
  skin is inert.

## Brief for a coding agent

Copy this into the agent working in `rockysurf`. It is deliberately one PR — the skin only,
no component changes — because that PR is provably inert and reviewable in a minute.

> Add the etched skin to `packages/web`. The design lives in the Rocky Surf design system;
> `handoff/README.md` there has the full rationale.
>
> 1. Copy `handoff/etched.css` to `packages/web/src/etched.css`, unchanged.
> 2. Import it in `src/App.tsx` immediately after `import './App.css'`.
> 3. Add `data-rs-skin="etched"` to `<html>` in `packages/web/index.html`.
>
> Do not edit `App.css`. Do not edit any component. If a colour looks wrong, the fix is a rule
> in `etched.css` or moving a hardcoded hex onto an existing `--rs-*` token — never a change to
> `App.css`, which this skin promises not to touch.
>
> Before opening the PR, run the test suite **with the attribute removed** and confirm nothing
> changed. The skin must be inert when off; if a test moves, the skin is leaking.
>
> Known: `CostsPage` and `SpendCapBanner` hardcode `#f85149` / `#d29922` / `#3fb950` inline and
> will stay GitHub-dark on a night ground. Leave them for the follow-up; note it in the PR.

Then, one PR per part, in this order — each independently revertable:

> Adopt `<Lamp>` from `src/components/etched.tsx` in place of `<StatusBadge>` in
> `DashboardPage` and `ServerDetailPage`. Mount `<EtchedDefs />` once in `AppShell`, above
> `<main>`. `Lamp` keeps `data-status` and `data-transition`, so DOM-reading tests should pass
> unchanged; anything matching the `.status-badge` class needs `.lamp` added.

…then `Beacon` for the step rail, `Tally` beside uptime, `Moon` + `Waterline` on the spend cap,
and `Shore` / `Swell` / `Plate` last. The rollout section above has the reasoning for the order.

**Point the agent at the design system, not just at the diff.** `SKILL.md` at the root of this
project is Agent Skills-compatible: dropped into `.claude/skills/`, it gives an agent the
palette, the type and spacing scales, the assets, the tone-of-voice rules, and the prompt notes
on every component — including the two rules the etched design depends on (caps never carry a
sentence; a level needs its ceiling named). An agent with the skill loaded will make judgement
calls that match; one working from the CSS alone will not.

## Where the design lives

- `components/etched/` — the nine parts with their props contracts and usage notes
- `tokens/etched.css`, `css/etched.css` — the skin as the design system states it
- `ui_kits/explorations/G-etched-parts.html` — the dashboard built from the parts
- `ui_kits/explorations/H-etched-screens.html` — the create form and server detail
- `readme.md` § *The etched skin* — what each mark replaces and why
