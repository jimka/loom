// The status bar's selection-readout rule, split out of EditorController.ts
// so it stays unit testable: vitest.config.ts runs in the `node` environment
// with no DOM, and a module that imports @jimka/typescript-ui's components
// touches `document` at load time.

/**
 * The status bar's selection readout: the selected character count, with the
 * number of lines it spans appended once the selection covers more than
 * one — VS Code's `(N selected)` wording. The empty string covers both no
 * file being open and an empty (collapsed) selection, so the caller can pass
 * either through without a separate check.
 *
 * @param metrics - The active file's selection extent, or `null` when no file is open.
 * @returns The text to show in the status bar's selection readout.
 */
export function selectionLabel(metrics: { characters: number; lines: number } | null): string {
    if (metrics === null || metrics.characters === 0) {
        return ''
    }

    return metrics.lines > 1 ? `${metrics.characters} selected, ${metrics.lines} lines` : `${metrics.characters} selected`
}
