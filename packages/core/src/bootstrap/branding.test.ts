import { describe, expect, it } from 'vitest'
import { ROCKY_SURF_LOGO, ROCKY_SURF_URL, brandingScript } from './branding.js'

/**
 * The banner is the one bootstrap output a human reads, and every way it can break is silent:
 * a swallowed backslash still writes a file, a non-ASCII byte still renders somewhere, a
 * too-wide line still fits on the author's terminal. So the bytes are pinned here rather than
 * left to a reviewer's eye.
 *
 * This literal is an independent copy of the art — if it and `branding.ts` ever disagree, one
 * of them was retyped, which is exactly the failure the copy exists to catch.
 */
const LOGO_AS_ATTACHED = [
  '    ____             __            _____             ____',
  '   / __ \\____  _____/ /____  __   / ___/__  ______  / __/',
  '  / /_/ / __ \\/ ___/ //_/ / / /   \\__ \\/ / / / ___/ /_/',
  ' / _, _/ /_/ / /__/ ,< / /_/ /   ___/ / /_/ / /  / __/',
  '/_/ |_|\\____/\\___/_/|_|\\__, /   /____/\\__,_/_/  /_/',
  '                      /____/',
].join('\n')

describe('the Rocky Surf logo', () => {
  it('is byte-identical to the art as attached to the issue', () => {
    expect(ROCKY_SURF_LOGO).toBe(LOGO_AS_ATTACHED)
  })

  it('is pure 7-bit ASCII, so no locale or font can mangle it', () => {
    const offending = [...ROCKY_SURF_LOGO].filter((c) => c.codePointAt(0)! > 0x7e)
    expect(offending).toEqual([])
  })

  it('fits an 80-column terminal, with room to spare', () => {
    const widths = ROCKY_SURF_LOGO.split('\n').map((line) => line.length)
    // The measured widths of the six art lines. A width that changed means the art changed.
    expect(widths).toEqual([57, 57, 55, 54, 51, 28])
    expect(Math.max(...widths)).toBeLessThanOrEqual(80)
  })

  it('carries no trailing whitespace, which a terminal renders as a ragged right edge', () => {
    expect(ROCKY_SURF_LOGO.split('\n').filter((line) => /\s$/.test(line))).toEqual([])
  })
})

describe('brandingScript', () => {
  const script = brandingScript('srv-123')

  it('writes the logo and the project URL to /etc/motd', () => {
    const lines = ROCKY_SURF_LOGO.split('\n')
    expect(script).toContain(lines[0])
    expect(script).toContain(lines.at(-1))
    expect(script).toContain('https://github.com/amroja-biz/rockysurf')
    expect(ROCKY_SURF_URL).toBe('https://github.com/amroja-biz/rockysurf')
    expect(script).toContain('> /etc/motd')
  })

  it('delivers the banner through a quoted heredoc, so a backslash cannot be eaten', () => {
    // `<<'DELIM'` and not `<<DELIM`: in an unquoted heredoc the shell would interpret the art.
    expect(script).toMatch(/<<'[A-Z_]+'\n/)
    // The exact backslash run from art line 2. If quoting regresses, this is the byte that goes
    // missing first — and the logo ships with holes in it rather than failing anything.
    expect(script).toContain('\\____')
  })

  it('still names this server in /etc/rockysurf/server-info, shell-quoted', () => {
    expect(script).toContain("printf 'serverId=%s\\n' 'srv-123' > /etc/rockysurf/server-info")
    expect(brandingScript("srv'; rm -rf /; '")).toContain(
      `printf 'serverId=%s\\n' 'srv'\\''; rm -rf /; '\\''' > /etc/rockysurf/server-info`,
    )
  })

  it('quiets Ubuntu’s advertising by name, and leaves the box-state scripts alone', () => {
    for (const noise of [
      '00-header',
      '10-help-text',
      '50-motd-news',
      '50-landscape-sysinfo',
      '85-fwupd',
      '88-esm-announce',
      '91-contract-ua-esm-status',
      '91-release-upgrade',
      '95-hwe-eol',
    ]) {
      expect(script).toContain(noise)
    }
    // Never a blanket glob: 90-updates-available and friends report a condition of THIS box.
    expect(script).not.toMatch(/chmod -x [^\n]*update-motd\.d\/\*/)
    expect(script).not.toContain('90-updates-available')
    expect(script).not.toContain('98-reboot-required')
    // `rm` would strand an operator who wants one back, and would not converge as a re-run.
    expect(script).not.toMatch(/\brm\b/)
    expect(script).toContain('chmod -x')
  })

  it('is the shape agent.sh requires: strict, guarded, and never reaching for sudo', () => {
    expect(script.startsWith('set -euo pipefail\n')).toBe(true)
    // The step already declares runAs: 'root' and the agent dispatches the privilege. A
    // container has no sudo, and byo-host.mjs is a container.
    expect(script).not.toContain('sudo')
    // `if [ -f … ]` rather than `[ -f … ] &&`, which under `set -e` exits on the first absent
    // file — i.e. on every non-Ubuntu box, where none of them exist.
    expect(script).toContain('if [ -f "/etc/update-motd.d/$motd_script" ]; then')
    expect(script).not.toMatch(/\[ -f [^\n]*\] &&/)
  })

  it('renders deterministically, because a plan must render identically twice', () => {
    expect(brandingScript('srv-123')).toBe(script)
  })
})
