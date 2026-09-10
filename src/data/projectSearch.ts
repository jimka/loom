// Walks a list of file paths and reports every line matching a compiled
// query, which may be case-sensitive and may be a regular expression. Takes
// its file reading as an injected parameter — the same shape
// `listFilesRecursive` (./fileIndex.ts) gives its own I/O — so the walking
// and matching logic gets real vitest coverage without a Tauri runtime
// behind it.

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

/** The flag set `@codemirror/search`'s `RegExpCursor` compiles with (`g` to
 *  scan, `m` and `u` to keep validity and semantics identical to the in-file
 *  find panel's) — `i` is appended separately when a query is
 *  case-insensitive. Hardcoded rather than feature-detected the way
 *  CodeMirror does, because Loom runs only in the Tauri webview. */
export const REGEXP_FLAGS = 'gmu'

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

/** What the Search view's three controls say: the text typed into the query
 *  field, and the two toggles beside it. */
export interface SearchQuery {
    /** The pattern — a plain substring, or a regular-expression source when `regexp` is set. */
    text: string
    /** Whether matching distinguishes upper from lower case. */
    caseSensitive: boolean
    /** Whether `text` is a regular-expression source rather than a plain substring. */
    regexp: boolean
}

/** A {@link SearchQuery} resolved into the form the line scanner uses. The
 *  `substring` arm's `needle` is already case-folded when `caseSensitive` is
 *  `false`; the `regexp` arm's `re` is shared across every file in a run. */
export type CompiledQuery =
    | { kind: 'substring'; needle: string; caseSensitive: boolean }
    | { kind: 'regexp'; re: RegExp }

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

/** One hit's position inside a single line — the shared shape
 *  {@link substringSpans} and {@link regexpSpans} report, before
 *  {@link findMatches} turns each into a {@link SearchMatch}. */
interface MatchSpan {
    column: number
    length: number
}

/**
 * Every occurrence of `needle` in `line`, resuming the scan after each hit
 * so overlapping candidates never double-count.
 *
 * @param line - The line to scan.
 * @param needle - The substring to search for, already case-folded when `caseSensitive` is `false`.
 * @param caseSensitive - Whether `line` is matched as-is or case-folded before searching.
 * @returns The matches found, in column order.
 */
function substringSpans(line: string, needle: string, caseSensitive: boolean): MatchSpan[] {
    const spans: MatchSpan[] = []
    const haystack = caseSensitive ? line : line.toLowerCase()
    let column = haystack.indexOf(needle)

    while (column !== -1) {
        spans.push({ column, length: needle.length })

        column = haystack.indexOf(needle, column + needle.length)
    }

    return spans
}

/**
 * Every occurrence of `re` in `line`. `re` carries the shared `g` flag and is
 * reused across every line of every file in a run, so its `lastIndex` is
 * reset here rather than trusted to have been left at 0 by the previous
 * call.
 *
 * @param line - The line to scan.
 * @param re - The shared, `g`-flagged regular expression to match against `line`.
 * @returns The matches found, in column order; a match that would be empty is skipped.
 */
function regexpSpans(line: string, re: RegExp): MatchSpan[] {
    const spans: MatchSpan[] = []

    // Reset per line, not per file: `re` carries the `g` flag and therefore a
    // mutable `lastIndex`, and one `CompiledQuery` is shared by every line of
    // every file in a run.
    re.lastIndex = 0

    let match = re.exec(line)

    while (match !== null) {
        if (match[0].length === 0) {
            // A pattern that can match nothing (`x*`) matches at every
            // position; `exec` leaves `lastIndex` where it started, so the
            // scan has to step forward itself or it never terminates.
            re.lastIndex += 1
        } else {
            spans.push({ column: match.index, length: match[0].length })
        }

        match = re.exec(line)
    }

    return spans
}

/**
 * `query` compiled for scanning: a plain substring is case-folded up front
 * when `caseSensitive` is `false`; a regular expression is compiled once
 * with {@link REGEXP_FLAGS} (plus `i` when `caseSensitive` is `false`) so
 * every file in a run shares the same `RegExp`.
 *
 * @param query - What the Search view's controls currently say.
 * @returns `query` compiled for scanning, or `null` for an empty pattern or an invalid regular-expression source.
 */
export function compileQuery(query: SearchQuery): CompiledQuery | null {
    if (query.text === '') {
        return null
    }

    if (!query.regexp) {
        return {
            kind: 'substring',
            needle: query.caseSensitive ? query.text : query.text.toLowerCase(),
            caseSensitive: query.caseSensitive,
        }
    }

    try {
        return { kind: 'regexp', re: new RegExp(query.text, query.caseSensitive ? REGEXP_FLAGS : `${REGEXP_FLAGS}i`) }
    } catch {
        return null
    }
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
 * Every occurrence of `compiled` in `text`, up to `limit` matches, matched
 * one line at a time — a pattern cannot span a line break, so `^`/`$` in a
 * regular expression bind to a line's own ends.
 *
 * @param path - The file `text` was read from; carried onto every match unchanged.
 * @param text - The file's text.
 * @param compiled - The query to scan for, as a substring or a regular expression.
 * @param limit - The most matches to return.
 * @returns The matches found, in file order.
 */
export function findMatches(path: string, text: string, compiled: CompiledQuery, limit: number): SearchMatch[] {
    const matches: SearchMatch[] = []

    if (limit <= 0) {
        return matches
    }

    const lines = text.split(LINE_SPLIT)

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        const spans = compiled.kind === 'regexp'
            ? regexpSpans(line, compiled.re)
            : substringSpans(line, compiled.needle, compiled.caseSensitive)

        if (spans.length === 0) {
            continue
        }

        const lineText = previewOf(line)

        for (const span of spans) {
            matches.push({ path, line: index + 1, column: span.column, length: span.length, lineText })

            if (matches.length === limit) {
                return matches
            }
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
 * @param compiled - The query to scan for; an empty or invalid pattern never reaches here, because {@link compileQuery} returns `null` for one.
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
    compiled: CompiledQuery,
    readText: ReadFileText,
    onFileMatches: (matches: SearchMatch[]) => void,
    isCancelled: () => boolean,
    limits: SearchLimits,
): Promise<SearchOutcome> {
    const outcome: SearchOutcome = { completion: 'complete', matchCount: 0, fileCount: 0, filesSearched: 0 }

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

        const matches = findMatches(path, text, compiled, limits.maxMatches - outcome.matchCount)

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
