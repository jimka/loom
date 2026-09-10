// Walks a list of file paths and reports every line matching a plain
// substring query. Takes its file reading as an injected parameter — the
// same shape `listFilesRecursive` (./fileIndex.ts) gives its own I/O — so the
// walking and matching logic gets real vitest coverage without a Tauri
// runtime behind it.

/** Characters of a file examined for a NUL byte before deciding it is
 *  binary. Git's own `buffer_is_binary` examines the first 8000 *bytes*;
 *  this examines the first 8000 *characters* because `readText` has already
 *  decoded the file into a string by the time {@link isProbablyBinary} sees
 *  it. */
export const BINARY_SNIFF_CHARS = 8000

/** Longest `lineText` a match carries, in characters — long enough to show a
 *  statement in context, short enough that one minified line cannot fill the
 *  results panel. */
export const MAX_LINE_PREVIEW_CHARS = 120

/** CodeMirror's own default line splitter (`EditorState.create` normalises
 *  line endings with it), so a reported line number addresses the line the
 *  editor's gutter shows. */
const LINE_SPLIT = /\r\n?|\n/

/** A NUL character, built at runtime rather than typed as a raw byte in this
 *  source file — a literal NUL in a text file makes `git diff` treat it as
 *  binary, the very thing {@link isProbablyBinary} is testing for. */
const NUL = String.fromCharCode(0)

/** Where a match sits inside a document: a 1-based line, a 0-based column within that line, and the match's length in characters. */
export interface MatchLocation {
    line: number
    column: number
    length: number
}

/** One match, with the file it was found in and the text of its line. */
export interface SearchMatch extends MatchLocation {
    /** The file's absolute path. */
    path: string
    /** The match's line, trimmed and truncated to {@link MAX_LINE_PREVIEW_CHARS}. */
    lineText: string
}

/** How a run ended. */
export type SearchCompletion = 'complete' | 'match-limit' | 'file-limit' | 'cancelled'

/** What a run found, and how it ended. */
export interface SearchOutcome {
    completion: SearchCompletion
    /** Total matches reported. */
    matchCount: number
    /** Files that contributed at least one match. */
    fileCount: number
    /** Files the run attempted to read, whether or not the read succeeded. */
    filesSearched: number
}

/** The ceilings a run stops at. */
export interface SearchLimits {
    maxMatches: number
    maxFiles: number
}

/** Reads a file as text — the shape `readFileText` (src/data/workspace.ts) already has. */
export type ReadFileText = (path: string) => Promise<string>

/**
 * `line`, trimmed and truncated to {@link MAX_LINE_PREVIEW_CHARS}.
 *
 * @param line - The raw line text.
 * @returns The preview text for a match on `line`.
 */
function previewOf(line: string): string {
    const trimmed = line.trim()

    return trimmed.length > MAX_LINE_PREVIEW_CHARS
        ? `${trimmed.slice(0, MAX_LINE_PREVIEW_CHARS)}…`
        : trimmed
}

/**
 * Whether `text` is probably a binary file: git's own `buffer_is_binary`
 * rule — a NUL byte within the first {@link BINARY_SNIFF_CHARS} characters —
 * applied to already-decoded text rather than raw bytes. `readTextFile`
 * decodes non-fatally, so a binary file arrives as a string full of
 * replacement characters rather than as a read error; this is the check
 * that catches it instead.
 *
 * @param text - The file's already-decoded text.
 * @returns Whether `text` looks like a binary file.
 */
export function isProbablyBinary(text: string): boolean {
    return text.slice(0, BINARY_SNIFF_CHARS).includes(NUL)
}

/**
 * Every case-insensitive occurrence of `query` in `text`, up to `limit`
 * matches. `query === ''` matches nothing — an empty needle would otherwise
 * match every column of every line.
 *
 * @param path - The file `text` was read from; carried onto every match unchanged.
 * @param text - The file's text.
 * @param query - The plain substring to search for.
 * @param limit - The most matches to return.
 * @returns The matches found, in file order.
 */
export function findMatches(path: string, text: string, query: string, limit: number): SearchMatch[] {
    const matches: SearchMatch[] = []

    if (query === '' || limit <= 0) {
        return matches
    }

    const needle = query.toLowerCase()
    const lines = text.split(LINE_SPLIT)

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        const haystack = line.toLowerCase()
        let column = haystack.indexOf(needle)

        while (column !== -1) {
            matches.push({ path, line: index + 1, column, length: query.length, lineText: previewOf(line) })

            if (matches.length === limit) {
                return matches
            }

            column = haystack.indexOf(needle, column + needle.length)
        }
    }

    return matches
}

/**
 * Walks `paths` in order, reading each through `readText` and reporting its
 * matches through `onFileMatches` as it goes — the `await` on every read
 * yields to the event loop, so a caller repainting on each callback shows
 * results streaming in rather than appearing all at once at the end. Stops
 * early on cancellation or either limit; a file that fails to read or turns
 * out to be binary is skipped silently and still counts toward
 * `filesSearched`.
 *
 * @param paths - The files to search, in walk order.
 * @param query - The plain substring to search for; `''` matches nothing.
 * @param readText - Reads one file as text.
 * @param onFileMatches - Called with a file's matches; never called with an empty array.
 * @param isCancelled - Checked before each file's read starts, and again
 *   right after it resolves and before its matches are reported — the second
 *   check is what stops a read already in flight when a newer run starts
 *   from still delivering its matches into it. A `true` from either check
 *   ends the run as `'cancelled'`.
 * @param limits - The match and file ceilings the run stops at.
 * @returns What the run found, and how it ended.
 */
export async function searchFiles(
    paths: readonly string[],
    query: string,
    readText: ReadFileText,
    onFileMatches: (matches: SearchMatch[]) => void,
    isCancelled: () => boolean,
    limits: SearchLimits,
): Promise<SearchOutcome> {
    const outcome: SearchOutcome = { completion: 'complete', matchCount: 0, fileCount: 0, filesSearched: 0 }

    if (query === '') {
        return outcome
    }

    for (const path of paths) {
        if (isCancelled()) {
            outcome.completion = 'cancelled'

            return outcome
        }

        if (outcome.filesSearched >= limits.maxFiles) {
            outcome.completion = 'file-limit'

            return outcome
        }

        outcome.filesSearched += 1

        let text: string

        try {
            text = await readText(path)
        } catch {
            // Unreadable, or over the editor's own size limit — skipped silently.
            continue
        }

        // Re-checked here, not just at the top of the loop: a newer run can
        // start (and clear the caller's results) while this file's read was
        // still in flight, and the top-of-loop check alone would let this
        // file's now-stale matches through anyway — the same
        // check-immediately-before-use shape `PropertiesPanel.loadInfo` uses
        // after its own `await`.
        if (isCancelled()) {
            outcome.completion = 'cancelled'

            return outcome
        }

        if (isProbablyBinary(text)) {
            continue
        }

        const matches = findMatches(path, text, query, limits.maxMatches - outcome.matchCount)

        if (matches.length === 0) {
            continue
        }

        outcome.matchCount += matches.length
        outcome.fileCount += 1
        onFileMatches(matches)

        if (outcome.matchCount >= limits.maxMatches) {
            outcome.completion = 'match-limit'

            return outcome
        }
    }

    return outcome
}
