---
depends-on: [temp-tabs]
touches-shared: [src/shell/shortcuts.ts, src/shell/EditorShell.ts, src/EditorController.ts, src/main.ts, README.md, TODO.md]
---

# Command Palette — Implementation Plan

## Overview

Loom has no fuzzy file finder and no way to run a command without a mouse
trip to the menu bar. This plan adds a Ctrl/Cmd+P **command palette**: a
floating panel that fuzzy-matches every file in the open workspace by
default, and switches to fuzzy-matching a fixed list of app commands when
the query starts with `>`.

The palette reuses the file-opening surface `plans/temp-tabs.md` lands:
`EditorController.openFile(path, mode?: OpenMode)`, defaulting to
`'permanent'`. That plan gives the tab strip one reusable **temp tab** — a
lightweight preview that a later temporary open recycles, and that becomes a
permanent tab the moment it's edited, double-clicked, or explicitly
confirmed. Moving the highlight over a file result here calls
`openFile(path, 'temporary')`, recycling that same temp tab; confirming a
result (Enter or click) calls `openFile(path)`. Both calls are exactly what
`plans/temp-tabs.md`'s own "For the follow-on command palette" section names
as this plan's contract — no new file-opening path is introduced.

Three new pure modules do the non-UI work: `src/data/fileIndex.ts` walks the
open project into a flat file list, `src/data/fuzzyMatch.ts` scores and ranks
matches, and `src/shell/commands.ts` turns the shell's existing menu actions
into a command list. The palette itself, `src/shell/CommandPalette.ts`, is a
`PopupPanel` hosting a `TextField` and a `List` — the same
field-forwards-keystrokes-to-list shape
[`AutoCompleteField`](node_modules/@jimka/typescript-ui/src/typescript/lib/component/input/AutoCompleteField.ts)
already uses for its dropdown. `EditorController` gains one small addition on
top of what `temp-tabs.md` lands: `closeTemporaryTab` becomes public, so the
palette's Escape/cancel path can undo an unconfirmed preview.

---

## Architecture Decisions

### Preview and confirm reuse `openFile(path, mode)` verbatim

The palette never opens a file itself. Every highlight change in file mode
calls `onPreviewFile(path)`, which `EditorShell` binds to
`controller.openFile(path, 'temporary')`; every confirm calls
`onConfirmFile(path)`, bound to `controller.openFile(path)`. This is the
contract `plans/temp-tabs.md` already wrote for "a future command palette,"
so this plan adds no new open-file entry point.[^one-open-path]

### Cancelling reverts the preview through one new public method

Escape or an outside click must not leave a stray temp tab behind. The
palette's `onCancel` callback runs `controller.closeTemporaryTab()` — the
private helper `plans/temp-tabs.md` adds, made public here — followed by
`controller.openFile(originalActivePath, 'temporary')` when a file was active
before the palette opened. Both calls are safe to run unconditionally, even
when nothing was ever previewed.[^cancel-is-unconditional]

### The v1 command list is `EditorShell`'s own menu actions, filtered rather than greyed out

