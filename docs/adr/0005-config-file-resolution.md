# ADR-0005: The config file's home, and the order it is found in

## Status

Accepted — 2026-08-13. Implemented by `rockysurf-8wgm` (the resolution) and hardened by
`rockysurf-96ce` (what a boot without a pack source may not do); the settings editor
(`rockysurf-m29b`) writes whichever file was loaded.

## Context

The config file (`rockysurf.config.yaml`) started life as "whatever is in the working
directory", which was fine when the only way to run Rocky Surf was from a checkout. Three
things broke that assumption. The `npx` path has no checkout, so a cwd-based config means the
app behaves differently depending on which directory it was launched from — and a first-run
save would litter a config file into a directory that just happens to be someone's cwd, where
it silently becomes the config for the next person to `cd` there. The Settings page needs a
deterministic answer to "which file do I write" — including on an install where no file exists
yet. And the operator ruling that settled it: configuration does not live inside a code
checkout. A worktree is disposable and gets rebuilt, deleted, and recreated; a credential
reference sitting inside one is in the blast radius of every one of those operations.

The data directory already defaults to `~/.rockysurf`. The config's durable home should sit
beside the data it describes — but it cannot be *derived from* the data directory setting,
because the config is what defines that setting. A path that depends on a value inside the
file it locates is a circle.

## Decision

Resolution is three tiers, first match wins, and the boot notice names which one loaded:

1. **`--config <path>`** (or the programmatic equivalent) — explicit, and fatal if absent.
   Naming a file that is not there is an error, never a silent fallback (`rockysurf-cf51`).
2. **`./rockysurf.config.yaml`** — the working directory, *if the file exists*. This tier
   exists for checkout development and for running several instances out of several
   directories. It is a workflow tier, not the home.
3. **`~/.rockysurf/config.yaml`** — the durable home. A literal path from the OS home
   directory, deliberately independent of `server.dataDir` (no circularity, enforced by a test
   that points `dataDir` elsewhere and asserts the home file still loads).

No file anywhere: the app starts on defaults with the in-memory provider, and says so, listing
both paths it looked at. A first save from the Settings page **creates the home file** — never
a cwd file. The Settings page always writes the file that was loaded, which it can do because
boot resolves once and hands the answer to everything downstream; there are not two resolvers
to disagree.

## Consequences

- Existing checkout setups keep working untouched: a cwd file beats a home file, so nothing
  migrates by surprise. Migration is a choice — move the file, and the next boot says
  `config: ~/.rockysurf/config.yaml`.
- The one-line boot notice (`config: <path>`) is load-bearing. With three candidate locations,
  "it started" no longer implies "it read the file I just edited"; the notice is what makes
  that debuggable in one glance.
- A boot from an arbitrary directory is now *normal*, not an accident — which is why the pack
  sync had to learn that "I found no pack source" means *leave the database alone*, not
  "delete everything file-backed" (`rockysurf-96ce`). Any other subsystem that treats
  "not found where I looked" as "gone" inherits the same obligation.
- Credential references (`${VAR}`) in the home file are read from the environment of whatever
  shell starts the process, wherever that is. The file may legitimately be *ahead* of the
  environment — a reference saved before its variable is exported fails the *next boot* with a
  message naming the variable, and the Settings page warns at save time rather than refusing
  (`rockysurf-1z5q`).

## Rejected

- **cwd-only** (the status quo): breaks `npx`, litters first-run saves, and puts config inside
  disposable checkouts.
- **Home-only**: breaks the run-two-instances-from-two-directories workflow and forces every
  test and script through `--config`.
- **Deriving the home from `dataDir`**: circular, see Context.
- **An environment variable for the config path** (`ROCKYSURF_CONFIG`): a fourth tier nobody
  asked for; `--config` already serves the explicit case and appears in `ps`, where an
  operator can see it.
