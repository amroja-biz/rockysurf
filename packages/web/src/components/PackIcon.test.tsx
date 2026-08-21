import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PackIcon } from './PackIcon'

describe('PackIcon', () => {
  it('renders an <img> when the pack declares imageUrl', () => {
    const { container } = render(<PackIcon pack={{ packId: 'p', name: 'P', imageUrl: '/images/surge-packs/p.png' }} />)
    const img = container.querySelector('img')
    expect(img).toBeTruthy()
    expect(img!.src).toContain('/images/surge-packs/p.png')
  })

  it('renders a monogram tile when the pack has no imageUrl', () => {
    render(<PackIcon pack={{ packId: 'rust-dev', name: 'Rust Dev' }} />)
    expect(screen.getByTestId('pack-monogram-rust-dev').textContent).toBe('RD')
  })

  it('falls back to the monogram when the image fails to load, rather than hiding', () => {
    const { container } = render(
      <PackIcon pack={{ packId: 'p', name: 'Pack Name', imageUrl: '/images/surge-packs/broken.png' }} />,
    )
    const img = container.querySelector('img')!
    fireEvent.error(img)
    expect(screen.getByTestId('pack-monogram-p')).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
  })

  it('is deterministic: the same pack renders the identical monogram and colour across renders', () => {
    const pack = { packId: 'aider', name: 'Aider' }
    const first = render(<PackIcon pack={pack} />)
    const firstEl = screen.getByTestId('pack-monogram-aider')
    const firstText = firstEl.textContent
    const firstClass = firstEl.className
    first.unmount()

    render(<PackIcon pack={pack} />)
    const secondEl = screen.getByTestId('pack-monogram-aider')
    expect(secondEl.textContent).toBe(firstText)
    expect(secondEl.className).toBe(firstClass)
  })

  it('takes initials from the first two words, or the first two characters of one word', () => {
    const a = render(<PackIcon pack={{ packId: 'a', name: 'AI Agents' }} />)
    expect(screen.getByTestId('pack-monogram-a').textContent).toBe('AA')
    a.unmount()

    render(<PackIcon pack={{ packId: 'b', name: 'Aider' }} />)
    expect(screen.getByTestId('pack-monogram-b').textContent).toBe('AI')
  })

  it('honours an allowlisted theme value as the accent', () => {
    render(<PackIcon pack={{ packId: 'x', name: 'X', theme: 'theme-purple' }} />)
    expect(screen.getByTestId('pack-monogram-x').className).toContain('theme-purple')
  })

  it('ignores a theme value outside the allowlist and falls back to the hash', () => {
    render(<PackIcon pack={{ packId: 'aider', name: 'Aider', theme: 'theme-evil-injection' }} />)
    const el = screen.getByTestId('pack-monogram-aider')
    // Whatever the hash picks for 'aider', it must be one of the six real accents, never the
    // rejected value.
    expect(el.className).not.toContain('theme-evil-injection')
    expect(el.className).toMatch(/theme-(orange|blue|green|purple|red|slate)/)
  })

  it('never lets a theme value become an arbitrary class name', () => {
    render(<PackIcon pack={{ packId: 'y', name: 'Y', theme: 'not-a-theme-class at-all' }} />)
    const el = screen.getByTestId('pack-monogram-y')
    expect(el.className).not.toContain('not-a-theme-class at-all')
  })

  it('carries the --large modifier at the detail header size', () => {
    render(<PackIcon pack={{ packId: 'z', name: 'Z' }} size="large" />)
    expect(screen.getByTestId('pack-monogram-z').className).toContain('pack-monogram--large')
  })

  /**
   * Born as a real-shipped-pack case (rockysurf-8u2l): `packs/omp.yaml` briefly shipped with
   * no `imageUrl` after its dangling one was dropped, making it the first pack to render this
   * fallback in production. The owner later supplied real artwork, so `omp` now ships an
   * image again — the props here are the historical icon-less shape, kept because "OMP" is
   * the one-word branch of the initials rule and nothing else covers it.
   */
  it('renders the fallback for a one-word pack name with no imageUrl', () => {
    render(<PackIcon pack={{ packId: 'omp', name: 'OMP' }} />)
    expect(screen.getByTestId('pack-monogram-omp').textContent).toBe('OM')
  })
})
