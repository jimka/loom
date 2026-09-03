---
touches-shared: [src/data/workspace.ts, src/shell/EditorShell.ts, README.md, TODO.md]
---

# Drag-and-Drop to Open — Implementation Plan

## Overview

Loom opens a file or a project folder only through menu-driven dialogs and the
welcome screen today: the native folder picker in
[`src/EditorController.ts:188`](src/EditorController.ts#L188), a tree click in
[`src/shell/EditorShell.ts:73`](src/shell/EditorShell.ts#L73), and the Open
Recent entries in [`src/shell/EditorShell.ts:103`](src/shell/EditorShell.ts#L103).
This plan adds a second way in: dragging a file or folder from the OS file
manager onto the Loom window.

The drop arrives as a Tauri **window** event carrying real filesystem paths, not
as a DOM `drop` event.[^window-event] The subscription joins the app's other
window-event subscription, `onCloseRequested`, in
[`src/data/workspace.ts:254`](src/data/workspace.ts#L254) — the app's sole
`@tauri-apps` importer.[^boundary] Everything past that point routes into the
open-file and open-folder paths that already exist; no opening logic is
duplicated.

Two new frontend modules carry the feature — `src/shell/dropIntent.ts` (the pure
rule deciding what a set of dropped paths means) and `src/shell/fileDrop.ts`
(the wiring) — plus two additions to `src/data/workspace.ts`, and an import, a
method rename, and one registration call in `src/shell/EditorShell.ts`. No Rust, no
[`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json), and no
[`src-tauri/capabilities/default.json`](src-tauri/capabilities/default.json)
change.[^no-scope-change]

---

## Architecture Decisions

### Subscribe in `workspace.ts`, mirroring `onCloseRequested`

`src/data/workspace.ts` gains `onFilesDropped(handler)`, which subscribes to
`getCurrentWindow().onDragDropEvent` and invokes `handler` with the dropped
paths on a `'drop'` payload only. It has the same shape as `onCloseRequested`
at [`src/data/workspace.ts:254`](src/data/workspace.ts#L254): a
`void`-returning registration that swallows the subscribe promise and hands the
app a plain callback.[^boundary]

### Install the drop from `EditorShell`, mirroring `installAccelerators`

A new module `src/shell/fileDrop.ts` exports
`installFileDrop(actions: FileDropActions)`, called once from `EditorShell`'s
constructor beside `installAccelerators(actions)` at
[`src/shell/EditorShell.ts:133`](src/shell/EditorShell.ts#L133). `FileDropActions`
mirrors `AcceleratorActions` at
[`src/shell/shortcuts.ts:88`](src/shell/shortcuts.ts#L88): an interface of
callbacks that a global input source dispatches into.[^install-seam]

### The rule deciding what a drop means is its own pure module

`src/shell/dropIntent.ts` holds `dropIntent(items)`, which maps the dropped
paths (each already classified as file or folder) to one of four outcomes. The
module imports nothing from `@jimka/typescript-ui`, so `tests/dropIntent.test.ts`
can exercise it in vitest's `node` environment — the same split
`src/shell/welcomeText.ts` makes, for the same reason its header comment at
[`src/shell/welcomeText.ts:1`](src/shell/welcomeText.ts#L1) gives.[^pure-split]

### One folder, or any number of files — never both

A drop opens files **or** a folder, never a mix. Several files all open as tabs.
A single folder opens as the workspace. Several folders, or any mix of files and
folders, opens nothing and shows an error dialog saying why.[^one-folder]

| Dropped | Intent | Result |
|---|---|---|
| (empty) | `none` | nothing happens, no dialog |
| `notes.md` | `files` | opens as a tab |
| `a.ts`, `b.ts` | `files` | both open as tabs, `a.ts` first |
| `~/projects/app` | `folder` | opens as the workspace |
| `~/projects/app`, `~/projects/lib` | `unsupported` | error dialog, nothing opens |
| `a.ts`, `~/projects/app` | `unsupported` | error dialog, nothing opens |

### A dropped folder takes the Recent Projects route, prompts included

A dropped folder is handed to `EditorShell`'s existing
`handleOpenRecentProject`, renamed `confirmAndOpenProject` in this plan. That
method already answers the exact question a folder drop raises: with no
workspace open it opens straight away; a folder inside the open workspace gets
the three-way "open as its own workspace, or reveal it in the tree" prompt; a
folder outside it gets the "close the current workspace?" confirm.[^folder-route]

There is no unsaved-changes guard to mirror, because opening a folder never
discards a buffer. `EditorShell.openProjectRoot` at
[`src/shell/EditorShell.ts:169`](src/shell/EditorShell.ts#L169) repoints the tree
and leaves the tab strip untouched, so nothing dirty is at risk.

### A dropped file takes `EditorController.openFile` unchanged

Each dropped file goes to `controller.openFile(path)` — the same call the tree
click and the Open Recent file item already make. Its own behaviour carries over
untouched: a file already open just activates its tab, and a file that will not
read shows `Could not open file` with the underlying message.

### An unreadable dropped path is treated as a file

`workspace.ts` gains `isDirectory(path)`, which returns `false` when `stat`
rejects rather than throwing — the same swallow-and-degrade shape `pathExists`
uses at [`src/data/workspace.ts:150`](src/data/workspace.ts#L150). A path that
cannot be stat'd therefore classifies as a file and lands in `openFile`, which
reports it.[^stat-degrade]

### Nothing guards against a drag that started inside Loom

A drag that begins inside the app — reordering a tab, or anything in the file
tree — cannot reach this handler, so the plan adds no check for one.[^internal-drag]

---

## Public API

```ts
/** src/data/workspace.ts — new exports. */
export function onFilesDropped(handler: (paths: string[]) => void): void
export async function isDirectory(path: string): Promise<boolean>
```

```ts
/** src/shell/dropIntent.ts — new module. */
export interface DroppedPath {
    path: string
    isDir: boolean
}

export type DropIntent =
    | { kind: 'files', paths: string[] }
    | { kind: 'folder', path: string }
    | { kind: 'unsupported' }
    | { kind: 'none' }

export function dropIntent(items: DroppedPath[]): DropIntent
```

```ts
/** src/shell/fileDrop.ts — new module. */
export interface FileDropActions {
    onDropFile: (path: string) => Promise<void>
    onDropFolder: (path: string) => Promise<void>
}

export function installFileDrop(actions: FileDropActions): void
```

```ts
/** src/shell/EditorShell.ts — renamed from handleOpenRecentProject; body unchanged. */
private async confirmAndOpenProject(path: string): Promise<void>
```

---

## Internal Structure

### `dropIntent` (`src/shell/dropIntent.ts`)

```ts
export function dropIntent(items: DroppedPath[]): DropIntent {
    if (items.length === 0) {
        return { kind: 'none' }
    }

    const folders = items.filter(item => item.isDir)

    if (folders.length === 0) {
        return { kind: 'files', paths: items.map(item => item.path) }
    }

    if (items.length === 1 && folders.length === 1) {
        return { kind: 'folder', path: folders[0].path }
    }

    return { kind: 'unsupported' }
}
```

### `fileDrop.ts`

```ts
export function installFileDrop(actions: FileDropActions): void {
    onFilesDropped(paths => { void handleDrop(paths, actions) })
}

/** Classifies `paths`, then applies the intent they add up to. */
async function handleDrop(paths: string[], actions: FileDropActions): Promise<void> {
    const intent = dropIntent(await classifyDropped(paths))

    if (intent.kind === 'files') {
        for (const path of intent.paths) {
            await actions.onDropFile(path)
        }

        return
    }

    if (intent.kind === 'folder') {
        await actions.onDropFolder(intent.path)

        return
    }

    if (intent.kind === 'unsupported') {
        await Dialog.error(
            'Cannot open these items',
            'Loom opens one project folder at a time. Drop a single folder to open it as the project, or drop files to open them in tabs.',
        )
    }
}

/** Resolves each dropped path's file-or-folder kind, preserving drop order. */
async function classifyDropped(paths: string[]): Promise<DroppedPath[]> {
    return Promise.all(paths.map(async path => ({ path, isDir: await isDirectory(path) })))
}
```

The `for`/`await` loop over `intent.paths` is deliberate: opening files one at a
time keeps the tabs in drop order, and keeps the per-file error dialogs
`openFile` may raise from stacking on top of each other.

---

## Ordered Implementation Steps

1. **`src/data/workspace.ts`** — add `isDirectory` next to `pathExists`
   (after line 158):

   ```ts
   /**
    * Whether `path` names a directory. Swallows a `stat` rejection — a missing
    * path, or one outside the app's filesystem scope — resolving `false`
    * rather than throwing, so a caller classifying a dropped path treats an
    * unreadable one as a file and reports it through the normal open-file
    * error path.
    *
    * @param path - The path to check.
    * @returns Whether `path` is a directory.
    */
   export async function isDirectory(path: string): Promise<boolean> {
       try {
           return (await stat(path)).isDirectory
       } catch {
           return false
       }
   }
   ```

   `stat` is already imported on line 7 — add no imports.

2. **`src/data/workspace.ts`** — add `onFilesDropped` after `onCloseRequested`
   (end of file):

   ```ts
   /**
    * Registers `handler` to run whenever files or folders are dropped onto the
    * window from the OS. This is a window-level native event, not a DOM `drop`
    * event: the payload carries real filesystem paths, and it fires wherever in
    * the window the drop lands. Hover and cancel payloads are ignored — only a
    * completed drop reaches `handler`.
    *
    * @param handler - Called with the dropped paths, in the order the OS listed them.
    */
   export function onFilesDropped(handler: (paths: string[]) => void): void {
       void getCurrentWindow().onDragDropEvent(event => {
           if (event.payload.type === 'drop') {
               handler(event.payload.paths)
           }
       })
   }
   ```

   `getCurrentWindow` is already imported on line 8 — add no imports.

3. **Create `src/shell/dropIntent.ts`** with `DroppedPath`, `DropIntent`, and
   `dropIntent` exactly as `## Public API` and `## Internal Structure` give
   them. Open the file with a header comment recording why the module is
   separate — the same reason `src/shell/welcomeText.ts:1` gives: vitest runs in
   the `node` environment, and a module importing `@jimka/typescript-ui`
   components touches `document` at load time. Import nothing.

4. **Create `tests/dropIntent.test.ts`** covering the six unit-testable cases in
   `## Expected Behaviour`. Follow `tests/welcomeText.test.ts`'s shape:
   `import { describe, it, expect } from 'vitest'` and a relative import of
   `../src/shell/dropIntent`.

5. **`npm test`** — expect the new `dropIntent` tests green and the existing
   suite unchanged. This is the red-green point for the drop rule; every step
   after it is wiring that no test covers.

6. **Create `src/shell/fileDrop.ts`** with `FileDropActions`, `installFileDrop`,
   `handleDrop`, and `classifyDropped` as `## Internal Structure` gives them.
   Imports: `Dialog` from `@jimka/typescript-ui/overlay` (matching
   `src/shell/recentProjectPrompt.ts:1`), `onFilesDropped` and `isDirectory`
   from `../data/workspace`, and `dropIntent` plus the `DroppedPath` type from
   `./dropIntent`.

7. **`src/shell/EditorShell.ts`** — rename `handleOpenRecentProject` to
   `confirmAndOpenProject`. Three edits: the declaration at line 211, and the
   two call sites at lines 77 and 103. Update the method's JSDoc first sentence
   to name all three entry points — the welcome screen, the File > Open Recent
   submenu, and a folder dropped on the window — instead of Recent Projects
   alone. The body does not change.

8. **`src/shell/EditorShell.ts`** — add the import
   `import { installFileDrop } from './fileDrop'` beside the existing
   `./recentProjectPrompt` import (line 16), and register the drop immediately
   after the `installAccelerators(actions)` call that ends the constructor
   (line 133 before this step's import shifts it):

   ```ts
   installFileDrop({
       onDropFile: (path: string) => controller.openFile(path),
       onDropFolder: (path: string) => this.confirmAndOpenProject(path),
   })
   ```

9. **Check the Tauri boundary held.** `grep -rn '@tauri-apps' src/` — expect
   every hit in `src/data/workspace.ts` and nowhere else.
   `grep -rn 'onDragDropEvent' src/` — expect exactly one hit, in
   `src/data/workspace.ts`.

10. **Check the rename is complete.** `grep -rn 'handleOpenRecentProject' src/` —
    expect zero matches.

11. **`npm run typecheck`** — expect no errors.

12. **`TODO.md`** — delete two things. The one-line backlog item on line 26 of
    `## High`, which begins **Drag-and-drop to open**. And the two-line
    sub-bullet on lines 127–128 under `## Notes`, which begins "Native OS
    drag-and-drop" and exists only to point at the item line 26 held.

13. **`README.md`** — add the Highlights bullet described in
    `## Documentation Impact`, after the Recent Projects & Files bullet
    (lines 38–40).

14. **Run the manual checks** in `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `src/shell/dropIntent.ts` |
| Create | `src/shell/fileDrop.ts` |
| Create | `tests/dropIntent.test.ts` |
| Modify | `src/data/workspace.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### `dropIntent` — unit-testable (`tests/dropIntent.test.ts`)

1. **Nothing dropped.** `dropIntent([])` → `{ kind: 'none' }`.
2. **One file.** `dropIntent([{ path: '/p/a.ts', isDir: false }])` →
   `{ kind: 'files', paths: ['/p/a.ts'] }`.
3. **Several files keep their order.**
   `dropIntent([{ path: '/p/a.ts', isDir: false }, { path: '/p/b.ts', isDir: false }])`
   → `{ kind: 'files', paths: ['/p/a.ts', '/p/b.ts'] }`.
4. **One folder.** `dropIntent([{ path: '/p/app', isDir: true }])` →
   `{ kind: 'folder', path: '/p/app' }`.
5. **Several folders.** Two entries with `isDir: true` →
   `{ kind: 'unsupported' }`.
6. **A file and a folder.** One entry of each →
   `{ kind: 'unsupported' }`, whichever order they appear in.

### The drop itself — manual verification (`npm run tauri:dev`)

None of these is unit-testable: `src/data/workspace.ts` is the app's Tauri
boundary and carries no logic to test, and the event only exists inside a
running Tauri process with a real OS drag behind it. Drag each item from the
system file manager onto the Loom window.

7. **A file drops into a tab.** With no workspace open, drop a text file. It
   opens as a tab, and the editor deck replaces the welcome screen.
8. **A file already open just activates.** Drop a file that already has a tab.
   No second tab appears; the existing one becomes active.
9. **Several files all open.** Select three files and drop them together. Three
   tabs appear in the order the OS listed them, and the last one is active.
10. **A folder opens as the workspace, with nothing open.** Drop a project
    folder while no workspace is open. The tree points at it, the welcome
    screen's heading becomes the folder's name, and the folder appears under
    Recent Projects in the File menu.
11. **A folder outside the open workspace asks first.** With a workspace open,
    drop an unrelated folder. The `"…" is a separate workspace from "…". Open it
    and close the current workspace?` confirm appears. Cancel leaves the tree
    and tabs exactly as they were; confirming repoints the tree and leaves the
    open tabs in place.
12. **A folder inside the open workspace offers both readings.** Drop a
    subdirectory of the currently open workspace. The three-way `Open Recent`
    prompt appears. *Expose in Tree* selects that directory in the existing
    tree; *Open as Workspace* repoints the tree at it; *Cancel* changes nothing.
13. **Two folders are refused.** Drop two folders together. The
    `Cannot open these items` dialog appears and neither the tree nor the tabs
    change.
14. **A file and a folder together are refused.** Same dialog, same lack of
    change.
15. **A folder from outside `$HOME` opens to full depth.** Drop a project folder
    from outside the home directory. The tree lists it, and a file nested two or
    more levels down opens — Tauri's filesystem plugin grants the drop its own
    recursive scope.
16. **An unreadable path reports itself.** Drop a file the user cannot read. The
    familiar `Could not open file` dialog appears with the underlying message,
    and nothing opens.
17. **Where the drop lands does not matter.** Repeat case 7 dropping over the
    file tree, over the menu bar, and over the status bar. All three behave
    identically.
18. **In-app dragging is unaffected.** Drag a tab within the tab strip to
    reorder it. The reorder still works, and no drop dialog or tab-open occurs.

---

## Verification

- `npm run typecheck` — no errors.
- `npm test` — the new `tests/dropIntent.test.ts` cases 1–6 pass and the
  existing suite is unchanged.
- `grep -rn '@tauri-apps' src/` — every hit inside `src/data/workspace.ts`.
- `grep -rn 'onDragDropEvent' src/` — exactly one hit, in
  `src/data/workspace.ts`.
- `grep -rn 'handleOpenRecentProject' src/` — zero matches.
- `git diff src-tauri/` — empty. No Rust, config, or capability change belongs
  to this plan.
- `npm run tauri:dev`, then work through cases 7–18 of `## Expected Behaviour`,
  dragging from the system file manager onto the Loom window.

---

## Documentation Impact

- **`README.md`** — add a Highlights bullet after the Recent Projects & Files
  bullet (lines 38–40): dropping a file from the OS onto the window opens it in
  a tab, and dropping a single folder opens it as the project — the same prompts
  a Recent Projects entry raises when a workspace is already open.
- **`TODO.md`** — remove the **Drag-and-drop to open** item from `## High`
  (line 26), and the "Native OS drag-and-drop" sub-bullet under `## Notes`
  (lines 127–128) that exists only to reference it.

---

## Potential Challenges

- **A dropped folder that cannot be listed reports nothing.**
  `confirmAndOpenProject` ends at `EditorController.openRecentProject`
  ([`src/EditorController.ts:218`](src/EditorController.ts#L218)), which
  deliberately does not catch a failed listing — its own doc comment says so.
  Dropping an unreadable folder therefore leaves an unhandled rejection and no
  dialog. Mitigation: none here; this is the existing behaviour of every
  known-path folder open, and changing it means changing `openRecentProject`,
  which is out of scope (see `## Non-Goals`).
- **The scope grant for a dropped path lands on the Rust side, not in this
  code.** Tauri's filesystem plugin grants access to each dropped path when it
  handles the drop, which is what lets a folder from outside `$HOME` open; the
  frontend's first `stat` follows one IPC round-trip later. The two are not
  formally ordered against each other. Mitigation: case 15 of
  `## Expected Behaviour` is the check. If it fails, the symptom is specific and
  recognisable — a folder dropped from outside `$HOME` is misreported as an
  unopenable *file*, because `isDirectory` degrades a refused `stat` to `false`.
- **Two drops in quick succession run two independent flows.** Nothing
  serialises them, so a second drop while a prompt from the first is still up
  starts its own classification and its own prompt. Mitigation: none — menu
  actions have the same property today, and the prompts stack rather than
  corrupting state.
- **Dropping very many files opens very many tabs.** A drop of a hundred files
  opens a hundred tabs, one read at a time. Mitigation: none; see
  `## Non-Goals`.
- **The window gives no visual sign it accepts drops.** The `enter`/`over`
  payloads are ignored, so the cursor is the only feedback the OS provides.
  Mitigation: none in this plan; see `## Non-Goals`.

---

## Critical Files

- [`src/data/workspace.ts:243-260`](src/data/workspace.ts#L243) —
  `closeWindow`/`onCloseRequested`, the window-event subscription shape
  `onFilesDropped` copies. The module header (lines 1–5) states its role as the
  app's sole `@tauri-apps` importer.
- [`src/data/workspace.ts:142-158`](src/data/workspace.ts#L142) — `pathExists`,
  the swallow-a-`stat`-rejection shape `isDirectory` copies.
- [`src/shell/shortcuts.ts:87-143`](src/shell/shortcuts.ts#L87) —
  `AcceleratorActions` and `installAccelerators`, the actions-interface +
  install-function pair `fileDrop.ts` mirrors.
- [`src/shell/welcomeText.ts:1-6`](src/shell/welcomeText.ts#L1) — the header
  comment explaining why pure logic is split into its own module for testing.
- [`src/shell/EditorShell.ts:199-235`](src/shell/EditorShell.ts#L199) —
  `handleOpenRecentProject`, renamed and reused as the folder branch's target.
- [`src/shell/EditorShell.ts:155-180`](src/shell/EditorShell.ts#L155) —
  `openProjectRoot`; read to confirm a workspace switch leaves the open tabs
  alone, which is why no unsaved-changes guard is needed.
- [`src/EditorController.ts:258-292`](src/EditorController.ts#L258) — `openFile`,
  the file branch's target, including its own error reporting.
- [`src/EditorController.ts:208-223`](src/EditorController.ts#L208) —
  `openRecentProject`, which `confirmAndOpenProject` calls and which does not
  report a failed listing.
- [`src/shell/recentProjectPrompt.ts`](src/shell/recentProjectPrompt.ts) — the
  two prompts a dropped folder inherits, and the `Dialog` import style
  `fileDrop.ts` follows.
- [`tests/welcomeText.test.ts`](tests/welcomeText.test.ts) — the test file shape
  `tests/dropIntent.test.ts` follows.

---

## Non-Goals

- **Drag-over feedback.** No highlight, overlay, or cursor change while a drag
  hovers the window. Painting a highlight means a full-window overlay component
  driven by the `enter`/`over`/`leave` payloads, which is a UI feature of its
  own; the library's `FileDropZone` is built on the HTML5 drop API and never
  sees a native drag, so it cannot serve as one.
- **Per-region drop targeting.** Every drop means the same thing wherever in the
  window it lands. Region-specific meanings — dropping on a tree directory to
  copy a file into it, dropping on the tab strip to insert at a position — need
  filesystem-mutating operations Loom does not have.
- **Opening several folders at once.** Loom has one workspace and one window;
  multi-root workspaces and multi-window are both open backlog items in
  `TODO.md`.
- **Capping how many files one drop opens.** Nothing else in the app caps tab
  count — `EditorController.restoreFiles` reopens a whole saved session
  uncapped — and a cap would need a threshold with no principled value behind
  it.
- **Dropping text, a URL, or an image to insert it into the document.** The
  payload this plan reads is a path list; content drops are a CodeMirror-level
  concern.
- **Reporting a failed listing from `openRecentProject`.** That gap predates
  this plan and belongs to whichever change reworks `openRecentProject`'s error
  handling, alongside its Recent Projects caller.
- **Changing `dragDropEnabled`, the capability file, or any Rust.** All three
  are already correct for this feature.

---

## Notes

[^window-event]: Tauri's native drag-and-drop is a window event, not a DOM one.
    With `dragDropEnabled` left at its default of `true` — Loom's
    `src-tauri/tauri.conf.json` never sets it — the OS drag handler intercepts
    the drop before the webview sees it and Tauri emits `tauri://drag-drop`
    with a `paths: string[]` payload. `@tauri-apps/api` 2.11.1 wraps that as
    `onDragDropEvent`, on both `Webview` (`webview.d.ts:413`) and `Window`
    (`window.d.ts:1281`); the `Window` method is used here only because
    `getCurrentWindow` is already imported in `workspace.ts`, and both wrap the
    same three underlying events. The DOM route was rejected: an HTML5 `drop`
    yields `File` objects whose real filesystem path the webview cannot see, and
    that path is the whole point here. `dragDropEnabled: true` also suppresses
    HTML5 drag-and-drop inside the webview on Windows, so the DOM route would
    not fire there at all. The library's
    `FileDropZone` component is built on that same HTML5 `DataTransfer.files`
    API (its own remarks say so), so it cannot serve this feature either.

[^boundary]: `src/data/workspace.ts`'s header comment declares it the only
    module importing `@tauri-apps/*`, and `onCloseRequested` is the existing
    proof that a window-event subscription belongs there rather than in a shell
    module: it takes a plain handler, `void`s the promise the Tauri subscribe
    call returns, and exposes nothing Tauri-shaped to its caller.
    `onFilesDropped` is the same three properties. Filtering the payload down to
    `'drop'` inside `workspace.ts` keeps `DragDropEvent`'s four-variant union
    from leaking into the shell, matching how `onCloseRequested` keeps
    `CloseRequestedEvent` and its `preventDefault()` inside the module.

[^install-seam]: `EditorController` registers `onCloseRequested`, so it is the
    obvious first candidate. It was rejected because the folder branch needs
    `EditorShell.confirmAndOpenProject`, which the controller cannot reach — the
    controller has no reference to the shell, only the listener callbacks the
    shell injects into it. Adding a fourth injected listener for this would
    widen `EditorController`'s API for one call site. `EditorShell` already
    reaches both branches: `controller.openFile` for the file case and its own
    private method for the folder case. `installAccelerators` establishes the
    shape — a `src/shell/` module that subscribes to a global input source and
    dispatches into an actions interface, installed once from the constructor —
    and `installFileDrop` copies it. The one deliberate deviation is that
    `FileDropActions`' callbacks return `Promise<void>` where
    `AcceleratorActions`' return `void`: the drop handler awaits each file open
    so tabs land in drop order.

[^pure-split]: `vitest.config.ts` runs the suite in the `node` environment with
    no DOM, and every test in `tests/` covers a module that imports no
    `@jimka/typescript-ui` component. `src/shell/welcomeText.ts` was split out of
    `WelcomeScreen.ts` for exactly this reason and says so in its header
    comment. Keeping `dropIntent` in `fileDrop.ts` — which must import `Dialog`
    to report an unsupported drop — would make the rule untestable, and the rule
    is the only part of this feature that has cases worth pinning.

[^folder-route]: Three routes were available for a dropped folder.
    `EditorController.openProjectFolder` was rejected outright: it shows the
    native picker, which a drop has already replaced.
    `EditorController.openRecentProject` opens a known path with no questions
    asked, and was rejected because a drop is far easier to trigger by accident
    than a picker confirmation, and because it would silently replace a
    workspace whose tree the user was still using.
    `EditorShell.handleOpenRecentProject` is the codebase's only existing answer
    to "open a folder whose path is already known, when a workspace may already
    be open", and its two prompts were written for precisely the two cases a
    drop raises — a folder inside the open workspace is ambiguous between
    opening and revealing, and a folder outside it can only mean replacement.
    Reusing that method also means a dropped folder and a Recent Projects click
    can never drift apart. The remaining asymmetry is that *File > Open Folder…*
    still replaces the workspace with no confirm; that is left alone because the
    picker interposes a native dialog the user must navigate and accept, which
    is the deliberateness the drop lacks.

[^one-folder]: Three rules were considered for a mixed or multi-folder drop.
    Opening the files and silently ignoring the folders leaves the user with no
    explanation for the part that did nothing. Taking the first folder and
    ignoring the rest picks arbitrarily between items the user selected
    together. Refusing with a dialog is the only one that stays honest about
    Loom's actual constraint — one workspace, one window, both recorded in
    `TODO.md`'s Low backlog — and it costs nothing to relax later if
    multi-window lands. Several *files* are not refused because opening many
    tabs is a real capability the app already has: `restoreFiles` does it on
    every launch.

[^internal-drag]: Two conditions would have to hold for an in-app drag to reach
    the handler, and neither does. First, `tauri://drag-drop` is raised by the
    OS window's drag-drop handler and fires only for a drag carrying filesystem
    paths from outside the process; an in-page pointer drag never enters that
    protocol. Second, the app's only in-page drag is the tab strip's reorder,
    and `@jimka/typescript-ui`'s `TabBar` implements it with `mousedown`-based
    tracking, not the HTML5 drag API — the string `draggable` appears in that
    file only inside a comment. `Tree` has no drag support at all, so the file
    tree cannot start one either. A guard would therefore be dead code, and the
    manual check (case 18) exists to confirm the reasoning rather than to
    exercise a code path.

[^stat-degrade]: The alternative — letting `isDirectory` throw and catching it
    in `fileDrop.ts` — would need its own error dialog and its own copy of
    `EditorController`'s private `messageOf` helper, to say something less
    useful than what `openFile` already says. Degrading to `false` routes the
    path into `openFile`, which reports the real underlying reason through the
    dialog the user already knows from clicking an unreadable file in the tree.
    The cost is that an unreadable *folder* is reported as `Could not open file`
    rather than as a folder; that is a rare wording imprecision, not a wrong
    outcome.

[^no-scope-change]: Three things that look like they need configuring do not.
    `dragDropEnabled` defaults to `true` in Tauri's window config, and
    `src-tauri/tauri.conf.json` does not override it, so the event already
    fires. Listening needs `core:event:allow-listen`, which `core:default` —
    already the first entry in `src-tauri/capabilities/default.json` — pulls in
    via every core plugin's own default set. And filesystem access to a dropped
    path outside `$HOME/**` is granted automatically: `tauri-plugin-fs` 2.5.2,
    the version pinned in `src-tauri/Cargo.lock`, handles
    `WindowEvent::DragDrop(DragDropEvent::Drop)` in its `on_event` hook
    (`src/lib.rs:517-528`) by calling `scope.allow_file(path)` for each dropped
    file and `scope.allow_directory(path, true)` for each dropped directory —
    the same recursive runtime grant the folder picker's `recursive: true`
    obtains, which `plans/implemented/open-outside-home.md` documents. Case 15
    of `## Expected Behaviour` is what confirms the grant lands before the
    frontend's first `stat`.
