import { isCollection, isScalar, isSeq, parseDocument, YAMLMap, YAMLSeq, type Document } from 'yaml'

/**
 * EDITING THE FILE IN PLACE, comments and all (rockysurf-m29b, constraint 2).
 *
 * The alternative — parse to a plain object, apply the form's values, re-serialise — is how a
 * settings GUI eats a hand-written config file. It would return a byte-perfect rendering of
 * everything the form knew about and silently drop everything else: the header explaining
 * `${VAR}`, the paragraph above `sshAllowedCidr` saying why there is no default, the
 * commented-out `publicUrl` an operator left as a note to themselves, and any key this version
 * of the editor does not surface. `yaml`'s Document API edits the parse tree instead, so a save
 * touches the lines it changes and leaves every other byte where it was.
 *
 * The one thing it cannot preserve is a comment attached to a LIST ENTRY THAT IS REMOVED. The
 * comment described the entry; removing the entry removes it. That is stated in the UI rather
 * than worked around.
 *
 * Verified rather than assumed (`settings.test.ts`): an unmodified round trip is byte-identical
 * except that runs of spaces before a trailing `#` collapse to one, which is `yaml`'s own
 * rendering and not something this file can or should fight.
 */

/** One edit. `unset` deletes the key (or the list entry); otherwise `value` is written. */
export interface Change {
  path: readonly (string | number)[]
  value?: unknown
  unset?: boolean
}

/**
 * A section written as a bare `section:` with every child commented out parses as `null`, and
 * `setIn` refuses to descend into it — the same trap `config/schema.ts` handles with
 * `section()`, arriving here as an exception instead of a validation error. The null scalar is
 * replaced with an empty collection, carrying its comment across so the commented-out lines
 * the operator left survive the save that fills the section in.
 */
function ensureCollection(doc: Document, path: readonly (string | number)[], wantSeq: boolean): void {
  const existing = doc.getIn(path, true)
  if (isCollection(existing)) return

  const replacement = wantSeq ? new YAMLSeq(doc.schema) : new YAMLMap(doc.schema)
  if (isScalar(existing)) {
    if (existing.comment != null) replacement.comment = existing.comment
    if (existing.commentBefore != null) replacement.commentBefore = existing.commentBefore
  }
  doc.setIn(path, replacement)
}

/** Apply every change to the document text, returning the new text. Throws on nothing. */
export function applyChanges(text: string, changes: readonly Change[]): string {
  const doc = parseDocument(text)

  for (const change of changes) {
    const path = change.path
    // Walk the parents outward-in, so a null section is repaired before anything tries to
    // descend through it.
    for (let i = 1; i < path.length; i++) {
      ensureCollection(doc, path.slice(0, i), typeof path[i] === 'number')
    }

    /**
     * `hosts: []` and `tokens: []` are flow sequences, and appending to one leaves the entry
     * inside the brackets — valid YAML that nobody would have written by hand. An empty flow
     * list is the file saying "none yet", so the first entry turns it into a block list.
     */
    const parent = path.length > 1 ? doc.getIn(path.slice(0, -1), true) : undefined
    const emptyFlowSeq = isSeq(parent) && parent.flow && parent.items.length === 0

    if (change.unset) doc.deleteIn(path)
    else doc.setIn(path, change.value)

    if (emptyFlowSeq && isSeq(parent) && parent.items.length > 0) parent.flow = false
  }

  return doc.toString()
}

/** The file's values as a plain tree, `${VAR}` references intact and nothing interpolated. */
export function parseTree(text: string): unknown {
  return parseDocument(text).toJS()
}
