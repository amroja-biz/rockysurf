# Desktops, daemons, and the login session that does not exist

Read this only if your pack ships a graphical desktop, or installs something that is supposed to
keep running after the install finishes. A headless pack of CLIs needs none of it.

The whole subject reduces to one fact: **the bootstrap agent drops privilege without a PAM
session.** `rocky` never logs in. There is no user systemd instance, no `$XDG_RUNTIME_DIR`, no
per-user D-Bus — and this is true on a real cloud box, not only in the smoke container. Anything
that expects a logged-in user has to be given one deliberately.

## A desktop

Set `desktop: xfce` on the pack, and almost certainly `requiresRdp: true` so Rocky Surf asks the
user for a remote-desktop password at create time and delivers it as `$RDP_PASSWORD`. Do not
special-case your `packId` in the application — these fields exist so a pack describes itself.

`packs/open-claw.yaml` is the worked example, and its `desktop-environment` tool at
`installOrder: 35` is the one to copy. Three things in it are load-bearing:

- **Whole-file writes with a `changed` flag.** Session config files (`.xsession`,
  `/etc/xrdp/startwm.sh`) are written only when their content would differ, and `xrdp` is
  restarted only if something actually changed. Restarting it unconditionally on a resumed
  install would drop every live desktop session — precisely the visible side effect the harness's
  second run exists to catch.
- **`install -d -o rocky -g rocky`** for anything under `/home/rocky` written by a root step. A
  root-owned file in the user's home is a file they cannot edit.
- **The systemd guard**, because the smoke container has no init:
  `if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then …`

The RDP password goes in on stdin, never in `argv`, because everything in `argv` is readable
through `ps` by every other unprivileged step on the box:

```bash
printf 'rocky:%s\n' "$RDP_PASSWORD" | chpasswd
```

Guard it first — `$RDP_PASSWORD` is absent rather than empty when the pack does not ask for one,
and an empty value would pass a naive check and then set an empty desktop password.

## A user service, and lingering

`systemctl --user` cannot work at bootstrap for the reason above. systemd's own answer is
**lingering**: it starts `user@<uid>.service` without a session, at boot, and keeps it running
after the user logs out — which is exactly the lifetime a background assistant wants.

Enabling linger for another user is root's job, so this is two tools, or the two halves of one
tool at different `installOrder` values.

```bash
# runAs: root, the lower installOrder
if [ -d /run/systemd/system ] && command -v loginctl >/dev/null 2>&1; then
  uid=$(id -u rocky)
  if loginctl enable-linger rocky; then
    # logind starts the user manager asynchronously; wait for its bus rather than racing it.
    for _ in $(seq 1 30); do
      [ -S "/run/user/$uid/bus" ] && break
      sleep 1
    done
  fi
  [ -S "/run/user/$uid/bus" ] ||
    echo "warning: no user bus at /run/user/$uid/bus; the service will not install" >&2
else
  echo "no systemd here: skipping loginctl enable-linger"
fi
```

```bash
# runAs: rocky, the higher installOrder
if [ -d /run/systemd/system ] && [ -S "/run/user/$(id -u)/bus" ]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
  mytool install-daemon && mode=service || mode=manual
else
  mode=manual
fi
```

Note the chicken-and-egg this resolves: tools that would run `loginctl enable-linger` themselves
typically do it only *after* deciding user services are available, which is the very thing that
cannot be true until linger has run. Root breaks the cycle, and after that the tool's own
machinery works unmodified.

Two details worth checking by reading the installed package rather than guessing: **what the unit
is actually called** (a guide naming `mytool.service` when the installer writes
`mytool-gateway.service` ships three commands that all answer "Unit could not be found"), and
whether the tool infers the session variables itself. The exports above are usually for *your*
script's benefit — a bare `systemctl --user` you run — rather than the tool's.

## Nothing here is fatal

This is the part most likely to be got wrong. **A daemon that will not install is not worth
failing the box for.** No systemd, an unreachable logind, a bus that never appears, an
`--install-daemon` that exits non-zero: each should fall back to an installed-but-not-running
tool, with a warning in the step log. The steps after yours may include the desktop the user
would need in order to fix it, and failing to insist on a daemon leaves them with nothing.

## Tell the box's own story

Record which branch happened, in a stamp that holds the **outcome** rather than merely existing:

```bash
stamp="$HOME/.rockysurf/mytool-onboarded"
mode=$([ -f "$stamp" ] && cat "$stamp" || true)
case "$mode" in service | manual) ;; *) mode='' ;; esac
# … do the work, set mode=service|manual …
mkdir -p "$(dirname "$stamp")" && printf '%s\n' "$mode" > "$stamp"
```

On a resumed run the work is skipped and this file is the only witness left to what actually
happened. Read it back when writing any on-box note, and write that note as a whole file so it
cannot accumulate duplicates. Then make the pack's `guide` cover **both** states — "on a box where
the service could not be installed, the note on the desktop says so, and tells you to run … " —
so the user is told the truth about their particular box rather than a hopeful default.

## The smoke harness cannot prove any of this

The container has no init, so the systemd branch is never the branch CI takes: what CI proves is
that your guards *fall back* correctly. Everything above about lingering and user services is
exercised only on a real box. Say so when you report — an untested branch described as verified
is the failure this whole document exists to prevent.
