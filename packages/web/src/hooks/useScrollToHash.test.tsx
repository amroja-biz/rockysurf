import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useScrollToHash } from './useScrollToHash'

/**
 * The scroll-to-fragment mechanism behind issue #344, tested without the rest of the app: a
 * plain harness with two targets and a same-page navigation button, standing in for what
 * `AppShell` actually wires up (a page rendered via `<Link to="/page#id">`) and what a real
 * browser does when the URL carries a fragment on mount.
 *
 * jsdom implements no `scrollIntoView` at all (unlike a real browser), which is exactly why the
 * hook guards the call with `?.()` — this suite supplies the mock the hook would otherwise call
 * into nothing.
 */
function Harness() {
  useScrollToHash()
  const navigate = useNavigate()
  return (
    <div>
      <div id="target-a">A</div>
      <div id="target-b">B</div>
      <button onClick={() => navigate('#target-b')}>go to b</button>
    </div>
  )
}

describe('useScrollToHash', () => {
  let scrollIntoView: ReturnType<typeof vi.fn>

  beforeEach(() => {
    scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
  })

  it('scrolls to the element the URL fragment names, on mount', () => {
    render(
      <MemoryRouter initialEntries={['/help#target-b']}>
        <Harness />
      </MemoryRouter>,
    )

    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    // Called on target-b specifically, not just called on something.
    expect((scrollIntoView.mock.instances[0] as unknown as HTMLElement).id).toBe('target-b')
  })

  it('does nothing when the URL carries no fragment', () => {
    render(
      <MemoryRouter initialEntries={['/help']}>
        <Harness />
      </MemoryRouter>,
    )

    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('scrolls again on an in-app navigation that only changes the fragment', () => {
    render(
      <MemoryRouter initialEntries={['/help#target-a']}>
        <Harness />
      </MemoryRouter>,
    )
    scrollIntoView.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'go to b' }))

    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect((scrollIntoView.mock.instances[0] as unknown as HTMLElement).id).toBe('target-b')
  })

  it('does not throw when the named element does not exist', () => {
    expect(() =>
      render(
        <MemoryRouter initialEntries={['/help#does-not-exist']}>
          <Harness />
        </MemoryRouter>,
      ),
    ).not.toThrow()
    expect(scrollIntoView).not.toHaveBeenCalled()
  })
})
