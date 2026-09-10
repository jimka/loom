// Pure line-number rules for the Go to Line prompt, kept out of
// goToLinePrompt.ts so vitest's `node` environment can test them: that module
// imports @jimka/typescript-ui components, which touch `document` at load
// time.

/** Matches a bare run of ASCII decimal digits — no sign, no decimal point, no exponent. */
const DIGITS_ONLY = /^[0-9]+$/

/**
 * CodeMirror's own default line splitter (`EditorState.create` normalises
 * line endings with it), mirrored rather than imported so this module keeps
 * its zero-import, node-testable contract — see the file header. Matches
 * `src/data/projectSearch.ts`'s `LINE_SPLIT`: a lone `\r` opens a new line
 * exactly as a `\n` or `\r\n` does, so a classic-Mac-ending file counts the
 * same number of lines here as CodeMirror's own gutter shows.
 */
const LINE_SPLIT = /\r\n?|\n/

/**
 * The line number `raw` names, or `null` when it does not name one. Leading and
 * trailing whitespace is ignored and leading zeros are accepted; anything that
 * is not a run of decimal digits, and zero itself, is rejected. No upper bound
 * is applied — `CodeEditor.revealRange` clamps a too-large line against the
 * live document.
 *
 * @param raw - The prompt field's text.
 * @returns The 1-based line number, or `null` when `raw` does not name one.
 */
export function parseLineNumber(raw: string): number | null {
    const trimmed = raw.trim()

    if (!DIGITS_ONLY.test(trimmed)) {
        return null
    }

    const line = Number(trimmed)

    return line === 0 ? null : line
}

/**
 * How many lines `text` has, counting the way CodeMirror does: one more than
 * the number of line breaks {@link LINE_SPLIT} matches, so an empty document
 * has one line and a trailing newline opens a final empty one. A `\r\n` pair
 * counts once, since `LINE_SPLIT` matches it as a single break.
 *
 * @param text - The document's full text.
 * @returns The line count, always at least 1.
 */
export function countLines(text: string): number {
    return text.split(LINE_SPLIT).length
}
