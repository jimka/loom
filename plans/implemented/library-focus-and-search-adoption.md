---
depends-on: [typescript-ui-0-11-adoptions]
touches-shared: [src/EditorController.ts, src/editor/FileEditor.ts, src/editor/editorSearch.ts, README.md, package.json, package-lock.json]
---

# Library Focus and Search Adoption — Implementation Plan

## Overview

Two fixes landed in `@jimka/typescript-ui`'s unreleased `master` at Loom's
request. This plan adopts both, as two parts that each land as their own code
commit.

1. **`CodeEditor.openSearch()`.** Edit › Find…, its palette entry, and the
   Ctrl/Cmd+F accelerator open the library's search card, but keyboard focus
   stays where it was (the tree, or `<body>`) instead of moving to the find
   field. The cause is Loom's own path in
   [src/editor/editorSearch.ts:45](src/editor/editorSearch.ts#L45): it finds
   the CodeMirror view through `EditorView.findFromDOM`, appends a second
   `search()` extension, and calls `openSearchPanel` itself. After this part
   `openFindPanel` calls `editor.openSearch()`, which opens the card, fills
   the find field from the selection, and focuses it. The `installed` WeakSet,
   `resolveView` and all three CodeMirror imports go, and with them Loom's
   last direct `@codemirror/*` dependencies in `package.json`.
2. **`Dock.focusPanel(id, { focus: false })`.** Arrowing through the file
   tree onto a file whose tab sits in a torn-off `TabWindow` moves keyboard
   focus into that window, so the next arrow key goes to the window instead
   of the tree. After this part every `focusPanel` call in
   [src/EditorController.ts](src/EditorController.ts) (lines 468, 498, 542,
   691) passes `{ focus: false }`. Loom then moves focus into the editor
   itself, through a new `FileEditor.focusEditor()`, for every open the user
   asked for: double-click, Enter, the palette, Open Recent, a drop, the
   settings commands, New File, and the launch restore. Today a permanent
   open of a file that was not already showing leaves focus in the tree,
   because `CodeEditor.focus()` does nothing before the editor has laid out.
   `focusEditor()` fixes that too.

Loom's `package.json` keeps `"@jimka/typescript-ui": "^0.11.0"` until the
library releases. The implementer builds against a symlink to the library
checkout (see Setup).

---

## Architecture Decisions

### Build against the library checkout through a worktree symlink

After `npm ci`, the worktree's `node_modules/@jimka/typescript-ui` is replaced
with a symlink to `/home/jika/typescript/typescript-ui/packages/lib`. Neither
`package.json` range nor the main tree's `node_modules` changes.[^linked-build]

### Part 1 — `openFindPanel` wraps `openSearch`, as `revealRange` wraps `CodeEditor.revealRange`

`openFindPanel(editor)` keeps its name and signature and becomes a thin
wrapper. It calls `editor.openSearch()`. When that returns `false`, which
means the editor has not mounted its view yet, it calls `openSearch()` once
more from `editor.onFirstLayout`. The precedent is the same module's
[`revealRange`](src/editor/editorSearch.ts#L80), which wraps
`CodeEditor.revealRange` with the same `onFirstLayout` wait.[^find-before-mount]

`FileEditor.openFind`'s early return while the Markdown preview is showing
stays.

### Part 1 — drop all three `@codemirror/*` dependencies

`@codemirror/search`, `@codemirror/state` and `@codemirror/view` leave
`package.json`. `editorSearch.ts` is the only file that imports any of them,
and all three were added in the commit that created it (`62e045b`). The
packages stay installed as the library's own dependencies, so the `dedupe`
list in [vite.config.ts:26](vite.config.ts#L26) keeps working and is not
touched.[^codemirror-deps]

### Part 2 — every `focusPanel` call passes `{ focus: false }`

All four `dock.focusPanel` calls in `EditorController` pass a shared
`ACTIVATE_WITHOUT_FOCUS` constant (`{ focus: false }`). The dock activates the
tab and raises a floating window that holds it, and never moves keyboard
focus. Loom wants focus either left where it is or put in the editor. The
library's default puts it on a tab button or a window frame, which is neither
of those.[^focus-false-everywhere]

The dock still emits `"focus"` for these activations, so
`handlePanelFocus`, the status bar, the window title and the Find… target
keep following the active file.[^focus-event-still-fires]

### Part 2 — the open mode decides whether the editor takes focus

The rule already in the code stays: a `'permanent'` open moves focus into the
editor and a `'temporary'` open leaves focus alone. New File and the launch
restore join the "editor takes focus" side. The result, for every entry
point:

| Entry point | Controller call | Keyboard focus afterwards |
|---|---|---|
| Tree click or arrow key | `openFile(path, 'temporary')` | stays in the tree |
| Search results click or arrow key on a match | `openFileAt(…, 'temporary')` | stays in the results tree |
| Tree double-click or Enter | `openFile(path, 'permanent')` | the file's editor |
| Search results double-click or Enter (match or file row) | `openFileAt(…, 'permanent')` / `openFile(path, 'permanent')` | the file's editor (match selected) |
| Palette Enter on a file, Open Recent › Files, a dropped file, Open Settings, Open Workspace Settings | `openFile(path)` (`'permanent'` by default) | the file's editor |
| File › New File, Ctrl/Cmd+N | `newFile()` | the new untitled editor |
| Launch session restore | `restoreFiles(…)` | the restored active file's editor |

Every row behaves the same when the file's tab is in a floating window: the
window is raised, and focus either stays put or lands in that window's
editor.

A click followed by a double-click on the same tree row is one temporary
open upgraded to permanent while the read is in flight (`_pendingOpens`). The
first call reads the upgraded mode as `settled`, so focus goes to the editor.
That stays as it is.

### Part 2 — `FileEditor.focusEditor()` waits for the editor's first layout

`focusEditor()` calls `this._editor.focus()` from
`this._editor.onFirstLayout(...)`. The precedent is
[`SearchPanel.focusQuery`](src/explorer/SearchPanel.ts#L259), which waits the
same way for its query field.[^why-wait]

`onFirstLayout` on an editor that has already laid out runs the callback
after the next layout pass, which comes one frame later at most. So
`focusEditor()` works for a new tab, a background tab being switched to, and
the tab already showing.

### Part 2 — closes and the unsaved-changes prompt need no Loom change

The library's new rule (`migration/next.md`) also reaches Loom's closes
from code. None of them needs a code change:[^close-paths]

| Path | Before the library change | Now |
|---|---|---|
| Tree delete closes open tabs (`closeFilesUnder` → `removePanel`) | focus moved to a neighbouring tab button | focus stays in the tree |
| Temp tab recycled by the next tree click (`closeTemporaryTab` → `removePanel`) | focus moved to a neighbouring tab button | focus stays in the tree |
| Ctrl/Cmd+W, or ✕ on a dirty tab, then *Don't Save* (`confirmThenClose` → `removePanel`) | the neighbouring tab button | the neighbouring tab button (unchanged) |

### No new unit tests

The focus decision is the existing `mode === 'permanent'` check, which has no
new logic to extract. What can break is DOM focus timing. Vitest runs with no
DOM, so the by-eye cases in **Verification** cover this plan, and the suite
stays at 549.[^no-unit-tests]

---

## Public API

Loom-internal only; nothing in the library changes.

`src/editor/FileEditor.ts`:

```typescript
/** Moves keyboard focus into this file's editor once the editor has laid out. */
focusEditor(): void
```

`src/editor/editorSearch.ts` keeps `openFindPanel(editor: CodeEditor): void`
and `revealRange(editor, at, focus?)` with unchanged signatures.

`src/EditorController.ts` gains a module-private constant:

```typescript
const ACTIVATE_WITHOUT_FOCUS: DockFocusPanelOptions = { focus: false }
```

---

## Implementation

### `src/editor/editorSearch.ts` — lines 1-61 become

Everything above `revealRange`'s doc comment (lines 1-61) is replaced with
this. `revealRange` and its doc comment (lines 62-87) stay
unchanged below it.

```typescript
// Opens a Loom `CodeEditor`'s search card, and positions its caret at a
// project-search match. Both functions are thin wrappers over public
// `CodeEditor` methods — `openSearch` and `revealRange` — that add the one
// thing those methods leave to the caller: waiting for an editor that has not
// mounted its view yet. `CodeEditor` mounts on its first sized layout, and
// both methods do nothing before that, so each wrapper waits for
// `Component.onFirstLayout`.

import type { CodeEditor } from '@jimka/typescript-ui/component/editor'
import type { MatchLocation } from '../data/projectSearch'

/**
 * Opens `editor`'s search card, fills its find field from the selection and
 * moves keyboard focus to it — what Ctrl/Cmd+F does inside the document. An
 * editor that has not mounted yet gets the call once more after its first
 * layout, so *Find…* on a file opened a moment ago still opens the card.
 *
 * @param editor - The editor to open the card over.
 */
export function openFindPanel(editor: CodeEditor): void {
    if (editor.openSearch()) {
        return
    }

    editor.onFirstLayout(() => {
        editor.openSearch()
    })
}
```

Keep exactly one blank line between this block and `revealRange`'s doc
comment.

### `src/editor/FileEditor.ts` — `openFind` doc comment (lines 251-255)

```typescript
    /** Opens the search card over this file's editor and focuses its find
     *  field. A no-op while the Markdown preview is showing: `Card` hides the
     *  editor with `setVisible(false)`, which leaves it laid out but
     *  invisible, so the card and its focused find field would open where the
     *  user can't see them. */
```

### `src/editor/FileEditor.ts` — `focusEditor`, inserted after `openFind` (after line 262)

One blank line before and after:

```typescript
    /** Moves keyboard focus into this file's editor once the editor has laid
     *  out. `CodeEditor.focus()` does nothing before the editor mounts its
     *  view (on its first sized layout) or while its tab page is hidden, and
     *  a tab opened or activated a moment ago is still in one of those two
     *  states — so the focus waits for `onFirstLayout`, as
     *  `SearchPanel.focusQuery` does for its query field. */
    focusEditor(): void {
        this._editor.onFirstLayout(() => {
            this._editor.focus()
        })
    }
```

### `src/EditorController.ts` — import and constant

Line 4 becomes:

```typescript
import type { DockPanelEvent, DockCloseController, DockFocusPanelOptions } from '@jimka/typescript-ui/overlay'
```

Insert after `WIDEST_LANGUAGE_ID` (its declaration is line 59), one blank
line before and after:

```typescript
/**
 * The options every `dock.focusPanel` call passes: activate the tab and raise
 * a floating window that holds it, without moving keyboard focus. A
 * selection-driven open (a tree or search-results click or arrow key) must
 * leave focus where it is, and an open the user asked for moves focus into
 * the editor itself through `FileEditor.focusEditor` — never onto a tab
 * button or a window frame, which is where the dock's default would put it.
 */
const ACTIVATE_WITHOUT_FOCUS: DockFocusPanelOptions = { focus: false }
```

### `src/EditorController.ts` — `newFile` (lines 448-470)

Doc comment (line 448) becomes:

```typescript
    /** Opens an empty untitled buffer in a new panel, activates it, and moves keyboard focus into its editor. */
```

Lines 468-469 become:

```typescript
        this.dock.focusPanel(panelId, ACTIVATE_WITHOUT_FOCUS)
        this.syncActive()
        file.focusEditor()
```

### `src/EditorController.ts` — `openFile` (lines 472-548)

In the doc comment, replace lines 481-484 (from "in flight for the same
path. A `'permanent'` open also moves keyboard" to "the command palette's
query field).") with:

```
     * in flight for the same path. A `'permanent'` open moves keyboard focus
     * into the file's editor, ready to type, once that editor has laid out. A
     * `'temporary'` open leaves focus wherever it was, since that mode exists
     * for browsing without leaving the caller (the file tree, the search
     * results). Either way the dock activates the tab, and raises a floating
     * window holding it, without taking focus itself.
```

Existing-tab branch, lines 498-502 become:

```typescript
            this.dock.focusPanel(existing.getPanelId(), ACTIVATE_WITHOUT_FOCUS)

            if (mode === 'permanent') {
                existing.focusEditor()
            }
```

New-tab tail, lines 542-547 become:

```typescript
        this.dock.focusPanel(file.getPanelId(), ACTIVATE_WITHOUT_FOCUS)
        this.syncActive()

        if (settled === 'permanent') {
            file.focusEditor()
        }
```

### `src/EditorController.ts` — `restoreFiles` (lines 684-692)

```typescript
        // Activated after the restore, not during: `setLayoutState` activates
        // one panel per group itself, so the remembered active file has to
        // win back afterward — and its editor takes keyboard focus, as after
        // any open the user asked for.
        const activeFile = activePath !== null ? this.findByPath(activePath) : null
        const toActivate = activeFile ?? firstOpened

        if (toActivate) {
            this.dock.focusPanel(toActivate.getPanelId(), ACTIVATE_WITHOUT_FOCUS)
            toActivate.focusEditor()
        }
```

### `src/EditorController.ts` — `findInActive` doc comment (line 1086)

```typescript
    /** Opens the search card over the active file's editor, with its find field focused. */
```

### `README.md`

- **File tree** bullet, lines 38-40. Replace "A single click opens a file in
  a reusable temp tab; a double click, or Enter on the selected row, opens it
  permanently." with: "A single click, or an arrow-key move, opens a file in
  a reusable temp tab and leaves keyboard focus in the tree, also when the
  file's tab sits in a floating window; a double click, or Enter on the
  selected row, opens it permanently with the caret in its editor."
- **Find & replace** bullet, lines 58-59. Replace "Ctrl/Cmd+F opens the
  editor's search panel, a floating card pinned to the active editor's
  upper-right corner;" with: "Ctrl/Cmd+F, *Edit > Find…* or the matching
  command-palette entry opens the editor's search panel, a floating card
  pinned to the active editor's upper-right corner, with the cursor in its
  find field, which starts out holding the selected text;"
- **Project search** bullet, lines 74-77. Replace "previews a row in the
  reusable temp tab — a file branch opens the file, a match opens it with
  that match selected — and a double click, or Enter, opens it permanently."
  with: "previews a row in the reusable temp tab while keeping focus in the
  results — a file branch opens the file, a match opens it with that match
  selected — and a double click, or Enter, opens it permanently with the
  caret in its editor."
- **New files** bullet, line 138. Replace "opens an empty, untitled tab;"
  with "opens an empty, untitled tab with the caret in it;".

Rewrap each edited paragraph to the file's existing ~76-column width.

---

## Ordered Implementation Steps

All steps run from the worktree root.

### Setup

1. **Install and link the library checkout.**
   ```bash
   npm ci
   rm -rf node_modules/@jimka/typescript-ui
   ln -s /home/jika/typescript/typescript-ui/packages/lib node_modules/@jimka/typescript-ui
   ```
   Checks:
   - `readlink node_modules/@jimka/typescript-ui` →
     `/home/jika/typescript/typescript-ui/packages/lib`.
   - `grep -c "openSearch" node_modules/@jimka/typescript-ui/dist/lib/types/component/editor/CodeEditor.d.ts`
     → at least 1, and
     `grep -n "focusPanel(id: string, options" node_modules/@jimka/typescript-ui/dist/lib/types/overlay/Dock.d.ts`
     → one match. If either fails, the library's `dist` is stale: stop and
     report it. Do not build the library yourself.
   - `git diff --stat package.json package-lock.json` → empty. The link is
     not recorded anywhere.
2. **Baseline.** `npm run typecheck && npm test` → clean, `549 passed`.
3. **Red by-eye baseline.** Start the browser shell (see **Verification**)
   and run cases V1, V4 and V6 against the unmodified code. All three must
   fail, as they did when this plan was written: V1 leaves focus in the tree
   with the card open; V4 moves focus into the `TabWindow`; V6 leaves focus in
   the tree. Stop the dev server. This proves the three checks can fail.

### Part 1 — `openSearch`

4. **[src/editor/editorSearch.ts](src/editor/editorSearch.ts)** — replace
   lines 1-61 with the block in **Implementation**. Checks:
   - `grep -n "codemirror\|installed\|resolveView\|findFromDOM\|appendConfig" src/editor/editorSearch.ts`
     → zero matches.
   - `grep -rn "from '@codemirror" src tests browser-shell` → zero matches.
5. **[src/editor/FileEditor.ts](src/editor/FileEditor.ts)** — replace
   `openFind`'s doc comment (lines 251-255) with the one in
   **Implementation**.
6. **[src/EditorController.ts](src/EditorController.ts)** — replace
   `findInActive`'s doc comment (line 1086).
7. `npm run typecheck && npm test` → clean, `549 passed`. **Commit Part 1**
   as one code commit (commit skill): `src/editor/editorSearch.ts`,
   `src/editor/FileEditor.ts`, `src/EditorController.ts`.
8. **Drop the dependencies.** Run:
   ```bash
   npm uninstall --package-lock-only --no-audit --no-fund @codemirror/search @codemirror/state @codemirror/view
   ```
   `--package-lock-only` leaves `node_modules`, and so the symlink, alone.
   Checks:
   - `git diff package.json` → exactly the three `@codemirror/*` lines removed.
   - `git diff package-lock.json` → exactly the same three lines removed from
     the root package's `dependencies`; the `node_modules/@codemirror/*`
     entries stay.
   - `readlink node_modules/@jimka/typescript-ui` → still the library path.
   - `npm run typecheck && npm test && npm run build` → clean.

   Commit as a tooling commit: `package.json`, `package-lock.json`.

### Part 2 — `focusPanel({ focus: false })`

9. **[src/editor/FileEditor.ts](src/editor/FileEditor.ts)** — insert
   `focusEditor()` after `openFind` (after line 262, or wherever `openFind`'s
   closing brace now is).
10. **[src/EditorController.ts](src/EditorController.ts)** — make the edits
    in **Implementation**, bottom of the file first so earlier line numbers
    stay valid: `restoreFiles` (684-692), `openFile`'s new-tab tail (542-547),
    its existing-tab branch (498-502), its doc comment (481-484), `newFile`
    (468-469, then 448), the constant after line 59, the import on line 4.
    Checks:
    - `grep -n "focusPanel(" src/EditorController.ts` → four matches, each
      ending `ACTIVATE_WITHOUT_FOCUS)`.
    - `grep -rn "getEditor().focus()" src` → zero matches.
    - `grep -n "focusEditor()" src/EditorController.ts` → four matches
      (`newFile`, `openFile` twice, `restoreFiles`).
    - `npm run typecheck && npm test` → clean, `549 passed`.
11. **Commit Part 2** as one code commit: `src/editor/FileEditor.ts`,
    `src/EditorController.ts`.

### Documentation and final checks

12. **[README.md](README.md)** — the four bullet edits in **Implementation**.
    Commit as a documentation commit.
13. **Full check.** `npm run typecheck && npm test && npm run build` → clean,
    `549 passed`. `git status --short` → empty.
14. Run every case in **Verification**.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src/editor/editorSearch.ts` |
| Modify | `src/editor/FileEditor.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `package.json` |
| Modify | `package-lock.json` |
| Modify | `README.md` |

---

## Expected Behaviour

**Unit-testable:** none new. The suite stays at 549 and must pass unchanged
(see *No new unit tests*).

**Manual** (browser shell; cases V1–V12 in **Verification**):

1. Find… from outside the editor (accelerator from the tree, Edit menu,
   palette) opens the card and focuses its find field. With text selected in
   the editor, the field holds that text (V1, V2, V3).
2. Find… while the Markdown preview is showing still opens nothing.
   `FileEditor.openFind`'s early return is untouched, and no by-eye case
   covers it: `src` holds no Markdown file.
3. Arrowing in the tree onto a file whose tab is in a floating window raises
   the window and activates the tab, and focus stays in the tree. The status
   bar and the Find… target follow that file (V4).
4. Arrowing in the search results onto a match in a floating window's file
   keeps focus in the results tree (V5).
5. Every "the file's editor" row of the entry-point table ends with the caret
   in that editor: a new tab (V6), a background tab (V7), a tab in a floating
   window (V8), Enter in the tree (V6), the palette (V9), New File (V10), a
   search result double-click with the match selected (V11).
6. ✕ on a dirty tab, then *Don't Save*, leaves focus on the neighbouring tab
   button, as before (V12).
7. Launch restore puts the caret in the restored active file's editor. The
   browser shell cannot test this, because it writes no session. Check it
   under `npm run tauri:dev` if available; otherwise record it as not
   checked in the implementation notes.

---

## Verification

- `npm run typecheck`, `npm test` (549 passed), `npm run build` — all clean.
- The greps in steps 1, 4, 8 and 10.
- **By eye, browser shell.** From the worktree:
  1. `npm run dev:browser -- --port 1447 --strictPort` (any free port), and
     open `http://localhost:1447/` with the chrome-devtools tools. With
     `evaluate_script`, set `window.__FAKE_PROJECT_ROOT__` to the absolute
     path of the worktree's `src` folder, then click *Open Folder…*. The tree
     shows `data`, `editor`, `explorer`, `shell`, `appIdentity.ts`,
     `EditorController.ts`, `errors.ts`, `fileIcons.ts`, `main.ts`.
  2. **Focus probe.** After each step, wait about 500 ms, then run:
     ```js
     () => {
         const a = document.activeElement
         return {
             tag: a?.tagName,
             role: a?.getAttribute('role'),
             inTree: !!a?.closest('[role=tree]'),
             inEditor: !!a?.closest('.cm-editor'),
             inTabWindow: !!a?.closest('.TabWindow'),
             value: a instanceof HTMLInputElement ? a.value : null,
         }
     }
     ```
     The search card's find field reads as `tag: 'INPUT'`, `inTree: false`.
  3. **Tear-off.** The library's tab drag follows mouse events, so dispatch
     pointer and mouse events together. This script tears `main.ts`'s tab
     off and drops it below the Properties header, which is not a drop
     target:
     ```js
     async () => {
         const tab = [...document.querySelectorAll('[role=tab]')].find(t => t.textContent.trim() === 'main.ts')
         const header = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Properties')
         const tr = tab.getBoundingClientRect()
         const hr = header.getBoundingClientRect()
         const sx = tr.x + tr.width / 2, sy = tr.y + tr.height / 2
         const ex = hr.x + hr.width / 2, ey = hr.y + hr.height + 60
         const base = { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, view: window }
         const start = document.elementFromPoint(sx, sy)
         start.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1, clientX: sx, clientY: sy }))
         start.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1, clientX: sx, clientY: sy }))
         for (let i = 1; i <= 25; i++) {
             await new Promise(r => requestAnimationFrame(r))
             const x = sx + (ex - sx) * i / 25, y = sy + (ey - sy) * i / 25
             const target = document.elementFromPoint(x, y) ?? document.body
             target.dispatchEvent(new PointerEvent('pointermove', { ...base, buttons: 1, clientX: x, clientY: y }))
             target.dispatchEvent(new MouseEvent('mousemove', { ...base, buttons: 1, clientX: x, clientY: y }))
         }
         const end = document.elementFromPoint(ex, ey) ?? document.body
         end.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0, clientX: ex, clientY: ey }))
         end.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0, clientX: ex, clientY: ey }))
         await new Promise(r => setTimeout(r, 800))
         return document.querySelectorAll('.TabWindow').length
     }
     ```
     It returns `1` once the window exists.
  4. Run the cases in order; each builds on the previous state.
     - **V1 — Find… from the tree.** Double-click `errors.ts`, then click
       `fileIcons.ts` (a temp tab opens). Press Ctrl+F. Probe: `INPUT`,
       `inTree: false`. *(Baseline: `inTree: true`.)*
     - **V2 — Find… from the menu, seeded.** Click into the `fileIcons.ts`
       editor, press Ctrl+Home, ArrowDown, ArrowDown, ArrowDown, ArrowDown
       (line 5 begins `import { baseName`), then Shift+Ctrl+ArrowRight to
       select `import`. Open *Edit > Find…*. Probe: `INPUT`,
       `value: 'import'`. Press Escape: focus returns to the editor
       (`inEditor: true`).
     - **V3 — palette.** Click `fileIcons.ts` in the tree. Open *View >
       Command Palette…*, type `>Find`, Enter. Probe: `INPUT`,
       `inTree: false`. Press Escape.
     - **V4 — arrow onto a torn-off tab.** Double-click `main.ts`. Run the
       tear-off script (returns `1`). Click `fileIcons.ts` in the tree, then
       press ArrowDown so `main.ts` is selected. Probe: `inTree: true`,
       `inTabWindow: false`. The window's `main.ts` tab is
       `aria-selected="true"`. Press Ctrl+F: probe gives `INPUT`,
       `inTabWindow: true`, which shows the active file followed the arrow.
       Press Escape. *(Baseline: the ArrowDown moved focus into the window,
       `inTabWindow: true`, `role: 'dialog'`.)*
     - **V5 — arrow through search results into the window.** Open the
       Search view (Ctrl+Shift+F), search `FILE_ICON_GLYPHS`. Click the first
       match under `fileIcons.ts`, then press ArrowDown until a match under
       `main.ts` is selected. After every key, probe: `inTree: true`,
       `inTabWindow: false`. Switch back to the Files view.
     - **V6 — permanent open of a new tab.** Close every tab in the main
       strip (✕ on each; leave the window). Double-click
       `appIdentity.ts`. Probe: `inEditor: true`. Click `errors.ts` in the
       tree, then press Enter. Probe: `inEditor: true`. *(Baseline for the
       double-click: `inTree: true`.)*
     - **V7 — permanent open of a background tab.** Double-click
       `appIdentity.ts` again (it is now a background tab behind
       `errors.ts`). Probe: `inEditor: true`.
     - **V8 — permanent open of a tab in the window.** Double-click
       `main.ts`. Probe: `inEditor: true`, `inTabWindow: true`.
     - **V9 — palette.** Open *View > Command Palette…*, type `EditorCon`,
       Enter. Probe: `inEditor: true`, and the `EditorController.ts` tab is
       active.
     - **V10 — New File.** *File > New File*. Probe: `inEditor: true`; type
       `x` and confirm `Untitled-1` shows the modified dot. Then *File > New
       File* again; `Untitled-2` opens in the same strip, because the dock
       adds a tab beside the one it last added.
     - **V11 — search result double-click.** In the Search view, double-click
       a `FILE_ICON_GLYPHS` match under `fileIcons.ts`. Probe:
       `inEditor: true`; the status bar's selection readout shows
       `16 selected`.
     - **V12 — dirty close.** Click `Untitled-1`'s tab, then its ✕, then
       *Don't Save*. Probe: `tag: 'BUTTON'`, `role: 'tab'`, on
       the strip's newly active tab.
  5. Stop the dev server and confirm `git status --short` is empty.

Saves are no-ops in the browser shell, so no case saves.

---

## Documentation Impact

- **README.md** — the four bullets in **Implementation**.
- **TODO.md** — no change. No entry covers Find… focus or the dock's focus.
- No public API changes. Loom has no `docs/` tree.

---

## Potential Challenges

- **`dist` lags the library's source.** Loom resolves the library through
  its `exports`, which point at `dist/`. Step 1's two greps catch a stale
  build; report it rather than building the library.
- **The palette hides with an animation.** `CommandPalette` closes with
  `hideAnimated()` after `onConfirmFile` runs. `PopupPanel` restores no
  focus on hide, so the editor focus from `focusEditor()` wins. If V9 still
  ends with focus on `<body>`, stop and report it as a library question; do
  not add a Loom-side delay.
- **A slow restore and an early click.** `restoreFiles` reads every file
  before it focuses the active editor. A user who clicks into the tree during
  a long restore has focus moved to the editor when it finishes. This
  matches every other editor's restore and is accepted.

---

## Critical Files

- [src/editor/editorSearch.ts](src/editor/editorSearch.ts) — the whole file;
  `revealRange` (:80) is the precedent for Part 1's wait.
- [src/editor/FileEditor.ts:251-282](src/editor/FileEditor.ts#L251) —
  `openFind`, `revealMatch`.
- [src/EditorController.ts](src/EditorController.ts) — `newFile` (:449),
  `openFile` (:489), `openFileAt` (:575), `addFileTab` (:595),
  `restoreFiles` (:649), `findInActive` (:1087), `closeTemporaryTab` (:1335),
  `confirmThenClose` (:1420), `handlePanelFocus` (:1458).
- [src/explorer/SearchPanel.ts:259](src/explorer/SearchPanel.ts#L259) —
  `focusQuery`, the precedent for `focusEditor`.
- [src/shell/EditorShell.ts:163-189, :344-365, :435](src/shell/EditorShell.ts#L163)
  — every `openFile`/`openFileAt`/`newFile` caller and the mode it passes.
- [src/explorer/FileTree.ts:114-131](src/explorer/FileTree.ts#L114) —
  `"selection"` → temporary, `"dblclick"` (also fired by Enter) → permanent.
- Library, under `/home/jika/typescript/typescript-ui/packages/lib/`:
  - `docs/reference/migration/next.md` and `docs/reference/changelog/next.md`
    — the focus rule, `openSearch`, `focusPanel({ focus })`, and the
    `restoreLayout` float `autoFocus` change.
  - `src/typescript/lib/overlay/Dock.ts:233` (`DockFocusPanelOptions`),
    `:2395` (`focusPanel`), `:654` (`addPanel`), `:2084` and `:2177` (where
    the dock's `"focus"` event comes from).
  - `src/typescript/lib/overlay/AbstractWindow.ts:986` (`bringToFront`) and
    `:1049` (`onActivate`, which emits `"activate"` with or without focus).
  - `src/typescript/lib/component/editor/CodeEditor.ts:1397` (`focus`) and
    `:2117` (`openSearch`).
  - `src/typescript/lib/core/Component.ts:8266` (`onFirstLayout`) and
    `:8425` (`afterNextLayout`).
- **Precedents:**
  [plans/implemented/typescript-ui-0-11-adoptions.md](plans/implemented/typescript-ui-0-11-adoptions.md)
  (adopting library APIs in parts, by-eye cases with a red baseline) and
  [plans/implemented/typescript-ui-0-11-bump.md](plans/implemented/typescript-ui-0-11-bump.md)
  (worktree installs).

---

## Non-Goals

- **Focus after a close from code.** Ctrl/Cmd+W on a clean tab, like the
  dirty-close case, leaves focus on the neighbouring tab button rather than
  in its editor. That is unchanged library behaviour for a close whose
  content held focus.
- **Keeping a float buried.** `{ focus: false }` still raises a floating window.
  Keeping a float buried while its tab is selected from the tree is not
  wanted.
- **Where new tabs open.** `Dock.addPanel` opens beside the group the user
  last activated, which can be a floating window after V4. Library
  behaviour, unchanged.
- **`Tree.moveNode`, `Dock.splitPanel`/`splitresize`, editor settings,
  clipboard, the muted text colour.** Sibling plans:
  `tree-move-on-rename.md`, `split-editor-and-layout-save.md`,
  `editor-settings.md`, `edit-clipboard-and-polish.md`.
- **The `package.json` range.** Stays `^0.11.0` until the library releases.

---

## Notes

[^linked-build]: The features this plan adopts exist only in the library's
    unreleased `master`, whose version string is still 0.11.0, so no
    published package has them. Loom's current code already typechecks and
    passes 549 tests against that checkout. The earlier bump plan's rule
    against linking was about linking the *main tree's* `node_modules` into a
    worktree, where an `npm install` would overwrite the main tree's link;
    this plan links only inside its own worktree, after its own `npm ci`.

[^find-before-mount]: `openSearch()` returns `false` and is not queued when
    the editor has not mounted. Three choices were considered. Doing nothing
    would make Find… silently fail in the frame or two between a file
    opening and its first layout. Always deferring, as `revealRange` does,
    would move focus one frame after the user's gesture even when the editor
    is ready. Trying now and waiting only on `false` opens the card at once
    in the normal case and still works in the rare one. `onFirstLayout` is the
    library's documented way to act on a component once it is mounted and
    sized, so this is ordinary use of the library, not a workaround. In
    practice the active file has nearly always laid out already, since it is
    the one showing.

[^codemirror-deps]: `git show 62e045b -- package.json` adds exactly these
    three packages, and `grep -rn "from '@codemirror" src tests browser-shell`
    finds only `editorSearch.ts`. Other mentions of `@codemirror/search` in
    `src/data/projectSearch.ts` and `src/explorer/SearchPanel.ts` are
    comments naming CodeMirror's conventions, not imports. An
    `npm uninstall --package-lock-only` of the three, tried on a copy of the
    lockfile, removes only the three root `dependencies` lines; the
    `node_modules/@codemirror/*` package entries stay, because
    `@jimka/typescript-ui` depends on all three.

[^focus-false-everywhere]: The library's default for `focusPanel` moves
    focus onto the panel's tab button when nothing holds focus or the strip
    already does, and into a floating window when its `autoFocus` is on —
    which it is for every torn-off window, and, since this release, for every
    window `restoreLayout` rebuilds. That default is what moved focus into
    the `TabWindow` while arrowing in the tree. For a permanent open, the
    default would also work, because `focusEditor()` moves focus afterwards,
    but it would first bounce focus to a tab button or window frame for a
    frame. Passing `{ focus: false }` everywhere gives one rule with no
    intermediate focus stop. Checked in the browser shell on library master
    before this plan: arrowing onto a torn-off file moved focus to the
    `TabWindow`'s dialog element.

[^focus-event-still-fires]: `Dock.focusPanel` calls the float's
    `bringToFront({ focus })` and the tab's `setActiveTabIndex(index, { focus })`.
    The dock's `"focus"` event comes from the tab's `"activate"`
    (`Dock.onPanelFocused`) and the window's `"activate"`
    (`Dock.onFloatActivated`). `AbstractWindow.onActivate` emits
    `"activate"` whether or not the raise takes focus; `_focusOnActivation`
    only decides whether it calls `takeFocus()`. So `_activePanelId` in
    `EditorController` updates exactly as before.

[^why-wait]: `CodeEditor.focus()` hands focus to the CodeMirror view when one
    exists, and otherwise focuses the host `<div>`, which is not focusable,
    so nothing happens. The view is built on the editor's first sized
    layout. `openFile` adds the tab and calls `focus()` in the same tick, so
    for a new tab the call has always done nothing; with the old library the
    tab button took focus instead, and with library master focus stays in
    the tree. A background tab's page is `display: none`, and focusing inside
    it also fails. Both were checked in the browser shell on library master
    before this plan: a double-click on an unopened file, and on a file open
    in a background tab, left focus in the tree. A double-click on the file
    already showing focused the editor.

[^close-paths]: Under the new rule a close from code moves focus to the
    neighbouring tab only when the closed tab or its content held focus.
    During a tree delete or a temp-tab recycle, focus is in the tree, so it
    now stays there, which is what a user arrowing through the tree wants.
    For the unsaved-changes prompt, Loom vetoes the strip's close and later
    calls `removePanel`, a close from code. The dialog hands focus back to
    the closing tab before that call, so the tab "held focus" and focus moves
    to the neighbour. Checked in the browser shell on library master: ✕ on a
    dirty tab, then *Don't Save*, ended on the neighbouring tab button.

[^no-unit-tests]: Extracting a helper such as `takesEditorFocus(mode)`
    would wrap `mode === 'permanent'`, and its test could not fail for any
    reason the by-eye cases would miss. The bugs this plan fixes are all
    about when the browser accepts focus (before mount, inside a hidden
    page, inside a raised window), which only a live DOM shows. V1, V4 and
    V6 are run red against the unmodified code in step 3, so each manual
    check is known to be able to fail.

---

## Implementation Notes

- **Suite size.** The plan expected 549 tests; the branch it is stacked on
  (`tree-move-on-rename`) had already raised the suite to 567. All 567 pass
  before and after, with no new tests, as the plan prescribed.
- **Line numbers.** Every edit site had drifted by about twelve lines after
  `tree-move-on-rename`; the code at each site was unchanged, so the edits
  went in as written.
- **Red baseline.** V1, V4 and V6 were run against the unmodified code on
  library master and all three failed as predicted: V1 left focus on the
  tree with the card open; V4 moved focus to the `TabWindow`'s dialog
  element; the double-click of V6 left focus on the tree.
- **V3.** Typing `>Find` in the palette lists *Find in Files…* first, so
  Enter alone runs project search. The check pressed ArrowDown once to reach
  *Find…*, then Enter; the result matched the plan.
- **V5 and V11 in the harness.** A search-result row is as wide as its
  longest line, so the devtools click, which lands on the row's centre, hit
  the editor beside the sidebar. Both cases were driven with a synthetic
  pointer and mouse sequence on the row's visible left edge instead. Every
  V1–V12 case then passed as the plan describes.
- **Launch restore (Expected Behaviour 7)** was not checked: the browser
  shell writes no session, and `npm run tauri:dev` cannot run in this
  sandbox. It remains a by-eye check under Tauri.
