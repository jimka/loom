// Opens CodeMirror's own find/replace panel over a Loom `CodeEditor`.
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
