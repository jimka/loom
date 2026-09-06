// The status bar's caret-readout rule, split out of EditorController.ts so it
// stays unit testable: vitest.config.ts runs in the `node` environment with
// no DOM, and a module that imports @jimka/typescript-ui's components
// touches `document` at load time.
import type { CodeEditorCursorPosition } from '@jimka/typescript-ui/component/editor'

/**
 * The status bar's caret readout: the caret's 1-based line and column, its
 * document offset rendered as a 1-based position, or the empty string when
 * no file is open — the same blank the language text beside it falls back
 * to.
 *
 * @param position - The active file's caret position, or `null` when no file is open.
 * @returns The text to show in the status bar's cursor readout.
 */
export function cursorLabel(position: CodeEditorCursorPosition | null): string {
    return position === null ? '' : `Ln ${position.line}, Col ${position.column} · Pos ${position.offset + 1}`
}
