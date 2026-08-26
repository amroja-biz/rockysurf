---
KEY: launchers-hand-the-agent-less-than-a-shell-does
DATE: 2026-08-26
UPDATED: 2026-08-26
STATUS: active
SOURCE: issue #158, the owner's first two personal packs
---

# The systemd launcher hands the agent less than any shell does — and the harnesses all use a shell

`docs/writing-a-pack.md` promises every step `$HOME`. Unprivileged steps get it explicitly
(`sudo -u rocky -H`); root steps inherit the bootstrap agent's own environment. On a real box
that environment comes from `systemd-run --unit=rockysurf-bootstrap` with no `User=`, and
systemd sets `HOME`, `USER` and `LOGNAME` **only** for units that have `User=`. So every root
step on every real box ran without `HOME` from the first release until 2026-08-26, and nothing
noticed, because no shipped root step reads it — the shipped packs keep root's work in
`/usr/local` and `/etc`, and everything under `$HOME` is `rocky`'s by rule 4.

The first personal pack that piped an upstream installer to `bash` as root found it in a
second: the installer opened with `set -euo pipefail` and its first expansion was
`${HEADLONG_HOME:-$HOME/.headlong}`. `bash: line 32: HOME: unbound variable`, rc=1, box
terminated, after every shipped tool had installed cleanly for ten minutes.

Why no harness caught it: `docker exec`, `docker run` and a `nohup` shell all carry a `HOME`.
The pack smoke harness, the agent smoke and the push smoke are all richer than the launcher
they stand in for. A harness has to be told what the real launcher *withholds*, not just what
it provides — the smoke harness now starts the agent with `env -u HOME -u USER -u LOGNAME`, and
a unit test runs `agent.sh` with `PATH` and the state directory and nothing else.

The rule that generalises: when a harness substitutes one launcher for another (a shell for
systemd, a container for a VM, `runuser` for `sudo`), enumerate the environment the real one
provides and strip everything else in the harness. The agent, not the launcher, establishes
what the pack contract promises — a `--setenv=HOME=` on the `systemd-run` line would have
fixed one launcher and left the contract unstated for the other.

Aside from the same day: the owner's other personal pack failed for an unrelated reason — the
upstream installer it piped to `bash` hardcodes a `ubuntu` user and died in its own "Installing
SRPS" phase — and the failure report called it an apt error ("apt reported ║ INSTALLATION FAILED ║")
because `failure-report.ts` classifies any step log that mentions `apt-get` or `dpkg` as apt,
and a third-party installer runs both. Piped installers as root are the common thread; the
docs already say neither version rule licenses one.