`buildPaletteCommands` maps the same callbacks the `actions: MenuBarActions`
object [`EditorShell.ts:90-109`](src/shell/EditorShell.ts#L90) already
supplies to the menu bar into a flat command list — no new controller
surface for commands. A command whose menu entry would show disabled
(`enabled: false`) is left out of the list entirely rather than shown greyed
out.[^filtered-not-greyed]

### The palette is a `PopupPanel` hosting a `TextField` and a `List`

`CommandPalette` extends `PopupPanel`
([overlay/PopupPanel.ts:79](node_modules/@jimka/typescript-ui/src/typescript/lib/overlay/PopupPanel.ts#L79))
for the floating chrome, fade, and dismiss lifecycle, and composes a
`TextField` (the query) above a `List` rendered with
`GlyphListItemRenderer` (the results) — the same two-component shape
`AutoCompleteField`/`AutoCompleteDropdown` already use, with the query field
forwarding a fixed set of keys into the list's own keyboard reducer via
`List.handleKey`.[^why-popuppanel]

### `>` switches to command mode; one fuzzy module serves both

Typing `>` as the query's first character switches the palette from
file-name search to command-title search, mirroring VS Code's own
convention. Both modes call the same `fuzzyScore`/`filterAndRankFuzzy` pair
in `src/data/fuzzyMatch.ts` — one matcher, two data sources.

### Highlight-change previews, not "the arrow keys"

A file result is previewed whenever the *highlighted* row changes — whether
that happened because the user pressed an arrow key, or because typing
narrowed the list and a different file became the top match. Both paths
call the same preview logic, so there is exactly one rule ("highlight
changed") instead of two ("arrow key" and "top match changed while typing")
that could drift apart.

### The flat file list is a new, independently tested module

`listFilesRecursive` in `src/data/fileIndex.ts` walks a project root into a
flat file list, reusing `listDirectory`
([src/data/workspace.ts:88](src/data/workspace.ts#L88)) and the ignore-chain
helpers in `src/data/gitignore.ts` — the same building blocks
`FileTree.loadDirectory` already composes
([src/explorer/FileTree.ts:242-249](src/explorer/FileTree.ts#L242)), just
flattened instead of built into tree nodes, and with the show-hidden/
show-ignored toggles fixed off unconditionally rather than read from
`FileTree`'s own (private) state.[^why-not-tree-toggles] Unlike
`FileTree.ts`, `fileIndex.ts` takes its I/O as injected parameters —
mirroring `buildRootIgnoreChain`
([src/data/gitignore.ts:187-208](src/data/gitignore.ts#L187)) rather than
`FileTree.ts`'s direct imports — specifically so the walking-and-filtering
logic gets real `vitest` coverage instead of joining the app's
manual-verify-only component surface.

### No caching: the file index is rebuilt on every open

Every Ctrl/Cmd+P re-walks the project from scratch; there is no
invalidation logic to keep an index fresh across file creates/deletes. This
mirrors the tree's own accepted limitation — "the tree does not react to
changes made outside the app" (`TODO.md`'s **Filesystem watching**
entry) — rather than building a second, independent staleness problem for
one feature.[^no-caching]

### Preview-on-navigate reads the palette's own cached result order, not `List.getValue()`

`List.getValue()` reports the *selected* row, which lags one step behind the
keyboard-focused row while `setSelectFollowsFocus(false)` is set (see
`## Internal Structure`). The palette therefore keeps its own
`_currentFilePaths` array — the same array just handed to
`setItemsArray` — and reads the newly focused file by indexing it with
`List.getFocusedIndex()`.[^getvalue-lags-focus]

### The palette instance is built once and never added as a child component

`CommandPalette` is constructed once, in `EditorShell`'s constructor,
exactly like `AutoCompleteField` builds its one `_dropdown` up front. It is
never passed to `addComponent` — like every other `Position.FIXED` overlay
in the library, it mounts itself directly on `document.documentElement` via
the inherited `showAnimated()` the moment `open()` calls `showAt`.

---

## Public API

```typescript
// src/data/fuzzyMatch.ts

/**
 * Case-insensitive ordered-subsequence match score between `query` and
 * `candidate`, or `null` when `query`'s characters do not all appear, in
 * order, somewhere in `candidate`. An empty `query` matches every candidate
 * with score `0`.
 */
export function fuzzyScore(query: string, candidate: string): number | null

/**
 * Filters `items` to those `toText` renders as a fuzzy match for `query`,
 * ranked highest score first, ties broken alphabetically by `toText`, capped
 * at `limit` entries.
 */
export function filterAndRankFuzzy<T>(
    query: string,
    items: readonly T[],
    toText: (item: T) => string,
    limit: number,
): T[]
```

```typescript
// src/data/fileIndex.ts

/** Lists one directory's immediate children — the shape `listDirectory` (src/data/workspace.ts) already has. */
export type ListDirectory = (dir: string) => Promise<DirectoryItem[]>

/**
 * Recursively lists every file (not directory) under `root`, depth-first,
 * skipping dotfiles and any path `.gitignore` excludes — the same rules
 * `FileTree.loadDirectory` applies, flattened, with the show-hidden/
 * show-ignored toggles fixed off.
 */
export async function listFilesRecursive(
    root: string,
    listDirectory: ListDirectory,
    tryReadTextFile: TryReadTextFile,
    pathExists: PathExists,
): Promise<string[]>
```

```typescript
// src/shell/commands.ts

/** One entry in the command palette's `>`-mode list. */
export interface PaletteCommand {
    /** Stable identifier — what the palette's `List` keys the row on. */
    id: string
    /** Display text; the shortcut, when the command has one, is appended in parentheses. */
    title: string
    /** Display-only shortcut hint, from `shortcuts.ts`'s exported constants. */
    shortcut?: string
    /** Runs the command. Synchronous — every `MenuBarActions` callback already is. */
    run: () => void
}

/**
 * The subset of `EditorShell`'s `actions: MenuBarActions` object this module
 * reads, declared locally rather than imported: `EditorShell.ts` doesn't
 * export `MenuBarActions`, and this type doesn't need every field that
 * interface has anyway — `actions` already satisfies this narrower type
 * structurally, with no import (and no new `export` on `MenuBarActions`)
 * required.
 */
export interface PaletteCommandActions {
    onNewFile: () => void
    onOpenFolder: () => void
    onToggleExplorer: () => void
    onExit: () => void
    canSaveActive: () => boolean
    onSave: () => void
    hasActiveFile: () => boolean
    onSaveAs: () => void
    onCloseFile: () => void
    onFormat: () => void
    isShowingHidden: () => boolean
    onToggleHidden: (value: boolean) => void
    isShowingIgnored: () => boolean
    onToggleIgnored: (value: boolean) => void
}

/** Builds the current command list from the shell's own menu-action callbacks, leaving out any that would show disabled in the menu bar. */
export function buildPaletteCommands(actions: PaletteCommandActions): PaletteCommand[]
```

```typescript
// src/shell/CommandPalette.ts

export interface CommandPaletteParams {
    /** Fires every time the highlighted row changes to a different file in file-search mode. */
    onPreviewFile: (path: string) => void
    /** Fires when a file result is confirmed (Enter or click) in file-search mode. */
    onConfirmFile: (path: string) => void
    /** Fires when the palette is dismissed without confirming a file. `originalActivePath` is whatever `open()` was given. */
    onCancel: (originalActivePath: string | null) => void
}

class CommandPalette extends PopupPanel {
    constructor(params: CommandPaletteParams)

    /**
     * Opens the palette: resets its query to empty and its mode to file
     * search, records `root` (for relative-path labels) and
     * `originalActivePath` (what a cancel restores), shows the panel
     * centered near the top of the viewport, and focuses the query field.
     */
    open(files: string[], commands: PaletteCommand[], root: string | null, originalActivePath: string | null): void
}
```

```typescript
// src/shell/shortcuts.ts — additions

/** Display label shown on the View menu's shortcut hint. */
export const COMMAND_PALETTE_SHORTCUT = 'Ctrl/Cmd+P'

/** Whether a keydown is the Command-Palette chord (Ctrl/Cmd+P). */
export function isCommandPaletteChord(event: KeyboardEvent): boolean

// AcceleratorActions gains:
    /** Ctrl/Cmd+P — opens the command palette. */
    onOpenCommandPalette: () => void
```

```typescript
// src/EditorController.ts — visibility change only, body unchanged from plans/temp-tabs.md

/**
 * Closes the strip's temp tab, if it has one. Public so a preview surface
 * outside this class — the command palette's cancel path is the first —
 * can undo an unconfirmed `'temporary'` open without knowing which file, if
 * any, is currently temporary. A no-op when nothing is temporary, including
 * when the previewed path was already open as a permanent tab (`openFile`'s
 * existing-file branch never marks a file temporary, so there is nothing
 * here to close).
 */
closeTemporaryTab(): void
```

---

## Internal Structure

`fuzzyScore` walks `candidate` once per query character, greedily taking the
earliest remaining match, and scores three things: that a match happened at
all, that it sits at the start of a path segment, and that it continues a
run from the previous match:

```typescript
const MATCH_BASE_SCORE = 1
/** Bonus for a match landing at index 0 or right after a `/` — rewards matching a file's own name over a directory segment. */
const SEGMENT_START_BONUS = 2
/** Bonus for a match immediately following the previous one — rewards a contiguous run over scattered letters. */
const CONTIGUOUS_BONUS = 1

export function fuzzyScore(query: string, candidate: string): number | null {
    if (query === '') {
        return 0
    }

    const q = query.toLowerCase()
    const c = candidate.toLowerCase()
    let candidateIndex = 0
    let previousMatchedIndex = -2
    let score = 0

    for (const ch of q) {
        while (candidateIndex < c.length && c[candidateIndex] !== ch) {
            candidateIndex += 1
        }

        if (candidateIndex >= c.length) {
            return null
        }

        score += MATCH_BASE_SCORE

        if (candidateIndex === 0 || c[candidateIndex - 1] === '/') {
            score += SEGMENT_START_BONUS
        }

        if (candidateIndex === previousMatchedIndex + 1) {
            score += CONTIGUOUS_BONUS
        }

        previousMatchedIndex = candidateIndex
        candidateIndex += 1
    }

    return score
}

export function filterAndRankFuzzy<T>(query: string, items: readonly T[], toText: (item: T) => string, limit: number): T[] {
    const scored = items
        .map(item => ({ item, text: toText(item), score: fuzzyScore(query, toText(item)) }))
        .filter((entry): entry is { item: T; text: string; score: number } => entry.score !== null)

    scored.sort((a, b) => b.score - a.score || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))

    return scored.slice(0, limit).map(entry => entry.item)
}
```

Worked example — query `"sh"` against three real files in this repo:

| Candidate | Match? | Score | Why |
|---|---|---|---|
| `src/shell/shortcuts.ts` | yes | 4 | `s` at index 0 (segment start: `1+2`); `h` at index 5, not a segment start, not contiguous (`+1`) |
| `src/data/paths.ts` | yes | 4 | `s` at index 0 (segment start: `1+2`); `h` at index 12 (in "pat**h**s"), not a segment start, not contiguous (`+1`) |
| `src/EditorController.ts` | no | — | no `h` anywhere in "EditorController" after the matched `s` |

The first two tie at score 4; the alphabetical tie-break (`"src/data/paths.ts"` `<` `"src/shell/shortcuts.ts"`) ranks `paths.ts` first.

`listFilesRecursive` mirrors `FileTree.loadDirectory`'s chain-extension
logic ([src/explorer/FileTree.ts:242-249](src/explorer/FileTree.ts#L242)),
flattened and with `isEntryVisible`'s two toggles
([:263-269](src/explorer/FileTree.ts#L263)) collapsed to "always exclude
hidden and ignored":

```typescript
export async function listFilesRecursive(
    root: string,
    listDirectory: ListDirectory,
    tryReadTextFile: TryReadTextFile,
    pathExists: PathExists,
): Promise<string[]> {
    const rootChain = await buildRootIgnoreChain(root, tryReadTextFile, pathExists)
    const files: string[] = []

    async function walk(dir: string, chain: IgnoreChain): Promise<void> {
        const items = await listDirectory(dir)
        const extended = items.some(item => !item.isDir && item.name === GITIGNORE_NAME)
            ? extendIgnoreChain(chain, dir, await tryReadTextFile(joinPath(dir, GITIGNORE_NAME)))
            : chain

        for (const item of items) {
            if (isHiddenName(item.name) || isIgnoredByChain(extended, item.path, item.isDir)) {
                continue
            }

            if (item.isDir) {
                await walk(item.path, extended)
            } else {
                files.push(item.path)
            }
        }
    }

    await walk(root, rootChain)

    return files
}
```

`buildPaletteCommands` mirrors `buildMenuBar`'s own enablement checks
([src/shell/EditorShell.ts:314-321](src/shell/EditorShell.ts#L314)), using
each as a filter instead of an `enabled` flag:

```typescript
export function buildPaletteCommands(actions: PaletteCommandActions): PaletteCommand[] {
    const commands: PaletteCommand[] = [
        { id: 'new-file',        title: 'New File',        shortcut: NEW_FILE_SHORTCUT,      run: actions.onNewFile },
        { id: 'open-folder',     title: 'Open Folder…',    shortcut: OPEN_FOLDER_SHORTCUT,   run: actions.onOpenFolder },
        { id: 'toggle-explorer', title: 'Toggle Explorer', shortcut: TOGGLE_EXPLORER_SHORTCUT, run: actions.onToggleExplorer },
        { id: 'exit',            title: 'Exit',            shortcut: EXIT_SHORTCUT,          run: actions.onExit },
    ]

    if (actions.canSaveActive()) {
        commands.push({ id: 'save', title: 'Save', shortcut: SAVE_SHORTCUT, run: actions.onSave })
    }

    if (actions.hasActiveFile()) {
        commands.push({ id: 'save-as',         title: 'Save As…',         shortcut: SAVE_AS_SHORTCUT,   run: actions.onSaveAs })
        commands.push({ id: 'close-file',       title: 'Close File',      shortcut: CLOSE_FILE_SHORTCUT, run: actions.onCloseFile })
        commands.push({ id: 'format-document',  title: 'Format Document', shortcut: FORMAT_SHORTCUT,     run: actions.onFormat })
    }

    commands.push({
        id: 'toggle-hidden-files',
        title: actions.isShowingHidden() ? 'Hide Hidden Files' : 'Show Hidden Files',
        run: () => actions.onToggleHidden(!actions.isShowingHidden()),
    })
    commands.push({
        id: 'toggle-ignored-files',
        title: actions.isShowingIgnored() ? 'Hide Ignored Files' : 'Show Ignored Files',
        run: () => actions.onToggleIgnored(!actions.isShowingIgnored()),
    })

    return commands
}
```

`CommandPalette`'s constructor wires a `TextField` and a `List` exactly like
`AutoCompleteField`/`AutoCompleteDropdown` do — `setSelectFollowsFocus(false)`
so arrow keys move the highlight without committing, `setFocusOnRowClick(false)`
so DOM focus stays on the query field, and the query field's `keydown`
forwarded through the same ArrowDown/ArrowUp/Enter allow-list
`AutoCompleteField.onKeyDown` uses
([component/input/AutoCompleteField.ts:274-291](node_modules/@jimka/typescript-ui/src/typescript/lib/component/input/AutoCompleteField.ts#L274)):

```typescript
class CommandPalette extends PopupPanel {
    private readonly _queryField: TextField
    private readonly _resultsList: List
    private readonly _onPreviewFile: (path: string) => void
    private readonly _onConfirmFile: (path: string) => void
    private readonly _onCancel: (originalActivePath: string | null) => void

    private _files: string[] = []
    private _commands: PaletteCommand[] = []
    private _root: string | null = null
    private _mode: 'files' | 'commands' = 'files'
    private _originalActivePath: string | null = null
    private _lastPreviewedPath: string | null = null
    /** The paths behind the currently rendered rows, in row order — read by keyboard navigation to find the newly focused file, since `List.getValue()` lags one step behind while selection-follows-focus is off (see the plan's decision on this). Empty in command mode. */
    private _currentFilePaths: string[] = []

    constructor(params: CommandPaletteParams) {
        const queryField = new TextField({ placeholder: 'Search files, or > for commands' })
        const resultsList = new List({ rendererFactory: () => new GlyphListItemRenderer() })

        resultsList.setSelectFollowsFocus(false)
        resultsList.setFocusOnRowClick(false)

        super({
            layoutManager: new VBox({ spacing: 4, stretching: true }),
            preferredSize: { width: PALETTE_WIDTH_PX, height: PALETTE_HEIGHT_PX },
            components: [queryField, resultsList],
        })

        this._queryField = queryField
        this._resultsList = resultsList
        this._onPreviewFile = params.onPreviewFile
        this._onConfirmFile = params.onConfirmFile
        this._onCancel = params.onCancel

        Event.addListener(this._queryField, 'input', () => this.renderResults(this._queryField.getValue()))
        Event.addListener(this._queryField, 'keydown', (e: KeyboardEvent) => this.handleKeyDown(e))
        this._resultsList.on('action', () => this.handleCommit())

        this.setCloseHandler(() => this.close(true))
    }

    open(files: string[], commands: PaletteCommand[], root: string | null, originalActivePath: string | null): void {
        this._files = files
        this._commands = commands
        this._root = root
        this._originalActivePath = originalActivePath
        this._lastPreviewedPath = null

        this._queryField.setValue('')
        this.renderResults('')

        const viewport = DOM.source.getViewportSize()
        const x = Math.max(0, (viewport.width - PALETTE_WIDTH_PX) / 2)

        this.showAt({ top: PALETTE_TOP_OFFSET_PX, bottom: PALETTE_TOP_OFFSET_PX, left: x, right: x } as Rect)
        this._queryField.focus()
    }

    /** Re-derives the mode from a leading `>`, re-filters/ranks against the matching data source, and (file mode, non-empty query) previews the new top match when it differs from the last one previewed. */
    private renderResults(rawQuery: string): void {
        const isCommandMode = rawQuery.startsWith(COMMAND_MODE_PREFIX)

        this._mode = isCommandMode ? 'commands' : 'files'

        const query = isCommandMode ? rawQuery.slice(COMMAND_MODE_PREFIX.length) : rawQuery

        if (this._mode === 'commands') {
            this._currentFilePaths = []

            const matches = query === '' ? this._commands : filterAndRankFuzzy(query, this._commands, c => c.title, MAX_PALETTE_RESULTS)

            this._resultsList.setEmptyText('No matching commands')
            this._resultsList.setItemsArray(matches.map(command => ({
                key: command.id,
                label: command.shortcut ? `${command.title} (${command.shortcut})` : command.title,
            })))

            return
        }

        if (query === '') {
            this._currentFilePaths = []
            this._lastPreviewedPath = null
            this._resultsList.setEmptyText('Type to search files')
            this._resultsList.setItemsArray([])

            return
        }

        const matches = filterAndRankFuzzy(query, this._files, path => path, MAX_PALETTE_RESULTS)

        this._currentFilePaths = matches
        this._resultsList.setEmptyText('No matching files')
        this._resultsList.setItemsArray(matches.map(path => ({
            key: path,
            label: this._root !== null ? (relativeTo(this._root, path) ?? path) : path,
            glyph: glyphNameForPath(path),
        })))

        const top = matches[0] ?? null

        if (top !== null && top !== this._lastPreviewedPath) {
            this._lastPreviewedPath = top
            this._onPreviewFile(top)
        }
    }

    /** Forwards ArrowUp/ArrowDown/Enter into the list's keyboard reducer, then — for a navigation key only, in file mode — previews the newly focused row. Enter's own preview-suppression matters here: Enter commits through the list's `"action"` event (handled by `handleCommit`, below) before this method's own post-processing runs, so the nav-only guard stops it from re-previewing what was just confirmed. */
    private handleKeyDown(e: KeyboardEvent): void {
        const isNavKey = e.key === 'ArrowDown' || e.key === 'ArrowUp'
        const isCommitKey = e.key === 'Enter'

        if (!isNavKey && !isCommitKey) {
            return
        }

        if (!this._resultsList.handleKey(e)) {
            return
        }

        e.preventDefault()

        if (!isNavKey || this._mode !== 'files') {
            return
        }

        const idx = this._resultsList.getFocusedIndex()
        const path = idx >= 0 && idx < this._currentFilePaths.length ? this._currentFilePaths[idx] : null

        if (path !== null && path !== this._lastPreviewedPath) {
            this._lastPreviewedPath = path
            this._onPreviewFile(path)
        }
    }

    /** The list's `"action"` event — Enter or a row click. Confirms a file or runs a command, then closes without cancelling. */
    private handleCommit(): void {
        const key = this._resultsList.getValue()

        if (key === '') {
            return
        }

        if (this._mode === 'files') {
            this._onConfirmFile(key)
        } else {
            this._commands.find(command => command.id === key)?.run()
        }

        this.close(false)
    }

    /** Hides the panel and, when `cancelled`, fires `onCancel` with the path recorded by `open`. */
    private close(cancelled: boolean): void {
        this.hideAnimated()

        if (cancelled) {
            this._onCancel(this._originalActivePath)
        }
    }
}
```

`EditorShell`'s new pieces — one field for the built-once palette, one for
the `MenuBarActions` object `openCommandPalette` needs to rebuild the
command list, and the method itself:

```typescript
private readonly _palette: CommandPalette
private readonly _menuBarActions: MenuBarActions

private async openCommandPalette(): Promise<void> {
    const root = this._tree.getProjectRoot()
    const originalActivePath = this._controller.getActiveFilePath()
    const files = root !== null
        ? await listFilesRecursive(root, listDirectory, tryReadTextFile, pathExists)
        : []

    this._palette.open(files, buildPaletteCommands(this._menuBarActions), root, originalActivePath)
}
```

The palette is constructed as a local `const` beside `tree`/`welcome`/`split`
(before `super(...)`, per the existing constructor shape) and assigned to
`this._palette` after, mirroring the existing `this._tree = tree` lines:

```typescript
const palette = CommandPalette({
    onPreviewFile: (path: string) => { void controller.openFile(path, 'temporary') },
    onConfirmFile: (path: string) => { void controller.openFile(path) },
    onCancel: (originalActivePath: string | null) => {
        controller.closeTemporaryTab()

        if (originalActivePath !== null) {
            void controller.openFile(originalActivePath, 'temporary')
        }
    },
})
```

---

## Ordered Implementation Steps

1. **[src/data/fuzzyMatch.ts](src/data/fuzzyMatch.ts)** (new) — add `fuzzyScore` and `filterAndRankFuzzy` exactly as in **Internal Structure**.

2. **[tests/fuzzyMatch.test.ts](tests/fuzzyMatch.test.ts)** (new) — cover: an empty query scores `0` against any candidate; a query whose characters are not an ordered subsequence returns `null`; the worked `"sh"` example's three rows (two matches with the stated scores, one `null`); `filterAndRankFuzzy` excludes non-matches, ranks by score descending, breaks a tie alphabetically (reproduce the `"sh"` tie), and caps at `limit`.

3. **[src/data/fileIndex.ts](src/data/fileIndex.ts)** (new) — add `ListDirectory` and `listFilesRecursive` exactly as in **Internal Structure**, importing `DirectoryItem` from `./workspace` and `buildRootIgnoreChain`, `extendIgnoreChain`, `isIgnoredByChain`, `isHiddenName`, `GITIGNORE_NAME`, `IgnoreChain`, `TryReadTextFile`, `PathExists` from `./gitignore`, and `joinPath` from `./paths`.

4. **[tests/fileIndex.test.ts](tests/fileIndex.test.ts)** (new) — using in-memory fakes for `listDirectory`/`tryReadTextFile`/`pathExists` (mirroring `tests/gitignore.test.ts`'s `makeFakes`, [:111-119](tests/gitignore.test.ts#L111)): a nested directory tree flattens to every file path, depth-first; a dotfile and a `.gitignore`-matched file are both excluded; a directory whose own `.gitignore` adds a rule affects only its own subtree; an empty directory tree returns `[]`.

5. **[src/shell/commands.ts](src/shell/commands.ts)** (new) — add `PaletteCommand`, `PaletteCommandActions`, and `buildPaletteCommands` exactly as in **Internal Structure**, importing the shortcut constants from `./shortcuts`. Import nothing from `./EditorShell` (see `PaletteCommandActions`'s own doc comment for why).

6. **[src/shell/shortcuts.ts](src/shell/shortcuts.ts)** — add `COMMAND_PALETTE_SHORTCUT` after `EXIT_SHORTCUT` ([:23](src/shell/shortcuts.ts#L23)); add `isCommandPaletteChord` after `isExitChord` ([:83-85](src/shell/shortcuts.ts#L83)); add `onOpenCommandPalette: () => void` to `AcceleratorActions` ([:96](src/shell/shortcuts.ts#L96), after the `onExit` field); add an `else if (isCommandPaletteChord(event)) { actions.onOpenCommandPalette() }` branch to `installAccelerators` ([:127-143](src/shell/shortcuts.ts#L127)), immediately after the `isToggleExplorerChord` branch.

7. **[src/EditorController.ts](src/EditorController.ts)** — find the `closeTemporaryTab` private method `plans/temp-tabs.md` lands (grep `closeTemporaryTab`); drop `private`, and replace its doc comment with the version in **Public API**. No other line in the method changes.

8. **[src/shell/CommandPalette.ts](src/shell/CommandPalette.ts)** (new) — add the module constants `COMMAND_MODE_PREFIX = '>'`, `MAX_PALETTE_RESULTS = 50`, `PALETTE_WIDTH_PX = 560`, `PALETTE_HEIGHT_PX = 400`, `PALETTE_TOP_OFFSET_PX = 80`, each with a one-line doc comment saying what it trades off (row count vs. scoring cost, width vs. most relative paths fitting unwrapped, height vs. rows visible, offset vs. staying clear of the menu bar); add `CommandPaletteParams` and the `CommandPalette` class exactly as in **Public API**/**Internal Structure**; export it wrapped in `callable(...)`, matching every other component in `src/shell/` (e.g. [WelcomeScreen.ts](src/shell/WelcomeScreen.ts)).

9. **[src/shell/EditorShell.ts](src/shell/EditorShell.ts)**:
   - Add imports: `CommandPalette` from `./CommandPalette`; `buildPaletteCommands` from `./commands`; `listFilesRecursive` from `../data/fileIndex`; `listDirectory, tryReadTextFile, pathExists` from `../data/workspace`; `COMMAND_PALETTE_SHORTCUT` added to the existing shortcut-constants import ([:17-20](src/shell/EditorShell.ts#L17)).
   - Add `private readonly _palette: CommandPalette` and `private readonly _menuBarActions: MenuBarActions` beside the existing fields ([:62-65](src/shell/EditorShell.ts#L62)).
   - In the constructor, construct `const palette = CommandPalette({...})` (per **Internal Structure**) immediately after the `tree`/`welcome`/`deck`/`split` block and before the `actions` object literal.
   - After the `actions: MenuBarActions = {...}` object literal, add `onOpenCommandPalette: () => { void this.openCommandPalette() }` as one more field on it.
   - After `super({...})` (where `this._tree = tree` etc. are assigned), add `this._palette = palette` and `this._menuBarActions = actions`.
   - Add the `openCommandPalette` private method from **Internal Structure**.
   - In `buildMenuBar`'s `View` menu items array ([:323](src/shell/EditorShell.ts#L323)), insert a new leading item before `Toggle Explorer`: `{ text: 'Command Palette…', glyph: 'magnifying-glass', shortcut: COMMAND_PALETTE_SHORTCUT, action: actions.onOpenCommandPalette }`, followed by `{ separator: true }`.

10. **[src/main.ts](src/main.ts)** — import `magnifying_glass` from `@jimka/typescript-ui/glyphs/solid/magnifying_glass` and add it to the `Glyph.register(...)` call ([:24](src/main.ts#L24)).

11. Checks:
    - `npm run typecheck` — clean.
    - `grep -rn 'closeTemporaryTab' src/EditorController.ts` — one match, with no `private` on the same line.
    - `grep -rln 'CommandPalette' src/` — `src/shell/CommandPalette.ts` and `src/shell/EditorShell.ts` only.
    - `grep -rn 'onOpenCommandPalette' src/` — matches in `src/shell/shortcuts.ts` (the interface field) and `src/shell/EditorShell.ts` (the `actions` field, the menu item, and the accelerator branch) only.

12. **[README.md](README.md)** — add a new bullet immediately after the *File tree* bullet ([:17-23](README.md#L17)): "**Command palette** — Ctrl/Cmd+P opens a fuzzy file finder over every file in the project; moving the highlight previews the file in a temp tab (see *Tabbed editing*, below), Enter opens it for keeps, and Escape cancels back to whatever was open before. Typing `>` switches to a list of app commands — Save, Format Document, Toggle Explorer, and the rest of the menu bar — instead."

13. **[TODO.md](TODO.md)** — delete the **Commmand palette / fuzzy file finder (Ctrl+P)** bullet ([:19-22](TODO.md#L19)), this plan's own backlog entry. Immediately after the **Library `Tab.setTabGlyph` / `TabBar.setEntryGlyph`** bullet ([:27-31](TODO.md#L27)), add a **Library `List` row-level enabled/disabled state** bullet: `AbstractSelectableList` has no per-row disabled flag, only the whole list's `enabled`/`readOnly`, so the command palette filters out a disabled command instead of greying it out the way the menu bar does.

14. Run `npm run typecheck && npm test && npm run build` — all clean.

15. Run the manual cases in **Expected Behaviour**.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `src/data/fuzzyMatch.ts` |
| Create | `tests/fuzzyMatch.test.ts` |
| Create | `src/data/fileIndex.ts` |
| Create | `tests/fileIndex.test.ts` |
| Create | `src/shell/commands.ts` |
| Create | `src/shell/CommandPalette.ts` |
| Modify | `src/shell/shortcuts.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `src/main.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

**Unit-testable** (see steps 2 and 4 for the exact cases):

1. `fuzzyScore`/`filterAndRankFuzzy` behave per **Internal Structure**'s worked example and the empty-query/no-match/tie-break/cap rules above.
2. `listFilesRecursive` flattens a fake tree depth-first, excludes dotfiles and gitignored paths, and respects a nested `.gitignore`'s own subtree scope.

**Manual verification** in the Tauri window (`npm run tauri:dev`), per `plans/temp-tabs.md`'s own "No new automated tests" precedent for component/DOM behaviour — open a project with at least six files across at least two directories:

3. **Ctrl/Cmd+P opens the palette**, centered near the top of the window, with an empty query and a "Type to search files" hint — no file is previewed yet.
4. **Typing fuzzy-matches and previews the top result.** Type a few characters of an open file's name: matching paths appear ranked, and the top one opens as a temp tab (labelled `~name`, per `plans/temp-tabs.md`) behind the palette.
5. **Arrowing changes the preview.** Press ArrowDown: the highlight moves and the temp tab recycles to the newly highlighted file; the strip never shows more than the one temp tab throughout.
6. **Enter confirms permanently.** With a result highlighted, press Enter: its tab loses the `~` (becomes a permanent tab, per `plans/temp-tabs.md`), the palette closes, and Recent Files lists it.
7. **Clicking a result behaves like Enter.** Click a (non-highlighted) row directly: it becomes the permanent tab and the palette closes, without an intermediate preview of the highlighted-but-not-clicked row leaking through.
8. **Escape reverts an unconfirmed preview to nothing open before.** Starting with no tabs open, Ctrl/Cmd+P, arrow onto a result (previews it as a temp tab), then Escape: the temp tab is gone and the welcome screen (or whatever was showing) returns — no stray tab remains.
9. **Escape reverts to the file that was active before.** With `a.ts` open and active (permanent tab), Ctrl/Cmd+P, arrow onto `b.ts` (previews it, recycling the temp slot), then Escape: `a.ts` is active again and no tab for `b.ts` remains.
10. **Escape after opening the palette on a pre-existing temp tab restores it.** Single-click `c.ts` in the tree (temp tab `~c.ts`), Ctrl/Cmd+P, arrow onto `d.ts` (recycles to `~d.ts`), then Escape: `~c.ts` is back, active, and `d.ts` has no tab.
11. **Escape with no preview is a pure no-op.** Ctrl/Cmd+P, then Escape immediately with an empty query: nothing about the tab strip changes.
12. **Clicking outside the palette cancels the same way Escape does.** Repeat case 9, but dismiss by clicking elsewhere in the window instead of pressing Escape: the same revert happens.
13. **`>` switches to command mode.** Type `>`: the list shows every command from **Internal Structure**'s `buildPaletteCommands` (with no active file, `Save`/`Save As…`/`Close File`/`Format Document` are absent). Typing after `>` fuzzy-filters the command titles.
14. **A confirmed command runs and closes the palette.** With `>form` typed (matching Format Document), press Enter: the active file reformats and the palette closes. No file preview ever occurred during this session.
15. **Arrowing through commands never runs one.** Type `>`, arrow through several commands: nothing executes until Enter or a click.
16. **Deleting the `>` returns to file search** using whatever text remains, with the file/command distinction re-evaluated live.
17. **No project open still offers commands.** With no folder open (welcome screen), Ctrl/Cmd+P and `>`: the list shows exactly the six commands `buildPaletteCommands` lists unconditionally — `New File`, `Open Folder…`, `Toggle Explorer`, `Exit`, `Show Hidden Files`, `Show Ignored Files` — with `Save`/`Save As…`/`Close File`/`Format Document` absent; the plain (non-`>`) file search shows the "Type to search files" hint and, once text is typed, "No matching files" (there is nothing to search).
18. **The View menu's new item works identically to the shortcut**, including its `Ctrl/Cmd+P` shortcut hint.
19. **A hidden or gitignored file never appears** in file-search results, even by typing its exact name.

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — clean; covers the new `fuzzyMatch`/`fileIndex` suites.
- `npm run build` — clean.
- `grep -rn 'closeTemporaryTab' src/EditorController.ts` — one match, public.
- `grep -rln 'CommandPalette' src/` — exactly `src/shell/CommandPalette.ts` and `src/shell/EditorShell.ts`.
- `git diff --name-only` — exactly the files in the table above, plus the two new test files.
- Manual: `npm run tauri:dev`, then cases 3-19 above.

---

## Documentation Impact

- **[README.md](README.md)** — step 12 adds the *Command palette* bullet; no other bullet describes file opening or command execution as a single surface.
- **[TODO.md](TODO.md)** — step 13 deletes this feature's own backlog entry and records the `List` row-disabled gap, matching how `plans/temp-tabs.md` retired its own entry and recorded the `Tab.setTabGlyph` gap (commit precedent: `plans/temp-tabs.md`'s own `## Documentation Impact`).
- Loom has no `docs/` tree or generated API reference, so nothing else needs regenerating.

---

## Potential Challenges

- **`showAt`'s anchor-rect argument type.** `PopupPanel.showAt(anchorRect: Rect)` expects the library's `Rect` shape, which may carry `width`/`height` fields this plan's synthetic zero-size anchor (`{top, bottom, left, right}`) doesn't supply directly; check the actual `Rect` export from `@jimka/typescript-ui/core` at typecheck time and add `width: 0, height: 0` (or derive them from `left`/`right`/`top`/`bottom`) if the type demands it. The placement math in **Internal Structure** is unaffected either way — only the literal's shape may need padding out.
- **A very large workspace makes every Ctrl/Cmd+P recompute the whole file list.** No caching (see the matching Architecture Decision) — acceptable for Loom's dogfood-scale projects today; revisit if it's ever felt live.
- **`DOM.source.getViewportSize()`'s exact availability.** `PopupPanel.showAt` itself calls this internally; confirm at implementation time that it's reachable through the public `DOM` export used in this plan (`import { DOM } from '@jimka/typescript-ui/core'`), the same object the library's own overlay code reads.
- **A palette invoked mid-drag-reorder of the tab strip, or during another open overlay (a `Dialog`), is unexplored.** `LayerManager`'s own band/z-index system should keep the palette on top of ordinary content; no special handling is added, since Loom has no code path that opens the palette while another modal is already up.

---

## Critical Files

- [plans/temp-tabs.md](plans/temp-tabs.md) — the dependency this plan builds on: `openFile`'s `mode` parameter, the temp-tab recycling rule, and the "For the follow-on command palette" section this plan's preview/confirm behaviour implements verbatim.
- [src/shell/EditorShell.ts](src/shell/EditorShell.ts) — `MenuBarActions` ([:31-52](src/shell/EditorShell.ts#L31)), the constructor's `actions` object literal ([:90-109](src/shell/EditorShell.ts#L90)), and `buildMenuBar` ([:301-343](src/shell/EditorShell.ts#L301)) — the precedent `buildPaletteCommands` mirrors and the file most of this plan's wiring lands in.
- [node_modules/@jimka/typescript-ui/src/typescript/lib/component/input/AutoCompleteField.ts](node_modules/@jimka/typescript-ui/src/typescript/lib/component/input/AutoCompleteField.ts) and [AutoCompleteDropdown.ts](node_modules/@jimka/typescript-ui/src/typescript/lib/component/input/AutoCompleteDropdown.ts) — the field-forwards-keydown-to-list pattern `CommandPalette` copies, including the exact `setSelectFollowsFocus(false)`/`setFocusOnRowClick(false)` combination and the ArrowDown/ArrowUp/Enter keydown allow-list.
- [node_modules/@jimka/typescript-ui/src/typescript/lib/overlay/PopupPanel.ts](node_modules/@jimka/typescript-ui/src/typescript/lib/overlay/PopupPanel.ts) — the base class: placement, the height cap, `setCloseHandler`/`requestClose`'s dismissal contract.
- [node_modules/@jimka/typescript-ui/src/typescript/lib/component/list/AbstractSelectableList.ts](node_modules/@jimka/typescript-ui/src/typescript/lib/component/list/AbstractSelectableList.ts) — `moveFocus` ([:1963-1979](node_modules/@jimka/typescript-ui/src/typescript/lib/component/list/AbstractSelectableList.ts#L1963)), `setSelectFollowsFocus` ([:1774](node_modules/@jimka/typescript-ui/src/typescript/lib/component/list/AbstractSelectableList.ts#L1774)), and `getFocusedIndex`/`getValue`'s split behaviour this plan's cached-array workaround depends on.
- [src/explorer/FileTree.ts:242-269](src/explorer/FileTree.ts#L242) — `loadDirectory`/`isEntryVisible`, the precedent `listFilesRecursive` mirrors.
- [src/data/gitignore.ts](src/data/gitignore.ts) — `buildRootIgnoreChain`'s injected-I/O shape, mirrored by `listFilesRecursive`.
- [tests/gitignore.test.ts:111-119](tests/gitignore.test.ts#L111) — `makeFakes`, the in-memory fake pattern `tests/fileIndex.test.ts` reuses.

---

## Non-Goals

- **No cross-file content search.** This is file-*name* navigation only, matching `TODO.md`'s own framing of the backlog entry this plan retires.
- **No fuzzy-match highlighting of matched characters in a row's label.** `GlyphListItemRenderer`'s label is a single plain `Text`; multi-span rich-text rendering per row is a separate library investment.
- **No two-line rows (bolded name plus dimmed parent directory).** Same limitation — one label per row; the full project-relative path is shown instead.
- **No live invalidation of the file index** as files are created/deleted outside a palette session (see the matching Architecture Decision).
- **No respecting the tree's live Show Hidden/Show Ignored toggles.** File search always excludes dotfiles and gitignored paths, independent of what the explorer is currently showing.
- **No per-row disabled/greyed command entries.** Filtered out instead (see Architecture Decisions and the new `TODO.md` entry).
- **No recent-files-first ordering when the query is empty.** An empty query shows a hint, not a list, in file mode.
- **No settings to remap the `>` prefix or the Ctrl/Cmd+P shortcut.** Settings of any kind remain a separate backlog item (`TODO.md`'s **Transition hard-coded settings…** entry).
- **No library changes.** `@jimka/typescript-ui` is used exactly as shipped.

---

## Notes

[^one-open-path]: `plans/temp-tabs.md`'s own `## Public API` section, under "For the follow-on command palette," already specifies both calls this plan wires up: `void controller.openFile(path)` on Enter, and `void controller.openFile(path, 'temporary')` while "arrowing through results." Re-deriving a second opening path here would contradict a dependency this plan is required to build on, and would cost a second recycling rule to keep in sync with the one `EditorController` already owns.

[^cancel-is-unconditional]: Calling `closeTemporaryTab()` unconditionally is safe because it already no-ops when nothing is currently temporary — including the case where the palette's last preview happened to coincide with a file that was already open as a *permanent* tab (`openFile`'s existing-file branch never marks a file temporary, so `_openFiles.find(file => file.isTemporary())` finds nothing to close). An earlier design considered gating the revert behind "did the palette preview anything this session," then closing whatever tab is currently *active* — that is unsafe: after a preview, the active tab is always the temp tab, but if the top match ever coincided with an already-open *permanent* tab, the active tab at cancel time would be that permanent tab, and closing it outright (with its own dirty-check prompt, if dirty) would be a destructive bug triggered by pressing Escape in a command palette. `closeTemporaryTab()`'s own "only ever touches a file that `isTemporary()`" guarantee avoids this entirely, which is why it — not `closeActive()` — is the method this plan exposes.

[^filtered-not-greyed]: `AbstractSelectableList` (the base `List` extends) has no per-row enabled/disabled flag — only the whole list's `enabled`/`readOnly`, which would grey out every row at once. Filtering avoids inventing a new library capability for one caller; the new `TODO.md` entry (step 13) records the gap for a future caller that does need it.

[^why-popuppanel]: `Dialog` (Loom's only existing modal precedent, used throughout `src/shell/*Prompt.ts`) is built around a fixed title bar and a button row driven by static config — there is no supported way to host a live-filtering `TextField`+`List` inside one. `PopupPanel` is documented as exactly "the building block for a custom popup with no overlay plumbing of its own," and already backs `ComboBox`/date pickers' own field-plus-list compositions in spirit (via `AutoCompleteDropdown`), so this plan follows that shape rather than hand-rolling a new floating-panel/dismissal/fade mechanism — consistent with this project's standing preference for the library's own components over hand-rolled UI.

[^why-not-tree-toggles]: `FileTree`'s `_showHidden`/`_showIgnored`/`_rootChain` are private, and there is no existing public surface to read them from outside the component. Coupling `fileIndex.ts` (a `src/data/` module) to `FileTree`'s internal state would need new getters whose only consumer is this plan, for a v1 feature whose fixed default (always exclude hidden/ignored) already covers the common case and matches VS Code's own default Quick Open scope, which is independent of its Explorer's own dotfile-visibility setting.

[^no-caching]: A cache needs an invalidation strategy — recomputed on file save, on external changes (which Loom cannot detect at all, per the **Filesystem watching** backlog item), on project-root switch, or some combination. Rebuilding fresh on every open sidesteps all of that at the cost of a walk per Ctrl/Cmd+P, which is the same trade the tree itself already accepts for its own listings (reloaded explicitly, never watched).

[^getvalue-lags-focus]: `List.getValue()` reads `getSelectedIndex()`, which `moveFocus` only updates when `_selectFollowsFocus` is `true` — with it `false` (this plan's setting, so Enter/click alone commit), an arrow key moves `_focusedIndex` and the visible highlight but leaves `_selectedSet`/`getValue()` pointing at whatever was last *committed*. The palette needs the *focused* row's path on every arrow press, not the last-committed one, so it reads `getFocusedIndex()` and looks the path up in its own `_currentFilePaths` — the same array it just handed to `setItemsArray`, so the two stay in lockstep by construction.
