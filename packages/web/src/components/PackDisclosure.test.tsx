import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PackDisclosurePanel } from './PackDisclosure'
import type { PackDisclosure, RegistryPackDetail, ToolDisclosure } from '../lib/api'

/**
 * The disclosure panel, which is the security control rather than a modal that happens to be
 * near one.
 *
 * Every test here defends a property that would otherwise be quietly removable by someone
 * tidying the component: scripts rendered as text and not markup, the incompleteness caveat
 * present, root steps visible, and the install control reachable only from here. None of those
 * would fail a typecheck or look wrong in a screenshot if they regressed.
 */

const tool = (over: Partial<ToolDisclosure> = {}): ToolDisclosure => ({
  toolId: 'rustup',
  name: 'rustup',
  description: 'The Rust toolchain installer',
  url: 'https://rustup.rs',
  runAs: 'root',
  installOrder: 30,
  installScript: 'curl -fsSL https://sh.rustup.rs | sh\n',
  fetchesUrls: ['https://sh.rustup.rs'],
  ...over,
})

const disclosure = (over: Partial<PackDisclosure> = {}): PackDisclosure => ({
  packId: 'rust-dev',
  name: 'Rust Dev',
  tools: [tool()],
  referencesTools: [],
  rootStepCount: 1,
  fetchesUrls: ['https://sh.rustup.rs'],
  requiresRepos: false,
  requiresRdp: false,
  summaryIsComplete: false,
  ...over,
})

const detail = (over: Partial<PackDisclosure> = {}): RegistryPackDetail => ({
  entry: {
    packId: 'rust-dev',
    name: 'Rust Dev',
    description: 'Installs 1 tool(s): rustup',
    path: 'packs/rust-dev.yaml',
    sha256: 'ab'.repeat(32),
    definesTools: ['rustup'],
    referencesTools: [],
    requiresRepos: false,
    requiresRdp: false,
    sourceName: 'Rocky Surf Pack Shop',
    trust: 'community',
    installed: false,
  },
  yaml: 'version: 1\n',
  disclosure: disclosure(over),
})

const show = (over: Partial<PackDisclosure> = {}) =>
  render(
    <PackDisclosurePanel
      detail={detail(over)}
      installing={false}
      onCancel={vi.fn()}
      onInstall={vi.fn()}
    />,
  )

describe('the scripts are the point', () => {
  it('renders every install script verbatim', () => {
    const script = 'set -euo pipefail\n\n  curl   https://x.example/y   |  sh\n'
    show({ tools: [tool({ installScript: script })] })
    // Byte for byte: a panel that reformatted the script would be showing something other than
    // what will run.
    expect(screen.getByTestId('disclosure-tool-rustup').querySelector('pre')?.textContent).toBe(script)
  })

  it('renders a setup script too, and says when it runs', () => {
    show({ tools: [tool({ setupScript: 'echo setting up\n' })] })
    const block = screen.getByTestId('disclosure-tool-rustup')
    expect(block.textContent).toContain('echo setting up')
    expect(block.textContent).toContain('after any repositories are cloned')
  })

  it('renders script content as TEXT, never as markup', () => {
    // The rule this file exists to keep. A pack is somebody else's shell, fetched over the
    // network; the moment any of it reaches innerHTML this stops being a disclosure and becomes
    // an injection surface. React escapes by default, so the way this regresses is somebody
    // reaching for dangerouslySetInnerHTML to "render it nicely".
    const nasty = '<img src=x onerror="alert(1)">\n<script>alert(2)</script>\n'
    const { container } = show({ tools: [tool({ installScript: nasty })] })

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(screen.getByTestId('disclosure-tool-rustup').textContent).toContain('<img src=x')
  })
})

describe('the derived summary', () => {
  it('says how many steps run as root', () => {
    show({ rootStepCount: 3 })
    expect(screen.getByTestId('root-step-count').textContent).toBe('3')
  })

  it('marks each step with the user it runs as', () => {
    show({ tools: [tool({ runAs: 'root' }), tool({ toolId: 'other', runAs: 'rocky' })] })
    expect(screen.getByTestId('run-as-rustup').textContent).toBe('root')
    expect(screen.getByTestId('run-as-other').textContent).toBe('rocky')
  })

  it('lists every URL the scripts fetch', () => {
    show({ fetchesUrls: ['https://a.example/x', 'https://b.example/y'] })
    const panel = screen.getByRole('dialog')
    expect(panel.textContent).toContain('https://a.example/x')
    expect(panel.textContent).toContain('https://b.example/y')
  })

  it('says the URL list cannot be complete', () => {
    // Without this sentence the summary tells an operator they have seen every download, and a
    // script that builds a URL from a variable makes that false. `summaryIsComplete` is false
    // from the API by construction; this asserts the UI actually renders the consequence.
    show()
    expect(screen.getByTestId('summary-incomplete').textContent).toContain('cannot be complete')
  })

  it('says plainly that nobody has audited the scripts', () => {
    // The register the whole epic is written in: validated, not audited.
    show()
    expect(screen.getByRole('dialog').textContent).toContain('Nobody has audited them')
  })

  it('handles a pack that downloads nothing without claiming it is safe', () => {
    show({ fetchesUrls: [], tools: [tool({ installScript: 'apt-get install -y ripgrep\n', fetchesUrls: [] })] })
    const panel = screen.getByRole('dialog')
    expect(panel.textContent).toContain('No download URL appears literally in its scripts')
    // The caveat stays, because "no URL matched" and "it fetches nothing" are different claims.
    expect(screen.getByTestId('summary-incomplete')).toBeTruthy()
  })
})

describe('what the operator is told before consenting', () => {
  it('names the registry and the label their own config gave it', () => {
    show()
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('Rocky Surf Pack Shop')
    expect(dialog.textContent).toContain('community')
  })

  it('warns when this installation cannot resolve a referenced tool', () => {
    // Such a pack would half-install: the steps its author assumed would simply be absent.
    show({ referencesTools: ['claude-code'] })
    expect(screen.getByTestId('unresolved-tools').textContent).toContain('claude-code')
  })

  it('shows the pack’s own guide as prose, and says it is never executed', () => {
    show({ guide: 'Run rustup default stable.' })
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('Run rustup default stable.')
    expect(dialog.textContent).toContain('never executed')
  })

  it('offers the verified bytes, identified by their digest', () => {
    show()
    expect(screen.getByRole('dialog').textContent).toContain('abababab')
  })

  it('is a labelled dialog, so a screen reader announces what is being reviewed', () => {
    show()
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Review Rust Dev')
  })
})
