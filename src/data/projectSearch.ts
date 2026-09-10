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

/** {@link LINE_SPLIT}, wrapped in a capturing group so `String.split` keeps
 *  each line's own separator as its own array entry instead of discarding
 *  it — built from `LINE_SPLIT`'s own source so the two can never drift
 *  apart. Content sits at even indices, its following separator (if any) at
 *  the next odd index; the last entry is always content, matching
 *  `LINE_SPLIT`'s own line-counting behaviour (a file ending in a newline
 *  reports one extra, empty, trailing line — inherited unchanged from
 *  `findMatches`, not a new quirk). */
const LINE_SPLIT_KEEPING_ENDINGS = new RegExp(`(${LINE_SPLIT.source})`)

/**
 * `text` split into alternating content/line-ending entries, keeping every
 * line's own separator instead of discarding it the way {@link LINE_SPLIT}
 * does — a replace pass must never rewrite a line ending that isn't part of
 * a match, or a project-wide pass would silently turn every CRLF file it
 * writes into LF.
 *
 * @param text - The file's text.
 * @returns `text` split on {@link LINE_SPLIT_KEEPING_ENDINGS}.
 */
function splitKeepingLineEndings(text: string): string[] {
    return text.split(LINE_SPLIT_KEEPING_ENDINGS)
}

/**
 * `replacement` with `@codemirror/search`'s own group-reference syntax
 * resolved against `match` — `$&` for the whole match, `$$` for a literal
 * `$`, and `$1` through `$9`+ for a captured group, falling back to the
 * literal template text when the group doesn't exist. Only called for a
 * `regexp` query; a `substring` query's replacement is used as-is by its own
 * caller.
 *
 * @param replacement - The replacement template, as typed into the Replace field.
 * @param match - The `RegExpExecArray` the template's group references resolve against.
 * @returns `replacement` with every `$`-reference resolved.
 */
function resolveReplacement(replacement: string, match: RegExpExecArray): string {
    return replacement.replace(/\$([$&]|\d+)/g, (whole, ref: string) => {
        if (ref === '&') {
            return match[0]
        }

        if (ref === '$') {
            return '$'
        }

        for (let length = ref.length; length > 0; length -= 1) {
            const groupNumber = Number(ref.slice(0, length))

            if (groupNumber > 0 && groupNumber < match.length) {
                return (match[groupNumber] ?? '') + ref.slice(length)
            }
        }

        return whole
    })
}

/**
 * Every occurrence of `needle` in `line`, replaced with `replacement` —
 * mirrors {@link substringSpans}' own scanning shape, but builds the
 * replaced text instead of reporting spans.
 *
 * @param line - The line to scan.
 * @param needle - The substring to search for, already case-folded when `caseSensitive` is `false`.
 * @param caseSensitive - Whether `line` is matched as-is or case-folded before searching.
 * @param replacement - The literal text every occurrence is replaced with.
 * @returns The line with every occurrence replaced, and how many were replaced.
 */
function replaceLineAllSubstring(
    line: string, needle: string, caseSensitive: boolean, replacement: string,
): { text: string; count: number } {
    const haystack = caseSensitive ? line : line.toLowerCase()
    let result = ''
    let cursor = 0
    let count = 0
    let column = haystack.indexOf(needle)

    while (column !== -1) {
        result += line.slice(cursor, column) + replacement
        cursor = column + needle.length
        count += 1
        column = haystack.indexOf(needle, cursor)
    }

    return { text: result + line.slice(cursor), count }
}

/**
 * Every occurrence of `re` in `line`, replaced with `replacement` resolved
 * per match via {@link resolveReplacement} — mirrors {@link regexpSpans}' own
 * scanning shape (reset `lastIndex` per line, skip a zero-length match, step
 * `lastIndex` forward by one so a pattern that can match nothing can never
 * loop), but builds the replaced text instead of reporting spans.
 *
 * @param line - The line to scan.
 * @param re - The shared, `g`-flagged regular expression to match against `line`.
 * @param replacement - The replacement template, resolved per match.
 * @returns The line with every occurrence replaced, and how many were replaced.
 */
