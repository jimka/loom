---
depends-on: [project-search-regex-and-match-case]
touches-shared: [src/data/projectSearch.ts, src/explorer/SearchPanel.ts, src/explorer/searchResults.ts, tests/projectSearch.test.ts, tests/searchResults.test.ts, README.md, TODO.md]
---

# Project-Wide Replace — Implementation Plan

## Overview

The Search view finds matches only ([`TODO.md:14`](TODO.md#L14)). This plan adds a replacement field to the panel, a per-match and a per-file apply action in the results tree, and a project-wide Replace All action, closing that `## High` backlog entry.

This plan is built on top of [`plans/project-search-regex-and-match-case.md`](project-search-regex-and-match-case.md) (hereafter "the search plan"), which must land first. The search plan turns the panel's query into a `SearchQuery`/`CompiledQuery` pair (`src/data/projectSearch.ts`) and gives every match its own `length`, so a regex match's replacement can differ per occurrence. This plan reuses that seam exactly: a replace pass re-runs the same `CompiledQuery` a search run already produced, against a file's *current* text, and writes back only what still matches. Its own `## Architecture Decisions` — one `CompiledQuery` shared across a run, matching kept line-by-line, an invalid pattern never reaching the search — all carry over unchanged; this plan adds none of its own that conflict with them.

Four files change beyond the two data/UI modules the search plan already touched: `src/EditorController.ts` gains the write path (buffer-or-disk, matching how `save`/`saveAs` already write there), `src/explorer/SearchPanel.ts` gains the replace field, the Replace All button, and the results tree's context menu, `src/shell/EditorShell.ts` wires the new panel callbacks to the controller, and `src/main.ts` registers one new glyph. A new `src/explorer/searchReplacePrompt.ts` holds the Replace All confirmation, mirroring the app's existing small prompt modules.

---

## Architecture Decisions

### Per-match and per-file apply are `Tree` context-menu actions, mirroring `FileTree`'s own

The results tree gains a `"contextmenu"` listener: right-clicking a match leaf offers **Replace**, right-clicking a file branch offers **Replace All in File**. This is exactly [`src/explorer/FileTree.ts:126`](src/explorer/FileTree.ts#L126)'s `handleNodeContextMenu` — a `Menu` instance, `MenuItemConfig[]` built per row kind, shown at the click point.[^context-menu-not-inline]

A folder branch gets no context menu — see `## Non-Goals`.

### An open file's replace goes through its live buffer; a closed file's goes straight to disk

When the target path is open in a tab, the replacement is applied to that file's own `CodeEditor` document via `setValue()` — the same whole-document write `reloadFromDisk` already uses, and the same one CodeMirror's own in-file Replace All button uses on the active document. This dirties the tab exactly like a manual edit; Save is the user's, same as any other change. When the target path is *not* open, the new text is written straight to disk through `writeFileText` ([`src/data/workspace.ts:167`](src/data/workspace.ts#L167)) — the same function `EditorController.save`/`saveAs` already call.[^why-buffer-not-disk]

Routing an open file's replace through its buffer this way is also the answer to reconciling a replace against a dirty tab: there is nothing to reconcile, because the replace never touches disk for that file at all. It edits the same buffer the user's own unsaved changes already live in, on top of them, exactly as if the user had typed the replacement themselves.[^not-reload-precedent]

### Undo is per-open-file CodeMirror history; a closed file's write is immediate and has none

For an open file, the replace lands as one more step in that file's own `history()` extension — Ctrl/Cmd+Z undoes it, matching `reloadFromDisk`'s own accepted whole-document-replace cost.[^setvalue-undo] For a closed file, the disk write has no undo at all: Loom keeps no buffer for a file with no open tab, so there is no document to hold a history the way VS Code's own always-live text-document model would.[^no-closed-file-undo] There is no cross-file undo transaction of any kind — this satisfies `TODO.md`'s "undo story" requirement by being explicit about what undo covers and what it doesn't, rather than promising something CodeMirror's per-document history cannot do.

Because a closed-file write can't be undone, the one action broad enough that its scope isn't visible at a glance — the panel's own Replace All, touching every file the results tree currently lists — is gated behind a confirmation dialog, mirroring [`src/explorer/fileTreePrompts.ts:139`](src/explorer/fileTreePrompts.ts#L139)'s `confirmDelete`. A single per-match or per-file apply is not gated: it is a small, visible, deliberately-targeted action the user just picked from a specific row's own menu, the same trust level `FileTree`'s Rename/Delete/New File items already carry with no extra confirmation of their own (Delete excepted, because *its* blast radius — a whole subtree — is likewise not visible at a glance).

### Every replace re-verifies its match against fresh text before writing anything

Every apply — per-match, per-file, or everywhere — re-reads the target's *current* content (the live buffer if open, disk otherwise) and re-runs the `CompiledQuery` over it before writing anything. Nothing here trusts the `SearchMatch` list's old `line`/`column` positions as still valid; they only say where to *look*. This is exactly the seam the search plan's own `^match-shape` footnote sets up: "a replace pass must re-read each file from disk before writing it... and re-running the same `CompiledQuery` over the re-read text is both how it confirms the match is still there and how it obtains the groups." A file that changed since the last search run (an external edit, a prior replace earlier in the same batch) is therefore handled the same way as one that didn't — there is no separate staleness code path, only "is it still there right now."

A per-match apply that finds nothing at the recorded position makes no change and reports failure silently — the tree's own post-apply rebuild (see the "Every apply finishes by re-running the search" decision below) is the only feedback, matching how a vanished search result already just disappears with no dialog.

### The regex replacement syntax mirrors `@codemirror/search`'s own `$1`/`$&`/`$$`

A regex query's replacement text supports `$&` (the whole match), `$$` (a literal `$`), and `$1` through `$9`+ (a captured group, falling back to literal text when the group doesn't exist) — copied from `RegExpQuery.getReplacement` in `node_modules/@codemirror/search/dist/index.js:727`. A substring query's replacement is used verbatim, matching that same file's `StringQuery.getReplacement` (line 662). This keeps the two Replace fields — CodeMirror's own in-file one and this project-wide one — speaking the same template language, the same reason the search plan copied CodeMirror's match flags rather than inventing new ones.

| `replacement` | Query kind | Applied to | Result |
|---|---|---|---|
| `bar` | substring | `foo` | `bar` |
| `[$&]` | regexp | `foo` | `[foo]` |
| `$2=$1` | regexp `(\w+)=(\d+)` | `x=5` | `5=x` |
| `$$1` | regexp | (any match) | `$1` (literal) |
| `cost: $x` | regexp | (any match) | `cost: $x` (`$x` isn't `$&`/`$$`/a digit run, so it's left untouched) |

### Every apply finishes by re-running the search

Per-match, per-file, and Replace All all end by calling the panel's own `runSearch()` — the same method Enter and the two toggles already call. This is the search plan's own `^rerun-on-toggle` precedent extended one step further: a replace is a deliberate act, not a keystroke, and the alternative (patching the results tree and the stored `_matches` array in place) would have to re-derive every match's shifted column on a line that had an earlier occurrence on it replaced first. Re-running from scratch sidesteps that bookkeeping entirely and always shows the project's actual current state, including a file that dropped out because it has no matches left.

### Write failures: a single-target action shows its own dialog; the bulk action collects and reports once

A per-match or per-file apply that fails to write shows the same `Dialog.error('Could not save file', ...)` `EditorController.save` already shows on its own write failure — one target, one dialog. Replace All instead collects every file's failure into one list and shows a single combined dialog once the whole run finishes, so a run touching dozens of files can't stack dozens of modal dialogs.[^why-not-per-file-dialog-in-bulk] A file that simply can't be *read* any more (deleted, or grown too large) is skipped silently in every case, matching `searchFiles`'s own skip-and-carry-on rule — that is not a write failure, and nothing was lost.

---

## Public API

`src/data/projectSearch.ts` — two new exported functions, no changed signatures:

```typescript
/**
 * Every occurrence `compiled` currently finds in `text`, replaced with
 * `replacement` — `$1`/`$&`/`$$` resolved per match for a regex query,
 * verbatim for a substring query. Only the matched spans change; every other
 * character, line endings included, is copied through untouched.
 *
 * @returns The new text, and how many occurrences were replaced. `count === 0`
 *   returns the original `text` value unchanged, so a caller can skip a write
 *   by checking `count` alone.
 */
export function replaceAllInText(
    text: string, compiled: CompiledQuery, replacement: string,
): { text: string; count: number }

/**
 * Replaces the single occurrence `at` names in `text`, verifying it is still
 * there first. `at` normally comes from a `SearchMatch` an earlier
 * `findMatches` run reported against a *different* copy of this file's text.
 *
 * @returns The new text, or `null` when `at.line` no longer exists, or
 *   nothing matches at `at.column` on that line any more.
 */
export function replaceOneInText(
    text: string, at: MatchLocation, compiled: CompiledQuery, replacement: string,
): string | null
```

`src/explorer/searchResults.ts` — one widened union member, and one function made public:

```typescript
export interface SearchStatus {
    phase: 'idle' | 'running' | 'replacing' | 'failed' | 'invalid-regex' | 'complete' | 'match-limit' | 'file-limit'
    matchCount: number
    fileCount: number
    filesSearched: number
}

/** `count`, followed by `singular` when `count === 1`, `plural` otherwise. */
export function pluralize(count: number, singular: string, plural: string): string
```

`src/explorer/searchReplacePrompt.ts` (new file):

```typescript
/**
 * Confirms a project-wide Replace All, naming how many occurrences and files
 * it is about to touch, and that a closed file's write can't be undone.
 *
 * @returns Whether the user confirmed.
 */
export async function confirmReplaceAll(matchCount: number, fileCount: number): Promise<boolean>
```

`src/EditorController.ts` — three new public methods:

```typescript
class EditorController {
    /**
     * Replaces the single occurrence `match` names — through the live buffer
     * when its file is open, straight to disk otherwise — verifying it is
     * still there first. A stale match (the file's content moved since the
     * search that found it ran) makes no change and resolves `false`
     * silently; a failed disk write shows a `Dialog.error` like {@link save}'s
     * own and resolves `false`.
     */
    async replaceMatch(match: SearchMatch, compiled: CompiledQuery, replacement: string): Promise<boolean>

    /**
     * Replaces every occurrence `compiled` currently finds in `path` — through
     * the live buffer when it's open, straight to disk otherwise. A failed
     * disk write shows a `Dialog.error` like {@link save}'s own and resolves
     * `0`.
     *
     * @returns How many occurrences were replaced.
     */
    async replaceInFile(path: string, compiled: CompiledQuery, replacement: string): Promise<number>

    /**
     * Runs {@link replaceInFile}'s own write over every one of `paths` in
     * turn, without its per-file dialog — a write failure is collected
     * instead, and reported in one combined `Dialog.error` once every file
     * has been attempted.
     *
     * @returns How many occurrences were replaced in total, and in how many files.
     */
    async replaceEverywhere(
        paths: readonly string[], compiled: CompiledQuery, replacement: string,
    ): Promise<{ matchesReplaced: number; filesChanged: number }>
}
```

`src/explorer/SearchPanel.ts` — three new constructor callbacks on `SearchPanelParams`, inserted between `onCommitFile` and `projectRoot`:

```typescript
export interface SearchPanelParams {
    // ...listFiles, readText, onOpenMatch, onCommitMatch, onCommitFile unchanged...

    /** Replaces the single occurrence `match` names; resolves whether it actually replaced anything. */
    onReplaceMatch: (match: SearchMatch, compiled: CompiledQuery, replacement: string) => Promise<boolean>
    /** Replaces every occurrence `compiled` finds in one file; resolves how many. */
    onReplaceInFile: (path: string, compiled: CompiledQuery, replacement: string) => Promise<number>
    /** Replaces every occurrence `compiled` finds across every one of `paths`; resolves the totals. */
    onReplaceEverywhere: (
        paths: readonly string[], compiled: CompiledQuery, replacement: string,
    ) => Promise<{ matchesReplaced: number; filesChanged: number }>

    projectRoot: string | null
}
```

---

## Internal Structure

### Splitting text while keeping its own line endings

`replaceAllInText`/`replaceOneInText` must never rewrite a line ending that isn't part of a match — a project-wide pass touching many files would otherwise silently turn every CRLF file it writes into LF, a `git diff` disaster unrelated to the actual edit. `findMatches`' own `LINE_SPLIT` (`src/data/projectSearch.ts:22`) discards the separator on every split; replace needs to keep it, so it wraps the same pattern in a capturing group:

```typescript
/** {@link LINE_SPLIT}, wrapped in a capturing group so `String.split` keeps
 *  each line's own separator as its own array entry instead of discarding
 *  it — built from `LINE_SPLIT`'s own source so the two can never drift
 *  apart. Content sits at even indices, its following separator (if any) at
 *  the next odd index; the last entry is always content, matching
 *  `LINE_SPLIT`'s own line-counting behaviour (a file ending in a newline
 *  reports one extra, empty, trailing line — inherited unchanged from
 *  `findMatches`, not a new quirk). */
const LINE_SPLIT_KEEPING_ENDINGS = new RegExp(`(${LINE_SPLIT.source})`)

function splitKeepingLineEndings(text: string): string[] {
    return text.split(LINE_SPLIT_KEEPING_ENDINGS)
}
```

| Input (escaped) | `splitKeepingLineEndings` result |
|---|---|
| `"foo"` | `["foo"]` |
| `"foo\r\nbar\n"` | `["foo", "\r\n", "bar", "\n", ""]` |

### Resolving a regex replacement template

```typescript
/**
 * `replacement` with `@codemirror/search`'s own group-reference syntax
 * resolved against `match` — see `## Architecture Decisions`'s worked table.
 * Only called for a `regexp` query; a `substring` query's replacement is
 * used as-is by its own caller.
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
```

### Replacing every match on one line

Mirrors `substringSpans`/`regexpSpans`'s own scanning shape (reset `lastIndex` per line, skip a zero-length match, step `lastIndex` forward by one so a pattern that can match nothing can never loop) but builds replacement text instead of `{column, length}` spans:

```typescript
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

function replaceLineAll(line: string, compiled: CompiledQuery, replacement: string): { text: string; count: number } {
    return compiled.kind === 'regexp'
        ? replaceLineAllRegexp(line, compiled.re, replacement)
        : replaceLineAllSubstring(line, compiled.needle, compiled.caseSensitive, replacement)
}
```

### `replaceAllInText`

```typescript
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
```

### Replacing exactly one occurrence, verifying it first

```typescript
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
```

| `at` (line, column) | Query | Fresh line's text | Result |
|---|---|---|---|
| `(1, 6)` | substring `foo` | `"const foo = 1"` (unchanged) | `"const X = 1"` |
| `(1, 6)` | substring `foo` | `"const bar = 1"` (edited since) | `null` |
| `(5, 0)` | any | file now has 3 lines | `null` |
| `(1, 4)` | regexp `(\w)=(\d)`, replacement `$2=$1` | `"a=1 b=2"` (targeting the second occurrence) | `"a=1 2=b"` — the first occurrence, at column 0, is untouched |

### `EditorController`'s write path

```typescript
private findOpenFile(path: string): FileEditor | null {
    return this._openFiles.find(candidate => candidate.getPath() === path) ?? null
}

/**
 * Shared write for {@link replaceInFile} and {@link replaceEverywhere}: reads
 * `path`'s current content — the live buffer when it's open, disk otherwise —
 * replaces every occurrence `compiled` finds, and writes the result back the
 * same way it was read. Skipped entirely when nothing matched, so a file with
 * no remaining occurrences is never touched. A read failure (deleted, now
 * over the size limit) is swallowed and reports `0`; a write failure
 * propagates, for the two public callers to handle differently.
 */
private async performReplaceInFile(path: string, compiled: CompiledQuery, replacement: string): Promise<number> {
    const open = this.findOpenFile(path)

    if (open) {
        const { text, count } = replaceAllInText(open.getEditor().getValue(), compiled, replacement)

        if (count > 0) {
            open.getEditor().setValue(text)
        }

        return count
    }

    let diskText: string

    try {
        diskText = await readFileText(path)
    } catch {
        return 0
    }

    if (isProbablyBinary(diskText)) {
        return 0
    }

    const { text, count } = replaceAllInText(diskText, compiled, replacement)

    if (count > 0) {
        await writeFileText(path, text)
    }

    return count
}

async replaceInFile(path: string, compiled: CompiledQuery, replacement: string): Promise<number> {
    try {
        return await this.performReplaceInFile(path, compiled, replacement)
    } catch (error) {
        await Dialog.error('Could not save file', messageOf(error))

        return 0
    }
}

async replaceEverywhere(
    paths: readonly string[], compiled: CompiledQuery, replacement: string,
): Promise<{ matchesReplaced: number; filesChanged: number }> {
    let matchesReplaced = 0
    let filesChanged = 0
    const failedPaths: string[] = []

    for (const path of paths) {
        try {
            const count = await this.performReplaceInFile(path, compiled, replacement)

            if (count > 0) {
                matchesReplaced += count
                filesChanged += 1
            }
        } catch {
            failedPaths.push(path)
        }
    }

    if (failedPaths.length > 0) {
        // Comma-joined, not one path per line: `Dialog`'s message renders with
        // `white-space: normal` (src/typescript/lib/overlay/Dialog.ts:742),
        // which collapses a `\n` into a single space anyway.
        await Dialog.error('Could not save every file', `These files could not be written: ${failedPaths.join(', ')}`)
    }

    return { matchesReplaced, filesChanged }
}

async replaceMatch(match: SearchMatch, compiled: CompiledQuery, replacement: string): Promise<boolean> {
    const open = this.findOpenFile(match.path)

    if (open) {
        const text = replaceOneInText(open.getEditor().getValue(), match, compiled, replacement)

        if (text === null) {
            return false
        }

        open.getEditor().setValue(text)

        return true
    }

    let diskText: string

    try {
        diskText = await readFileText(match.path)
    } catch {
        return false
    }

    if (isProbablyBinary(diskText)) {
        return false
    }

    const replaced = replaceOneInText(diskText, match, compiled, replacement)

    if (replaced === null) {
        return false
    }

    try {
        await writeFileText(match.path, replaced)
    } catch (error) {
        await Dialog.error('Could not save file', messageOf(error))

        return false
    }

    return true
}
```

Note what's absent: no call to `markSynced`/`setSyncedText` anywhere above. An open file's `_syncedText` (its last-known disk content) is deliberately left alone — disk hasn't moved, only the buffer has, exactly as if the user had typed the edit; the next `save()` writes the buffer's new content to disk and updates `_syncedText` through its own existing path.

### `SearchPanel`'s new row and menu

```typescript
const replaceField = new TextField({ placeholder: REPLACE_PLACEHOLDER })
const replaceAllButton = Button({ text: REPLACE_ALL_LABEL, glyph: REPLACE_GLYPH, showText: true, compact: true, flat: true })
const replaceRow = Container({
    layoutManager: new HBox({ spacing: TOGGLE_SPACING, itemAlign: 'center' }),
    components: [{ component: replaceField, constraints: { weight: 1 } }, replaceAllButton],
})
```

`replaceField` grows to fill the row and `replaceAllButton` keeps its own preferred width at the trailing edge — the same split [`src/editor/FileBreadcrumbs.ts:61`](src/editor/FileBreadcrumbs.ts#L61)'s trail-plus-action row uses. `TOGGLE_SPACING` is the constant the search plan already defines for the row above; this row reuses it rather than declaring its own.

```typescript
private readonly handleContextMenu = (node: TreeNode, event: MouseEvent): void => {
    const data = node.data as SearchTreeNodeData

    if (data.kind === 'match') {
        this._menu.show(event.clientX, event.clientY, [
            { text: 'Replace', glyph: REPLACE_GLYPH, action: () => { void this.applyMatchReplace(data.match) } },
        ])
    } else if (data.kind === 'file') {
        this._menu.show(event.clientX, event.clientY, [
            { text: 'Replace All in File', glyph: REPLACE_GLYPH, action: () => { void this.applyFileReplace(data.path) } },
        ])
    }
}
```

```typescript
private async applyMatchReplace(match: SearchMatch): Promise<void> {
    if (this._activeQuery === null) {
        return
    }

    const compiled = this._activeQuery

    await this._onReplaceMatch(match, compiled, this._replaceField.getValue())
    await this.runSearch()
}

private async applyFileReplace(path: string): Promise<void> {
    if (this._activeQuery === null) {
        return
    }

    const compiled = this._activeQuery

    await this._onReplaceInFile(path, compiled, this._replaceField.getValue())
    await this.runSearch()
}

private async applyReplaceAll(): Promise<void> {
    if (this._activeQuery === null || this._matches.length === 0) {
        return
    }

    // Captured now, not after the `await` below: TypeScript can't carry a
    // `this._activeQuery !== null` narrowing across an `await`, so `compiled`
    // is a local `const` instead — its own narrowed type survives the wait
    // for the confirmation dialog.
    const compiled = this._activeQuery
    const paths = [...new Set(this._matches.map(match => match.path))]

    if (!(await confirmReplaceAll(this._matches.length, paths.length))) {
        return
    }

    const replacement = this._replaceField.getValue()

    this.paintStatus({ phase: 'replacing', matchCount: 0, fileCount: 0, filesSearched: 0 })

    try {
        const { matchesReplaced, filesChanged } = await this._onReplaceEverywhere(paths, compiled, replacement)

        Notification.show(
            `Replaced ${pluralize(matchesReplaced, 'match', 'matches')} in ${pluralize(filesChanged, 'file', 'files')}.`,
            'success',
        )
    } finally {
        await this.runSearch()
    }
}

/** Enables the Replace All button exactly when the tree currently lists at
 *  least one match. Called wherever {@link _matches} changes. */
private syncReplaceAllEnabled(): void {
    this._replaceAllButton.setEnabled(this._matches.length > 0)
}
```

`_activeQuery` is the `CompiledQuery` the *currently displayed* results came from — set in `runSearch` at the same point `compiled` is computed there, so it always matches what's on screen even if the query field has since been edited without pressing Enter again:

```typescript
// Inside runSearch, in place of the search plan's own two `paintStatus` early returns:
if (query.text === '') {
    this._activeQuery = null
    this.paintStatus(IDLE_STATUS)

    return
}

const compiled = compileQuery(query)

if (compiled === null) {
    this._activeQuery = null
    this.paintStatus(INVALID_REGEX_STATUS)

    return
}

this._activeQuery = compiled
this.paintStatus({ phase: 'running', matchCount: 0, fileCount: 0, filesSearched: 0 })
```

### Status line

One new row joins the table `searchSummaryText` already implements:

| `phase` | Text |
|---|---|
| `replacing` | `Replacing…` |

---

## Ordered Implementation Steps

1. **`tests/projectSearch.test.ts`** — add `describe('replaceAllInText')` and `describe('replaceOneInText')` blocks covering every row of `## Expected Behaviour`'s unit tables below. Build every `CompiledQuery` input through `compileQuery`, the same rule the search plan's own step 1 established, so a case-folding bug in `compileQuery` would still be caught here. Import `replaceAllInText`, `replaceOneInText`, and `compileQuery` alongside the existing imports. Run `npm test` — red, because neither function exists yet.

2. **`src/data/projectSearch.ts`** — add, in this order, after `findMatches`:
   - `LINE_SPLIT_KEEPING_ENDINGS` and `splitKeepingLineEndings`, from `## Internal Structure`.
   - `resolveReplacement`, `replaceLineAllSubstring`, `replaceLineAllRegexp`, `replaceLineAll` (all private).
   - `export function replaceAllInText` and, after it, `replaceOneOnLine` (private) and `export function replaceOneInText`, all from `## Internal Structure`, each exported function with the TSDoc from `## Public API`.

   Run `npm test` — the two new suites are green.

3. **`tests/searchResults.test.ts`** — add one `searchSummaryText` case for `{ phase: 'replacing', matchCount: 0, fileCount: 0, filesSearched: 0 }` → `'Replacing…'`. Run `npm test` — red.

4. **`src/explorer/searchResults.ts`** — add `'replacing'` to `SearchStatus.phase`, between `'running'` and `'failed'`, add `case 'replacing': return 'Replacing…'` to `searchSummaryText`'s switch, and add `export` to `pluralize`'s declaration. Run `npm test` — green.

5. **`src/explorer/searchReplacePrompt.ts`** (new file) — modelled on [`src/explorer/fileTreePrompts.ts:139`](src/explorer/fileTreePrompts.ts#L139)'s `confirmDelete`:

   ```typescript
   import { Dialog } from '@jimka/typescript-ui/overlay'
   import { pluralize } from './searchResults'

   export async function confirmReplaceAll(matchCount: number, fileCount: number): Promise<boolean> {
       const result = await Dialog.show({
           title: 'Replace All?',
           message: `Replace ${pluralize(matchCount, 'match', 'matches')} in `
               + `${pluralize(fileCount, 'file', 'files')}? Files open in a tab are edited there — `
               + `undo with Ctrl/Cmd+Z and save when ready. Files not open are written to disk `
               + `immediately and can't be undone.`,
           buttons: [
               { text: 'Cancel', result: 'cancel' },
               { text: 'Replace All', result: 'confirm', primary: true },
           ],
       })

       return result === 'confirm'
   }
   ```

6. **`src/main.ts`** — import `right_left` from `@jimka/typescript-ui/glyphs/solid/right_left` and add it to the `Glyph.register(...)` call (line 32–35), anywhere in the list. Update the comment above the call (line 29–31) to mention the Search panel's replace actions alongside the shell/tree/prompt glyphs it already names.

7. **`src/EditorController.ts`**:
   - Extend the type import at line 10 with `SearchMatch` and `CompiledQuery`: `import type { MatchLocation, SearchMatch, CompiledQuery } from './data/projectSearch'`.
   - Add a value import beneath it: `import { replaceAllInText, replaceOneInText, isProbablyBinary } from './data/projectSearch'`.
   - Add `findOpenFile`, `performReplaceInFile`, `replaceInFile`, `replaceEverywhere`, and `replaceMatch` from `## Internal Structure`, each public method with the JSDoc from `## Public API`. Place `findOpenFile` next to `getActiveFile` (line 852); place the other four as a group after `save` (line 679), before `saveDialogDefault` (line 715).
   - Extend the class doc comment (line 42–47): "...every editor command (open/save/close/format/replace)."

   Run `npm run typecheck` — clean.

