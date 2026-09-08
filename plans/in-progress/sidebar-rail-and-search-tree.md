---
depends-on: [project-wide-search]
touches-shared: [src/shell/EditorShell.ts, src/explorer/SearchPanel.ts, src/explorer/searchResults.ts, tests/searchResults.test.ts, README.md, TODO.md]
---

# Sidebar Rail and Search Tree — Implementation Plan

## Overview

The explorer sidebar today stacks three `Accordion` sections in one panel — Tree, Properties, and Search — built by `buildExplorerSections` and wired together in [`src/shell/EditorShell.ts:106-300`](src/shell/EditorShell.ts#L106). This plan replaces that stack with a narrow icon rail: two `ToggleButton`s (**Files**, **Search**) switch which view fills the sidebar's content area, one at a time. **Files** keeps today's Tree-over-Properties accordion unchanged; **Search** becomes its own full-height view.

Alongside the rail, the Search view's results change shape: [`src/explorer/SearchPanel.ts`](src/explorer/SearchPanel.ts) currently paints matches as flat rows in a `List`. This plan rebuilds them as a `Tree`, grouped by folder — folders and files as expandable branches, each line match as a leaf — following the same node-building shape [`src/explorer/FileTree.ts`](src/explorer/FileTree.ts) already uses to turn directory listings into `TreeNode`s. Clicking a match still opens and reveals it exactly as today; clicking a file branch now also opens that file (with no specific location), matching VS Code's own search-results tree.

Two files are substantially rewritten ([`src/explorer/SearchPanel.ts`](src/explorer/SearchPanel.ts), [`src/explorer/searchResults.ts`](src/explorer/searchResults.ts)) and one is restructured ([`src/shell/EditorShell.ts`](src/shell/EditorShell.ts)). No new files. Nothing about `src/data/projectSearch.ts` — the matching engine — changes.

---

## Architecture Decisions

### Files keeps Tree and Properties together; Search becomes its own rail entry

The rail has exactly two entries. **Files** shows the same Tree-over-Properties `Accordion` the sidebar already builds, unchanged, mirroring VS Code's own convention of grouping a file tree with its sibling sections under one activity-bar icon. **Search** shows the rebuilt results tree. No other rail entry is added.

### The rail lives inside `explorer`'s own `BorderLayout`, WEST of a `Card`-switched content area

`explorer` — the `Container` that already occupies the outer `Split`'s first pane — changes from a bare `Accordion`-managed container into a `Border`-laid one: a narrow rail `Container` WEST, and a `Card`-managed content `Container` CENTER holding the Files view and the Search view as its two pages. This is the same `Border`-plus-`Card`/`Border`-plus-content composition already used twice in this codebase — `EditorShell`'s own top-level layout ([`src/shell/EditorShell.ts:255-262`](src/shell/EditorShell.ts#L255)) and `FileEditor`'s breadcrumb-over-editor layout ([`src/editor/FileEditor.ts:90-96`](src/editor/FileEditor.ts#L90)) — not a new `Split` pane (which would grow `SessionState.paneSizes` to a third entry, silently invalidating every restored session, the same reason a third pane was rejected for the Search section originally[^panel-placement-precedent]) and not a pane header (the pane has no single header to replace — the Files view keeps its own per-section `Accordion` headers).

`Toggle Explorer` (Ctrl/Cmd+B) keeps its exact current mechanism, `split.setPaneCollapsed(EXPLORER_PANE_INDEX, ...)` — collapsing the whole `explorer` pane, rail included. Splitting "hide the rail" from "hide the content" would need new persisted state Loom has no precedent for anywhere else; collapsing everything together is the minimal change that keeps today's shortcut doing exactly what it already does.

### Two plain `ToggleButton`s, hand-coordinated by one closure — not `ButtonGroup`, `Rail`, or `Tab`

The rail is two `ToggleButton`s (`glyph`, `showText: false`) in a narrow `VBox`, switched by one `selectExplorerView(view)` closure that sets both buttons' `setSelected` and the content `Card`'s visible page together — the same "one entry point every trigger shares" idiom `revealSearchSection` (renamed `revealSearchView`) already uses for Ctrl/Cmd+Shift+F, the Edit-menu item, and the palette command.

This was not the first design tried. `@jimka/typescript-ui/overlay`'s `Rail`/`RailHandle`, `Drawer`, and `ButtonGroup` were all investigated as the purpose-built candidates, and each falls short in a different way — full findings in the footnote.[^rail-investigation]

### A project switch resets the rail to Files

`relabelTreeSection` no longer rebuilds a 3-section accordion (so it can no longer reset an open Search section by side effect, the way it did before). To preserve the same "results belong to the previous project" behavior, the project-root listener's `finally` block now also calls `selectExplorerView('files')`, alongside its existing `properties.setProjectRoot`/`searchPanel.setProjectRoot`/`relabelTreeSection` calls.

### Search results build into a folder→file→match tree, following `FileTree`'s own shape

`src/explorer/searchResults.ts` gains `searchResultNodes(matches, root)`, replacing `searchResultRow`. It groups matches by file, then nests each file under every directory between it and `root`, producing plain `TreeNode[]` literals with a `data: SearchTreeNodeData` payload (`{kind:'folder'|'file'|'match', ...}`) — the same "eager `TreeNode[]` with an opaque `data` tag read back by a click handler" shape `FileTree.toNodes` already establishes, just built from an in-memory match list instead of one directory read at a time.[^tree-shape]

Within one directory level, folders sort before files, case-insensitively — reusing `sortDirEntries` ([`src/data/paths.ts:123`](src/data/paths.ts#L123)) unchanged, the same helper `FileTree`'s own listing traces back to. Matches inside one file are never resorted — they stay in the line order `findMatches` already returns them in.

VS Code's own search tree additionally compacts a chain of single-child directories into one row (`src/data` instead of two nested rows). `FileTree` does not do this for the file explorer, and this plan does not add it here either, for the same reason: it is a materially different, more involved algorithm than the file-explorer precedent this plan is told to follow, and nothing in the brief asks for it.

### Selecting a row opens it; every branch starts expanded; there's no auto-selected first result

`Tree` exposes only `"selection"` (fires for a click *or* an arrow-key move) and `"dblclick"` — there is no separate "commit" event the way `List`'s `"action"` was, and no public hook to forward keydowns into it from elsewhere the way `SearchPanel` used to forward `ArrowUp`/`ArrowDown` from the query field into `List.handleKey`.[^no-handlekey] Given that, this plan adopts `FileTree`'s own convention outright: selecting a row (click or arrow) fires the open action. A match leaf opens and reveals that match, exactly as `onOpenMatch`/`EditorController.openFileAt` already do today. A file branch now *also* opens on selection — with no specific location, since a file-level selection has none — calling `EditorController.openFile(path, 'permanent')` through a new `onOpenFile` callback, matching both VS Code's own search-tree behavior and `FileTree.handleSelection`'s own file-row convention. A folder branch does nothing beyond expanding/collapsing; there's no "open a folder" concept anywhere else in Loom either.

Because selecting now means opening, this plan does **not** auto-select the first result the way the old `List` did on the first streamed batch (`setFocusedIndex(0)`) — that would auto-open a file with no user action, which the old design never did (opening a match always needed an explicit Enter or click). Every folder and file branch starts (and stays) expanded instead: `SearchPanel.appendMatches` rebuilds the whole node tree from `_matches` on every streamed batch — `Tree.setNodes` always did discard and rebuild, same as the old `List.setItemsArray` did with the whole `_rows` array each batch — and calls `expandAll()` right after, which is deterministic and needs no "which folders were open before" bookkeeping the way `FileTree.rebuild`'s `getExpandedPaths`/`expandPaths` dance needs for a tree the user manually expands. Given search result sets are small (the same 200-match ceiling as today, see below), starting everything visible is what makes the fewest clicks needed to see anything, and it makes the streaming rebuild correct by construction rather than needing state restored across it.

One consequence of `Tree` owning its own focus directly (rather than the query field staying focused and forwarding arrow keys the way it did to `List`) is that browsing results with the arrow keys now requires first moving focus into the results tree — a Tab press or a click — rather than staying in the query field. This is an accepted, unavoidable trade-off of the switch to `Tree`, not an oversight; see the footnote for why no equivalent to `List.handleKey` exists to preserve the old behavior.[^no-handlekey]

### The Search view now fills the whole content area; `SEARCH_LIMITS` is left unchanged

`SearchPanel`'s fixed `preferredSize: { height: PANEL_HEIGHT_PX }` (280px, sized for a shared accordion section) is dropped. `Card` always sizes its visible child to fill the container's inner bounds, so once Search is its own full-height rail page there is nothing left for a fixed height to do — the results tree absorbs whatever height the content area has, the same way the Files view's own tree already absorbs the accordion's leftover height via its `weight: 1` section.

`SEARCH_LIMITS` (`maxMatches: 200, maxFiles: 2000`) is left at its current values even though the reason `maxMatches` was set where it is no longer fully applies: it was tuned against `List`, which renders every row with no virtualization; `Tree` *is* virtualized (`Tree.md`'s own "Virtual scrolling" note). Raising it is a separate, unrequested behavior change with its own testing surface (how a much bigger result tree performs, whether 2000 files stays the right read ceiling too) — recorded as a `## Non-Goals` entry rather than folded in here.

`EXPLORER_MIN_SIZE`/`EXPLORER_PREFERRED_SIZE` (160/300px, carried over from `FileTree`'s own declared size) are also left unchanged. The rail's own natural width (two compact icon buttons) now eats a small slice of that budget before the content area sees it — a few pixels the split gutter can always recover — not worth inventing a new, unverifiable pixel constant to compensate for.

---

## Public API

### `src/explorer/searchResults.ts` — replaces `SearchResultRow`/`searchResultRow`

```typescript
/** Tags one search-results tree node's `data` payload with what kind of row it is. */
export type SearchTreeNodeData =
    | { kind: 'folder'; path: string }
    | { kind: 'file'; path: string }
    | { kind: 'match'; match: SearchMatch }

/**
 * Groups `matches` by file, then by every directory between each file and
 * `root`, into `Tree`-ready root nodes — folders and files as branches (each
 * folder's children directories-first, case-insensitive; each file's own
 * children in line order, unsorted), matches as leaves. `root === null`
 * (search never actually finds anything then — `SearchPanel.listFiles`
 * resolves empty with no project open) falls back to a flat, unsorted list
 * of file branches keyed by absolute path.
 */
export function searchResultNodes(matches: readonly SearchMatch[], root: string | null): TreeNode[]
```

`SearchStatus`/`searchSummaryText` are unchanged — carried over verbatim.

### `src/explorer/SearchPanel.ts` — one new constructor field

```typescript
export interface SearchPanelParams {
    listFiles: () => Promise<string[]>
    readText: ReadFileText
    /** Fires when a match leaf is selected (click or arrow-key move) — opens and reveals it. */
    onOpenMatch: (match: SearchMatch) => void
    /** Fires when a file branch row is selected (click or arrow-key move), with no specific match location. */
    onOpenFile: (path: string) => void
    projectRoot: string | null
}
```

`SearchPanel`'s own public surface (`setProjectRoot`, `focusQuery`) is unchanged.

---

## Internal Structure

### `searchResultNodes`

```typescript
function groupByFile(matches: readonly SearchMatch[]): Map<string, SearchMatch[]> {
    const byFile = new Map<string, SearchMatch[]>()

    for (const match of matches) {
        const bucket = byFile.get(match.path)

        if (bucket) {
            bucket.push(match)
        } else {
            byFile.set(match.path, [match])
        }
    }

    return byFile
}

function matchNode(match: SearchMatch): TreeNode {
    return { label: `${match.line}: ${match.lineText}`, data: { kind: 'match', match } }
}

function fileNode(path: string, name: string, fileMatches: SearchMatch[]): TreeNode {
    return {
        label: `${name} (${fileMatches.length})`,
        data: { kind: 'file', path },
        children: fileMatches.map(matchNode),
    }
}

function sortLevel(nodes: TreeNode[]): TreeNode[] {
    const sorted = sortDirEntries(nodes.map(node => ({
        name: node.label,
        isDir: (node.data as SearchTreeNodeData).kind === 'folder',
        node,
    }))).map(entry => entry.node)

    for (const node of sorted) {
        if ((node.data as SearchTreeNodeData).kind === 'folder') {
            node.children = sortLevel(node.children!)
        }
    }

    return sorted
}

export function searchResultNodes(matches: readonly SearchMatch[], root: string | null): TreeNode[] {
    const byFile = groupByFile(matches)

    if (root === null) {
        return [...byFile.entries()].map(([path, fileMatches]) => fileNode(path, path, fileMatches))
    }

    const folders = new Map<string, TreeNode>()
    const topLevel: TreeNode[] = []

    function folderChildren(relDir: string): TreeNode[] {
        if (relDir === '') {
            return topLevel
        }

        const existing = folders.get(relDir)

        if (existing) {
            return existing.children!
        }

        const segments = pathSegments(relDir)
        const parentRel = segments.slice(0, -1).join('/')
        const node: TreeNode = { label: segments[segments.length - 1], children: [], data: { kind: 'folder', path: joinPath(root, relDir) } }

        folderChildren(parentRel).push(node)
        folders.set(relDir, node)

        return node.children!
    }

    for (const [path, fileMatches] of byFile) {
        const relDir = relativeTo(root, parentDir(path)) ?? ''

        folderChildren(relDir).push(fileNode(path, baseName(path), fileMatches))
    }

    return sortLevel(topLevel)
}
```

`folderChildren` is a nested `function` (hoisted, so it can call itself before its own declaration line is reached in source order) closing over `folders`/`topLevel`/`root`. It memoizes every directory node by its path relative to `root`, so two files sharing a directory — however deep — get exactly one shared folder node, built the first time either file reaches it. `pathSegments`, `joinPath`, `parentDir`, `baseName`, `relativeTo`, and `sortDirEntries` are the existing helpers in [`src/data/paths.ts`](src/data/paths.ts); nothing new is added there.

Worked example, matches in walk order `/p/src/data/paths.ts` (lines 10, 62), `/p/src/shell/EditorShell.ts` (line 45), `/p/README.md` (line 3), root `/p`:

| Path in tree | Node kind | Label |
| --- | --- | --- |
| `src` | folder | `src` |
| `src/data` | folder | `data` |
| `src/data/paths.ts` | file | `paths.ts (2)` |
| `src/data/paths.ts` → match | match | `10: <line 10's preview>` |
| `src/data/paths.ts` → match | match | `62: <line 62's preview>` |
| `src/shell` | folder | `shell` |
| `src/shell/EditorShell.ts` | file | `EditorShell.ts (1)` |
| `src/shell/EditorShell.ts` → match | match | `45: <line 45's preview>` |
| `README.md` | file | `README.md (1)` |
| `README.md` → match | match | `3: <line 3's preview>` |

`src` sorts before `README.md` at the top level (directories before files); `data` sorts before `shell` inside `src` (alphabetical, both directories); the two matches under `paths.ts` stay in line order (10 before 62), not resorted.

With `root === null`, this same match set collapses to three flat file nodes labeled `/p/src/data/paths.ts (2)`, `/p/src/shell/EditorShell.ts (1)`, `/p/README.md (1)`, no folder nesting.

### `SearchPanel` construction

```typescript
const queryField = new TextField({ placeholder: QUERY_PLACEHOLDER })
const resultsTree = new Tree({ rowOverflow: 'scroll' })
const statusText = new Text('', { truncate: true, foregroundColor: STATUS_COLOR })

resultsTree.setRendererFactory(() => new IconLabelTreeNodeRenderer(node => {
    const data = node.data as SearchTreeNodeData

    return data.kind === 'folder' ? 'folder' : glyphNameForPath(data.kind === 'file' ? data.path : data.match.path)
}))

super({
    layoutManager: new VBox({ spacing: 4, stretching: true }),
    insets: new Insets(PANEL_PAD, PANEL_PAD, PANEL_PAD, PANEL_PAD),
    components: [queryField, { component: resultsTree, constraints: { weight: 1 } }, statusText],
})
```

No `preferredSize` — see `## Architecture Decisions`. `PANEL_HEIGHT_PX` is deleted.

`handleSelection`, mirroring `FileTree.handleSelection`'s own `nodes[0]?.data` guard against an empty selection:

```typescript
private readonly handleSelection = (nodes: TreeNode[]): void => {
    const data = nodes[0]?.data as SearchTreeNodeData | undefined

    if (data?.kind === 'match') {
        this._onOpenMatch(data.match)
    } else if (data?.kind === 'file') {
        this._onOpenFile(data.path)
    }
}
```

Wired in the constructor, after `super()`: `this._resultsTree.on('selection', this.handleSelection)`. `handleKeyDown` shrinks to just the `Enter` branch — the `ArrowDown`/`ArrowUp` forwarding into `List.handleKey` is deleted outright, since `Tree` has no equivalent to forward into (see `## Architecture Decisions`):

```typescript
private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
        e.preventDefault()
        void this.runSearch()
    }
}
```

`appendMatches` and `clearResults` rebuild from `_matches` each time:

```typescript
private appendMatches(batch: SearchMatch[]): void {
    this._matches = [...this._matches, ...batch]
    this._resultsTree.setNodes(searchResultNodes(this._matches, this._root))
    this._resultsTree.expandAll()
}

private clearResults(): void {
    this._matches = []
    this._resultsTree.setNodes([])
}
```

`_rows: SearchResultRow[]` is deleted — nothing needs a flat, index-aligned array once nodes are rebuilt from `_matches` directly. `_resultsList: List` becomes `_resultsTree: Tree`. `runSearch`/`setProjectRoot`/`focusQuery`/`paintStatus`/`destructor` are otherwise unchanged.

### `EditorShell` — the rail and content composition

Replaces the current `initialSections`/`explorer`/`let accordion` block ([`src/shell/EditorShell.ts:155-166`](src/shell/EditorShell.ts#L155) and [`169-203`](src/shell/EditorShell.ts#L169)):

```typescript
const initialFilesSections = buildFilesViewSections(session.projectRoot)
const filesView = Container({ layoutManager: initialFilesSections.accordion })

filesView.addComponent(tree, initialFilesSections.treeSection)
filesView.addComponent(properties, initialFilesSections.propertiesSection)
filesView.setId(FILES_VIEW_ID)
searchPanel.setId(SEARCH_VIEW_ID)

const content = Container({ layoutManager: new Card(), components: [filesView, searchPanel] })

content.setVisibleComponentId(FILES_VIEW_ID)

const filesHandle = new ToggleButton(FILES_RAIL_LABEL, { glyph: 'folder', showText: false, flat: true, compact: true, selected: true })
const searchHandle = new ToggleButton(SEARCH_RAIL_LABEL, { glyph: 'magnifying-glass', showText: false, flat: true, compact: true })
const rail = Container({ layoutManager: new VBox({ spacing: 2 }), components: [filesHandle, searchHandle] })

/**
 * The sidebar's one entry point for switching views — every trigger
 * (a rail click, `revealSearchView`, a project switch) calls this instead of
 * touching `filesHandle`/`searchHandle`/`content` directly, so they can never
 * drift out of sync. Plain `ToggleButton`s don't coordinate with each other
 * on their own; this closure is what enforces that exactly one is selected.
 *
 * @param view - The view to show.
 */
const selectExplorerView = (view: ExplorerView): void => {
    filesHandle.setSelected(view === 'files')
    searchHandle.setSelected(view === 'search')
    content.setVisibleComponentId(view === 'files' ? FILES_VIEW_ID : SEARCH_VIEW_ID)
}

filesHandle.on('action', () => selectExplorerView('files'))
searchHandle.on('action', () => selectExplorerView('search'))

const explorer = Container({
    layoutManager: new BorderLayout({ spacing: 0 }),
    minSize: EXPLORER_MIN_SIZE,
    preferredSize: EXPLORER_PREFERRED_SIZE,
    components: [
        { component: rail,    constraints: { placement: Placement.WEST } },
        { component: content, constraints: { placement: Placement.CENTER } },
    ],
})
```

`relabelTreeSection` (renamed target only, same shape as today):

```typescript
const relabelTreeSection = (root: string | null): void => {
    const sections = buildFilesViewSections(root)

    filesView.setLayoutManager(sections.accordion)
    filesView.setLayoutConstraints(tree, sections.treeSection)
    filesView.setLayoutConstraints(properties, sections.propertiesSection)
    filesView.scheduleLayout()
}
```

`revealSearchSection` renamed `revealSearchView`, `accordion.openSection(SEARCH_SECTION_INDEX)` replaced:

```typescript
const revealSearchView = (): void => {
    split.setPaneCollapsed(EXPLORER_PANE_INDEX, false)
    selectExplorerView('search')
    searchPanel.focusQuery()
}
```

`actions.onFindInFiles` now reads `revealSearchView` (name only — the Edit-menu item at [`src/shell/EditorShell.ts:585`](src/shell/EditorShell.ts#L585) already reads `actions.onFindInFiles` and needs no change).

`ExplorerView` is a small module-level type: `type ExplorerView = 'files' | 'search'`.

`buildFilesViewSections`/`FilesViewSections` replace `buildExplorerSections`/`ExplorerSections` (renamed, and narrowed to two sections):

```typescript
interface FilesViewSections {
    accordion: Accordion
    treeSection: AccordionConstraints
    propertiesSection: AccordionConstraints
}

function buildFilesViewSections(root: string | null): FilesViewSections {
    const accordion = new Accordion({ compact: true })
    const treeSection = new AccordionConstraints(treeSectionLabel(root), true, 'folder')

    treeSection.weight = TREE_SECTION_WEIGHT

    return {
        accordion,
        treeSection,
        propertiesSection: new AccordionConstraints(PROPERTIES_SECTION_LABEL, true, 'circle-info'),
    }
}
```

(Unchanged besides dropping the `searchSection` entry — `treeSectionLabel`, `TREE_SECTION_WEIGHT`, `PROPERTIES_SECTION_LABEL` are all reused as-is.)

Project-root listener's `finally` block ([`src/shell/EditorShell.ts:285-291`](src/shell/EditorShell.ts#L285)) gains one line:

```typescript
} finally {
    const openedRoot = this._tree.getProjectRoot()

    properties.setProjectRoot(openedRoot)
    searchPanel.setProjectRoot(openedRoot)
    relabelTreeSection(openedRoot)
    selectExplorerView('files')
}
```

---

## Ordered Implementation Steps

1. **`tests/searchResults.test.ts`** — delete the `describe('searchResultRow', ...)` block and its `glyphNameForPath` import (glyphing moves into `SearchPanel`'s renderer factory, not into `searchResults.ts`). Add a `describe('searchResultNodes', ...)` block covering the `## Expected Behaviour` cases below, importing `searchResultNodes` and `type { SearchTreeNodeData }` in place of `searchResultRow`. Keep the `searchSummaryText` block untouched. Run `npm test` — red (`searchResultNodes` doesn't exist yet, and the old `searchResultRow` import is gone).

2. **`src/explorer/searchResults.ts`** — delete `SearchResultRow`, `LABEL_SEPARATOR`, `pathAndLine`, and `searchResultRow`; delete the `glyphNameForPath` import (no longer used here). Add the `import type { TreeNode } from '@jimka/typescript-ui/component/tree'` (type-only, so this module stays loadable in vitest's `node` environment, the same reason [`src/explorer/entryProperties.ts`](src/explorer/entryProperties.ts) type-imports `EntryInfo`) and `import { pathSegments, joinPath, parentDir, baseName, relativeTo, sortDirEntries } from '../data/paths'`. Add `SearchTreeNodeData` and `searchResultNodes` with its private helpers (`groupByFile`, `matchNode`, `fileNode`, `sortLevel`), exactly as in `## Internal Structure`. Keep `SearchStatus`/`searchSummaryText`/`pluralize`/`completionSummary` unchanged. Run `npm test` — green.

3. **`src/explorer/SearchPanel.ts`** — swap the `List, GlyphListItemRenderer` import for `import { Tree, IconLabelTreeNodeRenderer } from '@jimka/typescript-ui/component/tree'` and `import type { TreeNode } from '@jimka/typescript-ui/component/tree'`; swap the `searchResultRow`/`SearchResultRow` import for `searchResultNodes`/`type SearchTreeNodeData`; add `import { glyphNameForPath } from '../fileIcons'`. Add `onOpenFile: (path: string) => void` to `SearchPanelParams`, documented per `## Public API`. Delete `PANEL_HEIGHT_PX` and the `preferredSize` line in the `super({...})` call. Rename `_resultsList: List` to `_resultsTree: Tree` (and its constructor local), delete `_rows: SearchResultRow[]`, add the renderer-factory call and `handleSelection` from `## Internal Structure`. Replace `resultsList.on('action', ...)` with `this._resultsTree.on('selection', this.handleSelection)` (after `super()`, mirroring `FileTree`'s own `this.on('selection', this.handleSelection)` placement). Shrink `handleKeyDown` to the `Enter`-only branch from `## Internal Structure`, deleting the `ArrowDown`/`ArrowUp` block and the now-unused `this._resultsList.handleKey` reference. Rewrite `appendMatches`/`clearResults` per `## Internal Structure`, deleting `handleActivateRow` (folded into `handleSelection`) and the `wasEmpty`/`setFocusedIndex` logic. Run `npm run typecheck` — expect it to fail only on `EditorShell.ts`'s still-unmodified `SearchPanel({...})` call site, which is missing the new `onOpenFile` field; step 5 fixes it.

4. **`src/shell/EditorShell.ts` — imports, constants, and renaming `buildExplorerSections`.** Add `VBox` to the existing `@jimka/typescript-ui/layout` import (line 4) and `ToggleButton` to the existing `@jimka/typescript-ui/component/button` import (line 8). Delete `SEARCH_SECTION_LABEL`/`SEARCH_SECTION_INDEX` (lines 46-52). Add, beside the remaining section constants: `FILES_VIEW_ID = 'explorer-files'`, `SEARCH_VIEW_ID = 'explorer-search'` (the content `Card`'s two page ids, named like `EDITOR_PAGE_ID`/`WELCOME_PAGE_ID` above them), `FILES_RAIL_LABEL = 'Files'`, `SEARCH_RAIL_LABEL = 'Search'` (the rail buttons' accessible names — not painted, per `showText: false`), and `type ExplorerView = 'files' | 'search'`. In the same pass, rename the `ExplorerSections` interface to `FilesViewSections` and `buildExplorerSections` to `buildFilesViewSections` (lines 488-522), dropping the `searchSection` field and its `AccordionConstraints(SEARCH_SECTION_LABEL, ...)` line, and updating the function's own doc comment to describe two sections, not three. Update `EXPLORER_PANE_INDEX`'s doc comment (line 36) and the class-level doc comment (lines 99-105) to describe the rail-plus-content composition in place of "explorer accordion." Run `npm run typecheck` — expect it to fail on the constructor (lines 122-300), which still constructs `explorer` from the now-renamed, now-two-section `buildExplorerSections` and still calls `accordion.openSection(SEARCH_SECTION_INDEX)`; step 5 fixes it. Do not add a stub.

5. **`src/shell/EditorShell.ts` — the constructor.** Add `onOpenFile: (path: string) => { void controller.openFile(path, 'permanent') }` to the `SearchPanel({...})` call (line 135-140). Replace the `initialSections`/`explorer`/`let accordion` block (lines 155-166 and 169-203) with the rail-and-content composition from `## Internal Structure` — `filesView`, `content`, `filesHandle`, `searchHandle`, `rail`, `selectExplorerView`, the rebuilt `explorer` (now referencing `buildFilesViewSections`, already renamed in step 4), `relabelTreeSection`, and `revealSearchView` (renamed from `revealSearchSection`). Update `onFindInFiles: revealSearchSection,` (line 227) to `onFindInFiles: revealSearchView,`. Add `selectExplorerView('files')` to the project-root listener's `finally` block (lines 285-291), after `relabelTreeSection(openedRoot)`. Run `npm run typecheck` — green. Check: `grep -rn 'SEARCH_SECTION\|buildExplorerSections\|ExplorerSections\b\|revealSearchSection' src/` — zero matches.

6. **`README.md`** — add a **Sidebar rail** highlight bullet immediately before **File tree** (line 17), and rewrite the **Project search** bullet (lines 49-54), both per `## Documentation Impact`.

7. **`TODO.md`** — update the **Project-wide replace** and **Regular-expression and match-case project search** bullets' `The Search section` wording to `The Search view`, and extend the **Remembering which explorer sections are open** bullet, both per `## Documentation Impact`.

8. **Run the whole `## Verification` list.**

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Modify | `src/explorer/searchResults.ts` |
| Modify | `src/explorer/SearchPanel.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `tests/searchResults.test.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Unit-testable — `tests/searchResults.test.ts`, `searchResultNodes`

Using `PATHS_1 = { path: '/p/src/data/paths.ts', line: 10, ... }`, `PATHS_2 = { path: '/p/src/data/paths.ts', line: 62, ... }`, `SHELL_1 = { path: '/p/src/shell/EditorShell.ts', line: 45, ... }`, `README_1 = { path: '/p/README.md', line: 3, ... }` (each with distinct `lineText`, matching the existing `MATCH` fixture's other fields):

| Input | Expected |
| --- | --- |
| `searchResultNodes([], '/p')` | `[]` |
| `searchResultNodes([PATHS_1], '/p')` | One top-level folder node (`label: 'src'`, `data.kind: 'folder'`) → one folder node (`label: 'data'`) → one file node (`label: 'paths.ts (1)'`, `data: {kind:'file', path:'/p/src/data/paths.ts'}`) → one match leaf (`label: '10: <PATHS_1.lineText>'`, `data: {kind:'match', match: PATHS_1}`, no `children`) |
| `searchResultNodes([PATHS_1, PATHS_2], '/p')` | The same chain down to one file node labeled `paths.ts (2)` with two match children, in the order `[PATHS_1, PATHS_2]` — not resorted |
| `searchResultNodes([PATHS_1, SHELL_1], '/p')` | `src`'s children are `[data-folder, shell-folder]`, alphabetical |
| `searchResultNodes([PATHS_1, README_1], '/p')` | Top level is `[src-folder, README.md-file]` — the folder sorts before the file regardless of name |
| `searchResultNodes([PATHS_1], null)` | One flat file node, `label: '/p/src/data/paths.ts (1)'`, `data: {kind:'file', path:'/p/src/data/paths.ts'}`, one match child |
| `searchResultNodes([PATHS_1, PATHS_2, SHELL_1, README_1], '/p')` | The full worked-example tree from `## Internal Structure` |

`searchSummaryText`'s existing table of cases is unchanged and stays in the test file as-is.

### Manual verification — the live app (`npm run tauri:dev`)

Everything below needs a mounted, laid-out sidebar and real keyboard/pointer focus, none of which the vitest harness provides.

| Action | Expected |
| --- | --- |
| Launch with a project open | The sidebar shows a narrow rail with two icons; **Files** is selected, showing the tree over the properties panel exactly as before |
| Click the **Search** rail icon | The content area switches to the empty Search view (query field, empty results, idle status); **Files**'s icon is no longer selected |
| Click **Files** again | Switches back; the tree's scroll position and selection are exactly as left |
| Ctrl/Cmd+Shift+F | Un-collapses the explorer pane if collapsed, switches to **Search**, and focuses the query field — same as today |
| Type a query, press Enter | Results build into a tree: folders and files as expandable branches (files labeled with their match count), matches as leaves; everything starts expanded |
| A query matching many files | Rows appear progressively, top file first, without the tree collapsing or losing its expanded state as later batches arrive |
| Click (or arrow-key onto) a match leaf | Previews that file in a temporary tab, with the match selected and scrolled into view |
| Double-click a match leaf | Opens that file in a permanent tab, with the match selected and scrolled into view |
| Click (or arrow-key onto) a file branch row | Previews that file in a temporary tab, with no selection change in the editor beyond whatever the file's own cursor position is |
| Double-click a file branch row | Opens that file in a permanent tab, with no selection change in the editor beyond whatever the file's own cursor position is |
| Click a folder branch row | Only expands/collapses it; nothing opens |
| Arrow-key down through the results tree (after Tab/click into it) | The row reached previews as described above; that preview's own tab activation then moves keyboard focus to the tab strip — the same tab-activation behavior `FileTree`'s own arrow-key file-browsing has — so a further arrow press switches tabs rather than advancing the tree's selection, until focus returns to the tree (Tab or a click) |
| Press Enter again with a new query while a run is still going | The tree rebuilds from the new run's results only; nothing from the superseded run survives |
| Enter with an empty query | The tree clears and the status line reads `Enter a query to search the project.` |
| Search with no project folder open | The chord still opens the Search view; Enter on a query reports `No matches.` (no files to search) |
| Open a different project folder while Search is showing | The rail switches back to **Files**; the Search view's own results and query clear (via `searchPanel.setProjectRoot`, unchanged) |
| *Edit > Find in Files…* and the palette's `> Find in Files…` | Both do exactly what the chord does |
| Ctrl/Cmd+B (Toggle Explorer) | Hides the whole sidebar — rail and content both — and restores it the same way |
| Resize the split gutter narrower | The rail's two icons stay visible and clickable; the content area (tree, properties, or search results) shrinks around them |

---

## Verification

- `npm run typecheck` — clean (expected to fail only between steps 3 and 5, per the ordered steps).
- `npm test` — the rewritten `tests/searchResults.test.ts` passes alongside the rest of the suite; `tests/projectSearch.test.ts` is untouched and still passes.
- `npm run build` — clean.
- `grep -rn 'SEARCH_SECTION\|buildExplorerSections\|ExplorerSections\b\|searchResultRow\|SearchResultRow\|GlyphListItemRenderer' src/` — zero matches.
- `grep -rn 'revealSearchSection' src/` — zero matches (renamed `revealSearchView` everywhere).
- `npm run tauri:dev`, then walk the manual table above. Open Loom's own repository as the project — it has nested directories several levels deep (`src/shell`, `src/data`, `src/editor`, `src/explorer`) and enough files that a broad query groups into a multi-level tree.

---

## Documentation Impact

`README.md`'s `## Highlights` gains a new bullet, placed immediately before **File tree**:

> - **Sidebar rail** — a narrow strip of icon buttons on the sidebar's edge switches its content between two views: **Files** (the file tree and the Properties panel, stacked as today) and **Search**. Selecting one shows only that view's content; *Toggle Explorer* (Ctrl/Cmd+B) still hides the whole sidebar, rail included.

The **File tree** and **Properties** bullets are unchanged — their own content and behavior don't change, only their container.

The **Project search** bullet is rewritten:

> - **Project search** — Ctrl/Cmd+Shift+F switches the sidebar to its **Search** view; Enter runs a case-insensitive substring search over every file the command palette lists. Results build into a tree grouped by folder, with each matching file as a branch (labeled with its match count) and each line match as a leaf under it; clicking a file branch opens it, and clicking a match opens its file with that match selected. A file too large to open, or that looks binary (a NUL byte in its first 8000 characters, git's own rule), is skipped.

`TODO.md`: the **Project-wide replace** and **Regular-expression and match-case project search** bullets' `The Search section (see README.md's Project search highlight)` becomes `The Search view (see README.md's Project search highlight)`. The **Remembering which explorer sections are open** bullet gains a clause: `...neither session.json nor .loom/workspace.json records their state, and the sidebar rail always starts on Files too.`

---

## Potential Challenges

- **`Tree.setNodes` clears expansion and selection on every call, silently.** `appendMatches` relies on this being harmless: nothing here restores prior expansion (everything is deterministically re-expanded via `expandAll()`), and nothing reacts to the resulting empty-selection state, since `setNodes` clears `_selectedNodes` directly without emitting `"selection"` (`Tree.ts`'s `setNodes`, distinct from its own `_notifySelectionChange`-guarded mutation paths). Do not add code that assumes a batch preserves which row was selected.
- **Rebuilding the whole node tree per streamed batch is O(total matches so far) each time**, same as the old `List.setItemsArray(this._rows)` already was. Bounded by `SEARCH_LIMITS.maxMatches = 200`, so the worst case (200 files each contributing one match) is a few hundred rebuilds of a small tree — not a performance concern at today's limits; revisit if `SEARCH_LIMITS` is ever raised (see `## Non-Goals`).
- **A stale match's line can have moved or vanished by the time it's clicked.** Unchanged from today — `revealRange`'s own clamping (`src/editor/editorSearch.ts`) already handles it; this plan touches nothing on that path.

---

## Critical Files

| File | Why |
| --- | --- |
| [`src/explorer/FileTree.ts`](src/explorer/FileTree.ts) | The precedent for building `TreeNode[]` from domain data with an opaque `data` payload, an `IconLabelTreeNodeRenderer` glyph resolver, and a `"selection"` handler that opens/reveals a row — the shape this plan's search tree follows throughout. |
| [`src/data/paths.ts`](src/data/paths.ts) | `sortDirEntries`, `pathSegments`, `joinPath`, `parentDir`, `baseName`, `relativeTo` — every helper `searchResultNodes` is built from, reused unchanged. |
| [`src/shell/EditorShell.ts`](src/shell/EditorShell.ts) | The constructor's full current composition (`buildExplorerSections`, `relabelTreeSection`, `revealSearchSection`, the `actions` literal), being restructured. |
| [`src/explorer/SearchPanel.ts`](src/explorer/SearchPanel.ts) | The component being rebuilt around `Tree` instead of `List`. |
| [`plans/implemented/project-wide-search.md`](plans/implemented/project-wide-search.md) | The precedent for the current flat-list Search section, its `[^panel-placement]` footnote (why a third `Split` pane and a `PopupPanel` were both rejected — the same reasoning this plan's rail-placement decision reuses), and the `SEARCH_LIMITS`/streaming design this plan leaves untouched. |
| [`plans/implemented/explorer-properties-panel.md`](plans/implemented/explorer-properties-panel.md) | The precedent for the current Tree-over-Properties `Accordion` this plan keeps intact under the Files rail entry, and for `Card`'s "one of two pages visible" idiom this plan's content area reuses. |
| [`src/editor/FileEditor.ts:79-84`](src/editor/FileEditor.ts#L79) | The established Loom precedent for an icon-only `ToggleButton` (`showText: false`, `flat`, `compact`) — the exact construction the rail's two buttons copy. |
| `@jimka/typescript-ui`'s [`Tree.md`](../typescript-ui/packages/lib/docs/components/Tree.md), [`Card.md`](../typescript-ui/packages/lib/docs/layouts/Card.md), and [`Rail.md`](../typescript-ui/packages/lib/docs/components/Rail.md)/[`Drawer.md`](../typescript-ui/packages/lib/docs/components/Drawer.md)/[`ButtonGroup.md`](../typescript-ui/packages/lib/docs/components/ButtonGroup.md) | The library references behind every `## Architecture Decisions` choice above — read these before touching either rewritten file. |

---

## Non-Goals

- **A third rail entry, or any entry beyond Files and Search.** Not asked for; nothing in the investigation surfaced a need for one.
- **`ButtonGroup`, `Rail`, or `Tab` for the rail itself.** Investigated and rejected — see `## Architecture Decisions` and its footnote.
- **Raising `SEARCH_LIMITS`.** `Tree`'s virtualization removes the original rationale for the 200-match cap, but changing it is a separate, unrequested behavior change with its own testing surface.
- **VS Code's single-child-directory path compaction** (e.g. showing `src/data` as one row). `FileTree` doesn't do this for the file explorer either; this plan follows that precedent rather than inventing a new algorithm.
- **Per-row tooltips on the search tree.** `TreeNode` has no tooltip field (unlike `List`'s `SearchResultRow.tooltip`), and `FileTree` doesn't add one via a custom renderer either.
- **Forwarding arrow keys from the query field into the results tree.** `Tree` wires its own keydown handling directly with no public equivalent to `List.handleKey`; see the footnote.
- **Persisting the selected rail view, or the search tree's expansion state**, across a restart. Neither `session.json` nor `.loom/workspace.json` records explorer-section state today either (see the `TODO.md` item this plan extends).
- **Custom rail chrome** (a background tint or a divider border separating the rail from the content area). Left to the library's own default `ToggleButton` styling for now.
- **Any change to `src/data/projectSearch.ts`** — the matching engine, its limits' *values*, and its streaming/cancellation design are all unchanged.

---

## Notes

[^panel-placement-precedent]: `plans/implemented/project-wide-search.md`'s own `[^panel-placement]` footnote records why the Search section became a third `Accordion` section rather than a third `Split` pane: `SessionState.paneSizes` is restored wholesale, so a stored two-entry array would be silently discarded against a three-pane split, resetting every user's explorer width on upgrade. That same array is still exactly two entries today (the rail doesn't add a pane — it lives inside the existing first pane's own `Container`), so the risk that reasoning warned about doesn't reappear here, and there is no need to touch `SessionState`/`WorkspaceState` at all.

[^rail-investigation]: `Rail`/`RailHandle` (`@jimka/typescript-ui/overlay`) were investigated first, since they read as purpose-built for an edge-anchored icon strip. They aren't a fit: a `Rail` mounts on `document.documentElement` as a `Position.FIXED` overlay spanning a whole viewport edge, entirely outside the component tree (`Rail.md`: "A rail mounts on `document.documentElement` as a `Position.FIXED` overlay") — not something a `Container` can host inline inside a `Split` pane. Its `registerDrawer` semantics are also wrong for "switch which view shows": each handle's selected wash independently mirrors its own `Drawer`'s open/closed state, so nothing stops two drawers being open at once (`Rail.ts`/`RailHandle.ts` — there is no group-level exclusivity anywhere in either class) — there is no single-select "activity bar" mode built in. `Drawer` itself is a floating, off-screen-until-opened overlay that slides in over the rest of the UI (`Drawer.md`), not an always-visible inline content pane — using it here would mean the sidebar's Files/Search content vanishes and reappears as an overlay instead of staying part of the layout, which is not how a sidebar view switch should look or behave.

    `Tab` (`@jimka/typescript-ui/layout`) gives exactly the single-select "one visible content at a time, switched by header click" semantics this rail needs — it's what Loom already uses for editor tabs — and `setSide('west')`/`setOrientation('vertical-cw'|'vertical-ccw')` can turn its strip into a vertical column. But `Tab`'s per-child `LayoutConstraints` are read into the `TabButton` it builds by `TabBar.createBarEntry` (`packages/lib/src/typescript/lib/component/container/TabBar.ts:1711`), which forwards only `glyph` and `closeable` (plus a separately-attached `tooltip`) — there is no `showText` passthrough anywhere in that call, so a `Tab` strip cannot be coaxed into pure icon-only buttons the way `Button`/`ToggleButton`'s own `showText: false` can. Confirmed by reading `TabButton`'s own constructor (`TabButton.ts`), which never receives `showText` from `TabBar` at all.

    `ButtonGroup` (`@jimka/typescript-ui/overlay`) does give "exactly one of a set of `ToggleButton`s selected" — its own stated purpose. But `ButtonGroup.addButton` wires its exclusivity off each member's own `"action"` event (`ButtonGroup.ts:231`, `button.on("action", () => this.updateButtonStates(button))`) — there is no public method to select a member programmatically and have the group (and the member's siblings) reconcile around it, which `revealSearchView` needs: switching to Search from Ctrl/Cmd+Shift+F without simulating a click. Reaching for `ButtonGroup` here would mean writing the programmatic path's `setSelected` calls by hand *anyway* (bypassing the group's own exclusivity check, since there's no other way to drive it non-interactively), making it a second, redundant mechanism alongside the one already needed — for two buttons, no net benefit over just hand-coordinating both from the start.

    The chosen design is the smallest composition left standing once each purpose-built candidate is ruled out for a concrete, cited reason: two plain `ToggleButton`s (`glyph`, `showText: false`, mirroring `FileEditor`'s own established precedent for exactly this construction) inside a narrow `VBox`, and one closure — mirroring `revealSearchSection`'s own already-established "one entry point every trigger shares" idiom (`EditorShell.ts:209`, predating this plan) — that keeps both buttons and the content `Card` in sync on every call, click-driven or programmatic alike.

[^tree-shape]: `FileTree.toNodes` (`src/explorer/FileTree.ts:635`) maps `DirectoryItem[]` into `TreeNode` literals carrying `data: FileTreeNodeData` (`{path, isDir, parentChain}`), read back by `handleSelection`/`handleDblClick` via `node.data as FileTreeNodeData`. `searchResultNodes` follows the identical contract — a plain object literal per node, an opaque `data` tag, read back the same way in `SearchPanel.handleSelection` — the only structural difference is that `FileTree` builds one directory's worth of nodes lazily per expansion (`loadChildren`), while `searchResultNodes` builds the whole tree eagerly from an in-memory match list every time, because the full result set already exists in memory and nothing about it is lazy.

[^no-handlekey]: `List.handleKey` (used by both the old `SearchPanel` and `CommandPalette`) is a public method a caller can forward a raw `KeyboardEvent` into from anywhere — that's what let the query field stay focused while `ArrowUp`/`ArrowDown` drove the list's own highlight. `Tree` wires its keyboard handling directly and privately: `Event.addListener(this, "keydown", this._onKeyDown)` inside `Tree`'s own constructor, with no public equivalent exposed (confirmed by search — no `handleKey`, no `setSelectFollowsFocus`, nothing matching that shape anywhere in `Tree.ts`). Reproducing the old "stay in the query field, arrows drive a remote highlight" model would mean either duplicating `Tree`'s internal arrow-key/expand/collapse logic outside the class, or adding a new public hook to the library itself — both out of scope for an application-level plan. Embracing `Tree`'s native model instead — real DOM focus lives in the tree, arrows navigate and select natively — is also how `FileTree`, the precedent this plan is told to follow, already works throughout the rest of the sidebar.

---

## Implementation Notes

Two small deviations from this plan's literal code snippets were needed to make them compile, neither changing the design the plan describes:

- **`searchResultNodes`'s nested `folderChildren` closure needed an explicitly-typed local, not a direct reference to the narrowed `root` parameter.** The plan's `## Internal Structure` snippet reads `root` (typed `string | null`) directly inside the nested `function folderChildren`, relying on the `if (root === null) return ...` guard above it to have narrowed `root` to `string`. TypeScript does not carry a parameter's null-narrowing into a nested function declaration that closes over it — the guard only narrows within the enclosing function's own top-level flow — so `tsc` rejected `joinPath(root, relDir)` with "Type 'null' is not assignable to type 'string'." Fixed by introducing `const projectRoot: string = root` immediately after the guard and having `folderChildren` close over `projectRoot` instead; its explicit type needs no flow narrowing, since it's never reassigned. No behavioral change — `projectRoot` and the narrowed `root` hold the same value.
- **The content `Card`'s `setVisibleComponentId` calls needed a direct `Card` reference, not the wrapping `Container`.** The plan's `EditorShell` snippet calls `content.setVisibleComponentId(...)` where `content` is a `Container({ layoutManager: new Card(), ... })` — but `setVisibleComponentId` is `Card`'s own method, not `Container`'s; `tsc` rejected both call sites with "Property 'setVisibleComponentId' does not exist on type 'Container'." Fixed by keeping a separate `const contentCard = new Card()` reference (passed as `content`'s `layoutManager`) and calling `contentCard.setVisibleComponentId(...)` — the same shape `buildEditorDeck`'s own `card`/`deck` pair already uses one function above in this same file. No behavioral change.

Three further audit cycles (a post-implementation audit runs to convergence, re-reviewing the fixed state each round) surfaced seven more issues, all fixed on this branch:

- **`searchResultNodes` duplicated a folder reached both directly and as an ancestor, on a Windows-style root.** `folderChildren`'s memoization key (`relDir`, taken verbatim from `relativeTo`, which preserves `root`'s own separator) and its own recursively-computed `parentRel` (always `/`-joined, per the plan's literal snippet) disagreed on separator convention for a backslash-separated root, so the same logical directory memoized under two different keys and rendered twice. Fixed by normalising `relDir` to `/` at the one call site that derives it from `relativeTo`, and by rebuilding each folder node's own absolute `path` field one segment at a time via `joinPath` (onto its parent's *own already-resolved* path) instead of joining a whole `/`-normalised `relDir` string directly onto `root` — the latter would otherwise mix `/` and `root`'s own separator within one path string. A regression test (`tests/searchResults.test.ts`, "shares one folder node... on a Windows-style root") pins both the single-node and the correctly-separated-path behavior. Not something the plan's own unit-test table exercised — none of its cases use a backslash-separated root — so nothing here contradicts an existing test; this only adds coverage the plan's table didn't ask for.
- **The Search view's selection handlers cited a `FileTree` precedent they didn't actually match — and an intermediate fix compounded the citation error before it was caught.** The plan's `## Architecture Decisions` describes the new `onOpenFile` callback as "matching... `FileTree.handleSelection`'s own file-row convention," and its own manual-verification table names `'permanent'` explicitly for both a match-leaf and a file-branch click — but `FileTree.handleSelection`'s real file-row convention (`EditorShell.ts`'s `onSelectFile` wiring, which fires on both a click *and* an arrow-key move, exactly like `Tree`'s one `"selection"` event here) is `'temporary'`; `FileTree` reserves `'permanent'` for its `onOpenFile` callback, fired on a genuinely separate `"dblclick"` event `Tree` does emit (`Tree.ts`'s own `TreeEvent` union includes `"dblclick"`, documented as pairing with `"selection"` for exactly this preview/commit split). Left as the plan specified, arrow-browsing across several results — which fires the identical selection handler as a click, since `Tree` cannot tell a click from an arrow-key move apart — pinned one permanent tab per row reached, contradicting the same table's own arrow-key row ("mirrors the file tree's own arrow-key-**previews**-a-file behavior").

  Resolved in three passes. The first pass (cycle 1) changed only the file-branch `onOpenFile` wiring to `'temporary'`, reasoning that the match-leaf path (`onOpenMatch` → `EditorController.openFileAt`, hardcoded `'permanent'`) was pre-existing, out of this plan's declared file scope, and explicitly specified by the plan's own match-leaf table row — so it was left alone. A second audit cycle correctly called that inconsistent: this same branch already touched `src/shell/shortcuts.ts` for the doc-comment fix below, an equally out-of-scope file, and the identical pin-every-row-reached defect applies to match leaves with the same force it did to file branches. `openFileAt` has exactly one caller in the whole codebase (this plan's own `onOpenMatch` wiring), so widening its scope carried negligible risk: it gained an optional `mode: OpenMode = 'permanent'` parameter (default preserves every other behavior, since there are no other callers to preserve it for), and `onOpenMatch` started passing `'temporary'` explicitly — but the comment justifying this claimed `Tree` had no dblclick equivalent to reserve for `'permanent'`, which is false, and the net effect was that nothing in the Search view could open a permanent tab anymore — a real regression against this branch's own start point, where Enter or a click on a result committed one.

  A third audit cycle caught both the false claim and the resulting regression. Fixed by adding the missing half of `FileTree`'s real two-tier convention: `SearchPanel.ts` now wires `Tree`'s `"dblclick"` event (`handleDblClick`, mirroring `handleSelection`'s own `nodes[0]?.data` guard) to two new `SearchPanelParams` callbacks, `onCommitMatch`/`onCommitFile`, which `EditorShell.ts` wires to `'permanent'` opens — while `onOpenMatch`/`onOpenFile` keep their `'temporary'` selection-time meaning. `README.md`'s Project-search bullet was updated to describe the same click-previews/dblclick-commits split its File-tree bullet already documented, closing the doc gap the second cycle had left open. The `## Expected Behaviour` manual table above was updated to match (separate click-previews/dblclick-commits rows for both a match leaf and a file branch, replacing the superseded single-click-opens-permanent rows). Verified live: double-clicking a match leaf opens it in a non-italic (permanent) tab with the match selected; double-clicking a file branch opens it in a non-italic tab; double-clicking a second, different result opens a second permanent tab alongside the first rather than replacing it, confirming the commit path never recycles a single temp slot the way the preview path does.
- **The results `Tree` was missing `expandTrigger: 'click'`.** The plan's `## Internal Structure` snippet constructs `new Tree({ rowOverflow: 'scroll' })`, omitting the option — so the library's default (`'dblclick'`) applied, and a single click on a folder branch only selected it, contradicting the plan's own manual-verify row ("Click a folder branch row | Only expands/collapses it") and diverging from `FileTree`, the precedent this plan is told to follow outright (`FileTree.ts` sets `expandTrigger: 'click'` explicitly). Fixed by adding `expandTrigger: 'click'` to `SearchPanel.ts`'s `Tree` construction. Verified live: a single click on a folder branch now expands/collapses it.
- **A stale doc comment.** `AcceleratorActions.onFindInFiles` (`src/shell/shortcuts.ts`) still described "the explorer's Search section" after every other such reference in `src/`, `README.md`, and `TODO.md` was renamed to "Search view." Reworded to match.
- **A `'temporary'` reveal still stole keyboard focus via the editor itself, on top of a separate, pre-existing focus move the tab strip already makes on every open.** `EditorController.openFileAt`'s reveal step (`FileEditor.revealMatch` → `editorSearch.ts`'s `revealRange`) called `view.focus()` unconditionally, regardless of `mode` — so even after the `'temporary'` fix above, selecting one match moved keyboard focus into its editor on top of whatever the tab activation below already did. This silently violated `openFile`'s own documented contract ("`'temporary'` leaves focus wherever it was"). Fixed by threading an optional `focus: boolean = true` parameter through `revealRange` → `FileEditor.revealMatch` → `EditorController.openFileAt` (each with a single caller, so the default preserves all other behavior), with `openFileAt` passing `focus: mode === 'permanent'`. This part is correct and complete: for a `'temporary'` reveal, the editor itself no longer takes focus.

  **This fix does not, by itself, make continuous arrow-key browsing work**, and an earlier draft of this note overstated that it did. `EditorController.openFile` calls `this.tabs.getTab().setActiveContent(...)` on *every* open, already-open-file included (`src/EditorController.ts`'s existing-tab branch and its new-tab branch alike) — and `Tab.setActiveContent` moves keyboard focus to the newly active tab's own button (`setActiveTabIndex` → `TabBar.setActiveEntry` → `onTabPressed` → `RovingTabIndex.moveTo` → `Component.focus()`, which focuses even when the active index is unchanged). So arrow-browsing loses tree focus after the very first match or file-branch row it reaches (a folder branch triggers no open, so arrowing across folders alone does not), regardless of whether that row's file was already open; a further arrow press then switches tabs (Left/Right) rather than continuing to move the tree's own selection, until focus returns to the tree via Tab or a click. This is not a regression introduced by this plan or by this fix: the identical behavior was confirmed live in `FileTree`'s own arrow-key file-browsing on this same start point (clicking, then arrow-keying across, files in the **Files** view parks focus on each newly-activated tab button the same way). The `## Expected Behaviour` manual table's arrow-key row above was reworded to describe this actual, narrower scope rather than the "each row opens as it's reached" wording an earlier draft carried.
