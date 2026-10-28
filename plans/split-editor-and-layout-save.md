---
touches-shared: [src/EditorController.ts, src/shell/commands.ts, src/shell/EditorShell.ts, src/shell/shortcuts.ts, src/main.ts, tests/commands.test.ts, tests/shortcuts.test.ts, README.md, TODO.md]
---

# Split Editor Commands and Layout Save on Split Resize — Implementation Plan

## Overview

Loom adopts three `Dock` changes from `@jimka/typescript-ui`'s unreleased `master`. All three are listed in the library's `docs/reference/changelog/next.md`.

1. **`Dock.splitPanel(targetId, panel, side, options?)`** backs two new commands, *Split and Move Editor Right* (Ctrl/Cmd+\\) and *Split and Move Editor Down*. Each moves the active file's tab into a new tab group beside its current group, the same thing as dragging the tab onto that group's edge. The commands appear in the View menu and the command palette, and are greyed out when the active file is the only tab in its group. Code changes go in [`src/EditorController.ts`](src/EditorController.ts), [`src/shell/shortcuts.ts`](src/shell/shortcuts.ts), [`src/shell/commands.ts`](src/shell/commands.ts), [`src/shell/EditorShell.ts`](src/shell/EditorShell.ts), and a new pure helper `canSplitPanel` in [`src/data/editorLayout.ts`](src/data/editorLayout.ts).
2. **`Dock`'s new `splitresize` event** schedules a session save, beside the dock events [`installSessionAutosave`](src/shell/session.ts#L122) already listens to. A gutter drag inside the editor area is then saved as soon as the drag ends, not only at the next dock event or on exit.
3. **The library's layout save/restore fixes** need one small change in Loom. `remapPanelIds` already carries the new `windowMode: "strip"` window nodes through unchanged. `readLayoutState` gains a check on `windowMode`, a stale comment is corrected, and tests pin the new node shapes.

Two `TODO.md` *Medium* items close: *A Split Editor command* and *Re-saving the dock layout on a gutter drag*.

---

## Architecture Decisions

### The commands move the active file; they never duplicate it

