---
depends-on: [session-persistence, workspace-session-persistence]
touches-shared: [src/EditorController.ts, src/shell/EditorShell.ts, src/shell/session.ts, src/data/session.ts, src/data/workspaceState.ts, src/editor/FileEditor.ts, tests/session.test.ts, tests/workspaceState.test.ts, package.json, README.md, TODO.md]
---

# Dock-Based Split-Pane Editing — Implementation Plan

## Overview

Loom opens every file into one tab strip: a single `TabPanel` built in [`src/EditorController.ts:84`](src/EditorController.ts#L84), placed in the editor half of the shell's `Split` through a `Card` deck ([`src/shell/EditorShell.ts:543`](src/shell/EditorShell.ts#L543)). This plan replaces that one strip with a `Dock` — the library's rearrangeable panel workspace, which already composes `Split` and `Tab` — so a file can be dragged into a second editor group beside the first, or torn off into a floating window, and the whole arrangement comes back on the next launch.

Three things change shape. `EditorController`'s open-file registry becomes a map keyed by a **panel id** (the dock's identity key) instead of an array ordered by tab position. "The active editor" stops being `Tab.getActiveContent()` and becomes a field the controller updates from the dock's own dock-wide `focus` event. And persistence gains one field, `editorLayout`, beside today's `paneSizes`/`collapsedPanes`/`openFiles`/`activeFile` in both [`src/data/session.ts`](src/data/session.ts) and [`src/data/workspaceState.ts`](src/data/workspaceState.ts), carrying the dock's `LayoutState` with panel ids translated to file paths. One new pure module, `src/data/editorLayout.ts`, owns that translation and the layout's validation.

**This plan cannot be implemented against `@jimka/typescript-ui` as it stands.** `Dock` exposes no way to relabel a panel's tab, re-icon it, italicise it, mark it modified, react to a double-click on it, or veto its close, and no way to configure the tab strips it builds — seven things Loom's current tab strip does and that `README.md` documents. Those are library gaps, not Loom problems, so this plan states them as blocking upstream prerequisites rather than designing around them. `## Upstream Prerequisites` is the section a reviewer has to act on before anything else here starts.

---

## Upstream Prerequisites

Every item below is **blocking**: without it, a documented Loom behaviour disappears. The gap is that `Tab`'s per-tab surface is addressed by content component, and `Dock` owns its `Tab` regions privately — it creates them in `compileLayout`/`newTabRegion`, re-creates them whenever a drop splits a region, and exposes no accessor for the one hosting a given panel. The fix belongs upstream, keyed by panel id, next to the panel-id-keyed `focusPanel`/`removePanel` that already exist.

### Proposed `Dock` additions

```typescript
// @jimka/typescript-ui/overlay — class Dock

/** Relabels panel `id`'s tab. Returns whether the panel was found. */
setPanelTitle(id: string, title: string): boolean

/** Replaces panel `id`'s tab glyph. Returns whether the panel was found. */
setPanelGlyph(id: string, glyph: string): boolean

/** Italicises (or un-italicises) panel `id`'s tab label. Returns whether the panel was found. */
setPanelItalic(id: string, italic: boolean): boolean

/** Shows or hides the unsaved-changes dot on panel `id`'s tab. Returns whether the panel was found. */
setPanelModified(id: string, modified: boolean): boolean

/** Applies `options` to every region the dock owns now, and to every region it builds later. */
setTabOptions(options: TabOptions): this

// DockOptions
tabOptions?: TabOptions

// New events
on(event: 'beforeclose', listener: (event: DockPanelEvent, controller: TabCloseController) => void): this
on(event: 'dblclick', listener: (event: DockPanelEvent) => void): this
```

Three requirements on the above matter as much as the signatures:

1. **The four `setPanel*` writes must be durable**, stored where `Tab.createTab` re-reads them — the way `LayoutConstraints.glyph` already is — so they survive a tear-off, a re-dock, and a `setLayoutState` restore. `Tab.setTabItalic` and `Tab.setTabModified` are documented today as view-only and explicitly *not* surviving any of those three.[^durable-flags] A dock makes all three routine, so view-only flags cannot carry Loom's dirty dot or its temp-tab italics.
2. **The four `setPanel*` writes must accept a panel whose tab cell does not exist yet**, recording the value for the cell's eventual creation instead of returning `false`. The same durability that satisfies (1) satisfies this.[^flush-dance]
3. **`beforeclose` fires for every user-initiated destroy — a tab ✕ and a float window's chrome ✕ — and `removePanel(id)` bypasses it**, staying the unguarded programmatic path. `Tab` already splits these two paths exactly this way: the ✕ handler emits `beforetabclose` and honours `preventDefault`, while the public `closeTab` goes straight to the teardown. Loom's dirty-file prompt depends on that split — it vetoes the ✕, prompts, and then closes through the unguarded path.[^veto-split]

### What each one keeps alive

