import { useEffect, useRef } from 'react'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { StreamLanguage } from '@codemirror/language'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { EditorState } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'

/**
 * A shell script editor.
 *
 * THE ONE RULE: content round-trips byte for byte. What you type is what is stored, and what
 * is stored is what runs on someone's server. The cautionary tale is close to home — a `.trim()`
 * in the pack schema silently stripped the trailing newline off every `installScript`, which
 * nothing noticed until a round-trip test failed. So this component never normalises: no trim,
 * no line-ending conversion, no tab expansion, no "helpful" final newline.
 *
 * CodeMirror 6 is a set of packages rather than one bundle, wired here directly rather than
 * through the `codemirror` convenience package, so the extension list is visible and nothing
 * arrives by accident.
 *
 * Shell highlighting comes from `legacy-modes` through `StreamLanguage`: there is no
 * first-party `@codemirror/lang-shell`, and the legacy mode is the supported route.
 */

export interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  /** File-backed tools are read-only; the file is the source of truth (ADR-0004). */
  readOnly?: boolean
  ariaLabel: string
  /** Rows of visible text before scrolling. */
  minHeight?: string
}

export function CodeEditor({ value, onChange, readOnly = false, ariaLabel, minHeight = '14rem' }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  // Read at change time so the callback can be inline without rebuilding the editor.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!host.current) return

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        // `indentWithTab` last so Tab indents rather than moving focus. It is a deliberate
        // accessibility trade — Escape then Tab still leaves the editor.
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        StreamLanguage.define(shell),
        oneDark,
        EditorView.editable.of(!readOnly),
        EditorState.readOnly.of(readOnly),
        EditorView.lineWrapping,
        EditorView.theme({ '&': { minHeight }, '.cm-scroller': { overflow: 'auto' } }),
        EditorView.updateListener.of((update) => {
          // `docChanged` only: selection and focus changes must not look like edits.
          if (update.docChanged) onChangeRef.current(update.state.doc.toString())
        }),
        EditorView.contentAttributes.of({ 'aria-label': ariaLabel, role: 'textbox' }),
      ],
    })

    const editor = new EditorView({ state, parent: host.current })
    view.current = editor
    return () => {
      editor.destroy()
      view.current = null
    }
    // Built once. `value` is synced by the effect below instead, so typing does not tear the
    // editor down and rebuild it on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, ariaLabel, minHeight])

  /**
   * Adopt a value that changed underneath us — a different tool selected, or a reload.
   *
   * Guarded on inequality so it does not fight the user's own typing: without the guard every
   * keystroke would dispatch a full-document replacement and the cursor would jump to the end.
   */
  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const current = editor.state.doc.toString()
    if (current === value) return
    editor.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  return <div className="code-editor" ref={host} data-readonly={readOnly || undefined} />
}
