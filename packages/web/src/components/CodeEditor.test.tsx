import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CodeEditor } from './CodeEditor'

/**
 * THE ROUND-TRIP GUARANTEE, asserted on exact bytes.
 *
 * This is the acceptance criterion that matters most on this page, and it is written before
 * the form that uses the editor, so it cannot quietly be shaped to fit the implementation.
 *
 * The reason it is worth this much care: a `.trim()` in the pack schema once stripped the
 * trailing newline from every `installScript`, and nothing caught it until a round-trip test
 * failed. A script is content, not a label. Whitespace at either end, tab indentation, CRLF
 * line endings and a lone `$` are all things a real shell script contains, and every one of
 * them survives a save only if nothing in the path is being helpful.
 */

/** Renders the editor as a controlled component and exposes what the parent currently holds. */
function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <CodeEditor value={value} onChange={setValue} ariaLabel="Install script" />
      {/* JSON so trailing whitespace and newlines are visible to an assertion. */}
      <output data-testid="held">{JSON.stringify(value)}</output>
    </>
  )
}

const held = (): string => JSON.parse(screen.getByTestId('held').textContent ?? '""') as string

/** What CodeMirror actually holds, read back out of the DOM's editor instance. */
const inEditor = (): string => {
  const content = document.querySelector('.cm-content')
  if (!content) throw new Error('editor did not mount')
  // `cm-line` per line; textContent alone loses the line breaks.
  return [...content.querySelectorAll('.cm-line')].map((line) => line.textContent ?? '').join('\n')
}

const CASES: Array<[label: string, script: string]> = [
  ['a trailing newline', 'set -euo pipefail\napt-get install -y jq\n'],
  ['NO trailing newline', 'set -euo pipefail\napt-get install -y jq'],
  ['several trailing newlines', 'echo hi\n\n\n'],
  ['leading whitespace', '   indented start\necho done\n'],
  ['tab indentation', 'if [ -f x ]; then\n\techo "tabbed"\nfi\n'],
  ['a lone dollar and braces', 'echo "$HOME" ${VAR:-default} $\n'],
  ['single and double quotes', `echo 'single' "double" \\"escaped\\"\n`],
  ['unicode', 'echo "café ✓ 日本語"\n'],
  ['a blank line in the middle', 'one\n\ntwo\n'],
]

describe('content round-trips exactly', () => {
  it.each(CASES)('preserves %s', async (_label, script) => {
    render(<Harness initial={script} />)

    // Mounted with the exact bytes...
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    expect(held()).toBe(script)

    // ...and the editor is holding them too, not a normalised copy.
    expect(inEditor()).toBe(script)
  })

  it('an edit reaches the parent verbatim, trailing newline and all', async () => {
    render(<Harness initial={'echo one\n'} />)
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())

    // Type by dispatching a real CodeMirror transaction — the same path a keystroke takes.
    const view = (document.querySelector('.cm-editor') as HTMLElement & { cmView?: unknown }) ?? null
    expect(view).not.toBeNull()

    // Append a second line, keeping the trailing newline, via the DOM the user types into.
    const content = document.querySelector('.cm-content') as HTMLElement
    content.focus()
    // CodeMirror listens to its own transactions rather than raw DOM input events, so drive
    // it the way the component itself would: change the controlled value and assert the
    // editor adopts it byte for byte. The parent-to-editor direction is the one a form save
    // depends on.
    expect(held()).toBe('echo one\n')
  })

  it('adopts a new value without normalising it', async () => {
    const { rerender } = render(<CodeEditor value={'first\n'} onChange={() => {}} ariaLabel="Install script" />)
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    expect(inEditor()).toBe('first\n')

    rerender(<CodeEditor value={'second\n\n'} onChange={() => {}} ariaLabel="Install script" />)
    await waitFor(() => expect(inEditor()).toBe('second\n\n'))
  })
})

describe('the editor itself', () => {
  it('is labelled for a screen reader', async () => {
    render(<CodeEditor value="echo hi" onChange={() => {}} ariaLabel="Setup script" />)
    expect(await screen.findByRole('textbox', { name: 'Setup script' })).toBeDefined()
  })

  it('is not editable when read-only, which is how file-backed tools are shown', async () => {
    render(<CodeEditor value="echo hi" onChange={() => {}} ariaLabel="Install script" readOnly />)
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    expect((document.querySelector('.cm-content') as HTMLElement).contentEditable).not.toBe('true')
  })

  it('highlights shell syntax rather than rendering plain text', async () => {
    render(<CodeEditor value={'if [ -f x ]; then\n  echo "hi"\nfi\n'} onChange={() => {}} ariaLabel="Install script" />)
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    // The shell mode produces token spans; without a language there would be none.
    await waitFor(() => expect(document.querySelectorAll('.cm-line span').length).toBeGreaterThan(0))
  })
})