| Prerequisite | Loom behaviour that needs it | Today's call site |
| --- | --- | --- |
| `beforeclose` + `preventDefault` | Closing a tab with unsaved changes prompts instead of discarding | [`src/EditorController.ts:1048`](src/EditorController.ts#L1048) |
| `setPanelModified` | The per-tab unsaved-changes dot | [`src/EditorController.ts:1027`](src/EditorController.ts#L1027) |
| `setPanelItalic` | A temp (preview) tab's italic label | [`src/EditorController.ts:533`](src/EditorController.ts#L533) |
| `setPanelTitle` | Tab label after a rename, a Save As, or a temp→pinned flip | [`src/EditorController.ts:269`](src/EditorController.ts#L269) |
| `setPanelGlyph` | Tab icon after a Save As changes the file's type | [`src/EditorController.ts:904`](src/EditorController.ts#L904) |
| `dblclick` | Double-clicking a tab pins it | [`src/EditorController.ts:1116`](src/EditorController.ts#L1116) |
| `tabOptions` + `setTabOptions` | `widthMode: 'content'`, `scrollable`, and the `tabMaxWidthPx` setting | [`src/EditorController.ts:85`](src/EditorController.ts#L85), [`src/EditorController.ts:811`](src/EditorController.ts#L811) |

### Non-blocking gaps, recorded not solved

Two more gaps surfaced and are **not** prerequisites, because phase one works without them:

- **No programmatic split.** `Dock` has no `splitPanel(id, edge)`; splitting happens only by dragging a tab onto a region edge, through `DockRegion`. A *Split Editor Right* menu item or palette command therefore cannot be built — see `## Non-Goals`.
- **No layout-changed event.** Dragging a gutter inside the dock changes the split ratios `getLayoutState()` reports, but emits nothing Loom can subscribe to; `Dock`'s own documentation suggests re-reading `getLayoutState()` on `move`, which has the same hole. Covered here by the session write that already runs on the way out of the app — see `## Potential Challenges`.

---

## Architecture Decisions

### The editor pane becomes a `Dock`, mounted directly in the shell's existing `Split`

`EditorController` constructs a `Dock` where it constructs a `TabPanel` today, and `EditorShell` adds that dock to the editor pane directly — `splitBody.addComponent(controller.dock, { weight: 1 })` in place of the `Card` deck. The shell's `Split` keeps exactly two panes, so `SessionState.paneSizes` and `collapsedPanes` keep their current two-entry shape and no stored session is invalidated.[^two-panes] The precedent is the shell's own composition: [`src/shell/EditorShell.ts:248`](src/shell/EditorShell.ts#L248) already adds one component per pane with a weight, and `Dock`'s own documentation places it as the workspace panels live in.

### The welcome screen becomes the dock's `emptyContent`

`DockOptions.emptyContent` is the library's own "start page shown while no panel is open", which is exactly what Loom hand-builds today with a two-page `Card` and a controller callback. `EditorShell` calls `controller.dock.setEmptyContent(welcome)` where it used to call `buildEditorDeck`, and `buildEditorDeck`, `EDITOR_PAGE_ID`, `WELCOME_PAGE_ID`, and `EditorController.setEmptyStateListener` are all deleted.[^empty-content]

The one visible difference: the placeholder renders as a single non-closeable tab cell labelled from the component's name, so an empty Loom shows a **Welcome** tab above the welcome screen where today it shows no strip at all. `EditorShell` sets that label with `welcome.setName(WELCOME_TAB_LABEL)`.

### One dock panel per open buffer, keyed by a minted id — not by the file's path

Each open buffer gets a panel id minted once when it opens, `buf-1`, `buf-2`, … , and keeps it for the buffer's whole life. `FileEditor` carries it as a constructor field, and `EditorController._openFiles` becomes a `Map<string, FileEditor>` keyed by it.

The path cannot be the id. `Dock` wraps each panel's content in an identity frame whose id is fixed when the frame is constructed and cannot be reassigned afterwards — while a Save As or a tree rename does change an open buffer's path.[^minted-ids] An untitled buffer has no path at all. Minting instead means the **persisted** layout has to be translated — see the next decision.

### The dock-wide `focus` event is the new "active editor"

`EditorController` gains `_activePanelId: string | null`, set from `dock.on('focus', …)` (which fires across tiled groups *and* floats, with a `null` payload when nothing is focused). `getActiveFile()` resolves that id through `_openFiles`. Every existing caller of `getActiveFile()` — `saveActive`, `canSaveActive`, `closeActive`, `formatActive`, `findInActive`, `syncActive`, `handleCursorChange`'s same-file guard, `markExternalChanges`' active check — is unchanged.

One active panel dock-wide is the right model, not a per-group active file: the window title, the status bar's caret readout, and the language label all describe one file, and with two groups side by side that file is the one the user is working in. The non-focused group still shows its own active tab in its own strip, which `Tab` handles per region with no Loom involvement.

### `editorLayout` persists the arrangement, translated through file paths

Both `SessionState` and `WorkspaceState` gain `editorLayout: LayoutState | null`. It is captured from `dock.getLayoutState()` with every panel id rewritten to the buffer's file path, and restored by rewriting each path back to that launch's freshly minted panel id. Untitled buffers have no path, so they drop out of the saved layout — consistent with `openFiles`, which already omits them.

`openFiles` and `activeFile` stay exactly as they are and stay authoritative for *which* files reopen: `Dock.setLayoutState` sources panels from the registry by id, so every panel must already be registered before the arrangement is rebuilt. `editorLayout` only says how the reopened files are arranged. A `null` or unusable `editorLayout` — an older session file, a hand-edited one — is skipped, and every file lands in the dock's one default group, which is today's behaviour exactly.[^layout-degrades]

The translation, the validation, and the document-order walk that derives `openFiles` from the layout all live in one new pure module, `src/data/editorLayout.ts`, with no Tauri imports — the same split [`src/data/session.ts`](src/data/session.ts) and [`src/data/workspaceState.ts`](src/data/workspaceState.ts) already draw between pure data shape and the Tauri-backed read/write in [`src/shell/session.ts`](src/shell/session.ts).

### The search and reveal seam needs no change

[`src/editor/editorSearch.ts`](src/editor/editorSearch.ts) resolves the live CodeMirror view by the `CodeEditor`'s own DOM id ([`src/editor/editorSearch.ts:33`](src/editor/editorSearch.ts#L33)) and defers the reveal to `Component.onFirstLayout`. Neither depends on which group the editor sits in, so both keep working across groups and inside a torn-off float with no edit. `EditorController.openFileAt` already looks its target up in the open-file registry rather than trusting whichever tab is active ([`src/EditorController.ts:502`](src/EditorController.ts#L502)), so it is group-agnostic too. `findInActive()` follows the focused group, because it resolves through `getActiveFile()`.

### Drag-to-split, cross-group drag, and tear-off floats are all in scope; a split *command* is not

`Dock` wires `DockRegion` onto every region and `setReorderable(true)` onto every `Tab` itself, in a sweep that also covers the regions a drop creates mid-gesture. Loom gets tab reorder, cross-group drag, edge-drop-to-split, and tear-off by construction — there is no opt-out short of another upstream request, and nothing here tries to build one. Floats are persisted too, because `getLayoutState()` captures each float's rect, state, and internal region tree, and silently dropping them would lose an open editor across a restart.

What phase one does **not** get is a *Split Editor Right* / *Split Editor Down* command, because `Dock` offers no programmatic split (see `## Upstream Prerequisites`). Splitting is a drag gesture only. Making a torn-off float a real Tauri OS window also stays out — that is already its own `TODO.md` entry.

---

## Public API

### `src/data/editorLayout.ts` (new)

```typescript
import type { LayoutState } from '@jimka/typescript-ui/layout'

/**
 * Validates `value` as a `LayoutState`, discarding the whole value on any
 * defect — the same all-or-nothing rule `session.ts`'s `readLayoutSizeArray`
 * applies to a stale `paneSizes` array.
 */
export function readLayoutState(value: unknown): LayoutState | undefined

/**
 * Rewrites every panel id in `state` through `mapping`, dropping what no
 * longer resolves: an unmapped panel, a tab group left with no panels, a
 * split pane left empty (its `ratios`/`collapsed` entry going with it), and a
 * float window left with no content. A split left with one pane collapses
 * into that pane. Returns `null` when nothing survives.
 */
export function remapPanelIds(state: LayoutState, mapping: ReadonlyMap<string, string>): LayoutState | null

/** Every panel id in `state`, in document order: the tiled tree depth-first, then each float in `windows` order. */
export function panelOrder(state: LayoutState): string[]
```

### `src/data/session.ts`

```typescript
export interface SessionState {
    // … every existing field unchanged …
    /** The editor dock's arrangement with panel ids rewritten to file paths, or `null` when none was captured. */
    editorLayout: LayoutState | null
}
```

`emptySession()` returns `editorLayout: null`. `parseSession` reads it with `readLayoutState(doc.editorLayout) ?? empty.editorLayout`.

### `src/data/workspaceState.ts`

```typescript
export interface WorkspaceState {
    // … every existing field unchanged …
    /** The editor dock's arrangement with panel ids rewritten to file paths, or `null` when none was captured. */
    editorLayout: LayoutState | null
}
```

`emptyWorkspaceState()` returns `editorLayout: null`. `parseWorkspaceState` reads it the same way `parseSession` does. `workspaceStateFromSession` and `applyWorkspaceOverlay` copy it verbatim, alongside `paneSizes`/`collapsedPanes`.[^workspace-verbatim]

### `src/EditorController.ts`

```typescript
class EditorController {
    /** The editor workspace: one or more tab groups the user can split, rearrange, and tear off. Replaces the former single `tabs: TabPanel`. */
    readonly dock: Dock
    readonly statusBar: StatusBar

    /** The dock's arrangement with panel ids rewritten to file paths, or `null` when no saved file is open. */
    captureEditorLayout(): LayoutState | null

    /**
     * Reopens `paths`, rebuilds `editorLayout`'s arrangement over them, then
     * activates `activePath`. Replaces the two-argument `restoreFiles`.
     */
    restoreFiles(paths: string[], activePath: string | null, editorLayout: LayoutState | null): Promise<void>
}
```

Removed: `tabs: TabPanel` (replaced by `dock`), `setEmptyStateListener` (replaced by the dock's own `emptyContent`), and `getOpenFilePaths()` (replaced by `panelOrder(captureEditorLayout())`, so tab order is read from the arrangement rather than from a strip index). Every other public method keeps its current signature.

### `src/editor/FileEditor.ts`

```typescript
export interface FileEditorParams {
    /** The dock panel id minted for this buffer, fixed for its whole life. */
    panelId: string
    // … every existing field unchanged …
}

class FileEditor extends Container {
    /** The dock panel id this buffer's tab is addressed by. */
    getPanelId(): string
}
```

---

## Internal Structure

### `src/data/editorLayout.ts`

`remapPanelIds` walks bottom-up and returns `null` for a node that did not survive, so each parent filters its own children:

```typescript
function remapNode(node: LayoutNode, mapping: ReadonlyMap<string, string>): LayoutNode | null {
    if (node.kind === 'panel') {
        const mapped = mapping.get(node.panelId)

        return mapped === undefined ? null : { ...node, panelId: mapped }
    }

    if (node.kind === 'tab') {
        const active = node.children[node.activeIndex]
        const kept: LayoutNode[] = []
        let activeIndex = 0

        for (const child of node.children) {
            const mappedChild = remapNode(child, mapping)

            if (mappedChild !== null) {
                if (child === active) {
                    activeIndex = kept.length
                }

                kept.push(mappedChild)
            }
        }

        return kept.length === 0 ? null : { kind: 'tab', children: kept, activeIndex }
    }

    return remapSplit(node, mapping)
}

function remapSplit(node: SplitNode, mapping: ReadonlyMap<string, string>): LayoutNode | null {
    const kept: LayoutNode[] = []
    const ratios: number[] = []
    const collapsed: boolean[] = []

    node.children.forEach((child, index) => {
        const mappedChild = remapNode(child, mapping)

        if (mappedChild !== null) {
            kept.push(mappedChild)
            ratios.push(node.ratios[index] ?? 0)
            collapsed.push(node.collapsed[index] ?? false)
        }
    })

    if (kept.length === 0) {
        return null
    }

    // A split left with one pane is no longer a split — the same collapse
    // `Dock.collapseSinglePaneSplit` performs on a live tree when a region is
    // pruned, applied here so a restore never rebuilds a one-pane split.
    if (kept.length === 1) {
        return kept[0]
    }

    return { kind: 'split', orientation: node.orientation, children: kept, ratios: normalizeRatios(ratios), collapsed }
}
```

`normalizeRatios` divides each surviving ratio by their sum so the array still sums to 1; a sum of 0 distributes evenly across the survivors. Dropping a pane otherwise leaves `Split` restoring ratios that do not add up.

Window nodes are remapped in `remapPanelIds` itself: a node with `content` keeps it when `remapNode` survives, a legacy `panelId`-only node survives only when its id maps, and a node that survives neither way is dropped.[^foreign-windows]

Worked example. The mapping is the capture direction, `panel id → path`, and `buf-3` is an untitled buffer, so it has no entry:

```
mapping: buf-1 → /p/a.ts,  buf-2 → /p/b.ts      (buf-3 is untitled, so unmapped)

input root:
split horizontal   ratios [0.6, 0.4]   collapsed [false, false]
├── tab  activeIndex 1
│   ├── panel buf-1
│   └── panel buf-3
└── tab  activeIndex 0
    └── panel buf-2
```

| Case | Result |
| --- | --- |
| The tree above | `split` keeps both panes, ratios `[0.6, 0.4]`; the first `tab` keeps one child (`/p/a.ts`) with `activeIndex` 1 → 0, since the active child `buf-3` dropped; the second `tab` is unchanged but for its path |
| The same tree, mapping lacking `buf-1` too | The first `tab` loses every child and drops; the `split` is left with one pane and collapses into it, so the root becomes the `tab` holding `/p/b.ts` |
| The same tree, empty mapping | `null` — the caller skips the restore entirely |
| `panelOrder` over the input tree | `['buf-1', 'buf-3', 'buf-2']` — the tiled tree depth-first, panes in order, tabs in order |

### `EditorController` — the registry and the dock wiring

```typescript
readonly dock: Dock
private readonly _openFiles: Map<string, FileEditor> = new Map()
private _activePanelId: string | null = null
private _panelIdSeq = 0
```

Constructed in place of the `TabPanel` at [`src/EditorController.ts:84`](src/EditorController.ts#L84):

```typescript
this.dock = new Dock({
    tabOptions: { widthMode: 'content', maxWidth: DEFAULT_SETTINGS.tabMaxWidthPx, scrollable: true },
})
```

`reorderable` is not passed — `Dock` sets it on every region itself.

The four `Tab` subscriptions at [`src/EditorController.ts:125-128`](src/EditorController.ts#L125) become four `Dock` subscriptions:

```typescript
this.dock.on('beforeclose', this.handleBeforePanelClose)
this.dock.on('close', this.handlePanelClose)
this.dock.on('focus', this.handlePanelFocus)
this.dock.on('dblclick', this.handlePanelDoubleClick)
```

Each handler resolves the payload's `id` through `_openFiles` and then does exactly what its `Tab`-era counterpart did:

```typescript
private handleBeforePanelClose = (event: DockPanelEvent, controller: TabCloseController): void => {
    const file = this._openFiles.get(event.id)

    if (!file || !file.isDirty()) {
        return
    }

    controller.preventDefault()
    void this.confirmThenClose(file)
}

private handlePanelClose = (event: DockPanelEvent): void => {
    this._openFiles.delete(event.id)

    // The dock re-selects a surviving panel and emits its `focus` after this
    // handler returns, so reading the active panel synchronously here would
    // still see the one being closed — the same deferral the former
    // `"tabclose"` handler used for the same reason.
    queueMicrotask(() => this.syncActive())
}

private handlePanelFocus = (event: DockPanelEvent | null): void => {
    this._activePanelId = event?.id ?? null
    this.syncActive()

    const file = this.getActiveFile()

    if (file) {
        void this.resolvePendingExternalChange(file)
    }
}

private handlePanelDoubleClick = (event: DockPanelEvent): void => {
    const file = this._openFiles.get(event.id)

    if (file) {
        this.pinTab(file)
    }
}
```

`getActiveFile()` replaces its `Tab` read:

```typescript
private getActiveFile(): FileEditor | null {
    return this._activePanelId === null ? null : this._openFiles.get(this._activePanelId) ?? null
}
```

Every remaining `this.tabs.getTab().X(file, …)` call becomes the panel-id-keyed dock call, with `file.getPanelId()` in place of `file`:

| Today | Replacement |
| --- | --- |
| `setTabName(file, name)` | `this.dock.setPanelTitle(file.getPanelId(), name)` |
| `setTabGlyph(file, glyph)` | `this.dock.setPanelGlyph(file.getPanelId(), glyph)` |
| `setTabItalic(file, italic)` | `this.dock.setPanelItalic(file.getPanelId(), italic)` |
| `setTabModified(file, dirty)` | `this.dock.setPanelModified(file.getPanelId(), dirty)` |
| `setActiveContent(file)` | `this.dock.focusPanel(file.getPanelId())` |
| `closeTab(file)` | `this.dock.removePanel(file.getPanelId())` |
| `setMaxWidth(px)` | `this.dock.setTabOptions({ maxWidth: px })` |

Path lookups keep their current shape, scanning the registry's values where they scanned the array:

```typescript
private findByPath(path: string): FileEditor | null {
    for (const file of this._openFiles.values()) {
        if (file.getPath() === path) {
            return file
        }
    }

    return null
}
```

`addFileTab` mints the id, registers the panel, and drops the layout flush:

```typescript
private addFileTab(path: string, text: string, temporary: boolean = false): FileEditor {
    this._panelIdSeq += 1

    const panelId = `buf-${this._panelIdSeq}`
    const file = FileEditor({ panelId, path, name: baseName(path), text, projectRoot: this._projectRoot })

    file.setTemporary(temporary)
    file.onDirtyChange(() => this.handleDirtyChange(file))
    file.getEditor().on('cursorchange', () => this.handleCursorChange(file))
    this.dock.addPanel({ id: panelId, title: file.getName(), glyph: glyphNameForPath(path), content: file })
    this.dock.setPanelItalic(panelId, temporary)
    this._openFiles.set(panelId, file)

    return file
}
```

`this.tabs.flushLayout()` is deleted: it existed only because `Tab.setTabItalic` needed the tab cell to exist already, which `setPanelItalic`'s durable write does not (see `## Upstream Prerequisites`). `newFile()` mints its id the same way, passing `path: null` and the `Untitled-N` name.

`addPanel` docks into the region the user last worked in, so opening a file from the tree, the palette, or a search result lands it in the group they were last in — the behaviour this feature needs, with no Loom bookkeeping.

### `EditorController` — capture and restore

```typescript
captureEditorLayout(): LayoutState | null {
    if (this.dock.isEmpty()) {
        return null
    }

    const byPath = new Map<string, string>()

    for (const [panelId, file] of this._openFiles) {
        const path = file.getPath()

        if (path !== null) {
            byPath.set(panelId, path)
        }
    }

    return remapPanelIds(this.dock.getLayoutState(), byPath)
}

async restoreFiles(paths: string[], activePath: string | null, editorLayout: LayoutState | null): Promise<void> {
    const panelIds = new Map<string, string>()
    let firstOpened: FileEditor | null = null

    for (const path of paths) {
        if (this.findByPath(path) !== null) {
            continue
        }

        let text: string

        try {
            text = await readFileText(path)
        } catch {
            // A restored path that no longer reads (moved, deleted, permissions)
            // is expected, not an error — it is simply skipped, and its panel
            // drops out of the remapped layout below along with it.
            continue
        }

        const file = this.addFileTab(path, text)

        panelIds.set(path, file.getPanelId())
        firstOpened ??= file
    }

    const arrangement = editorLayout === null ? null : remapPanelIds(editorLayout, panelIds)

    if (arrangement !== null) {
        this.dock.setLayoutState(arrangement)
    }

    const activeFile = activePath !== null ? this.findByPath(activePath) : null
    const toActivate = activeFile ?? firstOpened

    if (toActivate) {
        this.dock.focusPanel(toActivate.getPanelId())
    }

    this.syncActive()
}
```

The order is load-bearing: every panel must be registered before `setLayoutState` runs, because the dock sources each leaf from its registry and silently skips an id it does not know; and the remembered active file is focused *after* the restore, because `setLayoutState` activates one panel per group itself.

### `EditorShell` — the editor pane

The `deck` local and `buildEditorDeck` are gone. [`src/shell/EditorShell.ts:174`](src/shell/EditorShell.ts#L174) and [`248-249`](src/shell/EditorShell.ts#L248) become:

```typescript
const welcome = WelcomeScreen({ /* unchanged */ })

welcome.setName(WELCOME_TAB_LABEL)
controller.dock.setEmptyContent(welcome)

// …

splitBody.addComponent(explorer, { weight: 0 })
splitBody.addComponent(controller.dock, { weight: 1 })
```

`WELCOME_TAB_LABEL = 'Welcome'` replaces `EDITOR_PAGE_ID`/`WELCOME_PAGE_ID`.

### `src/shell/session.ts` — capture, restore, autosave

`captureSession` derives `openFiles` from the captured layout, so tab order comes from the arrangement rather than from a strip index:

```typescript
export function captureSession(targets: SessionTargets): SessionState {
    const paneSizes = targets.split.getPaneSizes()
    const editorLayout = targets.controller.captureEditorLayout()

    return {
        version: 1,
        projectRoot: targets.tree.getProjectRoot(),
        expandedDirs: targets.tree.getExpandedPaths(),
        openFiles: editorLayout === null ? [] : panelOrder(editorLayout),
        activeFile: targets.controller.getActiveFilePath(),
        paneSizes,
        collapsedPanes: paneSizes.map((_, index) => index).filter(index => targets.split.isPaneCollapsed(index)),
        editorLayout,
        recentProjects: targets.controller.getRecentProjects(),
        recentFiles: targets.controller.getRecentFiles(),
    }
}
```

`applySession` passes the layout through:

```typescript
await targets.controller.restoreFiles(state.openFiles, state.activeFile, state.editorLayout)
```

`installSessionAutosave`'s two tab subscriptions ([`src/shell/session.ts:140-141`](src/shell/session.ts#L140)) become five dock subscriptions:

```typescript
targets.controller.dock.on('attach', schedule)
targets.controller.dock.on('detach', schedule)
targets.controller.dock.on('move', schedule)
targets.controller.dock.on('focus', schedule)
targets.controller.dock.on('close', schedule)
```

`schedule` takes no arguments and ignores each payload, as it already does for the tree and split events beside it.

---

## Ordered Implementation Steps

1. **Gate on the upstream work.** Confirm `@jimka/typescript-ui` exports every item in `## Upstream Prerequisites` — `grep -n 'setPanelTitle\|setPanelGlyph\|setPanelItalic\|setPanelModified\|setTabOptions\|tabOptions\|beforeclose\|dblclick' node_modules/@jimka/typescript-ui/dist/lib/types/overlay/Dock.d.ts` should find all seven. If any is missing, **stop and report it** rather than building a Loom-side substitute; every one of them replaces a documented behaviour, and working around them means duplicating `Dock`'s private region sweep inside Loom.[^rejected-workaround] Bump `@jimka/typescript-ui` in `package.json` to the first version that carries them. Run `npm run typecheck` — it must be clean *before* any of this plan's edits, since a dangling dependency link reports a few hundred unrelated module errors and would mask this plan's own.

2. **`tests/editorLayout.test.ts`** (new) — write the `readLayoutState`, `remapPanelIds`, and `panelOrder` cases from `## Expected Behaviour`, importing from `../src/data/editorLayout`. Run `npm test` — red, the module does not exist.

3. **`src/data/editorLayout.ts`** (new) — add `readLayoutState`, `remapPanelIds`, `panelOrder` and their private helpers (`remapNode`, `remapSplit`, `normalizeRatios`, and the node/window validators) per `## Public API` and `## Internal Structure`. Import `LayoutState`/`LayoutNode`/`SplitNode`/`TabNode`/`WindowNode` as types only from `@jimka/typescript-ui/layout`, so the module stays loadable in vitest's `node` environment — the same type-only rule [`src/data/session.ts:4`](src/data/session.ts#L4) already follows for `LayoutSize`. Run `npm test` — green.

4. **`tests/session.test.ts` and `tests/workspaceState.test.ts`** — add `editorLayout: null` to every `toEqual` literal that spells out a full record, and add the parse cases from `## Expected Behaviour`. Run `npm test` — red.

5. **`src/data/session.ts`** — add `editorLayout: LayoutState | null` to `SessionState` with its doc comment, `editorLayout: null` to `emptySession()`, and `editorLayout: readLayoutState(doc.editorLayout) ?? empty.editorLayout` to `parseSession`. Import `readLayoutState` from `./editorLayout` and `LayoutState` as a type from `@jimka/typescript-ui/layout`. Run `npm test` — `tests/session.test.ts` green.

6. **`src/data/workspaceState.ts`** — the same three additions to `WorkspaceState`, `emptyWorkspaceState()`, and `parseWorkspaceState`, plus `editorLayout: session.editorLayout` in `workspaceStateFromSession` and `editorLayout: workspace.editorLayout` in `applyWorkspaceOverlay`, each beside the existing `paneSizes` line. Run `npm test` — the whole suite green.

7. **`src/editor/FileEditor.ts`** — add `panelId: string` to `FileEditorParams` (first field, documented), store it as `private readonly _panelId: string`, and add `getPanelId(): string`. Rewrite the class doc comment's second sentence, which currently names the `Tab` operations `EditorController` addresses through this wrapper (`setTabName`, `setTabItalic`, `setTabModified`, `closeTab`, `getActiveContent`), to name the dock's panel-id-keyed equivalents instead. Run `npm run typecheck` — expect failures only at `EditorController`'s two `FileEditor({…})` call sites, fixed in the next step. Do not add a default.

8. **`src/EditorController.ts`** — the main rewrite, per `## Internal Structure`:
   - Swap the `TabPanel` import for `Dock` from `@jimka/typescript-ui/overlay` (joining the existing `Dialog` import) and add `import type { DockPanelEvent } from '@jimka/typescript-ui/overlay'`; add `import type { LayoutState } from '@jimka/typescript-ui/layout'` beside the existing `TabCloseController` type import; add `import { remapPanelIds } from './data/editorLayout'`.
   - Replace `readonly tabs: TabPanel` with `readonly dock: Dock`, and `_openFiles: FileEditor[]` with `_openFiles: Map<string, FileEditor>`; add `_activePanelId` and `_panelIdSeq`.
   - Construct the `Dock` with `tabOptions` and subscribe the four handlers.
   - Replace `handleBeforeTabClose`/`handleTabClose`/`handleActivate`/`handleTabDoubleClick` with `handleBeforePanelClose`/`handlePanelClose`/`handlePanelFocus`/`handlePanelDoubleClick`.
   - Rewrite `getActiveFile`, add `findByPath`, and route every `_openFiles.find(c => c.getPath() === path)` (in `openFile`, `openFileAt`, `markExternalChanges`, `saveAs`'s duplicate-target guard) through it. `_openFiles.some(...)`/`.filter(...)`/`.forEach`-style reads become `for (… of this._openFiles.values())` loops or `[...this._openFiles.values()]` — `closeFilesUnder`, `relocateOpenFiles`, `pushProjectRoot`, `closeTemporaryTab`, `confirmExit`, and the two `_openFiles.length === 0` empty checks (now `this._openFiles.size === 0`).
   - Apply the call-site table: every `this.tabs.getTab().X(file, …)` becomes the panel-id-keyed dock call.
   - Rewrite `addFileTab` and `newFile` to mint a panel id and call `dock.addPanel`; delete the `flushLayout` call and its comment.
   - Add `captureEditorLayout`, widen `restoreFiles` to three parameters, delete `getOpenFilePaths` and `setEmptyStateListener` (and `_emptyStateListener`), and drop `syncActive`'s `_emptyStateListener` call.
   - `applySettings`' `setMaxWidth` becomes `this.dock.setTabOptions({ maxWidth: settings.tabMaxWidthPx })`.
   - Update the class doc comment: it owns the dock, not a tab strip. Update `WIDEST_CURSOR_POSITION`'s own comment too, which names "the inactive ones `TabPanel` keeps `visibility: hidden`" — the same trap still applies, now per dock group.
   - Run `npm run typecheck` — expect failures only in `EditorShell.ts` and `shell/session.ts`, fixed next.

9. **`src/shell/EditorShell.ts`** — delete `buildEditorDeck`, `EDITOR_PAGE_ID`, `WELCOME_PAGE_ID`, and the `Card` import if nothing else in the file uses it (the explorer's content `Card` does, so check before removing). Add `WELCOME_TAB_LABEL`. Call `welcome.setName(WELCOME_TAB_LABEL)` and `controller.dock.setEmptyContent(welcome)` after the `WelcomeScreen({…})` construction, and add `controller.dock` to `splitBody` in place of `deck`. Update the class doc comment (it still says "the tab strip and the welcome screen, one visible at a time") and `EXPLORER_PANE_INDEX`'s own comment (which names "the editor deck"). Run `npm run typecheck` — one remaining failure, in `shell/session.ts`.

10. **`src/shell/session.ts`** — rewrite `captureSession`, widen the `applySession` call, and swap the two tab subscriptions for the five dock ones, per `## Internal Structure`. Import `panelOrder` from `../data/editorLayout`. Run `npm run typecheck` — clean. Check: `grep -rn '\.tabs\b\|getTab()\|getOpenFilePaths\|setEmptyStateListener\|buildEditorDeck\|EDITOR_PAGE_ID\|WELCOME_PAGE_ID' src/` — zero matches.

11. **`README.md` and `TODO.md`** — per `## Documentation Impact`.

12. **Run the whole `## Verification` list.**

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Create | `src/data/editorLayout.ts` |
| Create | `tests/editorLayout.test.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `src/editor/FileEditor.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `src/shell/session.ts` |
| Modify | `src/data/session.ts` |
| Modify | `src/data/workspaceState.ts` |
| Modify | `tests/session.test.ts` |
| Modify | `tests/workspaceState.test.ts` |
| Modify | `package.json` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Unit-testable — `tests/editorLayout.test.ts`

Fixtures: `PANEL = (id: string): PanelNode => ({ kind: 'panel', panelId: id })`, `TABS = (children, activeIndex) => ({ kind: 'tab', children, activeIndex })`, `SPLIT = (children, ratios) => ({ kind: 'split', orientation: 'horizontal', children, ratios, collapsed: children.map(() => false) })`, `STATE = (root, windows = []) => ({ version: 1, root, windows })`, `R = { x: 10, y: 10, width: 400, height: 300 }`, and `FLOAT = (content) => ({ kind: 'window', content, header: 'b.ts', rect: R, state: 'normal', restoreRect: null })`.

`readLayoutState`:

| Input | Expected |
| --- | --- |
| `undefined` | `undefined` |
| `{ version: 2, root: PANEL('a'), windows: [] }` | `undefined` — wrong version |
| `{ version: 1, root: PANEL('a') }` | `undefined` — `windows` missing |
| `{ version: 1, root: { kind: 'panel' }, windows: [] }` | `undefined` — `panelId` missing |
| `{ version: 1, root: { kind: 'blob' }, windows: [] }` | `undefined` — unknown node kind |
| `STATE(TABS([PANEL('a')], 0))` | the same object's contents, accepted |
| `STATE(SPLIT([TABS([PANEL('a')], 0), PANEL('b')], [0.5, 0.5]))` | accepted |

`remapPanelIds`, with `M = new Map([['buf-1', '/p/a.ts'], ['buf-2', '/p/b.ts']])` and `TREE = SPLIT([TABS([PANEL('buf-1'), PANEL('buf-3')], 1), TABS([PANEL('buf-2')], 0)], [0.6, 0.4])`:

| Input | Expected |
| --- | --- |
| `remapPanelIds(STATE(TREE), M)` | a `split` with two `tab` children and ratios `[0.6, 0.4]`; the first holds one panel `/p/a.ts` with `activeIndex: 0`; the second holds `/p/b.ts` |
| `remapPanelIds(STATE(TREE), new Map([['buf-2', '/p/b.ts']]))` | root is the surviving `tab` holding `/p/b.ts` — the emptied pane dropped and the one-pane split collapsed |
| `remapPanelIds(STATE(TREE), new Map())` | `null` |
| `remapPanelIds(STATE(TABS([PANEL('buf-1'), PANEL('buf-2')], 1)), M)` | `activeIndex` stays `1` — the active child survived |
| `remapPanelIds(STATE(SPLIT([PANEL('buf-1'), PANEL('buf-2'), PANEL('buf-3')], [0.5, 0.25, 0.25])), M)` | two panes, ratios renormalized to `[0.666…, 0.333…]` (each survivor over their `0.75` sum) |
| `remapPanelIds(STATE(PANEL('buf-1'), [FLOAT(TABS([PANEL('buf-2')], 0))]), M)` | one window kept, its content's panel now `/p/b.ts` |
| the same with `M` lacking `buf-2` | `windows` is `[]` — the float's content dropped, so the float did |
| `remapPanelIds(STATE(PANEL('buf-1')), M)` | a bare `panel` root, `/p/a.ts` |

`panelOrder`:

| Input | Expected |
| --- | --- |
| `panelOrder(STATE(TREE))` | `['buf-1', 'buf-3', 'buf-2']` |
| `panelOrder(STATE(PANEL('buf-1'), [FLOAT(TABS([PANEL('buf-2')], 0))]))` | `['buf-1', 'buf-2']` — tiled tree first, then floats |
| `panelOrder(STATE(TABS([], 0)))` | `[]` |

### Unit-testable — `tests/session.test.ts` / `tests/workspaceState.test.ts`

| Input | Expected |
| --- | --- |
| `emptySession()` / `emptyWorkspaceState()` | `editorLayout: null` alongside every existing empty default |
| `parseSession('{"version":1}')` | `editorLayout: null` |
| `parseSession('{"version":1,"editorLayout":{"version":1,"root":{"kind":"panel","panelId":"/p/a.ts"},"windows":[]}}')` | that `LayoutState`, accepted |
| `parseSession('{"version":1,"editorLayout":{"version":2,…}}')` | `editorLayout: null` — the whole field discarded, every other field still read |
| `parseSession('{"version":1,"editorLayout":"nope","openFiles":["/p/a.ts"]}')` | `editorLayout: null`, `openFiles: ['/p/a.ts']` |
| `workspaceStateFromSession(session)` | `editorLayout` copied verbatim, not filtered to the root |
| `applyWorkspaceOverlay(session, workspace)` | `editorLayout` taken from `workspace`, verbatim |
| `applyWorkspaceOverlay(session, null)` | `session` returned unchanged, `editorLayout` included |

### Manual verification — the live app (`npm run tauri:dev`)

Everything below needs real drag gestures, focus, and geometry, none of which the vitest harness provides.

| Action | Expected |
| --- | --- |
| Launch with several files open and no saved layout | One editor group, exactly as today; the restored active file is focused |
| Drag a tab onto the right edge of the editor area | The area splits into two groups side by side; the dragged file lands in the new right group and is focused there |
| Click into the left group's editor | The window title, the status bar's caret readout, and the language label all follow the left group's file; the right group keeps showing its own active tab |
| Type in the left group | Its tab shows the unsaved-changes dot; the right group's tabs are untouched |
| Drag that dirty tab into the right group's strip | The dot moves with it and is still showing after the drop |
| Single-click a file in the tree, then drag its italic temp tab into the other group | The label is still italic after the drop |
| *Save As* a file to a different extension while it sits in the second group | That group's tab label and icon both update in place; the tab does not close and reopen |
| Double-click an italic tab in either group | It becomes upright (pinned) |
| Close a dirty tab's ✕ in either group | The unsaved-changes prompt appears; *Cancel* leaves the tab open and still dirty |
| Close the last tab of one group | That group disappears and the survivor takes the full width |
| Close every tab in every group | The **Welcome** placeholder tab appears with the welcome screen under it |
| Open a file from the tree after working in the right group | It opens in the right group, not the left |
| Ctrl/Cmd+F | The find bar opens over the focused group's editor only |
| Click a project-search match while the right group is focused | The file opens (or is revealed) in the right group, with the match selected and centred |
| Drag a tab off a strip into open space | It tears off into a floating window; dropping a second tab on that float's edge splits the float itself |
| Restart the app | Group count, the split's ratio, each group's tab order, each group's own active tab, the focused file, and every float's position, size, and internal arrangement all come back |
| Delete one remembered file outside the app, then restart | Its tab is absent; if it was its group's only file, that group is gone and the survivor fills the width |
| Restart after closing every tab | The **Welcome** placeholder shows, no empty groups left behind |
| Edit a file outside the app while it sits in the non-focused group | No prompt yet; the prompt appears when that file's tab is focused — unchanged from today's tab-activation behaviour |
| Exit with a dirty file in the non-focused group | The exit prompt still counts it |
| Ctrl/Cmd+B | Collapses and restores the explorer pane; the editor dock keeps its internal split and group sizes |
| Change `tabMaxWidthPx` in settings and reopen the project | Both groups' tab strips honour the new cap |

---

## Verification

- `npm run typecheck` — clean (expected to fail only between steps 7 and 10, per the ordered steps).
- `npm test` — `tests/editorLayout.test.ts` passes alongside the extended `tests/session.test.ts` and `tests/workspaceState.test.ts`, and the rest of the suite is untouched.
- `npm run build` — clean.
- `grep -rn '\.tabs\b\|getTab()\|TabPanel\|getOpenFilePaths\|setEmptyStateListener\|buildEditorDeck\|EDITOR_PAGE_ID\|WELCOME_PAGE_ID' src/` — zero matches.
- `grep -rn 'setTabName\|setTabGlyph\|setTabItalic\|setTabModified\|setActiveContent\|closeTab\|setMaxWidth' src/` — zero matches; every one is now a `dock.setPanel*` / `focusPanel` / `removePanel` / `setTabOptions` call.
- `npm run tauri:dev`, then walk the manual table. Open Loom's own repository as the project — several files, a deep tree, and a Markdown file to exercise the preview toggle inside a second group.
- Inspect the written `session.json` and `<project>/.loom/workspace.json` after splitting and restarting: `editorLayout.root` must be a `split` whose panel ids are absolute file paths, and `openFiles` must list those same paths in the same document order.

---

## Documentation Impact

`README.md`'s **Tabbed editing** highlight gains a split-pane clause and a new bullet follows it:

> - **Split editor groups** — drag a tab onto the edge of the editor area to split it, and the dragged file opens in the new group beside the first; drag a tab between groups to move it, or off a strip entirely to tear it off into a floating window. The window title, the status bar, and *Find…* all follow whichever group has focus. Group layout, each group's tab order and active tab, and every floating window's position come back on the next launch.

`README.md`'s **Session restore** bullet gains `, the editor's split layout,` to its list of restored state. The **Architecture** paragraph's component list gains `Dock` beside `Tab`/`TabBar`.

`TODO.md`: the **Split-pane multi-file editing** entry is removed from `## High` (this plan implements it). Two new entries record what phase one left out, placed in `## Medium`:

> - **A *Split Editor* command.** Splitting the editor area is a drag gesture only — `Dock` exposes no programmatic split, so there is no menu item, palette command, or shortcut for it.

> - **Re-saving the dock layout on a gutter drag.** `Dock` emits nothing when a split ratio changes, so a gutter drag inside the editor area is only persisted at the next dock event or on exit.

The `## Low` **Multi-window / "open in new window"** entry is kept and reworded: tear-off now exists as an in-page float, and what remains is making it a real Tauri OS window. The **Known issues** entry about inactive tabs staying in the layout tree gains a clause noting that split groups keep more editors simultaneously visible, so the cost it describes now applies to every group's active editor too.

---

## Potential Challenges

- **`Dock` emits nothing when a split ratio changes**, so dragging a gutter inside the editor area schedules no session save. Mitigated by the exit flush already wired through `setBeforeExitListener` ([`src/EditorController.ts:1135`](src/EditorController.ts#L1135)), which captures the current ratios on the way out, and by the next dock event saving them anyway. Recorded in `TODO.md` rather than worked around.
- **`setLayoutState` closes every open `Window`.** `restoreLayout` tears down the float plane before rebuilding it, so calling `setLayoutState` while an unrelated floating window is open would close it. Loom opens none — `Dialog` is not a `Window` subclass — and `restoreFiles` is the only caller, running at launch before any dialog can open. Do not call `setLayoutState` from anywhere else.
- **A float restored at its saved rect can land outside a smaller window.** The rect is absolute pixels captured from the previous run. Check it manually: save a layout with a float near the right edge, shrink the OS window, restart, and confirm the float is reachable.
- **More groups mean more simultaneously visible editors.** `TODO.md`'s standing note about inactive tabs keeping live `CodeEditor`s in the layout tree now compounds: each group's active editor is genuinely visible, so any future per-keystroke handler that forces a layout read pays for all of them. Nothing in this plan adds such a handler — the status bar's caret readout is already fixed-width with auto-measure off ([`src/EditorController.ts:109-118`](src/EditorController.ts#L109)).
- **`addPanel` activates the panel it adds**, so a restore of N files fires N focus changes before `setLayoutState` rearranges them. Each one is a `syncActive` call — a window-title write and two status-bar text writes — not a layout flush, so the cost is bounded; but do not add work to `handlePanelFocus` that assumes it fires once per user action.
- **A panel id is minted per launch, so a hand-edited `editorLayout` naming `buf-3` restores nothing.** Saved layouts are path-keyed by construction (`captureEditorLayout` remaps before writing); anything else is dropped by `remapPanelIds`, which is the intended degradation, not a bug to repair.

---

## Critical Files

| File | Why |
| --- | --- |
| [`src/EditorController.ts`](src/EditorController.ts) | The class being rewritten — read the whole thing, particularly the four `Tab` subscriptions, `addFileTab`, `restoreFiles`, `getActiveFile`, and every `_openFiles` read. |
| [`src/shell/session.ts`](src/shell/session.ts) | `captureSession`/`applySession`/`installSessionAutosave` — the three functions the new `editorLayout` field flows through. |
| [`src/data/session.ts`](src/data/session.ts) and [`src/data/workspaceState.ts`](src/data/workspaceState.ts) | The field-by-field discard-on-defect parser convention the new `readLayoutState` follows, and the two records gaining `editorLayout`. |
| [`src/shell/EditorShell.ts`](src/shell/EditorShell.ts) | The editor pane's current `Card` deck and the two-pane `Split` the dock mounts into. |
| `@jimka/typescript-ui`'s [`Dock.md`](../typescript-ui/packages/lib/docs/components/Dock.md) | The panel registry, the five lifecycle events and their host-transition pairing, `emptyContent`, and `getLayoutState`/`setLayoutState` — every mechanism this plan builds on. |
| `@jimka/typescript-ui`'s [`Dock.ts`](../typescript-ui/packages/lib/src/typescript/lib/overlay/Dock.ts) | `addPanel`'s last-active-region docking, `resolvePanel`'s construction-time-only frame id, `newTabRegion`'s hardcoded `Tab` options, and `removePanel`'s route through `Tab.closeTab` — the four facts the architecture decisions and the upstream prerequisites rest on. |
| `@jimka/typescript-ui`'s [`LayoutSerialization.ts`](../typescript-ui/packages/lib/src/typescript/lib/layout/LayoutSerialization.ts) | `LayoutState`/`LayoutNode`/`WindowNode`'s exact shape, which `readLayoutState` validates and `remapPanelIds` rewrites, and `restoreLayout`'s park-and-rebuild model. |
| `@jimka/typescript-ui`'s [`Tab.ts`](../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts) | `createTab`'s label-resolution order, `setTabItalic`/`setTabModified`'s view-only remarks, and `_onBarTabClose` versus `closeTab` — the evidence behind all three requirements in `## Upstream Prerequisites`. |
| [`plans/implemented/sidebar-rail-and-search-tree.md`](plans/implemented/sidebar-rail-and-search-tree.md) | The precedent for a layout-level change in this repo: how pane count is kept stable so `paneSizes` stays valid, and how a library component is adopted rather than hand-rolled. |
| [`plans/implemented/workspace-session-persistence.md`](plans/implemented/workspace-session-persistence.md) | The precedent for adding a field to both `SessionState` and `WorkspaceState` at once, and for the app-wide-then-per-project overlay order. |

---

## Non-Goals

- **A *Split Editor Right* / *Split Editor Down* command, menu item, or shortcut.** `Dock` exposes no programmatic split; splitting is a drag gesture. Recorded in `TODO.md`.
- **Making a torn-off float a real Tauri OS window.** Already its own `TODO.md` entry; floats stay in-page here.
- **The same file open in two groups at once.** `Dock` holds exactly one content component per panel id, so one buffer lives in exactly one group. VS Code allows the duplicate; matching it would mean two panel ids per file and two `CodeEditor`s over one buffer.
- **A per-group status bar, or per-group breadcrumbs.** Breadcrumbs are already per-`FileEditor` and so already per-group; the status bar stays one, following the focused group.
- **Naming, numbering, or reordering groups, and keyboard shortcuts for moving focus between them.** Nothing in the backlog asks for it, and `Dock` exposes no group identity to hang a name on.
- **Persisting unsaved buffer contents.** Out of scope before this plan and still out.
- **Any change to the shell's own `Split`.** It keeps exactly two panes, so `paneSizes`/`collapsedPanes` keep their shape and no stored session is invalidated.
- **Suppressing tear-off or edge-drop.** `Dock` wires both itself on every region; opting out would need another upstream request for no benefit.
- **Reproducing `Dock`'s region sweep inside Loom** to reach the `Tab` regions it owns privately. See `## Upstream Prerequisites` and its footnote.

---

## Notes

[^durable-flags]: `Tab.setTabItalic` and `Tab.setTabModified` each carry the same `@remarks`: "The flag is view-only: it is not written to the tab's `LayoutConstraints`, so it does not survive a tear-off, a re-dock, or a saved layout." `Tab.setTabGlyph` is the counter-example — `applyTabGlyph` writes `constraints.glyph` and its own comment calls that "the glyph's durable home, re-read by `createTab` on a re-dock and captured by layout serialization". `PanelNode.glyph` exists in `LayoutState` for exactly that reason. So the upstream fix for italic and modified is the shape `glyph` already has: a constraint field, re-read by `createTab`, captured by `serializeLayout`, and restored by `restoreLayout`. Without it, every cross-group drag of a dirty or preview tab silently drops its marker, and a restored layout comes back with every dot and every italic gone.

[^flush-dance]: [`src/EditorController.ts:532`](src/EditorController.ts#L532) calls `this.tabs.flushLayout()` between `addTab` and `setTabItalic`, with a comment explaining why: `addTab` only enqueues the child, and `Tab` promotes it to an addressable entry on its next layout pass, so `setTabItalic` would silently miss it. A durable write has no such window — it records the value and `createTab` reads it — which is why requirement (2) comes free with requirement (1) and lets this plan delete the flush rather than re-create it against the dock.

[^veto-split]: `Tab._onBarTabClose` emits `beforetabclose` with a `TabCloseController` and returns early when a listener calls `preventDefault()`; the public `Tab.closeTab` goes straight to `closeEntry`, emitting nothing vetoable. `Dock.removePanel` already routes through `closeTab`, so it already sits on the unguarded side of that split — the prerequisite is only that a new `beforeclose` be wired to the ✕ path (and to a float's chrome ✕, which a dirty file reached by tearing off would otherwise close unprompted) and not to `removePanel`. Loom's [`confirmThenClose`](src/EditorController.ts#L1060) depends on the split: it vetoes the ✕, prompts, and then closes through the unguarded path. Were `removePanel` to re-emit `beforeclose`, that close would veto itself forever.

[^minted-ids]: `Dock.resolvePanel` builds each panel's identity frame as `new Container({ id: spec.id, name: spec.title, … })` and its own comment is explicit that the id must be set at construction, because the frame's `#id`-scoped CSS rule carries `position: absolute` and a later `setId` would leave that rule bound to the old id, collapsing the frame to `position: static`. So a panel id is immutable for the frame's life. Loom's buffers are not: [`repointFile`](src/EditorController.ts#L896) changes an open buffer's path on a first save, a Save As, and a tree rename, and an untitled buffer starts with no path at all. Keying panels on the path would therefore need a close-and-reopen on every rename — losing the buffer's undo history, its cursor position, and its place in the group. A minted id plus a path translation at the persistence boundary costs one pure function and keeps the buffer untouched.

[^layout-degrades]: This mirrors how `paneSizes` already degrades: `readLayoutSizeArray` ([`src/data/session.ts:207`](src/data/session.ts#L207)) discards the whole array if any entry is malformed, and `Split` then falls back to its weights. `editorLayout` discards the whole field the same way and the dock then falls back to its single default group. The alternative — repairing a partially-valid layout tree node by node — would have to invent ratios and active indices for the parts it could not read, and there is no precedent for entry-by-entry repair anywhere in either parser.

[^workspace-verbatim]: `workspaceStateFromSession` filters `openFiles`/`activeFile` to the project root through `filterToRoot`, because a `.loom/workspace.json` must never point outside its own project. `editorLayout` needs no filter of its own: `installSessionAutosave` already gates the entire workspace write on `openFilesBelongToRoot` ([`src/shell/session.ts:169`](src/shell/session.ts#L169)), so the file is only written when every open file is under the root — and every panel id in a captured layout is one of those files' paths. Copying it verbatim, as `paneSizes` and `collapsedPanes` already are, is therefore correct and keeps the one root-scoping rule in one place.

[^two-panes]: `plans/implemented/project-wide-search.md`'s own `panel-placement` footnote records why a third `Split` pane was rejected for the Search panel: `paneSizes` is restored wholesale, so a stored two-entry array would be silently discarded against a three-pane split and reset every user's explorer width on upgrade. The same constraint applies here, and this plan satisfies it by putting all the new structure *inside* the second pane, where the dock owns its own splits and serializes them separately. `SessionState.paneSizes` stays two entries.

[^empty-content]: The alternative was keeping today's `Card` deck and swapping `controller.tabs` for `controller.dock` as its first page — a smaller diff that preserves the current look exactly, with no **Welcome** tab cell. It was rejected because it keeps a Loom-specific mechanism (a two-page deck plus `setEmptyStateListener`, 20-odd lines across two files) in place of a library capability built for precisely this, which is the opposite of what this project exists to do. It would also leave the dock unmounted while empty, so an empty Loom could not be a drop target for a tab dragged back from a float.

[^foreign-windows]: `serializeLayout` captures every open `Window`, not only the dock's own floats, so a `LayoutState` could in principle carry a window Loom never docked anything into. `remapPanelIds` handles it by construction: such a window's content tree contains no `PanelNode` the mapping knows, so `remapNode` returns `null` for it and the window node drops. Loom opens no `Window` of its own today — `Dialog` extends `Component`, not `Window` — so the case is defensive rather than live.

[^rejected-workaround]: A Loom-side workaround does exist, and it is rejected. `Dock.getRootRegion()`, `Component.getComponents()`, `Component.getLayoutManager()`, and `Window.getOpenWindows()` are all public, so Loom could walk the dock's tree, find the `Tab` manager holding a given frame, and call `setTabName`/`setTabGlyph`/`setTabItalic`/`setTabModified`/`setMaxWidth` and subscribe `beforetabclose`/`tabdblclick` on it directly. Three costs make it the wrong answer. It duplicates `Dock`'s own private `runSweep`/`wireRegion` inside Loom, including the idempotence ledger needed to avoid stacking duplicate listeners on a region the dock re-wires. It still cannot fix the view-only italic and modified flags, so Loom would additionally have to re-assert every flag after every `attach`/`detach`/`move` event and after every layout restore. And `CLAUDE.md` names this exact pattern as the thing not to do: a Loom-specific workaround around a library gap, where the gap is what should be reported. The five methods and two events asked for in `## Upstream Prerequisites` are a smaller surface than the workaround, and they are the surface a consumer actually needs — panel-id-keyed, like `focusPanel` and `removePanel` already are.
