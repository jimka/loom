// Opens a Loom `CodeEditor`'s search card, and positions its caret at a
// project-search match. Both functions are thin wrappers over public
// `CodeEditor` methods — `openSearch` and `revealRange` — that add the one
// thing those methods leave to the caller: waiting for an editor that has not
// mounted its view yet. `CodeEditor` mounts on its first sized layout, and
// both methods do nothing before that, so each wrapper waits for
// `Component.onFirstLayout`.

import type { CodeEditor } from '@jimka/typescript-ui/component/editor'
import type { MatchLocation } from '../data/projectSearch'

/**
 * Opens `editor`'s search card, fills its find field from the selection and
 * moves keyboard focus to it — what Ctrl/Cmd+F does inside the document. An
 * editor that has not mounted yet gets the call once more after its first
 * layout, so *Find…* on a file opened a moment ago still opens the card.
 *
 * @param editor - The editor to open the card over.
 */
export function openFindPanel(editor: CodeEditor): void {
    if (editor.openSearch()) {
        return
    }

    editor.onFirstLayout(() => {
        editor.openSearch()
    })
}

/**
 * Selects `at`'s range in `editor`, scrolls it to the vertical centre of the
 * viewport, and paints a brief accent highlight over it — focusing the
 * editor unless `focus` is `false`. Centred rather than the library
 * default's minimal "nearest" scroll: a match opened from the results list
 * arrives with no idea what's already on screen, so centring is what
 * reliably shows the surrounding context on both sides. Deferred to
 * `Component.onFirstLayout`: a file a search result just opened may not have
 * built its `EditorView` yet, since `CodeEditor` mounts on its first sized
 * layout, and `CodeEditor.revealRange` itself no-ops before that (like every
 * other view operation). `at.column` is 0-based (a raw character offset into
 * the line), while `CodeEditor.revealRange` counts columns from 1 (matching
 * its own `getCursorPosition`), hence the `+ 1`.
 *
 * @param editor - The editor to reveal the match in.
 * @param at - The match's location.
 * @param focus - Whether to also move keyboard focus into the editor. Defaults to `true`.
 */
export function revealRange(editor: CodeEditor, at: MatchLocation, focus: boolean = true): void {
    editor.onFirstLayout(() => {
        editor.revealRange(
            { line: at.line, column: at.column + 1, length: at.length },
            { focus, scrollAlign: 'center' },
        )
    })
}
