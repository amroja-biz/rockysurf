# Changelog

All notable changes to Rocky Surf are recorded here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers follow the rules
in [`docs/RELEASE_SOP.md`](docs/RELEASE_SOP.md). Every package under `packages/` carries the same
number, so one entry covers the whole release. The GitHub release for each version carries the
longer notes.

## [0.1.5] - 2026-09-12

### Added

- **herdr on every box.** [herdr](https://herdr.dev) is a terminal workspace for coding agents:
  sessions live in a background server on the box, survive a dropped SSH connection, and each
  agent pane shows working, blocked or idle. It is now part of the base toolchain that every Surge
  Pack installs, pinned to a tagged release and checked against the vendor's digests. tmux stays
  alongside it. (#498, #503)
- **A herdr integration for each agent that has one.** Claude Code, Codex, OpenCode, Grok Build,
  Cursor CLI, OMP and Pi each get a `herdr-<agent>-integration` Tool that wires the agent's status
  into herdr's pane list. Amp has no target in herdr 0.9.0 and gets herdr alone. (#498, #503)
- **The Kitchen Sink Surge Pack.** One box carrying every shipped terminal agent, herdr, and every
  integration, for the case of one server with several agents managed from one herdr window.
  Twelve packs now ship in the box. (#498, #503, #504)
- **The `herdr machine add` line, ready to copy.** Once a Server is running and its pack carries
  herdr, the Server page shows `herdr machine add rocky@<ip> --label <name>` with a note about
  the SSH key, and the HTTP API and MCP server return the same string, so an agent that created a
  Server can hand you the attach command. (#500, #501)
- **A Herdr section in every pack guide**, covering reattaching on the box and attaching the box
  from your own machine. (#498, #503)
- **This changelog.**

### Changed

- **The shared base toolchain has its own file.** The fourteen Tools every pack references
  (build-essential, curl, gh, git, tmux, nodejs, playwright, beads and the rest) moved from
  `packs/claude-code.yaml` to `packs/base.yaml`, a Tool file with no pack of its own. A syntax
  error in the Claude Code pack no longer empties the pack picker, and a community pack author no
  longer sees curl defined under "Claude Code". No pack's install plan changed. (#499, #502)

## [0.1.4] - 2026-09-10

### Changed

- hono 4.13.1 to 4.13.5, picking up two upstream security fixes. (#492)
- Both READMEs document `--port` and name the cloud CLIs as prerequisites. (#496)

## [0.1.3] - 2026-09-10

### Changed

- The npm page's homepage is rockysurf.com; the npm README is shorter and leads with the web
  app. (#493)

## [0.1.2] - 2026-09-10

### Added

- A Personal tab under Surge Pack on the New Server page, for packs you uploaded or wrote
  yourself.

### Changed

- The README opening was rewritten from rockysurf.com; the backup section says what a backup
  holds.

## [0.1.1] - 2026-09-08

### Added

- The setup wizard sets each cloud up in place, checks the credentials, and has Back on every
  step. "Use my current IP" on the SSH allow-list field. Region and zone fields validate as you
  type.

### Fixed

- `npx -y rockysurf` on Node 20 or 22 now says Node 24 is required instead of failing with
  "could not determine executable to run".

### Changed

- Providers are named by the account you sign in to: AWS, Azure, Google Cloud, Hetzner Cloud,
  DigitalOcean.

## [0.1.0] - 2026-09-08

First public release. Create a Server on Hetzner Cloud, AWS, Azure or Google Cloud, install a
Surge Pack on it, and SSH in; a web app on `127.0.0.1`, an HTTP API, a CLI and an MCP server;
stop and start without losing your work; GitHub repository cloning; Personal Providers; a Shop;
backup and restore. The [v0.1.0 release notes](https://github.com/amroja-biz/rockysurf/releases/tag/v0.1.0)
carry the full feature list, the Provider capability matrix and the security posture.

[0.1.5]: https://github.com/amroja-biz/rockysurf/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/amroja-biz/rockysurf/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/amroja-biz/rockysurf/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/amroja-biz/rockysurf/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/amroja-biz/rockysurf/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/amroja-biz/rockysurf/releases/tag/v0.1.0
