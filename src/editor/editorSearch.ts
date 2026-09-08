// Opens CodeMirror's own find/replace panel over a Loom `CodeEditor`, and
// positions its caret at a project-search match.
//
// `CodeEditor` wires no `@codemirror/search` extension and keeps its
// `EditorView` private (see `mount()`'s extension list in the library's
// CodeEditor.ts), so this module reaches the live view through the
// component's DOM id — `EditorView.findFromDOM` is public, documented
// CodeMirror API for exactly this situation — and appends the search
// extension to it via `StateEffect.appendConfig`, CodeMirror's documented
// way to extend a running editor. See the plan's "Reach the live EditorView
// through the component's DOM id" architecture decision for why this is the
// one place in Loom that reaches into the DOM directly.

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
 * Selects `at`'s range in `editor`, scrolls it into view, and focuses the
 * editor. Deferred to `Component.onFirstLayout`: a file a search result just
 * opened may not have built its `EditorView` yet, since `CodeEditor` mounts
 * on its first sized layout. The three `Math.min` calls
 * clamp against the *live* document rather than trusting the match's
 * position outright, so a file that changed on disk since the search ran
 * lands at the nearest valid position instead of CodeMirror throwing on an
 * out-of-range offset.
 *
 * @param editor - The editor to reveal the match in.
 * @param at - The match's location.
 */
export function revealRange(editor: CodeEditor, at: MatchLocation): void {
    editor.onFirstLayout(() => {
        const view = resolveView(editor)

        if (view === null) {
            return
        }

        const line = view.state.doc.line(Math.min(at.line, view.state.doc.lines))
        const from = Math.min(line.from + at.column, line.to)
        const to = Math.min(from + at.length, line.to)

        view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true })
        view.focus()
    })
}
