---
depends-on: [file-search]
touches-shared: [src/EditorController.ts, src/editor/FileEditor.ts, src/editor/editorSearch.ts, src/shell/EditorShell.ts, src/shell/shortcuts.ts, src/shell/commands.ts, README.md, TODO.md]
---

# Project-Wide Search — Implementation Plan

## Overview

Ctrl/Cmd+Shift+F opens a **Search** section in the explorer sidebar: type a query, press Enter, and every matching line in the open project appears as a result row. Clicking a row opens that file and selects the matched text in it. This is the cross-file half of [`TODO.md:37`](TODO.md#L37)'s backlog entry; the in-file half already ships as CodeMirror's own find/replace bar.

Three source files are new. [`src/data/projectSearch.ts`](src/data/projectSearch.ts) walks a list of file paths, reads each one, and reports matches — a pure module taking its I/O as an injected parameter, exactly like [`src/data/fileIndex.ts:29`](src/data/fileIndex.ts#L29)'s `listFilesRecursive`, which supplies the paths. [`src/explorer/searchResults.ts`](src/explorer/searchResults.ts) turns a match into the row text the panel paints. [`src/explorer/SearchPanel.ts`](src/explorer/SearchPanel.ts) is the component: a query field over a results `List` over a status line.

Six existing source files change. [`src/editor/editorSearch.ts:42`](src/editor/editorSearch.ts#L42) gains a `revealRange` beside its existing `openFindPanel`, using the same live-`EditorView` seam. [`src/editor/FileEditor.ts:249`](src/editor/FileEditor.ts#L249) and [`src/EditorController.ts:412`](src/EditorController.ts#L412) carry the jump down to that seam. [`src/shell/shortcuts.ts:131`](src/shell/shortcuts.ts#L131) and [`src/shell/commands.ts:54`](src/shell/commands.ts#L54) add the chord and the palette entry, and [`src/shell/EditorShell.ts:449`](src/shell/EditorShell.ts#L449) adds the third accordion section and wires it all together.

Nothing about the tree, the tabs, or the save path changes.

---

## Architecture Decisions

### The results panel is a third section in the explorer accordion

`buildExplorerSections` ([`src/shell/EditorShell.ts:449`](src/shell/EditorShell.ts#L449)) gains a `searchSection`, and the explorer container gains a third child — the same two-line addition the properties panel made when it became the second section.[^panel-placement]

### The search section starts closed; the command opens and focuses it

The tree and properties sections both pass `initiallyOpen: true`; the search section passes `false`. Ctrl/Cmd+Shift+F un-collapses the explorer pane, calls `Accordion.openSection` on the search section, and focuses its query field.[^starts-closed]

### Matching runs in TypeScript, not in Rust

`searchFiles` reads each file through the existing `readFileText` ([`src/data/workspace.ts:125`](src/data/workspace.ts#L125)) and matches in the frontend. No new `#[tauri::command]`, no new capability permission, nothing added to `src-tauri/`.[^no-rust]

### Search scans exactly the files the editor can open

Reading through `readFileText` means the editor's own 5 MiB `MAX_OPEN_BYTES` guard ([`src/data/workspace.ts:38`](src/data/workspace.ts#L38)) is the size guard: a file too big to open is too big to search. A file that fails to read for any reason is skipped silently.[^size-guard]

### Binary files are detected by a NUL byte in the first 8000 characters

A file whose first 8000 decoded characters contain U+0000 is treated as binary and skipped. This is git's own rule, and it has to be Loom's own check — `readTextFile` decodes non-fatally, so a binary file arrives as a string full of replacement characters rather than as an error.[^binary]

### The searched file set is the command palette's file set

`listFilesRecursive` supplies the paths, so search covers exactly what Ctrl/Cmd+P lists: every file under the project root, with dotfiles and `.gitignore`-ignored paths excluded, regardless of the tree's *Show Hidden Files* / *Show Ignored Files* toggles.[^file-set]

### A run streams per file and is cancelled by the run that replaces it

`searchFiles` reports each file's matches through a callback as it goes, and checks a caller-supplied `isCancelled()` before each file. `SearchPanel` holds a run counter, bumps it on every new search and on a project switch, and its `isCancelled` closure compares against it — the staleness guard [`PropertiesPanel.loadInfo`](src/explorer/PropertiesPanel.ts#L98) already uses for a superseded metadata read.[^streaming]

### Search runs on Enter, not as you type

The query field runs a search when Enter is pressed. There is no input debounce and no search-as-you-type.[^on-enter]

### The query is a case-insensitive plain substring

No regular expressions, no match-case toggle, no whole-word toggle. A match is a case-insensitive substring of a single line.[^plain-substring]

### Ctrl/Cmd+Shift+F, through the existing `isCtrlChord` helper

`isFindInFilesChord` is `isCtrlChord(event, 'f', true)` and gets its own branch in `installAccelerators`, ahead of the Ctrl/Cmd+F branch. The chord was deliberately left unclaimed when in-file find shipped.[^chord]

### A jump addresses a line and a column, not a document offset

A match carries a 1-based line, a 0-based column within that line, and its length. `revealRange` resolves those against the *live* document and clamps them, rather than storing a raw offset taken from the disk text.[^line-not-offset]

### Project-wide replace is out of scope

This plan ships search only. Replace across files becomes its own `TODO.md` backlog entry.[^no-replace]

---

## Public API

New module `src/data/projectSearch.ts`:

```typescript
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

/** Characters of a file examined for a NUL byte before deciding it is binary. */
export const BINARY_SNIFF_CHARS: number

/** Longest `lineText` a match carries, in characters. */
export const MAX_LINE_PREVIEW_CHARS: number

export function isProbablyBinary(text: string): boolean

export function findMatches(path: string, text: string, query: string, limit: number): SearchMatch[]

export async function searchFiles(
    paths: readonly string[],
    query: string,
    readText: ReadFileText,
    onFileMatches: (matches: SearchMatch[]) => void,
    isCancelled: () => boolean,
    limits: SearchLimits,
): Promise<SearchOutcome>
```

New module `src/explorer/searchResults.ts`:

```typescript
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

export function searchResultRow(match: SearchMatch, root: string | null): SearchResultRow

export function searchSummaryText(status: SearchStatus): string
```

New module `src/explorer/SearchPanel.ts`:

```typescript
export interface SearchPanelParams {
    /** Every searchable file path in the open workspace, in walk order; resolves empty when no project is open. */
    listFiles: () => Promise<string[]>
    /** Reads one file as text; rejects for an unreadable or over-sized file. */
    readText: ReadFileText
    /** Fires when a result row is activated (Enter or a click). */
    onOpenMatch: (match: SearchMatch) => void
    /** The open project folder, or `null` when none is open — result labels are shown relative to it. */
    projectRoot: string | null
}

class SearchPanel extends Container {
    /** Repoints the panel at a new project folder, cancelling any run and clearing the results. */
    setProjectRoot(root: string | null): void
    /** Moves focus into the query field and selects whatever is in it. */
    focusQuery(): void
}
```

`src/editor/editorSearch.ts` — new export:

```typescript
/** Selects `at`'s range in `editor`, scrolls it into view, and focuses the editor. */
export function revealRange(editor: CodeEditor, at: MatchLocation): void
```

`src/editor/FileEditor.ts` — new public method on `FileEditor`:

```typescript
revealMatch(at: MatchLocation): void
```

`src/EditorController.ts` — new public method on `EditorController`:

```typescript
async openFileAt(path: string, at: MatchLocation): Promise<void>
```

`src/shell/shortcuts.ts` — new export, new predicate, new `AcceleratorActions` field:

```typescript
export const FIND_IN_FILES_SHORTCUT = 'Ctrl/Cmd+Shift+F'

export function isFindInFilesChord(event: KeyboardEvent): boolean

export interface AcceleratorActions {
    // ...existing fields unchanged...
    /** Ctrl/Cmd+Shift+F — opens and focuses the explorer's Search section. */
    onFindInFiles: () => void
}
```

`src/shell/commands.ts` — two new fields on `PaletteCommandActions`:

```typescript
export interface PaletteCommandActions {
    // ...existing fields unchanged...
    hasProjectRoot: () => boolean
    onFindInFiles: () => void
}
```

---

## Internal Structure

### Matching

`findMatches` splits on `/\r\n?|\n/` — CodeMirror's own default line splitter, so a reported line number addresses the same line the editor numbers — lowercases both the line and the query, and walks `indexOf` forward past each hit:

```typescript
if (query === '' || limit <= 0) {
    return []
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
```

| Text | Query | Matches (line, column) | Why |
|---|---|---|---|
| `const Foo = foo` | `foo` | (1, 6), (1, 12) | matching is case-insensitive, so `Foo` hits too |
| `aaaa` | `aa` | (1, 0), (1, 2) | scanning resumes *after* each hit, so matches never overlap |
| `a\r\nb` | `b` | (2, 0) | `\r\n` splits as one line break, and the `\r` is not part of line 1 |
| `abc` | `zzz` | none | no hit anywhere in the file |

A file `findMatches` never sees is a separate matter: `searchFiles` drops a binary or unreadable file before it gets this far.

`previewOf` trims the line and truncates it:

| Line | `lineText` |
|---|---|
| `    return baseName(trimmed)` | `return baseName(trimmed)` |
| a 300-character minified line | its first 120 characters, then `…` |

### The walk

```typescript
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
```

`await readText(path)` is what makes the run streaming rather than blocking: every file's read yields to the event loop, so the rows `onFileMatches` already appended are painted while the walk continues.

### Row text

`searchResultRow` builds the label from the project-relative path, the line number, and the preview, joined by the `·` separator the status bar already uses for its caret readout:

| Match | Root | `label` | `tooltip` |
|---|---|---|---|
| `/p/src/data/paths.ts`, line 42, `return baseName(trimmed)` | `/p` | `src/data/paths.ts:42 · return baseName(trimmed)` | `src/data/paths.ts:42` |

`key` is `` `${path}:${line}:${column}` `` — unique, because no two matches share a file, a line, and a column. `glyph` is `glyphNameForPath(match.path)`, the same per-file-type icon the tree and the palette paint.

### Status line

| `phase` | `matchCount` | `fileCount` | `filesSearched` | Text |
|---|---|---|---|---|
| `idle` | 0 | 0 | 0 | `Enter a query to search the project.` |
| `running` | — | — | — | `Searching…` |
| `failed` | — | — | — | `Could not read the project folder.` |
| `complete` | 0 | 0 | 40 | `No matches.` |
| `complete` | 1 | 1 | 40 | `1 match in 1 file` |
| `complete` | 37 | 12 | 512 | `37 matches in 12 files` |
| `match-limit` | 200 | 46 | 512 | `First 200 matches in 46 files — narrow the query.` |
| `file-limit` | 37 | 12 | 2000 | `37 matches in 12 files — stopped after 2000 files.` |

`SearchStatus.phase` has no `'cancelled'` member: a cancelled run's panel is immediately repainted by the run that replaced it, so `searchSummaryText` never sees one.

### Revealing a match

```typescript
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
```

`Component.onFirstLayout` is the library's "mounted and sized" signal: it runs the callback after this component's first connected layout, and — when the component has already laid out — defers it to the next layout flush. Either way the callback runs after the tab a freshly-opened file landed in has been laid out, which is what a newly-created `CodeEditor` needs before `resolveView` can find a live view at all.

The three `Math.min` calls are what make a stale match safe: the file may have changed on disk since the run, so a line past the end of the document, or a column past the end of its line, lands at the nearest valid position instead of throwing a CodeMirror range error.

---

## Ordered Implementation Steps

1. **Create `tests/projectSearch.test.ts`** covering `## Expected Behaviour`'s unit tables for `isProbablyBinary`, `findMatches`, and `searchFiles`. Follow [`tests/fileIndex.test.ts`](tests/fileIndex.test.ts)'s style: plain `describe`/`it`/`expect`, with an in-memory `Map<string, string>` backing a fake `readText` (`async path => { const text = files.get(path); if (text === undefined) { throw new Error('unreadable') } return text }`). Run `npm test` — the new suite fails because `src/data/projectSearch.ts` does not exist. That is the red step.

2. **Create `src/data/projectSearch.ts`** with the types from `## Public API` and the bodies from `## Internal Structure`. Add a file-header comment saying the module takes its file reading as an injected parameter so the walking and matching get real vitest coverage — the sentence [`src/data/fileIndex.ts`](src/data/fileIndex.ts)'s own header carries. Constants, each with the "what" in its name and the "why" in its comment:
   - `BINARY_SNIFF_CHARS = 8000` — git's `buffer_is_binary` examines the first 8000 *bytes*; Loom examines the first 8000 *characters* because the read has already decoded the file into a string.
   - `MAX_LINE_PREVIEW_CHARS = 120` — long enough to show a statement in context, short enough that one minified line cannot fill the results panel.
   - `LINE_SPLIT = /\r\n?|\n/` — CodeMirror's own default line splitter (`EditorState.create` normalises line endings with it), so a reported line number addresses the line the editor numbers.

   `isProbablyBinary` is `text.slice(0, BINARY_SNIFF_CHARS).includes('\u0000')` — the slice bounds the scan on a file with no NUL at all.

   Run `npm test` — green.

3. **Create `tests/searchResults.test.ts`** covering the `searchResultRow` and `searchSummaryText` tables in `## Expected Behaviour`. Follow [`tests/cursorLabel.test.ts`](tests/cursorLabel.test.ts)'s one-assertion-per-case style. Run `npm test` — red.

4. **Create `src/explorer/searchResults.ts`** with the types and functions from `## Public API`, built from `relativeTo` ([`src/data/paths.ts:162`](src/data/paths.ts#L162)) and `glyphNameForPath` ([`src/fileIcons.ts:121`](src/fileIcons.ts#L121)). The relative-path fallback is `relativeTo(root, match.path) ?? match.path`, mirroring [`CommandPalette.displayLabel`](src/shell/CommandPalette.ts#L183). Run `npm test` — green.

5. **`src/editor/editorSearch.ts`** — add the `revealRange` from `## Internal Structure` after `openFindPanel`, importing `MatchLocation` from `../data/projectSearch`. Extend the module's header comment to say it now also positions the caret, since the library exposes the caret read-only.

6. **`src/editor/FileEditor.ts`** — import `revealRange` alongside the existing `openFindPanel` import (line 10) and add a public `revealMatch` immediately after `openFind` (line 255):

   ```typescript
   revealMatch(at: MatchLocation): void {
       if (this._previewing) {
           this._previewToggle.setSelected(false)
           this.setPreviewing(false)
       }

       revealRange(this._editor, at)
   }
   ```

   Document why this leaves preview mode where `openFind` instead returns early: the caller asked for a specific position in the *source*, so showing the rendered preview would not answer the request. The two-line drop-out is the one [`syncPreviewAvailability`](src/editor/FileEditor.ts#L202) already uses, and `setSelected` does not re-fire the toggle's `"action"` event.

7. **`src/EditorController.ts`** — import `MatchLocation` from `./data/projectSearch` and add `openFileAt` immediately after `openFile` (line 471):

   ```typescript
   async openFileAt(path: string, at: MatchLocation): Promise<void> {
       await this.openFile(path, 'permanent')

       this._openFiles.find(candidate => candidate.getPath() === path)?.revealMatch(at)
   }
   ```

   Document that the registry is re-read rather than trusting the active tab, so a file whose read failed — `openFile` has already shown its `Dialog.error` and opened nothing — reveals nothing instead of scrolling whichever tab happened to stay active.

8. **Create `src/explorer/SearchPanel.ts`.** A `Container` laid out by `VBox({ spacing: 4, stretching: true })`, with `insets: new Insets(PANEL_PAD, PANEL_PAD, PANEL_PAD, PANEL_PAD)` and `preferredSize: { width: 0, height: PANEL_HEIGHT_PX }` — the zero-in-the-axis-it-does-not-constrain spelling `EXPLORER_PREFERRED_SIZE` ([`src/shell/EditorShell.ts:55`](src/shell/EditorShell.ts#L55)) already uses. Three children: a `TextField` (placeholder `Search project (Enter)`), a `List` carrying `constraints: { weight: 1 }`, and a status `new Text('', { truncate: true, foregroundColor: STATUS_COLOR })`. Model the construction on [`CommandPalette`](src/shell/CommandPalette.ts#L44) — same `VBox`, same `weight: 1` on the list, same `rendererFactory: () => new GlyphListItemRenderer()`, same `setSelectFollowsFocus(false)` — and the insets and muted colour on [`PropertiesPanel`](src/explorer/PropertiesPanel.ts#L20). Leave `setFocusOnRowClick` at its default: the palette turns it off to keep focus in its own query field, whereas here a clicked result hands focus to the editor anyway. Constants:
   - `SEARCH_LIMITS = { maxMatches: 200, maxFiles: 2000 }` — `List` renders every row (it is not virtualised the way `Tree` is), so 200 is what stops a broad query from building thousands of row components in a sidebar; it is four times [`MAX_PALETTE_RESULTS`](src/shell/CommandPalette.ts#L17), which is 50 because a popup is scanned by eye rather than scrolled. 2000 files is the read ceiling: `readFileText` costs two IPC round trips per file, so a folder larger than that stops being a search and starts feeling like a hang.
   - `PANEL_HEIGHT_PX = 280` — the query field, ten 22px `List` rows, and the status line. The section carries no accordion weight, so this is the height it keeps while the tree absorbs the sidebar's leftover space.
   - `PANEL_PAD = 6` — matches `PropertiesPanel`'s own `PANEL_PAD` so the sidebar's sections indent their content by one amount.
   - `STATUS_COLOR = 'rgb(140, 140, 140)'` — the same muted grey `PropertiesPanel` and `WelcomeScreen` paint their hint lines.

   Private state: `_matches: SearchMatch[]`, `_rows: SearchResultRow[]` (index-aligned with `_matches`), `_root: string | null`, `_runId = 0`. One private `paintStatus(status: SearchStatus): void` writes `searchSummaryText(status)` into the status `Text`; it is the only thing that ever calls `setText` on it.

   Behaviour:
   - The query field's `"keydown"` (wired with `Event.addListener`, as `CommandPalette` does) runs the search on `Enter`, and forwards `ArrowDown`/`ArrowUp` into `this._resultsList.handleKey(e)`, calling `preventDefault()` when the list consumed the key — [`CommandPalette.handleKeyDown`](src/shell/CommandPalette.ts#L194)'s shape, with Enter re-pointed at the search instead of at a commit.
   - `runSearch()` reads `const query = this._queryField.getValue()`, bumps `_runId`, captures it in a local `runId`, and clears `_matches`, `_rows`, and the list. An empty `query` then paints `'idle'` and returns without touching disk. Otherwise it paints `'running'`, `await`s `params.listFiles()` inside a `try`/`catch` (a rejection paints `'failed'` and returns), then awaits `searchFiles(files, query, params.readText, batch => this.appendMatches(batch), () => this._runId !== runId, SEARCH_LIMITS)`. A run whose `completion` is `'cancelled'`, or that returns while `this._runId !== runId`, paints nothing at all — the run that superseded it owns the panel now; anything else paints its outcome's phase.
   - `appendMatches(batch)` pushes onto `_matches`, pushes each `searchResultRow(match, this._root)` onto `_rows`, calls `setItemsArray(this._rows)`, and calls `setFocusedIndex(0)` **only when the list was previously empty** — so a streamed batch never yanks the highlight back while the user is arrowing through results.
   - The list's `"action"` event resolves the row by key (`const index = this._rows.findIndex(row => row.key === this._resultsList.getValue())`) and calls `params.onOpenMatch(this._matches[index])` when `index !== -1`, mirroring [`CommandPalette.handleCommit`](src/shell/CommandPalette.ts#L208).
   - `setProjectRoot(root)` bumps `_runId`, records `root`, clears the query, the matches, the rows, and the list, and paints `'idle'`.
   - `focusQuery()` is `this._queryField.onFirstLayout(() => { this._queryField.focus(); this._queryField.select() })` — deferred, because the section's content may not be laid out yet on the tick the section is opened, and `select()` with no arguments selects the whole field so re-invoking the command replaces the previous query.
   - `protected destructor()` bumps `_runId` before `super.destructor()`, so a walk in flight stops reporting into a torn-down panel — the shape [`FileEditor.destructor`](src/editor/FileEditor.ts#L343) uses for its pending preview refresh.

   Export via the `callable(...)` wrapper the other components use.

9. **`src/shell/shortcuts.ts`** — add, in the places matching the existing layout:
   - `export const FIND_IN_FILES_SHORTCUT = 'Ctrl/Cmd+Shift+F'` after `FIND_SHORTCUT` (line 27).
   - `isFindInFilesChord`, `isCtrlChord(event, 'f', true)`, after `isFindChord` (line 82).
   - `onFindInFiles: () => void` on `AcceleratorActions` after `onFind` (line 114), documented `/** Ctrl/Cmd+Shift+F — opens and focuses the explorer's Search section. */`.
   - `} else if (isFindInFilesChord(event)) { actions.onFindInFiles() }` in `installAccelerators` **before** the `isFindChord` branch (line 147), matching the Save-As-before-Save ordering the function already uses for a Shift variant.

   Run `npm run typecheck` — it now **fails** on `EditorShell.ts`'s `actions` literal, which does not yet supply `onFindInFiles`. Step 11 fixes it; do not add a stub.

10. **`src/shell/commands.ts`** — import `FIND_IN_FILES_SHORTCUT`, add `hasProjectRoot: () => boolean` and `onFindInFiles: () => void` to `PaletteCommandActions` (after `onFind`, line 40), and push the command in its own block after the existing `hasActiveFile()` block (line 71):

    ```typescript
    if (actions.hasProjectRoot()) {
        commands.push({ id: 'find-in-files', title: 'Find in Files…', shortcut: FIND_IN_FILES_SHORTCUT, run: actions.onFindInFiles })
    }
    ```

11. **`src/shell/EditorShell.ts`** — the wiring:
    - Add module constants beside the existing section constants (line 42): `const SEARCH_SECTION_LABEL = 'Search'` and `const SEARCH_SECTION_INDEX = 2` (the accordion's third child, after the tree and the properties panel), documented the way `EXPLORER_PANE_INDEX` (line 35) is.
    - Add `searchSection: AccordionConstraints` to the `ExplorerSections` interface, and `new AccordionConstraints(SEARCH_SECTION_LABEL, false, 'magnifying-glass')` to `buildExplorerSections`'s return (line 449). The `false` is the section's `initiallyOpen`; `magnifying-glass` is already registered in [`src/main.ts:33`](src/main.ts#L33).
    - Add a module-level helper next to `buildExplorerSections`, and call it from `openCommandPalette` (its inline `root !== null ? … : []` expression at lines 396–399) in place of that expression:

      ```typescript
      async function listWorkspaceFiles(root: string | null): Promise<string[]> {
          return root === null ? [] : listFilesRecursive(root, listDirectory, tryReadTextFile, pathExists)
      }
      ```

    - Build the panel among the constructor's pre-`super` locals, after the two `tree.setShowHidden` / `setShowIgnored` calls (line 123) and before `welcome` — it closes over `tree`, so it must come after `tree` exists:

      ```typescript
      const searchPanel = SearchPanel({
          listFiles: () => listWorkspaceFiles(tree.getProjectRoot()),
          readText: readFileText,
          onOpenMatch: (match: SearchMatch) => { void controller.openFileAt(match.path, match) },
          projectRoot: session.projectRoot,
      })
      ```

      Add `readFileText` to the `../data/workspace` import (line 24), import `SearchPanel` from `../explorer/SearchPanel`, and import the `SearchMatch` type from `../data/projectSearch`.
    - Add `explorer.addComponent(searchPanel, initialSections.searchSection)` after the properties panel's own line (line 147).
    - Hold the live accordion in a `let accordion = initialSections.accordion` beside `relabelTreeSection` (line 167), reassign it inside that closure (`accordion = sections.accordion`), and add `explorer.setLayoutConstraints(searchPanel, sections.searchSection)` alongside the other two. Extend that closure's doc comment: rebuilding the accordion also re-closes the search section, which is correct — a project switch invalidates the results anyway.
    - Add a second pre-`super` closure after `relabelTreeSection` and before the `actions` literal (line 180):

      ```typescript
      const revealSearchSection = (): void => {
          split.setPaneCollapsed(EXPLORER_PANE_INDEX, false)
          accordion.openSection(SEARCH_SECTION_INDEX)
          searchPanel.focusQuery()
      }
      ```

    - Add `onFindInFiles: revealSearchSection,` to the `actions` literal, after `onFind` (line 187).
    - Add `searchPanel.setProjectRoot(openedRoot)` beside `properties.setProjectRoot(openedRoot)` in the project-root listener's `finally` block (line 248).
    - Add the Edit-menu item after *Find…* (line 518):

      ```typescript
      { text: 'Find in Files…', glyph: 'magnifying-glass', shortcut: FIND_IN_FILES_SHORTCUT, enabled: actions.hasProjectRoot(), action: actions.onFindInFiles },
      ```

      and add `FIND_IN_FILES_SHORTCUT` to the `./shortcuts` import list (line 30).

    Run `npm run typecheck` — green again.

12. **`README.md`** — insert a **Project search** bullet in `## Highlights` immediately after the **Find & replace** bullet (line 46): Ctrl/Cmd+Shift+F opens a Search section in the explorer sidebar, Enter runs a case-insensitive search over every file the command palette lists, results stream in as `path:line · matched line`, and clicking one opens the file with the match selected. Mention the size and binary guards in one clause.

13. **`TODO.md`** — three edits:
    - Delete the `## High` section's **Cross-file (project-wide) search** bullet (lines 37–43) outright.
    - Add a `## Medium` bullet, **Project-wide replace**, listing what it still needs: a replace field on the search panel, per-match and per-file apply, writing files that are not open in tabs, reconciling a replacement against a tab with unsaved changes, and an undo story CodeMirror's per-document history does not provide across files. Add a second `## Medium` bullet, **Regular-expression and match-case project search**, noting the panel matches a case-insensitive plain substring today.
    - Rewrite the `## Low` **Go to Line** bullet (lines 84–88): its stated blocker — "the library exposes the caret read-only (no `setCursorPosition`), so a jump-to-line would need a new library API first" — no longer holds, because `src/editor/editorSearch.ts`'s `revealRange` now positions the caret through the same live-`EditorView` seam the find panel uses. What is left is a prompt for the line number and a call into it.

14. **Checkpoints** — `grep -rn 'onFindInFiles' src/` expects exactly three files (`shortcuts.ts`, `commands.ts`, `EditorShell.ts`); `grep -rn 'revealRange' src/` expects exactly two (`editorSearch.ts`, `FileEditor.ts`); `grep -rn 'openFileAt' src/` expects exactly two (`EditorController.ts`, `EditorShell.ts`); `grep -rn 'Cross-file (project-wide) search' TODO.md README.md` expects zero matches.

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Create | `src/data/projectSearch.ts` |
| Create | `src/explorer/searchResults.ts` |
| Create | `src/explorer/SearchPanel.ts` |
| Create | `tests/projectSearch.test.ts` |
| Create | `tests/searchResults.test.ts` |
| Modify | `src/editor/editorSearch.ts` |
| Modify | `src/editor/FileEditor.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `src/shell/shortcuts.ts` |
| Modify | `src/shell/commands.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Unit-testable — `tests/projectSearch.test.ts`

`isProbablyBinary`:

| Input | Result |
| --- | --- |
| `'const a = 1'` | `false` |
| `''` | `false` |
| `'x\u0000PNG'` | `true` |
| `'a'.repeat(8000) + '\u0000'` | `false` — the NUL sits past the 8000-character window |
| `'a'.repeat(7999) + '\u0000'` | `true` |

`findMatches` (called as `findMatches('/p/f.ts', text, query, 10)` unless the case says otherwise):

| Text | Query | Result |
| --- | --- | --- |
| `const Foo = foo` | `foo` | two matches: `(line 1, column 6)` and `(line 1, column 12)`, each `length: 3` |
| `aaaa` | `aa` | two matches: `(1, 0)` and `(1, 2)` |
| `a\r\nb` | `b` | one match at `(2, 0)` |
| `a\nb\nc` | `c` | one match at `(3, 0)` |
| `    return x` | `return` | one match whose `lineText` is `return x` |
| a 300-character line of `x` | `x` | with `limit` 1: one match whose `lineText` is 120 `x`s followed by `…` |
| `abc` | `` (empty) | no matches |
| `aaaa` | `a` | with `limit` 1: exactly one match |
| `abc` | `zzz` | no matches |

Every returned match carries `path` as `'/p/f.ts'`.

`searchFiles`, against a fake reader:

| Setup | Expected |
| --- | --- |
| two files, one matching | `completion: 'complete'`, `matchCount` 1, `fileCount` 1, `filesSearched` 2; `onFileMatches` called once |
| a file whose read rejects, then a matching file | the rejecting file is skipped, `filesSearched` counts both, the second file's matches are reported |
| a file containing `'x\u0000PNG'`, query `PNG` | no matches; `filesSearched` counts it |
| three matching files, `maxMatches: 2` | `completion: 'match-limit'`, `matchCount` exactly 2, and the walk stops — the third file is never read |
| five files, `maxFiles: 2` | `completion: 'file-limit'`, `filesSearched` 2 |
| `isCancelled` returning `true` on the second call | `completion: 'cancelled'`, and only the first file's matches were reported |
| empty query | `completion: 'complete'`, all counts 0, no file read |
| a file with no matches, then a matching file | `onFileMatches` is called once, never with an empty array |

### Unit-testable — `tests/searchResults.test.ts`

`searchResultRow`, for the match `{ path: '/p/src/data/paths.ts', line: 42, column: 11, length: 8, lineText: 'return baseName(trimmed)' }`:

| Root | `label` | `tooltip` |
| --- | --- | --- |
| `/p` | `src/data/paths.ts:42 · return baseName(trimmed)` | `src/data/paths.ts:42` |
| `null` | `/p/src/data/paths.ts:42 · return baseName(trimmed)` | `/p/src/data/paths.ts:42` |
| `/other` | `/p/src/data/paths.ts:42 · return baseName(trimmed)` | `/p/src/data/paths.ts:42` |

`key` for that match is `/p/src/data/paths.ts:42:11`, and `glyph` is whatever `glyphNameForPath('/p/src/data/paths.ts')` returns.

`searchSummaryText` — every row of the `## Internal Structure` status table, plus the singular/plural pair (`1 match in 1 file` versus `2 matches in 2 files`).

### Manual verification — the live app (`npm run tauri:dev`)

Everything below needs a mounted `CodeEditor`, a laid-out accordion, or real keyboard focus, none of which the node-environment vitest harness provides.

| Action | Expected |
| --- | --- |
| Ctrl/Cmd+Shift+F with a project open | The explorer pane expands if collapsed, the Search section opens, and the query field has focus |
| Ctrl/Cmd+Shift+F while the section is already open with a query in it | The query is selected, ready to be typed over; no second section, no re-run |
| Type a query, press Enter | The status line reads `Searching…`, then result rows appear and the final count replaces it |
| A query matching many files | Rows appear progressively, top file first, rather than all at once at the end |
| Arrow keys in the query field | Move the highlight through the results; nothing opens |
| Enter on a highlighted result, and a click on a result | Both open the file in a permanent tab with the matched text selected and scrolled into view, and focus lands in the editor |
| Click a result whose file is already open in a background tab | That tab activates and scrolls to the match; no second tab |
| Click a result whose file is open as the temp tab | The tab is pinned (its `~` prefix disappears) and scrolls to the match |
| Click a result in a Markdown file whose preview is showing | The preview toggle clears, the source shows, and the match is selected |
| Click a result after editing that file so the line moved | The jump lands on the nearest valid position; no console error |
| Delete a matched file outside the app, then click its result | `Could not open file` dialog; nothing else happens |
| Press Enter again with a new query while a run is still going | The old rows are replaced; no rows from the first run survive |
| Enter with an empty query | Results clear and the status line reads `Enter a query to search the project.` |
| Search a project containing a `.png` and a `.svg` | The `.svg` is searched (it is text); the `.png` produces no rows |
| Search a query matching more than 200 lines | Exactly 200 rows, and the status line names the cap |
| Search with no project folder open | The Edit menu's *Find in Files…* is greyed out and the palette omits the command; the chord still opens the section, and Enter on a query reports `No matches.` because there are no files to search |
| Open a different project folder while results are showing | The results and the query clear |
| Hover a truncated result row | The tooltip shows the project-relative path and line |
| Search a file with unsaved changes in a tab | The results reflect the file as it is **on disk**, not the buffer |
| *Edit > Find in Files…* and the palette's `> Find in Files…` | Both do exactly what the chord does |
| Ctrl/Cmd+F with a file open | Still opens CodeMirror's in-file panel — the two chords do not collide |

---

## Verification

- `npm run typecheck` — clean (expected to fail only between steps 9 and 11).
- `npm test` — the two new suites pass alongside the sixteen existing ones.
- `npm run build` — clean. No new dependency is added, so this is a regression check only.
- `grep -rn 'onFindInFiles' src/` — three files. `grep -rn 'revealRange' src/` — two. `grep -rn 'openFileAt' src/` — two.
- `grep -rn 'Cross-file (project-wide) search' TODO.md README.md` — zero matches.
- `npm run tauri:dev`, then walk the manual table. Open Loom's own repository as the project: it has a `.gitignore` excluding `node_modules`, a `.png` under `src-tauri/icons`, Markdown files with previews, and enough source files that streaming is visible.

---

## Documentation Impact

- `README.md` — `## Highlights` gains a **Project search** bullet (step 12). `## Architecture` is unchanged: the app still reaches the native shell only through `src/data/workspace.ts`, and no new dependency is added.
- `TODO.md` — the `## High` cross-file-search entry is deleted, two `## Medium` follow-up entries are added, and the `## Low` *Go to Line* entry's stated blocker is corrected (step 13).
- No library documentation changes. Nothing in `@jimka/typescript-ui` is modified.

---

## Potential Challenges

- **The editor may not be mounted when a jump is requested.** `CodeEditor` builds its `EditorView` on its first connected layout, so a file opened by a search result has no view during the tick that opens it. `revealRange` runs inside `Component.onFirstLayout`, which fires after that layout for a new editor and on the next layout flush for an existing one.
- **A lowercased character can be a different length than the original.** Matching compares `line.toLowerCase()` against `query.toLowerCase()`, and a few characters (Turkish dotted capital `İ`) lowercase to more than one character, which can shift a reported column by one on that line. `revealRange`'s clamp keeps the jump inside the line; no other handling is warranted for a case this rare.
- **A very large project is a long walk.** `readFileText` costs two IPC round trips per file, so a folder with thousands of files takes seconds even when nothing matches. The `maxFiles` ceiling stops the walk and the status line says so; a second Enter cancels the first run rather than interleaving with it.
- **Results go stale.** Nothing re-runs a search when the file watcher reports a change, so a result row can point at a line that has moved or a file that is gone. Both cases degrade rather than fail — the clamp for a moved line, `openFile`'s error dialog for a missing file.
- **`List` renders every row.** Unlike `Tree`, the list is not virtualised, which is what the 200-match ceiling is protecting. Do not raise it without moving the results onto a virtualised surface first.
- **The status `Text` must not be repainted per file.** `Text` auto-measures on every `setText`, which forces a synchronous document reflow whose cost scales with every open tab (see `TODO.md`'s standing forced-reflow note). The panel writes the status exactly twice per run — once when it starts, once when it ends — so the trap does not apply; do not add a per-file progress counter to it.

---

## Critical Files

| File | Why |
| --- | --- |
| [`src/data/fileIndex.ts`](src/data/fileIndex.ts) | `listFilesRecursive`, the path source, and the injected-I/O module shape `projectSearch.ts` copies |
| [`src/shell/CommandPalette.ts`](src/shell/CommandPalette.ts) | The `List` + `GlyphListItemRenderer` results UI, its `VBox` layout, and its key-forwarding and commit handlers |
| [`src/explorer/PropertiesPanel.ts`](src/explorer/PropertiesPanel.ts) | The other explorer section: its insets, its muted hint colour, its `setProjectRoot`, and its stale-response guard |
| [`src/explorer/entryProperties.ts`](src/explorer/entryProperties.ts) | The pure-formatting-module-beside-its-panel split `searchResults.ts` copies |
| [`src/shell/EditorShell.ts:449`](src/shell/EditorShell.ts#L449) | `buildExplorerSections`, `relabelTreeSection`, the `actions` literal, and the Edit menu |
| [`src/editor/editorSearch.ts`](src/editor/editorSearch.ts) | `resolveView`, the live-`EditorView` seam `revealRange` reuses |
| [`src/data/workspace.ts:125`](src/data/workspace.ts#L125) | `readFileText` and the `MAX_OPEN_BYTES` guard that doubles as the search size guard |
| [`src/shell/shortcuts.ts`](src/shell/shortcuts.ts) | `isCtrlChord`'s `shift` parameter and `installAccelerators`' branch order |
| [`plans/implemented/file-search.md`](plans/implemented/file-search.md) | The in-file half, whose Non-Goals scoped this plan and whose `[^chord]` footnote reserved Ctrl/Cmd+Shift+F |

---

## Non-Goals

- **Project-wide replace.** Search only; replace becomes its own backlog entry (step 13).
- **Regular expressions, match-case, and whole-word toggles.** The in-file panel gets these free from `@codemirror/search`; here each is Loom-side matching code plus a control in a narrow sidebar.
- **Search-as-you-type.** Enter runs the search.
- **A Rust or ripgrep backend.** Nothing is added to `src-tauri/`.
- **Grouped results.** Rows are flat and ordered by file, not a `Tree` with a header row per file and match rows under it.
- **Live results.** The file watcher does not re-run a finished search.
- **Searching unsaved buffers.** A run reads what is on disk.
- **Include/exclude filters.** The searched set is exactly what `listFilesRecursive` returns; there is no per-run glob and no honouring of the tree's *Show Hidden Files* / *Show Ignored Files* toggles.
- **Persisting the query or the section's open state.** Neither reaches `session.json` or `.loom/workspace.json`. The search section is closed on every launch and the other two are open on every launch, because nothing records section state — the gap `TODO.md`'s `## Low` entry on remembering explorer sections already tracks.
- **A Stop button.** A run is cancelled by the run that replaces it, by a project switch, or by the panel being torn down.
- **Go to Line.** Step 13 records that `revealRange` unblocks it; this plan adds no command, menu item, or palette entry for it.

---

## Notes

[^panel-placement]: The sidebar is the only place in Loom with an established multi-panel host, and the accordion is what makes a third panel a two-line change instead of a layout project. The alternatives were both worse. A third `Split` pane changes `paneSizes`' length, and `SessionState.paneSizes` is restored wholesale — a stored two-entry array would be discarded against a three-pane split, silently resetting every user's explorer width on upgrade. A `Border`-SOUTH panel under the editor deck (VS Code's Problems/Output shape) has no precedent anywhere in the shell and would need its own size persistence, collapse state, and toggle. A `PopupPanel` like `CommandPalette` is ruled out by the feature itself: the palette closes on activation, whereas search results must survive being clicked so the next result can be clicked too. The cost of the accordion is width — the pane starts at 300px, so a long row truncates; the row's tooltip carries the full project-relative path, and the split gutter already lets the user widen the pane.

[^starts-closed]: An empty results panel that occupies 280px of a sidebar on every launch is 280px taken from the tree for nothing. Starting closed also makes the reveal path the single entry point: one closure un-collapses the pane, opens the section, and focuses the field, so the chord, the Edit menu item, and the palette command cannot drift apart. Rebuilding the accordion — which `relabelTreeSection` does on every project-root change, because a section header's label can only be changed by rebuilding — re-closes the section, and that is the behaviour wanted: the results belonged to the previous project.

[^no-rust]: Rust would be faster, and it is what VS Code does by shelling out to ripgrep. It is also a different kind of change: `src-tauri/` today declares no `#[tauri::command]` at all, so a search command means a new IPC contract, a new capability permission in `capabilities/default.json`, an event channel for streaming partial results, and a second place where `.gitignore` semantics have to be implemented and kept in agreement with `src/data/gitignore.ts`. Loom's own convention runs the other way: `README.md` calls `src/data/workspace.ts` "the app's sole `@tauri-apps/*` entry point", and every piece of logic Loom owns — ignore-chain matching, fuzzy ranking, path arithmetic, session parsing — is a pure TypeScript module with vitest coverage. `listFilesRecursive` already walks an entire project from the frontend on every Ctrl/Cmd+P, so the frontend-walks-the-project pattern is established and measured. Reading each file adds an IPC round trip per file on top of that walk, which the `maxFiles` ceiling bounds; if that ceiling ever proves too low in practice, a ripgrep backend is the right next step and is recorded as a Non-Goal rather than half-built here.

[^size-guard]: Reusing `readFileText` rather than adding a second reader with its own threshold means there is one number, one place, and one rule to remember. `MAX_OPEN_BYTES` is 5 MiB and exists because `CodeEditor` wraps a single un-virtualised CodeMirror document; a file over it cannot be opened, so a search result pointing into one could not be acted on anyway. The cost is one extra IPC round trip per file — the stat, on top of the read — because `readFileText` sizes the file before it reads it. That is unavoidable: the only way to learn a file's size without a stat is to read it, which is exactly what the guard exists to prevent.

[^binary]: The obvious guard — let the read fail on a non-text file — does not exist. `@tauri-apps/plugin-fs`'s `readTextFile` invokes the Rust side for raw bytes and decodes them with a plain `TextDecoder`, which is non-fatal by default: invalid UTF-8 becomes U+FFFD and no error is ever raised. So a PNG arrives as a perfectly ordinary string. A NUL byte in the first 8000 bytes is git's own `buffer_is_binary` test, and it is the right one here for the same reason it is right there: text files essentially never contain U+0000, and binary formats essentially always do within their header. Loom applies it to the first 8000 *characters* of the decoded string rather than the first 8000 bytes, because the decode has already happened by the time the check runs. The residual case — a binary file with no NUL in its header — is scanned as text and may produce a junk row; git has the same blind spot, and the alternative (an extension allow-list) would mean a second table duplicating `fileIcons.ts`'s extension knowledge while getting `.svg` wrong in one direction and `.db` wrong in the other.

[^file-set]: `listFilesRecursive` fixes the show-hidden and show-ignored toggles off, which its own header comment records. Inheriting that gives search and the command palette one definition of "the files in this project", so a file the palette cannot open is a file search cannot surface. Threading the tree's live toggles through instead would make the searched set depend on a View-menu checkbox that is nowhere near the search panel, and would make two identical queries return different results for reasons the user cannot see from the panel.

[^streaming]: A whole-project read is the one operation in Loom long enough that the user can start a second one before the first finishes, so the two need to be ordered. A counter compared inside a closure is the cheapest correct answer and is already the codebase's answer to the same question — `PropertiesPanel.loadInfo` compares `this._entry === entry` after its `await` for exactly this reason. `AbortController` was the alternative; it adds a second cancellation vocabulary for no gain, since nothing being cancelled here is an `AbortSignal`-aware API. Streaming falls out of the same loop for free: each file's read yields to the event loop, so appending rows as they are found costs nothing extra and turns a multi-second blocking wait into a list that fills in.

[^on-enter]: Searching as you type would run a full project read per keystroke, debounced or not — the palette's fuzzy matcher can afford that because its data is already in memory, and a content search cannot. Enter also makes cancellation legible: one keypress, one run, and the run it replaces is the one that was still going. The cost is a keystroke the user must remember, mitigated by the field's placeholder text naming it.

[^plain-substring]: Every toggle the in-file panel offers arrives free with `@codemirror/search`; here each one is Loom-side code and a control in a 300px-wide sidebar. Case-insensitive substring is what a first project search is used for, and it has no failure modes to design around — a regex query brings invalid-pattern handling, a decision about whether the pattern may span lines, and a catastrophic-backtracking exposure across every file in the project. Regex and match-case are recorded as a `TODO.md` follow-up instead.

[^chord]: The in-file find plan reserved this chord for exactly this feature — its own chord footnote records that Ctrl/Cmd+Shift+F "is the conventional binding for project-wide search, and taking it for anything else now would have to be undone when cross-file search lands." It collides with nothing: `isCtrlChord` requires an exact `shiftKey` match, so `isFindChord` (`shift` false) and `isFindInFilesChord` (`shift` true) are mutually exclusive, and `isFormatChord` requires `altKey`, which `isCtrlChord` forbids. The branch still goes ahead of the Ctrl/Cmd+F branch, matching how `installAccelerators` already puts `isSaveAsChord` ahead of `isSaveChord` — the two are mutually exclusive there too, and keeping the Shift variant first is what makes that readable at a glance.

[^line-not-offset]: A raw offset taken from the disk text would be wrong in a case that is not rare at all: `EditorState.create` splits the document on line endings and rejoins with `\n`, so a CRLF file's document is shorter than its bytes and every offset past line 1 is off by the number of preceding lines. Line and column survive that normalisation untouched. Line and column also degrade better against the other staleness the panel cannot avoid — the file changed after the run — because a line number can be clamped to the document's line count and a column to its line's length, whereas an out-of-range offset simply makes CodeMirror throw. The line splitter used to produce the numbers is CodeMirror's own default (`/\r\n?|\n/`), so the line a match reports is the line the editor's gutter shows.

[^no-replace]: `TODO.md`'s entry asks for search and lists only search's parts; replace is a strictly larger feature that shares almost nothing with it beyond the match list. It needs to write files that have no tab and no editor, decide what to do when a match sits in a buffer with unsaved changes, and offer an undo — and CodeMirror's history is per document, so there is no existing mechanism that can undo an edit spanning forty files. Shipping search first also gives replace the match list it would have had to build anyway.
