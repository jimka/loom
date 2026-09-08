// The search panel's row- and status-formatting rules, split out of
// SearchPanel.ts so it stays unit testable — the same pure-formatting-module-
// beside-its-panel split entryProperties.ts makes for PropertiesPanel.ts.
import { relativeTo } from '../data/paths'
import { glyphNameForPath } from '../fileIcons'
import type { SearchMatch } from '../data/projectSearch'

/** The separator joining a row's path/line and its line preview — the same
 *  one `EditorController`'s status-bar caret readout already uses. */
const LABEL_SEPARATOR = ' · '

/** One results-list row, shaped to be handed straight to `List.setItemsArray`. */
export interface SearchResultRow {
    key: string
    label: string
    tooltip: string
    glyph: string
}

/** What the panel's status line is describing. */
export interface SearchStatus {
    phase: 'idle' | 'running' | 'failed' | 'complete' | 'match-limit' | 'file-limit'
    matchCount: number
    fileCount: number
    filesSearched: number
}

/**
 * `match`'s path and line, shown relative to `root` when it sits inside it —
 * falling back to the absolute path otherwise, mirroring
 * `CommandPalette.displayLabel`.
 *
 * @param match - The match to label.
 * @param root - The open project folder, or `null` when none is open.
 * @returns `path:line`, relative to `root` when possible.
 */
function pathAndLine(match: SearchMatch, root: string | null): string {
    return `${relativeTo(root, match.path) ?? match.path}:${match.line}`
}

/**
 * Builds one results-list row from a match.
 *
 * @param match - The match the row describes.
 * @param root - The open project folder, or `null` when none is open — the label and tooltip are shown relative to it.
 * @returns The row to hand to the results `List`.
 */
export function searchResultRow(match: SearchMatch, root: string | null): SearchResultRow {
    const location = pathAndLine(match, root)

    return {
        key: `${match.path}:${match.line}:${match.column}`,
        label: `${location}${LABEL_SEPARATOR}${match.lineText}`,
        tooltip: location,
        glyph: glyphNameForPath(match.path),
    }
}

/**
 * `count`, followed by `singular` when `count === 1`, `plural` otherwise.
 *
 * @param count - The count to pluralize against.
 * @param singular - The noun's singular form.
 * @param plural - The noun's plural form.
 * @returns `count` and the correctly-pluralized noun, space-separated.
 */
function pluralize(count: number, singular: string, plural: string): string {
    return `${count} ${count === 1 ? singular : plural}`
}

/**
 * The status line's text for a completed (or stopped) run: `N match(es) in N
 * file(s)`, prefixed or suffixed with a note when a limit cut the run short.
 *
 * @param status - The completed run's counts.
 * @returns The status line's text.
 */
function completionSummary(status: SearchStatus): string {
    const matches = pluralize(status.matchCount, 'match', 'matches')
    const files = pluralize(status.fileCount, 'file', 'files')

    if (status.phase === 'match-limit') {
        return `First ${status.matchCount} matches in ${files} — narrow the query.`
    }

    if (status.phase === 'file-limit') {
        return `${matches} in ${files} — stopped after ${status.filesSearched} files.`
    }

    return status.matchCount === 0 ? 'No matches.' : `${matches} in ${files}`
}

/**
 * The search panel's status line text for `status`.
 *
 * @param status - What the panel is currently describing.
 * @returns The text to show in the status line.
 */
export function searchSummaryText(status: SearchStatus): string {
    switch (status.phase) {
        case 'idle':
            return 'Enter a query to search the project.'
        case 'running':
            return 'Searching…'
        case 'failed':
            return 'Could not read the project folder.'
        default:
            return completionSummary(status)
    }
}