8. **`src/explorer/SearchPanel.ts`**:
   - Add `Button` to a new import: `import { Button } from '@jimka/typescript-ui/component/button'`.
   - Add `Menu, Notification` to a new import: `import { Menu, Notification } from '@jimka/typescript-ui/overlay'`.
   - Extend the value import from `./searchResults` (currently `searchResultNodes, searchSummaryText`) with `pluralize`.
   - Add `import { confirmReplaceAll } from './searchReplacePrompt'`.
   - Extend the type import from `../data/projectSearch` (carrying `SearchMatch, SearchLimits, ReadFileText, SearchQuery` once the search plan lands) with `CompiledQuery`.
   - Add the three callbacks to `SearchPanelParams` from `## Public API`, between `onCommitFile` and `projectRoot`.
   - Module constants beside the search plan's own `TOGGLE_SPACING`: `REPLACE_PLACEHOLDER = 'Replace'` (CodeMirror's own replace-field placeholder, verbatim — `node_modules/@codemirror/search/dist/index.js:1070`), `REPLACE_ALL_LABEL = 'Replace All'`, `REPLACE_GLYPH = 'right-left'`.
   - Two new private readonly fields, `_replaceField: TextField` and `_replaceAllButton: Button`, after the search plan's `_regexpToggle`; three new private readonly callback fields, `_onReplaceMatch`, `_onReplaceInFile`, `_onReplaceEverywhere`, typed from `SearchPanelParams`; `private readonly _menu = Menu()`; `private _activeQuery: CompiledQuery | null = null`.
   - Build `replaceField`, `replaceAllButton`, and `replaceRow` from `## Internal Structure` among the constructor's pre-`super` locals, after the search plan's `toggleRow`, and add `replaceRow` to the `components` array between `toggleRow` and `statusText`.
   - Assign the five new fields beside the existing constructor assignments, and initialise `replaceAllButton.setEnabled(false)` there (matches `_matches` starting empty).
   - Wire `replaceAllButton.on('action', () => { void this.applyReplaceAll() })` and `this._resultsTree.on('contextmenu', this.handleContextMenu)` beside the existing listener registrations.
   - Replace the two `paintStatus`/early-return branches in `runSearch` with the `## Internal Structure` version that also sets `_activeQuery`.
   - Add `this.syncReplaceAllEnabled()` as the last line of both `flushResults` and `clearResults`.
   - In `setProjectRoot`, add `this._replaceField.setValue('')` beside its existing `this._queryField.setValue('')` call, and add `this._activeQuery = null` beside its existing `this.clearResults()`/`this.paintStatus(IDLE_STATUS)` calls — the replace field resets exactly when the query field does.
   - Add `handleContextMenu`, `applyMatchReplace`, `applyFileReplace`, `applyReplaceAll`, and `syncReplaceAllEnabled` from `## Internal Structure`, placed after `handleDblClick`.
   - Update the class doc comment to mention the replace field and its three actions.

   Run `npm run typecheck` — clean. Run `npm test` — all suites green.

