---
KEY: playwright-installs-into-home
DATE: 2026-09-23
UPDATED: 2026-09-23
STATUS: active
SOURCE: issue #521
---

The base pack installs Playwright into rocky's home directory on purpose. Leave it there.

The `playwright` Tool in `packs/base.yaml` (runAs: rocky, installOrder 30) does `cd "$HOME"` before `npm install -D @playwright/test`. That drops `node_modules/`, `package.json` and `package-lock.json` into `/home/rocky`, next to the repos the box clones there. Issue #521 flagged the files as confusing and asked whether they were intentional. They are.

Repos are cloned as siblings under `/home/rocky`. Node resolves a bare `import '@playwright/test'` by walking up the directory tree for a `node_modules` that contains it, so the copy at `/home/rocky/node_modules` is inherited by every repo under `/home/rocky` that does not declare `@playwright/test` itself. That inheritance is the point of provisioning Playwright on the box: an agent can test the app the user is building without that app having to depend on Playwright. Relocating the install off that path (for example into `~/.rockysurf/playwright`) removes the inheritance, so such a repo would instead fetch the package via `npx` on first run.

Only the small `@playwright/test` JS package is subject to that directory walk. The expensive artifacts are found globally and are unaffected by where the package lives: the system libraries (`playwright-deps`, runAs root) are installed system-wide, and the Chromium browser is cached in `~/.cache/ms-playwright` and resolved by version. So the home-directory files are not clutter to remove; they are what makes the base Playwright install usable from the user's own repos.
