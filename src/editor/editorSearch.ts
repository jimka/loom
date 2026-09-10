// Opens CodeMirror's own find/replace panel over a Loom `CodeEditor`, and
// positions its caret at a project-search match.
//
// `CodeEditor` keeps its `EditorView` private and its own `Ctrl-F` panel only
// searches a query typed into it, with no public way to drive it from outside
// code — so `openFindPanel` below reaches the live view through the
// component's DOM id (`EditorView.findFromDOM` is public, documented
// CodeMirror API for exactly this situation) and appends the search extension
// to it via `StateEffect.appendConfig`, CodeMirror's documented way to extend
// a running editor. `revealRange` needs no such reach: `CodeEditor` itself now
// exposes `revealRange`, a public method built for exactly this — jumping to
// (and highlighting) a location computed elsewhere — so this module's own
// `revealRange` is a thin wrapper around it.

import { EditorView, keymap } from '@codemirror/view'
import { StateEffect } from '@codemirror/state'
import { search, searchKeymap, openSearchPanel } from '@codemirror/search'
import type { CodeEditor } from '@jimka/typescript-ui/component/editor'
import type { MatchLocation } from '../data/projectSearch'

/** Views whose configuration already carries the search extension. Keyed on
 *  the view rather than on the `CodeEditor`, so a rebuilt view gets a fresh
 *  install; a `WeakSet` keeps no view alive past its editor. */
const installed = new WeakSet<EditorView>()

/**
 * The live CodeMirror view behind `editor`, or `null` before the editor has
 * mounted (`CodeEditor` mounts on its first sized layout).
 *
 * @param editor - The editor whose view to resolve.
 * @returns The live view, or `null` when none exists yet.
 */
function resolveView(editor: CodeEditor): EditorView | null {
    const host = document.getElementById(editor.getId())

    return host !== null ? EditorView.findFromDOM(host) : null
}

/**
 * Opens CodeMirror's find/replace panel over `editor`, installing the
 * search extension on first use. A no-op before the editor has mounted.
 *
 * @param editor - The editor to open the panel over.
 */
export function openFindPanel(editor: CodeEditor): void {
    const view = resolveView(editor)

    if (view === null) {
        return
    }

    if (!installed.has(view)) {
        view.dispatch({
            effects: StateEffect.appendConfig.of([search({ top: true }), keymap.of(searchKeymap)]),
        })
        installed.add(view)
    }

    openSearchPanel(view)
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