9. **`src/shell/EditorShell.ts`**:
   - Extend the type import at line 17 (`import type { SearchMatch } from '../data/projectSearch'`) with `CompiledQuery`.
   - Add three new fields to the `SearchPanel({...})` call (line 153–167), after `onCommitFile`:
     ```typescript
     onReplaceMatch: (match: SearchMatch, compiled: CompiledQuery, replacement: string) =>
         controller.replaceMatch(match, compiled, replacement),
     onReplaceInFile: (path: string, compiled: CompiledQuery, replacement: string) =>
         controller.replaceInFile(path, compiled, replacement),
     onReplaceEverywhere: (paths: readonly string[], compiled: CompiledQuery, replacement: string) =>
         controller.replaceEverywhere(paths, compiled, replacement),
     ```

   Run `npm run typecheck` — clean.

10. **`README.md`** — append to the end of the **Project search** bullet ([`README.md:54`](README.md#L54), as rewritten by the search plan's own step 6): "A **Replace** field below the toggles holds the replacement text; right-clicking a match leaf offers **Replace**, and a file branch offers **Replace All in File** — each applies immediately, editing an open file's own buffer (undo it there, and save when ready) or writing a closed file straight to disk. The panel's own **Replace All** button confirms the count, then applies the same replacement to every match currently listed."

11. **`TODO.md`** — delete the **Project-wide replace** bullet outright ([`TODO.md:14`](TODO.md#L14)–[`:19`](TODO.md#L19)).

12. **Checkpoints** — `grep -rn 'Project-wide replace' TODO.md` expects zero matches; `grep -rln 'replaceAllInText\|replaceOneInText' src/` expects exactly two files (`data/projectSearch.ts`, `EditorController.ts`); `grep -rn "'right-left'" src/main.ts` expects one match.

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Modify | `src/data/projectSearch.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `src/explorer/SearchPanel.ts` |
| Modify | `src/explorer/searchResults.ts` |
| Create | `src/explorer/searchReplacePrompt.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `src/main.ts` |
| Modify | `tests/projectSearch.test.ts` |
| Modify | `tests/searchResults.test.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Unit-testable — `tests/projectSearch.test.ts`

`replaceAllInText`, `compiled` built via `compileQuery`:

| Text | `SearchQuery` | `replacement` | Result text | `count` |
| --- | --- | --- | --- | --- |
| `const Foo = foo` | `{text:'foo',caseSensitive:false,regexp:false}` | `X` | `const X = X` | 2 |
| `const Foo = foo` | `{text:'foo',caseSensitive:true,regexp:false}` | `X` | `const Foo = X` | 1 |
| `x=5` | `{text:'(\\w+)=(\\d+)',caseSensitive:false,regexp:true}` | `$2=$1` | `5=x` | 1 |
| `foo` | `{text:'foo',caseSensitive:false,regexp:true}` | `[$&]` | `[foo]` | 1 |
| `foo` | `{text:'foo',caseSensitive:false,regexp:true}` | `$$1` | `$1` | 1 |
| `ab` | `{text:'x*',caseSensitive:false,regexp:true}` | `Y` | `ab` (unchanged, same reference) | 0 |
| `foo\r\nfoo\n` | `{text:'foo',caseSensitive:false,regexp:false}` | `X` | `X\r\nX\n` | 2 |
| `foo\nbar` | `{text:'foo\\nbar',caseSensitive:false,regexp:true}` | `X` | `foo\nbar` (unchanged) | 0 |
| `nothing` | `{text:'zzz',caseSensitive:false,regexp:false}` | `X` | `nothing` (unchanged, same reference) | 0 |

`replaceOneInText`, `compiled` built via `compileQuery`:

| Text | `at` | `SearchQuery` | `replacement` | Result |
| --- | --- | --- | --- | --- |
| `const foo = 1` | `{line:1,column:6,length:3}` | `{text:'foo',caseSensitive:false,regexp:false}` | `bar` | `const bar = 1` |
| `const bar = 1` | `{line:1,column:6,length:3}` | `{text:'foo',caseSensitive:false,regexp:false}` | `bar` | `null` (content moved) |
| `only one line` | `{line:5,column:0,length:1}` | `{text:'a',caseSensitive:false,regexp:false}` | `X` | `null` (line doesn't exist) |
| `a=1 b=2` | `{line:1,column:4,length:3}` | `{text:'(\\w)=(\\d)',caseSensitive:false,regexp:true}` | `$2=$1` | `a=1 2=b` (only the targeted occurrence changes) |
| `Foo foo` | `{line:1,column:4,length:3}` | `{text:'foo',caseSensitive:true,regexp:false}` | `X` | `Foo X` |

### Unit-testable — `tests/searchResults.test.ts`

`searchSummaryText({ phase: 'replacing', matchCount: 0, fileCount: 0, filesSearched: 0 })` is `'Replacing…'`.

### Manual verification — the live app (`npm run tauri:dev`)

`EditorController`'s and `SearchPanel`'s changes have no automated coverage — same as every other controller/panel method in this codebase (there is no `EditorController.test.ts` or `SearchPanel.test.ts`). Verify by hand in the Search view with Loom's own repository open as the project.

| Action | Expected |
| --- | --- |
| Open the Search view, type a query with results | A **Replace** field and a **Replace All** button sit below the toggles; the button is enabled |
| Clear the query field | Replace All disables again |
| Type a replacement, right-click a match leaf | A context menu offers **Replace** only |
| Click **Replace** on a match in a file that is *not* open | The file is rewritten on disk; the search re-runs and that match is gone; the file's other line endings are untouched (check `git diff`) |
| Click **Replace** on a match in a file that *is* open, with unsaved changes elsewhere in it | The buffer updates in place, keeping the unsaved changes; the tab shows its dirty dot; Ctrl/Cmd+Z undoes just the replacement |
| Edit the target line yourself, then click **Replace** on a now-stale match before re-running search | Nothing changes; no dialog |
| Right-click a file branch | A context menu offers **Replace All in File** only |
| Click **Replace All in File** on an open file | Every occurrence in that file's buffer is replaced in one edit; the tab dirties; the search re-runs |
| Click **Replace All in File** on a closed file | Every occurrence is written to disk in one pass; the file's other content and line endings are untouched |
| Click the panel's **Replace All** button | A dialog names the match and file counts and warns that closed files can't be undone |
| Cancel that dialog | Nothing is touched |
| Confirm it | The status line reads `Replacing…`, then a toast reports how many matches were replaced in how many files, then the tree refreshes to the post-replace state |
| Run Replace All with a regex query using `$1` in the replacement | Every file's occurrences substitute their own captured groups correctly |
| Run Replace All, then look at a file that was open and dirty before the run | Its buffer was edited (undoable there); a file that was closed was written straight to disk |
| Make one target file read-only at the OS level, then Replace All | A single dialog at the end names that one file; every other file still got its replacement |
| Replace with an empty replacement field | Every matched occurrence is deleted, exactly like CodeMirror's own in-file Replace All with an empty replace field |
| Switch projects mid-session | The replace field, like the query field, clears; Replace All disables |

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — all suites pass, including the two new `projectSearch` suites and the widened `searchResults` suite.
- `npm run build` — clean.
- `grep -rn 'Project-wide replace' TODO.md` — zero matches.
- `grep -rln 'replaceAllInText\|replaceOneInText' src/` — exactly two files.
- `grep -n "'right-left'" src/main.ts` — one match.
- `npm run tauri:dev`, then walk the manual table above in the explorer's Search view.

---

## Documentation Impact

- `README.md` — the **Project search** bullet gains the replace field and its three actions (step 10).
- `TODO.md` — the **Project-wide replace** `## High` entry is deleted (step 11).
- No `@jimka/typescript-ui` API changes.

---

## Potential Challenges

- **Replace All writes files sequentially, one `await` at a time**, the same shape `searchFiles`' own walk already uses. A run touching close to the 200-match ceiling's worth of files could take a visible moment; the status line's `Replacing…` phase is the only feedback during that window, and there is no cancel — matching that a Delete or a multi-file Save-on-exit already has none either.
- **A regex whose replacement references a group number higher than the pattern has** falls back to the literal template text at that position (`resolveReplacement`'s final `return whole`), exactly like `@codemirror/search`'s own behaviour — not a Loom-specific gap.
- **`compiled.re` is one shared `RegExp` reused across every file and line of a run**, carrying the `g` flag and therefore a mutable `lastIndex`. `replaceLineAllRegexp` and `replaceOneOnLine` both reset it at the top of every line they process, the same discipline the search plan's own `regexpSpans` already established — a missed reset would show up as matches silently failing to replace from the second file onward.
- **A closed file's replace has no undo.** This is accepted and is why Replace All alone is confirmed — see `## Architecture Decisions`.

---

## Critical Files

| File | Why |
| --- | --- |
| [`src/data/projectSearch.ts`](src/data/projectSearch.ts) | `CompiledQuery`, `MatchLocation`, `LINE_SPLIT`, and `findMatches`'s own scanning shape this plan's replace functions mirror |
| [`src/EditorController.ts`](src/EditorController.ts) | `save`/`saveAs` (line 634, 679) for the write-and-error-dialog pattern reused; `_openFiles` (line 52) for the open-file registry |
| [`src/explorer/SearchPanel.ts`](src/explorer/SearchPanel.ts) | The panel this plan adds a row and a context menu to; `runSearch`'s existing `_runId` cancellation, which every apply's follow-up re-run relies on |
| [`src/explorer/FileTree.ts:126`](src/explorer/FileTree.ts#L126) | The context-menu precedent (`handleNodeContextMenu`, `buildFileMenuItems`) this plan's own per-match/per-file menus copy |
| [`src/explorer/fileTreePrompts.ts:139`](src/explorer/fileTreePrompts.ts#L139) | `confirmDelete` — the confirmation-dialog shape `confirmReplaceAll` copies |
| [`plans/implemented/reload-file-on-external-change.md`](plans/implemented/reload-file-on-external-change.md) | Established that `CodeEditor.setValue()` is a real, undoable, per-document write (its own `## Architecture Decisions` and `^setvalue-cost` footnote) — the fact this plan's open-file write path relies on |
| [`plans/project-search-regex-and-match-case.md`](project-search-regex-and-match-case.md) | The prerequisite this plan depends on: `SearchQuery`/`CompiledQuery`/`compileQuery`, and its own `^match-shape` note on why a replace pass re-verifies against fresh text rather than trusting stored match data |
| `node_modules/@codemirror/search/dist/index.js` | `StringQuery.getReplacement` (line 662) and `RegExpQuery.getReplacement` (line 727) — the exact replacement-template syntax mirrored; `SearchPanel`'s own replace-field placeholder (line 1070) |

---

## Non-Goals

- **Folder-level replace.** The results tree's context menu offers nothing on a folder branch — the TODO entry asks for per-match and per-file granularity only.
- **A toolbar "Replace" (single, advance-to-next) button.** The context menu's per-match **Replace** already covers this; a second, parallel control for the same action is redundant.
- **Preserving scroll or caret position on an open file's replace.** `setValue()` collapses both, the same accepted cost `reloadFromDisk` already carries.
- **Any cross-file undo.** Undo is per-open-file CodeMirror history only, or none at all for a closed file — see `## Architecture Decisions`.
- **A progress bar or cancel control for Replace All.** The status line's `Replacing…` phase is the only feedback; a run is bounded by the same ≤200-match ceiling search already has.
- **Interruptible or off-main-thread replace matching.** Inherits the search plan's own `## Non-Goals` on this exactly — a pathological pattern is no more or less contained here than it is during a search.
- **A setting to skip the Replace All confirmation.** Nothing in `src/data/settings.ts` gains a key.
- **Command-palette entry or keyboard shortcut for replace.** Ctrl/Cmd+Shift+F already reveals the Search view where the new field lives; nothing asks for a dedicated shortcut into it.

---

## Notes

[^context-menu-not-inline]: An inline per-row button (a custom `TreeNodeRenderer` positioning its own click target) was considered and rejected. `Tree`'s custom-renderer API positions "internal sub-components" but no code anywhere in Loom or its sibling SQLAdmin app has ever put an interactive control inside a tree row — the renderer is documented as never seeing the row's own selection or toggle handling, and adding a second click target inside a row already handled by `expandTrigger: 'click'` (a file branch already toggles open/closed on a plain click, per `SearchPanel`'s own class doc comment) risks fighting that existing gesture. The context menu is a proven, already-used pattern for exactly this "an action on this specific row" need, with zero new interaction-handling code.

[^why-buffer-not-disk]: The alternative — always writing to disk, then relying on `externalChangeOutcome`/the reload machinery to reconcile an open tab — was rejected. That machinery exists to resolve a genuine race (something *outside* Loom changed the file), and routing a replace through it would mean writing disk content that then has to be read back and diffed against a buffer Loom itself just invalidated, for no benefit: the buffer already holds the authoritative in-progress content, and writing to disk first only to immediately possibly discard that write (a "keep my changes" conflict outcome) would waste the write and risk a real editor-vs-disk race with no upside. Editing the buffer directly is also more correct: a dirty buffer's differences from disk are exactly the content the user is protecting, and this plan's replace should apply on top of them, not around them.

[^not-reload-precedent]: The obvious first instinct is to reuse `reload-file-on-external-change.md`'s conflict-prompt machinery (`externalChangeOutcome`, `promptExternalChange`) here, since it's the codebase's only other "disk vs. open buffer" story. It doesn't fit: that machinery exists because disk moved *out from under* the user without their say-so, and the prompt asks them to pick a side. A project-wide replace is the opposite — the user themselves triggered a project-wide edit that happens to include a file they have open — so the right mirror is CodeMirror's own in-file Replace All, which has never touched disk at all and never needed a prompt for this reason.

[^setvalue-undo]: `plans/implemented/reload-file-on-external-change.md`'s own `## Architecture Decisions` and `^setvalue-cost` footnote already established that `CodeEditor.setValue()`'s transaction is recorded by CodeMirror's `history()` extension, so a Ctrl/Cmd+Z after it restores the pre-write text. That plan used this fact to explain why a *reload* leaves one (unwanted but harmless) undo step behind; this plan relies on the exact same fact for the opposite, wanted reason — a replace *should* be one ordinary, undoable edit.

[^no-closed-file-undo]: VS Code can offer undo for a replace in a file that has no visible editor tab because it keeps a text-document model per URI independent of whether any tab shows it — every file it has ever touched has a live buffer somewhere. Loom's architecture is different by design: `EditorController._openFiles` *is* the complete set of files with any in-memory representation at all, and a file with no tab has no `FileEditor`, no `CodeEditor`, and therefore no `history()` to undo through. Building VS Code's model would mean giving every file in a project a buffer whether or not it's open — a much larger change than this feature calls for, and not something to introduce as a side effect of Replace.

[^why-not-per-file-dialog-in-bulk]: `EditorController.replaceInFile` (the single-target, context-menu-driven method) keeps its own `Dialog.error` because that mirrors `save`'s existing one-target-one-dialog shape exactly. `replaceEverywhere` calls the same underlying `performReplaceInFile` but bypasses that per-call dialog specifically because it can be called once per matching file in a project — up to the same ~200-file order of magnitude the search ceiling already allows — and `Dialog.show` awaits until dismissed, so N failures would mean N sequential blocking dialogs the user has to click through one at a time before the run can even finish.

---

## Implementation Notes

- **Step 12's own checkpoint (and the `## Verification` section's matching line), `grep -n "'right-left'" src/main.ts` expecting one match, does not hold as literally written.** `src/main.ts` registers the glyph via its imported, underscore-named binding (`import { right_left } from '@jimka/typescript-ui/glyphs/solid/right_left'`, then `Glyph.register(..., right_left, ...)`) — exactly the same pattern every other glyph in that file follows (e.g. `circle_info`, whose own kebab-case name `'circle-info'` likewise never appears as a quoted string in `main.ts`, only inside the glyph module itself and at whichever call site names it by string, `'circle-info'` in `EditorShell.ts`'s About button). The quoted string `'right-left'` does appear, once, where the plan's own step 8 puts it: `SearchPanel.ts`'s `REPLACE_GLYPH` constant. The underlying invariant the checkpoint was trying to pin down — the glyph is both registered and referenced by name exactly once each — holds; only the specific file named in the grep command was mistaken. Verified instead via `grep -n "right_left" src/main.ts` (one import, one `Glyph.register` argument) and `grep -n "'right-left'" src/explorer/SearchPanel.ts` (one match, the `REPLACE_GLYPH` declaration).
