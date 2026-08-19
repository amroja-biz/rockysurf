import { shellQuote } from './shell.js'

/**
 * The welcome screen an SSH session lands on — phase 5 of the install plan.
 *
 * It lives here rather than in `resolver.ts` because the resolver's job is step ORDER; this is
 * banner text, and it is the one step whose whole output is read by a human.
 *
 * Two properties are load-bearing and both are pinned by `branding.test.ts`:
 *
 * 1. THE LOGO'S BYTES. It is figlet "slant", pure 7-bit ASCII, widest line 57 columns — so no
 *    locale, font or 80-column terminal can mangle it. Every backslash in the art is a
 *    backslash in the file, which is why the banner is delivered through a QUOTED heredoc
 *    (`<<'…'`): in an unquoted one `\_` becomes `_` and the logo silently loses its edges.
 * 2. IT CONVERGES. `agent.sh` re-runs any step not journalled `done`, so a second run must
 *    leave `/etc/motd` byte-identical. Hence a whole-file `>` write, `chmod -x` rather than
 *    `rm`, and no appends that are not preceded by a truncation in the same script.
 *
 * The name and the logo are NOT covered by the MIT licence (`TRADEMARK.md`), which is why
 * `branding: false` omits this step entirely — a rebranded fork needs that switch to work.
 */

/** Where the banner points. The one URL issue #33 asks the box to show. */
export const ROCKY_SURF_URL = 'https://github.com/amroja-biz/rockysurf'

/**
 * The six art lines, verbatim from the logo the hosted build shipped. Copied byte for byte:
 * retyping this is how a `\` goes missing. Line widths are 57/57/55/54/51/28.
 */
export const ROCKY_SURF_LOGO = [
  '    ____             __            _____             ____',
  '   / __ \\____  _____/ /____  __   / ___/__  ______  / __/',
  '  / /_/ / __ \\/ ___/ //_/ / / /   \\__ \\/ / / / ___/ /_/',
  ' / _, _/ /_/ / /__/ ,< / /_/ /   ___/ / /_/ / /  / __/',
  '/_/ |_|\\____/\\___/_/|_|\\__, /   /____/\\__,_/_/  /_/',
  '                      /____/',
].join('\n')

/** Quoted, so nothing in the art is ever interpreted by the shell that writes it. */
const MOTD_HEREDOC = 'ROCKYSURF_MOTD'

/**
 * Ubuntu's stock MOTD scripts, disabled BY NAME.
 *
 * Never a blanket `chmod -x /etc/update-motd.d/*`: several of the ones left alone
 * (`90-updates-available`, `92-unattended-upgrades`, `98-reboot-required`, `98-fsck-at-reboot`)
 * report a condition of this actual machine, and silencing those is a real loss. These nine
 * are advertising, duplicated by the banner, or — in `50-motd-news`'s case — a network call
 * made while somebody waits for their prompt.
 */
const UBUNTU_MOTD_NOISE = [
  '00-header', // "Welcome to Ubuntu …" — the line the logo replaces
  '10-help-text',
  '50-motd-news', // fetches over the network at login
  '50-landscape-sysinfo', // the load/disk block, and it is slow
  '85-fwupd',
  '88-esm-announce',
  '91-contract-ua-esm-status',
  '91-release-upgrade',
  '95-hwe-eol',
]

/**
 * Whole-file writes, so a re-run converges rather than appending.
 *
 * The banner goes to the static `/etc/motd` and NOT to a new `/etc/update-motd.d` generator:
 * Ubuntu's PAM stack prints both (one `pam_motd` runs run-parts into `/run/motd.dynamic`, the
 * next prints `/etc/motd` afterwards), so owning both files would double-print. `/etc/motd`
 * also prints last — immediately above the prompt — and it is the half that still shows on a
 * box with no `update-motd.d` at all, which is every container and every non-Ubuntu host.
 */
export function brandingScript(serverId: string): string {
  return [
    'set -euo pipefail',
    // The whole banner through a quoted heredoc: not one backslash of the art is interpreted.
    `cat > /etc/motd <<'${MOTD_HEREDOC}'`,
    '',
    ROCKY_SURF_LOGO,
    '',
    `  ${ROCKY_SURF_URL}`,
    MOTD_HEREDOC,
    // The server id is data from outside, so it is quoted rather than pasted into the heredoc.
    // `>>` is safe to converge on because the `>` above truncated the file in this same run.
    `printf '  server %s\\n\\n' ${shellQuote(serverId)} >> /etc/motd`,
    'install -d -m 0755 /etc/rockysurf',
    `printf 'serverId=%s\\n' ${shellQuote(serverId)} > /etc/rockysurf/server-info`,
    // `chmod -x`, not `rm`: an operator can put any of these back, and a second run is a no-op.
    // The `if` guard rather than `&&` is what keeps a missing file from tripping `set -e` on a
    // non-Ubuntu box, where none of them exist.
    `for motd_script in ${UBUNTU_MOTD_NOISE.join(' ')}; do`,
    '  if [ -f "/etc/update-motd.d/$motd_script" ]; then',
    '    chmod -x "/etc/update-motd.d/$motd_script"',
    '  fi',
    'done',
    '',
  ].join('\n')
}