function replaceLineAllRegexp(line: string, re: RegExp, replacement: string): { text: string; count: number } {
    re.lastIndex = 0

    let result = ''
    let cursor = 0
    let count = 0
    let match = re.exec(line)

    while (match !== null) {
        if (match[0].length === 0) {
            re.lastIndex += 1
        } else {
            result += line.slice(cursor, match.index) + resolveReplacement(replacement, match)
            cursor = match.index + match[0].length
            count += 1
        }

        match = re.exec(line)
    }

    return { text: result + line.slice(cursor), count }
}

/**
 * Every occurrence `compiled` finds on `line`, replaced with `replacement`.
 *
 * @param line - The line to scan.
 * @param compiled - The query to scan for, as a substring or a regular expression.
 * @param replacement - The replacement text or template.
 * @returns The line with every occurrence replaced, and how many were replaced.
 */
function replaceLineAll(line: string, compiled: CompiledQuery, replacement: string): { text: string; count: number } {
    return compiled.kind === 'regexp'
        ? replaceLineAllRegexp(line, compiled.re, replacement)
        : replaceLineAllSubstring(line, compiled.needle, compiled.caseSensitive, replacement)
}

/**
 * Every occurrence `compiled` currently finds in `text`, replaced with
 * `replacement` — `$1`/`$&`/`$$` resolved per match for a regex query,
 * verbatim for a substring query. Only the matched spans change; every other
 * character, line endings included, is copied through untouched.
 *
 * @param text - The file's current text.
 * @param compiled - The query to scan for, as a substring or a regular expression.
 * @param replacement - The replacement text (a substring query) or template (a regexp query).
 * @returns The new text, and how many occurrences were replaced. `count === 0`
 *   returns the original `text` value unchanged, so a caller can skip a write
 *   by checking `count` alone.
 */
export function replaceAllInText(
    text: string, compiled: CompiledQuery, replacement: string,
): { text: string; count: number } {
    const parts = splitKeepingLineEndings(text)
    let count = 0

    for (let index = 0; index < parts.length; index += 2) {
        const line = replaceLineAll(parts[index], compiled, replacement)

        parts[index] = line.text
        count += line.count
    }

    return { text: count === 0 ? text : parts.join(''), count }
}

/**
 * Replaces the occurrence of `compiled` at `column` on `line`, verifying it
 * is still there first.
 *
 * @param line - The line to verify and replace on.
 * @param column - The 0-based column the match is expected at.
 * @param compiled - The query to scan for, as a substring or a regular expression.
 * @param replacement - The replacement text (a substring query) or template (a regexp query).
 * @returns The line with the occurrence replaced, or `null` when nothing matches at `column` any more.
 */
function replaceOneOnLine(line: string, column: number, compiled: CompiledQuery, replacement: string): string | null {
    if (compiled.kind === 'substring') {
        const haystack = compiled.caseSensitive ? line : line.toLowerCase()

        if (!haystack.startsWith(compiled.needle, column)) {
            return null
        }

        return line.slice(0, column) + replacement + line.slice(column + compiled.needle.length)
    }

    compiled.re.lastIndex = 0

    let match = compiled.re.exec(line)

    while (match !== null) {
        if (match[0].length > 0 && match.index === column) {
            return line.slice(0, column) + resolveReplacement(replacement, match) + line.slice(column + match[0].length)
        }

        if (match[0].length === 0) {
            compiled.re.lastIndex += 1
        }

        match = compiled.re.exec(line)
    }

    return null
}

/**
 * Replaces the single occurrence `at` names in `text`, verifying it is still
 * there first. `at` normally comes from a `SearchMatch` an earlier
 * `findMatches` run reported against a *different* copy of this file's text.
 *
 * @param text - The file's current text.
 * @param at - Where the occurrence was last found: a 1-based line and a 0-based column within it.
 * @param compiled - The query to scan for, as a substring or a regular expression.
 * @param replacement - The replacement text (a substring query) or template (a regexp query).
 * @returns The new text, or `null` when `at.line` no longer exists, or
 *   nothing matches at `at.column` on that line any more.
 */
export function replaceOneInText(
    text: string, at: MatchLocation, compiled: CompiledQuery, replacement: string,
): string | null {
    const parts = splitKeepingLineEndings(text)
    const partIndex = (at.line - 1) * 2

    if (partIndex >= parts.length) {
        return null
    }

    const replacedLine = replaceOneOnLine(parts[partIndex], at.column, compiled, replacement)

    if (replacedLine === null) {
        return null
    }

    parts[partIndex] = replacedLine

    return parts.join('')
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