Loom keeps one editor per file. [`openFile`](src/EditorController.ts#L489) focuses the file's existing tab when one is open, and [`findByPath`](src/EditorController.ts#L1169) is the one lookup behind that. So a split command cannot open a second view of the same file the way VS Code's *Split Editor* does. Instead, each command calls `dock.splitPanel(id, id, side)` with the active panel's id as both the target and the panel. That pulls the tab out of its own group into a new group on `side`, which is exactly what dragging the tab onto its own group's edge does.[^move-not-duplicate]

### Two commands: *Split and Move Editor Right* and *Split and Move Editor Down*

| id | Title | Side passed to `splitPanel` | Shortcut |
| --- | --- | --- | --- |
| `split-move-editor-right` | Split and Move Editor Right | `'right'` | Ctrl/Cmd+\\ |
| `split-move-editor-down` | Split and Move Editor Down | `'bottom'` | none |

The titles contain both "Split" and "Move", so the palette finds them under either word, and the name says that the file moves.[^names] Left and up are not added.[^two-commands]

### Ctrl/Cmd+\\ is matched on the physical key, and *Down* has no shortcut

`isSplitEditorRightChord` matches Ctrl or Cmd, no Alt, no Shift, and `event.code === 'Backslash'`. It does not match on `event.key`, because many layouts (Swedish, German) cannot type `\` without AltGr.[^backslash-code] CodeMirror's default keymap binds `Mod-Alt-\` and `Shift-Mod-\` but not `Mod-\`, so the window listener still receives the chord while the caret is in a document. *Split and Move Editor Down* gets no shortcut.[^no-down-shortcut]

### The new pane takes the size a drop gives it

`splitPanel` is called without `ratio`. A new split gives the new pane half of it, and a pane that joins a split already running that way takes an equal share from every pane. That matches the drag gesture the command mirrors.[^ratio-omitted]

### Enablement comes from the layout state, through a pure `canSplitPanel` helper

`splitPanel` returns `false` without changing anything in two cases that apply to Loom: the panel is the only tab in its group, or the panel sits in a tab-strip tear-off window (a `TabWindow`). Both menu items and both palette rows are enabled only when neither case holds. The new pure function `canSplitPanel(state, panelId)` in `editorLayout.ts` reads this from `dock.getLayoutState()`, and `EditorController.canSplitActive()` calls it for the active panel.[^can-split-derived]

`canSplitPanel` finds the `tab` node whose direct children include a `panel` node with that `panelId`. The result is `true` only when that tab node has two or more children and does not sit in a window whose `windowMode` is `'strip'`.

| Where the panel is | Result | Why |
| --- | --- | --- |
| Tiled `tab` node `[a, b]` | `true` | two tabs, one can leave |
| Tiled `tab` node `[a]` | `false` | only tab: `splitPanel` refuses |
| Bare float (no `windowMode`) with `tab` node `[b, c]` | `true` | a header-window mini-dock can be split |
| Strip window (`windowMode: 'strip'`) with `tab` node `[b, c]` | `false` | `splitPanel` refuses a target in a `TabWindow` |
| Legacy float with only `panelId: 'b'` | `false` | not inside a `tab` node |
| Panel id not in the state | `false` | nothing to split |

The keyboard chord does not check enablement first. When `splitPanel` returns `false`, nothing happens, the same way Ctrl/Cmd+S does nothing on a clean file.

### After a split, keyboard focus goes into the moved file's editor

`splitPanel` never focuses the moved panel's content and leaves that to the application. `EditorController.splitActive` calls `file.getEditor().focus()` when `splitPanel` returns `true`, the same way a permanent `openFile` ends.[^focus-editor]

### The commands live in the View menu, under *Toggle Explorer*

The two items form their own separator group, directly after *Toggle Explorer* in the View menu built by [`buildMenuBar`](src/shell/EditorShell.ts#L716). No new *Editor* menu is added.[^view-menu] The glyphs are `square-caret-right` and `square-caret-down`, registered in [`src/main.ts`](src/main.ts#L35).

### `splitresize` joins the existing autosave subscriptions

`installSessionAutosave` adds `targets.controller.dock.on('splitresize', schedule)` next to its `attach`/`detach`/`move`/`focus`/`close` lines ([`src/shell/session.ts:158`](src/shell/session.ts#L158)). This mirrors those lines exactly: the payload is ignored and the debounced `schedule` re-captures the whole session.[^session-precedent] The explorer/editor `Split` needs no change. It already saves through its own `paneresize` and `panecollapse` events.[^explorer-no-gap]

### `readLayoutState` validates `windowMode`; `remapPanelIds` keeps working unchanged

`remapWindow` copies a window node with `{ ...window, content }`, so `windowMode: 'strip'` survives remapping, and `remapTab` handles a strip window's `tab` content like any other tab group. `panelOrder` walks a strip window's `content`, so every tab's file is listed in `openFiles`. The one code change is in `isWindowNode`: a present `windowMode` must be `'bare'` or `'strip'`, or the whole layout is rejected, the same all-or-nothing rule the function already applies to `panelId`.[^windowmode-validate] The `remapWindow` doc comment is corrected, because `Dock.getLayoutState` now records only the dock's own floats.

### Old saved sessions restore without a code path of their own

A session saved under library 0.11.0 recorded a tab-strip float as a plain window holding only its first tab. `openFiles` is derived from that layout, so the float's other files were never saved. Restoring such a session opens a plain window with that one file, and nothing else is lost at restore time.[^old-sessions]

---

## Public API

### `src/data/editorLayout.ts`

```typescript
/**
 * Whether `Dock.splitPanel(panelId, panelId, side)` would move `panelId` into a
 * new group: the panel sits in a `tab` node with at least one other tab, and
 * not in a tab-strip (`windowMode: 'strip'`) window. Side-independent.
 */
export function canSplitPanel(state: LayoutState, panelId: string): boolean
```

### `src/shell/shortcuts.ts`

```typescript
export const SPLIT_EDITOR_RIGHT_SHORTCUT = 'Ctrl/Cmd+\\'

/** Whether a keydown is the Split-and-Move-Editor-Right chord (Ctrl/Cmd + the physical Backslash key). */
export function isSplitEditorRightChord(event: KeyboardEvent): boolean

export interface AcceleratorActions {
    // …existing fields…
    /** Ctrl/Cmd+\ — moves the active file into a new group on the right. */
    onSplitEditorRight: () => void
}
```

### `src/shell/commands.ts`

```typescript
export interface PaletteCommandActions {
    // …existing fields…
    canSplitActive: () => boolean
    onSplitEditorRight: () => void
    onSplitEditorDown: () => void
}
```

### `src/EditorController.ts`

```typescript
import type { Edge } from '@jimka/typescript-ui/primitive'

/** Whether the active file can be moved into a new group — read by the View menu and the palette. */
canSplitActive(): boolean

/**
 * Moves the active file's tab into a new group on `side` of its current group,
 * then focuses its editor. A no-op with no active file, or when the dock refuses
 * the split (the file is its group's only tab, or sits in a tab-strip window).
 */
splitActive(side: Edge): void
```

`MenuBarActions` in `EditorShell.ts` stays unexported. It gains `canSplitActive` and `onSplitEditorDown`, and inherits `onSplitEditorRight` from `AcceleratorActions`.

---

## Implementation

### `canSplitPanel`

```typescript
export function canSplitPanel(state: LayoutState, panelId: string): boolean {
    const tiled = tabSizeHolding(state.root, panelId)

    if (tiled !== null) {
        return tiled >= 2
    }

    for (const window of state.windows) {
        if (window.content === undefined) {
            continue
        }

        const size = tabSizeHolding(window.content, panelId)

        if (size !== null) {
            return window.windowMode !== 'strip' && size >= 2
        }
    }

    return false
}

/** The child count of the `tab` node directly holding `panelId` under `node`, or `null` when no tab node holds it. */
function tabSizeHolding(node: LayoutNode, panelId: string): number | null {
    if (node.kind === 'panel') {
        return null
    }

    if (node.kind === 'tab' && node.children.some(child => child.kind === 'panel' && child.panelId === panelId)) {
        return node.children.length
    }

    for (const child of node.children) {
        const size = tabSizeHolding(child, panelId)

        if (size !== null) {
            return size
        }
    }

    return null
}
```

A legacy window with only `panelId` has no `content`, so the loop skips it and the result is `false`.

### `EditorController`

```typescript
canSplitActive(): boolean {
    const file = this.getActiveFile()

    return file !== null && canSplitPanel(this.dock.getLayoutState(), file.getPanelId())
}

splitActive(side: Edge): void {
    const file = this.getActiveFile()

    if (file === null) {
        return
    }

    const id = file.getPanelId()

    if (this.dock.splitPanel(id, id, side)) {
        file.getEditor().focus()
    }
}
```

`canSplitActive` reads the dock's state directly, not `captureEditorLayout()`, because it needs the live panel ids, not file paths.

### `isWindowNode` addition

```typescript
if (node.windowMode !== undefined && node.windowMode !== 'bare' && node.windowMode !== 'strip') {
    return false
}
```

---

## Ordered Implementation Steps

1. **Set up against the library checkout.** From the worktree root, run `npm ci`, then `rm -rf node_modules/@jimka/typescript-ui && ln -s /home/jika/typescript/typescript-ui/packages/lib node_modules/@jimka/typescript-ui`. Do not change `package.json`. Its `^0.11.0` range stays until the library releases. Check: `grep -c splitPanel node_modules/@jimka/typescript-ui/dist/lib/types/overlay/Dock.d.ts` prints a non-zero count (if it prints `0`, stop and ask the user to rebuild the library). Then `npm run typecheck` passes and `npm test` reports 549 passing tests.
2. **`tests/editorLayout.test.ts` — write the new cases first** (see `## Expected Behaviour`: `readLayoutState` windowMode rows, the new `remapPanelIds` and `panelOrder` rows, and every `canSplitPanel` row). Add a `STRIP` fixture beside `FLOAT`. Import `canSplitPanel`. Run `npm test -- editorLayout` and expect the new cases to fail.
3. **`src/data/editorLayout.ts`.** Add `canSplitPanel` and the private `tabSizeHolding` as shown in `## Implementation`. Add the `windowMode` check to `isWindowNode`, and extend its doc comment to say that a present `windowMode` must be `'bare'` or `'strip'`. Replace `remapWindow`'s doc-comment sentence starting "`serializeLayout` captures every open `Window`…" with: "A state saved before typescript-ui recorded only the dock's own floats can carry a window whose content tree holds no panel id the mapping knows — such a window drops here too." Check: `npm test -- editorLayout` passes.
4. **`tests/shortcuts.test.ts` — write the new cases first.** Add a `describe('isSplitEditorRightChord')` block and two `dispatchAccelerator` cases (see `## Expected Behaviour`). Add `onSplitEditorRight` to the test file's `AcceleratorActions` builder. Expect failures.
5. **`src/shell/shortcuts.ts`.** Add `SPLIT_EDITOR_RIGHT_SHORTCUT` after `FIND_IN_FILES_SHORTCUT`. Add `isSplitEditorRightChord` after `isToggleExplorerChord`. Do not route it through `isCtrlChord`, which matches `event.key`. Write the check inline: `(event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.code === 'Backslash'`. Its doc comment says that it matches the physical key so that layouts without a direct `\` key can use it. Add `onSplitEditorRight` to `AcceleratorActions`. In `acceleratorFor`, add `[isSplitEditorRightChord, actions.onSplitEditorRight]` right after the `isToggleExplorerChord` row. Extend the header comment's "CodeMirror's default keymap binds none of these" sentence to say that `Mod-\` is free and `Mod-Alt-\`/`Shift-Mod-\` are CodeMirror's. Check: `npm test -- shortcuts` passes.
6. **`tests/commands.test.ts` — write the new cases first.** Add `canSplitActive: () => false`, `onSplitEditorRight: () => {}`, and `onSplitEditorDown: () => {}` to the `actions` builder. Update the two fixed-order tests to the fifteen-id list in `## Expected Behaviour`, and rename them from "thirteen" to "fifteen". Add the new split-command cases. Expect failures.
7. **`src/shell/commands.ts`.** Import `SPLIT_EDITOR_RIGHT_SHORTCUT`. Add the three fields to `PaletteCommandActions`. Read `const canSplitActive = actions.canSplitActive()` beside the existing snapshot reads. Insert two entries after `format-document`:
   `{ id: 'split-move-editor-right', title: 'Split and Move Editor Right', shortcut: SPLIT_EDITOR_RIGHT_SHORTCUT, enabled: canSplitActive, run: actions.onSplitEditorRight }` and
   `{ id: 'split-move-editor-down', title: 'Split and Move Editor Down', enabled: canSplitActive, run: actions.onSplitEditorDown }`.
   Check: `npm test -- commands` passes.
8. **`src/EditorController.ts`.** Import `canSplitPanel` with the existing `remapPanelIds` import from `./data/editorLayout`. Add `import type { Edge } from '@jimka/typescript-ui/primitive'`. Add `canSplitActive()` right after `canSaveActive()` (lines 270–273), and `splitActive(side)` right after `findInActive()` (line 1087), with the bodies from `## Implementation` and the doc comments from `## Public API`. Check: `npm run typecheck` passes.
9. **`src/shell/EditorShell.ts`.** Import `SPLIT_EDITOR_RIGHT_SHORTCUT`. In `MenuBarActions`, add `canSplitActive` ("Whether the active file can move into a new group — greys out the split items when not.") and `onSplitEditorDown` ("Moves the active file into a new group below its current one."). In the `actions` object (line 347), add `onSplitEditorRight: () => controller.splitActive('right')`, `onSplitEditorDown: () => controller.splitActive('bottom')`, and `canSplitActive: () => controller.canSplitActive()`. In the View menu, after the *Toggle Explorer* item, add `{ separator: true }` and then:
   `{ text: 'Split and Move Editor Right', glyph: 'square-caret-right', shortcut: SPLIT_EDITOR_RIGHT_SHORTCUT, enabled: actions.canSplitActive(), action: actions.onSplitEditorRight }` and
   `{ text: 'Split and Move Editor Down', glyph: 'square-caret-down', enabled: actions.canSplitActive(), action: actions.onSplitEditorDown }`.
   The existing separator before *Show Hidden Files* stays where it is.
10. **`src/main.ts`.** Import `square_caret_right` from `@jimka/typescript-ui/glyphs/solid/square_caret_right` and `square_caret_down` from `@jimka/typescript-ui/glyphs/solid/square_caret_down`, and add both to the `Glyph.register(...)` call. Check: `npm run typecheck` passes.
11. **`src/shell/session.ts`.** In `installSessionAutosave`, add `targets.controller.dock.on('splitresize', schedule)` directly after the `close` line (line 162). Check: `grep -c "dock.on('splitresize', schedule)" src/shell/session.ts` prints `1`.
12. **`README.md` and `TODO.md`** — apply the edits in `## Documentation Impact`. Check: `grep -n "A \*Split Editor\* command\|Re-saving the dock layout" TODO.md` prints nothing.
13. **Full check.** Run `npm run typecheck` and `npm test`. Every test passes, and the count is 549 plus the new cases. Then run the by-eye checks in `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Modify | `src/data/editorLayout.ts` |
| Modify | `src/shell/shortcuts.ts` |
| Modify | `src/shell/commands.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `src/main.ts` |
| Modify | `src/shell/session.ts` |
| Modify | `tests/editorLayout.test.ts` |
| Modify | `tests/shortcuts.test.ts` |
| Modify | `tests/commands.test.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Unit-testable — `tests/editorLayout.test.ts`

The existing fixtures (`PANEL`, `TABS`, `SPLIT`, `STATE`, `R`, `FLOAT`) are reused, plus `STRIP = (content: LayoutNode): WindowNode => ({ kind: 'window', windowMode: 'strip', content, header: 'b.ts', rect: R, state: 'normal', restoreRect: null })` and `M = new Map([['buf-1', '/p/a.ts'], ['buf-2', '/p/b.ts']])`, as in the existing `remapPanelIds` block.

`readLayoutState`:

| Input | Expected |
| --- | --- |
| `STATE(TABS([PANEL('a')], 0), [STRIP(TABS([PANEL('b'), PANEL('c')], 1))])` | accepted |
| the same with the window's `windowMode: 'bare'` | accepted |
| the same with `windowMode: 'tabs'` | `undefined` |
| the same with `windowMode: 42` | `undefined` |
| `STATE(TABS([PANEL('a')], 0), [FLOAT(TABS([PANEL('b')], 0))])` (no `windowMode`) | accepted |

`remapPanelIds`:

| Input | Expected |
| --- | --- |
| `STATE(TABS([PANEL('buf-1')], 0), [STRIP(TABS([PANEL('buf-1'), PANEL('buf-3'), PANEL('buf-2')], 2))])` with `M` | one window, `windowMode: 'strip'`, content `tab` with panels `/p/a.ts`, `/p/b.ts` and `activeIndex: 1` |
| `STATE(TABS([PANEL('buf-1')], 0), [STRIP(TABS([PANEL('buf-3')], 0))])` with `M` | `windows` is `[]` |
| `STATE(TABS([PANEL('buf-1')], 0), [FLOAT(TABS([PANEL('buf-2')], 0))])` with `M` | the kept window has no `windowMode` key (`'windowMode' in window` is `false`) |
| `STATE(SPLIT([TABS([PANEL('buf-1')], 0), { kind: 'split', orientation: 'vertical', children: [TABS([PANEL('buf-2')], 0), TABS([PANEL('buf-4')], 0)], ratios: [0.3, 0.7], collapsed: [false, false] }], [0.4, 0.6]))` with `M` plus `buf-4 → /p/d.ts` | outer ratios `[0.4, 0.6]` and inner ratios `[0.3, 0.7]`, both unchanged, inner orientation `vertical` |

`panelOrder`:

| Input | Expected |
| --- | --- |
| `panelOrder(STATE(TABS([PANEL('buf-1')], 0), [STRIP(TABS([PANEL('buf-2'), PANEL('buf-3')], 0))]))` | `['buf-1', 'buf-2', 'buf-3']` — every strip tab, in strip order |

`canSplitPanel`:

| State | `panelId` | Expected |
| --- | --- | --- |
| `STATE(TABS([PANEL('a'), PANEL('b')], 0))` | `'a'` | `true` |
| `STATE(TABS([PANEL('a')], 0))` | `'a'` | `false` |
| `STATE(SPLIT([TABS([PANEL('a')], 0), TABS([PANEL('b'), PANEL('c')], 1)], [0.5, 0.5]))` | `'a'` | `false` |
| the same | `'c'` | `true` |
| `STATE(TABS([PANEL('a')], 0), [FLOAT(TABS([PANEL('b'), PANEL('c')], 0))])` | `'b'` | `true` |
| `STATE(TABS([PANEL('a')], 0), [STRIP(TABS([PANEL('b'), PANEL('c')], 0))])` | `'b'` | `false` |
| `STATE(TABS([PANEL('a')], 0), [{ kind: 'window', panelId: 'b', header: 'b', rect: R, state: 'normal', restoreRect: null }])` | `'b'` | `false` |
| `STATE(PANEL('a'))` | `'a'` | `false` |
| `STATE(TABS([PANEL('a'), PANEL('b')], 0))` | `'zzz'` | `false` |

### Unit-testable — `tests/shortcuts.test.ts`

Each event is built with the file's `chord(...)` helper. Pass `code` explicitly.

| Event | `isSplitEditorRightChord` |
| --- | --- |
| `{ ctrlKey: true, code: 'Backslash', key: '\\' }` | `true` |
| `{ metaKey: true, code: 'Backslash', key: '\\' }` | `true` |
| `{ ctrlKey: true, code: 'Backslash', key: "'" }` (Swedish layout) | `true` |
| `{ ctrlKey: true, shiftKey: true, code: 'Backslash', key: '|' }` | `false` |
| `{ ctrlKey: true, altKey: true, code: 'Backslash', key: '\\' }` | `false` |
| `{ code: 'Backslash', key: '\\' }` | `false` |
| `{ ctrlKey: true, code: 'IntlBackslash', key: '\\' }` | `false` |

`dispatchAccelerator`: Ctrl + `code: 'Backslash'` with no modal open calls `onSplitEditorRight` once and returns `true`. With a modal open it calls nothing and still returns `true`.

### Unit-testable — `tests/commands.test.ts`

| Case | Expected |
| --- | --- |
| Fixed order, any state | `['new-file', 'open-folder', 'toggle-explorer', 'exit', 'save', 'save-as', 'close-file', 'find', 'go-to-line', 'format-document', 'split-move-editor-right', 'split-move-editor-down', 'toggle-hidden-files', 'toggle-ignored-files', 'toggle-dark-theme']` |
| `canSplitActive: () => false`, `hasActiveFile: () => true` | both split commands `enabled: false` |
| `canSplitActive: () => true` | both split commands `enabled: true` |
| Titles and shortcuts | right: `'Split and Move Editor Right'`, `shortcut` `SPLIT_EDITOR_RIGHT_SHORTCUT`; down: `'Split and Move Editor Down'`, `shortcut` `undefined` |
| `run()` on each, with spies | right calls `onSplitEditorRight` once, down calls `onSplitEditorDown` once, also while disabled |

The test "marks the always-available commands enabled regardless of state" keeps its list. The split commands are not in it.

### Manual verification — browser shell (`npm run dev:browser -- --port <n> --strictPort`)

Set `window.__FAKE_PROJECT_ROOT__` to a folder inside the checkout (for example its `src` folder), then click *Open Folder…*. Open files with a double click, so their tabs are permanent.

| Action | Expected |
| --- | --- |
| Open `main.ts` and `appIdentity.ts`; open the View menu | Both split items are enabled; *Right* shows `Ctrl/Cmd+\` |
| Press Ctrl+\\ with `appIdentity.ts` active | `appIdentity.ts` moves into a new group on the right, about half the width; `main.ts` stays on the left; typing a character lands in `appIdentity.ts` |
| Open the View menu again (each group now holds one tab) | Both split items are greyed out; in the palette, `>split` lists both, greyed |
| Press Ctrl+\\ again | Nothing changes |
| Open `errors.ts` (it lands in the right group), then run *Split and Move Editor Right* from the palette | A third column appears, the three sharing the width about equally |
| Open a fourth file into one group, then run *Split and Move Editor Down* from the View menu | That group's area splits top/bottom, with the moved file below; the window title and status bar show the moved file |
| Single-click a file in the tree (italic temp tab, in a group with another tab), then Ctrl+\\ | The tab keeps its italic label in its new group |
| Drag a tab off a strip into open space (a tab-strip float), drop a second tab onto the float's strip, focus one of its tabs, open the View menu | Both split items are greyed out |
| Shift-drag a tab off a strip (a header-window mini-dock), drop a second tab on its centre, focus one, press Ctrl+\\ | The float itself splits in two |

**Save on `splitresize`.** Session writes do nothing in the browser shell, but the save scheduling can be observed. Before the gutter checks, run this in the page with `evaluate_script`: `window.__saves = 0; const t = window.setTimeout; window.setTimeout = (fn, ms, ...a) => { if (ms === 500) window.__saves++; return t(fn, ms, ...a) }`. (500 is `SESSION_SAVE_DEBOUNCE_MS`.) Read `window.__saves` before and after each step.

| Action | Expected |
| --- | --- |
| Drag the gutter between two editor groups and release | `__saves` goes up by at least 1 on release, not while dragging |
| Double-click a group gutter's chevron to collapse a pane | `__saves` goes up |
| Leave the app idle for a few seconds | `__saves` does not change |

### Manual verification — the real app (`npm run tauri:dev`, run by the user)

The restore path reads `session.json` from the config folder, which the browser shell cannot reach. These checks need the native window.

| Action | Expected |
| --- | --- |
| Split the editor area, drag the group gutter, wait one second, then read `session.json` without exiting | `editorLayout.root` holds the new ratios |
| Stack two groups top/bottom at roughly 30/70, restart | They come back at roughly 30/70, not at equal heights |
| Tear off a tab into a strip float, add two more tabs, make the middle one active, restart | The float comes back as a tab-strip window with all three files in order and the middle one active |
| Restart with a long file in a restored group | The file scrolls inside its group; the group does not grow past the editor area |
| Restart from a `session.json` written before this change that holds a float | The float comes back as a plain window with its one saved file; no error dialog and no console warning |

---

## Verification

- `npm run typecheck` passes.
- `npm test` passes: the 549 existing tests (two renamed in `tests/commands.test.ts`) plus every case above.
- `grep -c "dock.on('splitresize', schedule)" src/shell/session.ts` prints `1`.
- `grep -rn "SPLIT_EDITOR_RIGHT_SHORTCUT" src` matches `shortcuts.ts`, `commands.ts`, and `EditorShell.ts`.
- `git diff --stat package.json` is empty.
- The browser-shell checks in `## Expected Behaviour`. Take a screenshot of the three-column state and of the greyed View menu.
- The `npm run tauri:dev` table is listed for the user to run. Report it as not run if the sandbox cannot open a native window.

---

## Documentation Impact

**`README.md`, the *Split editor groups* bullet** (line 106) becomes:

> - **Split editor groups** — drag a tab onto the edge of the editor area to split it, and the dragged file opens in the new group beside the first; or use *View > Split and Move Editor Right* (Ctrl/Cmd+\\) or *Split and Move Editor Down*, also in the command palette, to do the same for the active file. Loom keeps one editor per file, so the file moves into the new group rather than opening a second time, and both commands are greyed out while it is the only tab in its group or sits in a tab-strip floating window. Drag a tab between groups to move it, or off a strip entirely to tear it off into a floating window. The window title, the status bar, and *Find…* all follow whichever group has focus. Group layout, each group's tab order and active tab, and every floating window's position come back on the next launch; a resize of the gutter between groups is saved as soon as the drag ends.

**`TODO.md`:**

- Delete the *Medium* bullets **A *Split Editor* command.** and **Re-saving the dock layout on a gutter drag.**
- Add to *Known issues / loose ends*:

  > - **Some editor-layout changes wait for the next save.** A tab reordered within its strip and a floating window moved or resized are written at the next dock event or on exit, because `Dock` emits no event for either — by design, per its *Saving and restoring* docs. A gutter drag between groups is saved as soon as it ends (`splitresize`).

No library docs change. No Loom public API is exported for other packages.

---

## Potential Challenges

- **Sibling plans edit the same files.** `library-focus-and-search-adoption.md` and `edit-clipboard-and-polish.md` also change `commands.ts`, `EditorShell.ts`, and probably the fixed-order lists in `tests/commands.test.ts`. Insert the split entries after `format-document` in whatever list the branch holds at the time, and adjust the count in the test names to match.
- **Focus after a split may not land.** If manual checking shows the moved editor does not receive the typed character, do not add a deferred `focus()` or a timer. Record what was seen and ask the user, because it would be a library focus issue.
- **`getLayoutState()` runs on every View-menu open and palette open.** It walks the dock tree and reads each float's rectangle. That is cheap at Loom's scale, and both are user-paced events, not per-frame ones.

---

## Critical Files

- [`src/shell/session.ts:122`](src/shell/session.ts#L122) — `installSessionAutosave`, the precedent for the `splitresize` line.
- [`src/data/editorLayout.ts`](src/data/editorLayout.ts) — `remapPanelIds`, `panelOrder`, `isWindowNode`; `canSplitPanel` follows the same recursive node walk as `collectPanelIds`.
- [`src/shell/shortcuts.ts`](src/shell/shortcuts.ts) and [`src/shell/commands.ts`](src/shell/commands.ts) — the chord/constant pattern and the palette entry pattern (`find`, `format-document`).
- [`src/shell/EditorShell.ts:347`](src/shell/EditorShell.ts#L347) and [`:716`](src/shell/EditorShell.ts#L716) — the `actions` object and the View menu.
- [`src/EditorController.ts:1087`](src/EditorController.ts#L1087) — `findInActive`, the shape of a delegating active-file command.
- `/home/jika/typescript/typescript-ui/packages/lib/docs/components/Dock.md` — *Programmatic control* (`splitPanel`) and *`splitresize`*.
- `/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/overlay/Dock.ts:2460` — `splitPanel` and its `false` cases.
- `/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/layout/LayoutSerialization.ts:117` — `WindowNode.windowMode`.
- `plans/implemented/dock-split-pane-editing.md` — the plan that introduced the dock, the layout persistence, and the two TODO items closed here.

---

## Non-Goals

- **A real VS Code-style *Split Editor* that shows one file twice.** Loom keeps one editor per file; two live views of one buffer would need a shared-document design and is a separate feature.
- **Markdown preview as a split view.** `plans/implemented/markdown-preview.md` left side-by-side source and preview out, and `dock-split-pane-editing.md` left programmatic splitting out. `splitPanel` now makes a preview panel beside its source possible, but that is its own feature with its own plan.
- **Splitting inside a tab-strip floating window.** `splitPanel` refuses a target in a `TabWindow` by design. The commands are greyed out there.
- **Left/up commands, an *Editor* menu, focus-next-group commands, or join/merge-group commands.** Not asked for.
- **`CodeEditor.openSearch`, `focusPanel` focus changes, `Tree.moveNode`, editor settings, clipboard, the muted text colour.** Each is a sibling plan.

---

## Notes

[^move-not-duplicate]: `EditorController._openFiles` maps a panel id to its one `FileEditor`, and `openFile(path)` returns early through `findByPath` when the path is already open, focusing that tab instead of reading the file again. A second editor for the same path would break that rule and everything keyed on it: dirty tracking, external-change reloads, Save As relabelling, and project-wide replace in an open buffer. `splitPanel(id, id, side)` is covered by the library's own test *St7: splits the target itself out of its own group* (`tests/overlay/Dock.splitPanel.test.ts`).

[^names]: VS Code's *Split Editor Right* duplicates the editor, and its *Move Editor into Right Group* moves the editor into an existing group. Loom's command does neither exactly: it always makes a new group. The palette's `>` mode fuzzy-matches the title, so a user typing "split" (the word from the TODO item and from VS Code) or "move" finds the command either way.

[^two-commands]: Right and down are the pair VS Code binds by default. Left and up would only reorder where the new group sits, and adding them later is two more palette rows with no design change. Joining or closing groups already happens by dragging or by closing a group's last tab.

[^backslash-code]: `event.key` is the character the layout produces. On a Swedish layout `\` needs AltGr, and on Linux AltGr can also report as Ctrl+Alt, so a `key === '\\'` match is hard or impossible to type there. `event.code === 'Backslash'` names the physical key in the US `\` position (the key left of Enter on ISO boards). That is also how VS Code dispatches its US-labelled bindings by default. Shift is excluded because `Shift-Mod-\` is CodeMirror's `cursorMatchingBracket`, and Alt because `Mod-Alt-\` is CodeMirror's `indentSelection` (both in `@codemirror/commands`' `defaultKeymap`, which the library's `codeEditorKeymap` includes).

[^no-down-shortcut]: VS Code binds its down split to the two-stroke sequence Ctrl+K Ctrl+\\, which Loom's single-chord accelerator table cannot express. The one-chord neighbours Ctrl+Shift+\\ and Ctrl+Alt+\\ belong to CodeMirror's `indentSelection` and `cursorMatchingBracket`. The command stays reachable from the View menu and the palette.

[^ratio-omitted]: The command stands in for the drag gesture, so it sizes the pane the way a drop does. The library documents this as the default when `ratio` is omitted (`DockSplitOptions.ratio`). A fixed ratio such as 0.5 would also squeeze the existing groups unevenly when the new pane joins an existing split.

[^can-split-derived]: `Dock` has no query that answers "would `splitPanel` succeed?". Its public surface is `getLayoutState`, `splitPanel`, and the events. Three options were considered. Always-enabled items that silently do nothing were rejected, because a no-op menu item breaks the menu/palette rule that a command that cannot run is greyed out (`commands.ts` header). Walking the live component tree (`file.getParentComponent()`, the region's `Tab`) was rejected, because it reads dock internals the library does not document. Reading `getLayoutState()` uses only the documented state shape, and it reproduces the two documented `false` cases of `splitPanel` that apply when target and panel are the same: "the panel is the target's only tab" and "a target in a strip-mode tear-off window" (`Dock.md`, *Programmatic control*; library tests N3 and N7). The third documented case, "already sits alone right beside it", needs the panel to be alone in its group, which the only-tab rule already covers. If the library later gains a `Dock.canSplitPanel`, Loom's helper should be deleted in its favour. That upstream addition is an open question for the user, not a prerequisite.

[^focus-editor]: The library's `splitPanel` docs say: "the panel's new tab never takes focus, and focusing the panel's content is the application's job". Without the call, focus would stay in the menu's previous target or jump to a tab left in the old group (library test F8), and the next keystroke would not reach the file the user just moved. `openFile(path, 'permanent')` ends with `file.getEditor().focus()` for the same reason.

[^view-menu]: The View menu already holds the other layout command, *Toggle Explorer*. The Edit menu holds text operations (Find, Go to Line, Format). A new top-level menu for two items would add a fourth dropdown with no other contents.

[^session-precedent]: `schedule` takes no arguments and ignores every payload, as it already does for the tree, split, and other dock events. The `Dock` docs give exactly this list for saving as the user works: "listen to `splitresize`, `attach`, `detach`, `move`, `close` and `focus`". With `splitresize` added, Loom listens to all six. `splitresize` fires once per drag end and once per pane collapse or expand, so the 500 ms debounce never sees a stream of these events.

[^explorer-no-gap]: The explorer/editor gutter is a plain `Split` owned by `EditorShell`. `installSessionAutosave` already subscribes to that split's `paneresize` (fired once per completed gutter drag, never per frame, per `docs/layouts/Split.md`) and `panecollapse` (fired on every collapse change, including *Toggle Explorer*'s `setPaneCollapsed`). `captureSession` reads `getPaneSizes()` and `isPaneCollapsed` at save time. Nothing is missing there, and no library addition is needed.

[^windowmode-validate]: `readLayoutState` casts its input to `LayoutState` once every node checks out. Without the check, a hand-edited or corrupted `windowMode` would be typed as `TabDetachWindowMode` while holding anything. The library would treat an unknown value as `'bare'`, so the risk is a dishonest type, not a crash. The all-or-nothing rejection matches how `isWindowNode` already treats a non-string `panelId`. A future library mode beyond `'bare'`/`'strip'` would need this check widened, and would appear in the library changelog first.

[^old-sessions]: Library 0.11.0's `serializeLayout` wrote a `TabWindow` as a plain window node whose `content` was its first tab only. Loom's `captureSession` derives `openFiles` from `panelOrder(editorLayout)`, so the other tabs' paths were not written either. On restore, `restoreFiles` reopens exactly the listed paths, and the new `restoreLayout` rebuilds a window without `windowMode` as a header `Window` holding that one panel. Loom never persisted a foreign window (an open dialog, say): `captureEditorLayout` remaps every captured state through the open files' paths, which drops any window whose content holds no Loom panel. So the library's new "skip a saved window that names none of the dock's panels" rule does not change what Loom restores.
