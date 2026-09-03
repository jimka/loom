---
depends-on: [file-editor-dirty-state-adoption]
touches-shared: [src/EditorController.ts, src/editor/FileEditor.ts, src/explorer/FileTree.ts, src/shell/EditorShell.ts, README.md, TODO.md]
---

# Temp Tabs — Implementation Plan

## Overview

Every file opened from the tree gets a permanent tab today. `FileTree`
listens to one event, `"selection"`, and calls
`onOpenFile(path)` ([src/explorer/FileTree.ts:56-66](src/explorer/FileTree.ts#L56)),
which `EditorShell` wires straight to `controller.openFile(path)`
([src/shell/EditorShell.ts:73](src/shell/EditorShell.ts#L73)). Browsing ten
files leaves ten tabs.

This plan adds the editor "preview tab" pattern under the name Loom's backlog
already uses for it, **temp tabs** ([TODO.md:15-18](TODO.md#L15)). At most one
open file is marked *temporary*; a lightweight open recycles that one tab
instead of adding another. The tab becomes permanent — *pinned* — the moment
the user edits the file or double-clicks its row in the tree.

Three things change. `FileEditor` gains a `_temporary` flag that `getLabel()`
folds into the tab label, beside the `" •"` dirty marker it already renders
([src/editor/FileEditor.ts:241-244](src/editor/FileEditor.ts#L241)).
`EditorController.openFile` grows a second parameter saying which kind of tab
the caller wants, and owns the recycling and pinning.
`FileTree` grows a second callback, fed by the library's existing
`"dblclick"` event ([Tree.ts:556](node_modules/@jimka/typescript-ui/src/typescript/lib/component/tree/Tree.ts#L556)),
so the shell can map single-click and double-click to different open modes.

---

## Architecture Decisions

### A temp open builds a new tab; it does not repoint the old one

Recycling the temp tab means closing it with `Tab.closeTab`
([Tab.ts:1208](node_modules/@jimka/typescript-ui/src/typescript/lib/layout/Tab.ts#L1208))
and adding a fresh tab for the newly opened file — one `FileEditor` per file,
exactly as today. The alternative, keeping one `FileEditor` and pushing a new
document into it, is not viable: `CodeEditor` installs CodeMirror's `history()`
extension and exposes no way to clear it, so the previous file's text would sit
in the new file's undo stack.[^why-new-tab]

### "Temporary" is a flag on the `FileEditor`, not a separate registry

`FileEditor` holds `_temporary` and answers `isTemporary()`;
`EditorController` finds the temp tab with
`this._openFiles.find(file => file.isTemporary())`. There is no `_tempFile`
field on the controller to keep in step.[^flag-not-field]

### One entry point: `openFile(path, mode)`

`EditorController.openFile` takes a second parameter,
`mode: OpenMode` (`'temporary' | 'permanent'`), defaulting to `'permanent'`.
Every file-opening surface goes through it — the tree's single click passes
`'temporary'`, the tree's double click and the File menu's *Open Recent* pass
`'permanent'`.[^one-entry-point]

### A permanent open never recycles the temp tab

Only a `'temporary'` open closes the existing temp tab. A `'permanent'` open
adds its own tab and leaves the temp tab where it is.[^permanent-leaves-temp]

| Gesture | Call | Strip before | Strip after |
|---|---|---|---|
| single-click `a.ts` | `openFile('a.ts', 'temporary')` | `b.ts` | `b.ts`, `~a.ts` |
| single-click `c.ts` | `openFile('c.ts', 'temporary')` | `b.ts`, `~a.ts` | `b.ts`, `~c.ts` |
| double-click `c.ts` | `openFile('c.ts', 'permanent')` | `b.ts`, `~c.ts` | `b.ts`, `c.ts` |
| double-click `e.ts` | click 1 `'temporary'`, then `'permanent'` | `b.ts`, `~c.ts` | `b.ts`, `e.ts` |
| type in the `~c.ts` tab | — (dirty listener pins it) | `b.ts`, `~c.ts` | `b.ts`, `c.ts •` |
| *Open Recent* `d.ts` | `openFile('d.ts')` | `b.ts`, `~c.ts` | `b.ts`, `~c.ts`, `d.ts` |

The fourth row is the composite the tree actually produces for a double-click
on a file that was not already showing: the first click of the pair opens
`e.ts` into the temp slot (discarding `~c.ts`), then `"dblclick"` pins it.

### Editing pins the tab through the inherited dirty listener

`EditorController.handleDirtyChange` already runs on every open file's
`Component` dirty-state change ([src/EditorController.ts:535-539](src/EditorController.ts#L535)).
Pinning on edit is one `if` at the top of that handler. No second notion of
"changed" is introduced.[^dirty-is-the-signal]

### The tree reports gestures; the shell maps them to modes

`FileTreeParams` carries two callbacks: `onSelectFile` (fired from
`"selection"`) and `onOpenFile` (fired from `"dblclick"`). `FileTree` stays
free of the `OpenMode` vocabulary; `EditorShell` binds each to the matching
`openFile` call.[^tree-stays-dumb]

### A temp tab is marked with a `~` prefix on its label

`FileEditor.getLabel()` returns `~README.md` while the tab is temporary. The
mark is a prefix, not a suffix like the dirty `" •"`, because the strip caps a
tab at 200px and ellipsises the label's tail.[^tilde-prefix]

| File state | Label |
|---|---|
| temp tab showing `README.md` | `~README.md` |
| pinned, saved | `README.md` |
| pinned, unsaved edits | `README.md •` |

The two marks never appear together: the first edit pins the tab, so a
temporary file is always clean.

### The code says *temporary*, never *preview*

`FileEditor` already uses `preview`/`_previewing` for the Markdown preview
toggle ([src/editor/FileEditor.ts:118-132](src/editor/FileEditor.ts#L118)), so
every name this plan introduces says *temporary*, *temp tab*, or *pin*
instead — fields, methods, `OpenMode`'s members, and the README wording alike.

### No new automated tests

Loom's vitest suite runs in the `node` environment over pure data helpers and
never constructs a component; `vitest.config.ts` records that "component/DOM
behaviour is verified live, not here". This change is entirely component and
event behaviour, so it is verified by typecheck, greps, and the manual cases
in **Expected Behaviour** — the same call
`plans/implemented/file-editor-dirty-state-adoption.md` made.

---

## Public API

```typescript
// src/EditorController.ts

/** How an {@link EditorController.openFile} request should treat the tab it lands in. */
export type OpenMode = 'temporary' | 'permanent'

class EditorController {
    /**
     * Opens `path`. `'temporary'` recycles the strip's one temp tab;
     * `'permanent'` gets a tab of its own. Defaults to `'permanent'`.
     */
    async openFile(path: string, mode?: OpenMode): Promise<void>

    // Unchanged: newFile, restoreFiles, saveActive, saveActiveAs, saveAs, save,
    // closeActive, formatActive, exitApp, and every listener setter.
}
```

```typescript
// src/editor/FileEditor.ts

class FileEditor extends Container {
    /** Whether this file occupies the strip's temp tab — the one a temporary open recycles. */
    isTemporary(): boolean

    /** Marks this file as the temp tab's content, or pins it. The owner relabels the tab. */
    setTemporary(value: boolean): void

    /** The tab label: `"~name"` while temporary, `"name •"` while dirty, `"name"` otherwise. */
    getLabel(): string
}
```

```typescript
// src/explorer/FileTree.ts

export interface FileTreeParams {
    /** Invoked with a file's path when a file row is selected — a single click or an arrow-key move. */
    onSelectFile: (path: string) => void
    /** Invoked with a file's path when a file row is double-clicked. */
    onOpenFile: (path: string) => void
}
```

### For the follow-on command palette

The Ctrl+P fuzzy file finder on the backlog ([TODO.md:19-22](TODO.md#L19))
reuses temp-tab semantics by calling the same method, with no code of its own:

- **Enter on a result** — `void controller.openFile(path)` (permanent, the
  default).
- **Arrowing through results, if the palette wants to show each one as it is
  highlighted** — `void controller.openFile(path, 'temporary')`, which recycles
  the same one tab the tree recycles.

`openFile` is safe to call repeatedly with the same path while an earlier call
is still reading from disk: the second call joins the first rather than opening
a second tab, and a `'permanent'` request upgrades an in-flight `'temporary'`
one.[^pending-opens]

---

## Internal Structure

`EditorController`'s new field, beside `_openFiles`:

```typescript
/**
 * Paths whose disk read is in flight, mapped to the mode their tab will get.
 * A second request for the same path joins the entry instead of starting a
 * second read, and a `'permanent'` request upgrades a `'temporary'` one — so
 * the tree's click-then-double-click pair produces exactly one, pinned, tab
 * however the read and the double-click interleave.
 */
private readonly _pendingOpens: Map<string, OpenMode> = new Map()
```

`openFile` in full:

```typescript
async openFile(path: string, mode: OpenMode = 'permanent'): Promise<void> {
    const existing = this._openFiles.find(candidate => candidate.getPath() === path)

    if (existing) {
        if (mode === 'permanent') {
            this.recordRecentFile(path)
            this.pinTab(existing)
        }

        this.tabs.getTab().setActiveContent(existing)

        return
    }

    const pending = this._pendingOpens.get(path)

    if (pending !== undefined) {
        if (mode === 'permanent') {
            this._pendingOpens.set(path, 'permanent')
        }

        return
    }

    this._pendingOpens.set(path, mode)

    let text: string

    try {
        text = await readFileText(path)
    } catch (error) {
        this._pendingOpens.delete(path)
        await Dialog.error('Could not open file', messageOf(error))

        return
    }

    const settled = this._pendingOpens.get(path) ?? mode

    this._pendingOpens.delete(path)

    if (settled === 'temporary') {
        this.closeTemporaryTab()
    } else {
        this.recordRecentFile(path)
    }

    const file = this.addFileTab(path, text, settled === 'temporary')

    this.tabs.getTab().setActiveContent(file)
    this.syncActive()
}
```

The two new private helpers:

```typescript
/**
 * Pins `file`'s tab, so a later temporary open leaves it alone, and records it
 * in the recent-files list — reaching this point means the user did something
 * deliberate with the file. A no-op on an already-pinned tab.
 *
 * @param file - The open file whose tab to pin.
 */
private pinTab(file: FileEditor): void {
    if (!file.isTemporary()) {
        return
    }

    const path = file.getPath()

    file.setTemporary(false)

    if (path !== null) {
        this.recordRecentFile(path)
    }

    this.tabs.getTab().setTabName(file, file.getLabel())
}

/**
 * Closes the temp tab, if the strip has one. `Tab.closeTab` is the unguarded
 * programmatic path, which is safe here precisely because a temp tab is always
 * clean — the first edit pins it — so there is never anything to prompt about.
 */
private closeTemporaryTab(): void {
    const temporary = this._openFiles.find(file => file.isTemporary())

    if (temporary) {
        this.tabs.getTab().closeTab(temporary)
    }
}
```

`addFileTab` takes the flag and sets it before `addTab`, so the label the tab is
built with already carries the `~`:

```typescript
private addFileTab(path: string, text: string, temporary: boolean = false): FileEditor {
    const file = FileEditor({ path, name: baseName(path), text, projectRoot: this._projectRoot })

    file.setTemporary(temporary)
    file.onDirtyChange(() => this.handleDirtyChange(file))
    this.tabs.addTab(file, file.getLabel(), { closeable: true, glyph: glyphNameForPath(path) })
    this._openFiles.push(file)

    return file
}
```

`handleDirtyChange` gains the pin:

```typescript
private handleDirtyChange = (file: FileEditor): void => {
    if (file.isDirty()) {
        this.pinTab(file)
    }

    this.tabs.getTab().setTabName(file, file.getLabel())
    this.syncActive()
}
```

`FileEditor`'s new members and the rewritten `getLabel`:

```typescript
/** The label prefix marking a temp tab. A prefix, not a suffix like the dirty
 *  `" •"`: the tab strip caps a tab's width (`TAB_MAX_WIDTH`, in
 *  `EditorController`) and ellipsises the label's tail, so a long file name
 *  would swallow a trailing mark. */
const TEMPORARY_LABEL_PREFIX: string = '~'

/** Whether this file occupies the strip's temp tab — the one a temporary open recycles. */
isTemporary(): boolean {
    return this._temporary
}

/**
 * Marks this file as the temp tab's content, or pins it. Changing the flag
 * changes {@link getLabel}, so the owner relabels the tab afterwards.
 *
 * @param value - Whether this file is the temp tab's content.
 */
setTemporary(value: boolean): void {
    this._temporary = value
}

/**
 * The tab label: the display name, prefixed with `"~"` while the tab is
 * temporary and suffixed with `" •"` while the document is dirty. The two
 * marks never appear together — the first edit pins a temp tab, so a
 * temporary file is always clean.
 */
getLabel(): string {
    if (this._temporary) {
        return `${TEMPORARY_LABEL_PREFIX}${this._name}`
    }

    return this.isDirty() ? `${this._name} •` : this._name
}
```

`FileTree`'s two handlers:

```typescript
/** `"selection"`: browses the selected node's file in the temp tab; a directory selection opens nothing. */
private handleSelection = (nodes: TreeNode[]): void => {
    const data = nodes[0]?.data as FileTreeNodeData | undefined

    if (data && !data.isDir) {
        this._onSelectFile(data.path)
    }
}

/** `"dblclick"`: opens the node's file for keeps; a directory double-click opens nothing. */
private handleDblClick = (node: TreeNode): void => {
    const data = node.data as FileTreeNodeData | undefined

    if (data && !data.isDir) {
        this._onOpenFile(data.path)
    }
}
```

---

## Ordered Implementation Steps

The tree does not typecheck throughout: step 7's `openFile` calls two helpers
step 9 adds, and step 12 changes a `FileTreeParams` shape step 13 rewires. Do
not stop to investigate an error before step 14, the first checkpoint.

1. **[src/editor/FileEditor.ts](src/editor/FileEditor.ts)** — add the
   `TEMPORARY_LABEL_PREFIX` constant with its doc comment (from **Internal
   Structure**) immediately after `PREVIEW_LABEL`
   ([:26](src/editor/FileEditor.ts#L26)).

2. **Same file** — add `private _temporary: boolean = false` immediately after
   `private _name: string` ([:53](src/editor/FileEditor.ts#L53)), keeping the
   mutable per-file state together.

3. **Same file** — add `isTemporary()` and `setTemporary()` immediately before
   `getLabel()` ([:241](src/editor/FileEditor.ts#L241)), and replace
   `getLabel()` and its doc comment with the version in **Internal Structure**.

4. **Same file** — extend the class JSDoc
   ([:40-50](src/editor/FileEditor.ts#L40)) with a sentence saying that a file
   may occupy the strip's one temp tab, that `getLabel()` marks it, and that
   the flag is set by `EditorController`, which owns the "at most one" rule.

5. **[src/EditorController.ts](src/EditorController.ts)** — add the exported
   `OpenMode` type with its doc comment immediately after the
   `SAVE_MESSAGE_DURATION_MS` constant ([:24](src/EditorController.ts#L24)).

6. **Same file** — add the `_pendingOpens` field with its doc comment (from
   **Internal Structure**) immediately after `_openFiles`
   ([:36](src/EditorController.ts#L36)).

7. **Same file** — replace `openFile` and its doc comment
   ([:258-292](src/EditorController.ts#L258)) with the version in **Internal
   Structure**. The doc comment must say what `mode` does and that a repeat
   call for a path already being read joins the first call.

8. **Same file** — add the `temporary` parameter to `addFileTab`
   ([:304](src/EditorController.ts#L304)) and the `file.setTemporary(temporary)`
   line before `file.onDirtyChange(...)`, per **Internal Structure**. Extend its
   doc comment with an `@param temporary` line. `restoreFiles`
   ([:365](src/EditorController.ts#L365)) calls it with two arguments and needs
   no edit — a restored tab is permanent.

9. **Same file** — add the `pinTab` and `closeTemporaryTab` private methods
   from **Internal Structure**, immediately after `getActiveFile()`
   ([:528-533](src/EditorController.ts#L528)) and before `handleDirtyChange`.

10. **Same file** — add the `if (file.isDirty()) { this.pinTab(file) }` block at
    the top of `handleDirtyChange` ([:536-539](src/EditorController.ts#L536)),
    and update its one-line doc comment to say it also pins a temp tab on the
    file's first edit. Leave the two following lines alone.

11. **Same file** — in `saveAs`, add `this.pinTab(file)` on the line
    immediately after `file.markClean()`
    ([:429](src/EditorController.ts#L429)). Do not remove or reorder anything
    else in that method; in particular keep the `setPath` → `markClean` order
    and the `setTabName` call at [:431](src/EditorController.ts#L431).

12. **[src/explorer/FileTree.ts](src/explorer/FileTree.ts)** — replace the
    single `onOpenFile` entry in `FileTreeParams`
    ([:21-24](src/explorer/FileTree.ts#L21)) with the two-callback version in
    **Public API**; rename the `_onOpenFile` field
    ([:31](src/explorer/FileTree.ts#L31)) to `_onSelectFile` and add
    `_onOpenFile` beside it, both `private readonly` with the same
    `(path: string) => void` type; assign both in the constructor
    ([:46](src/explorer/FileTree.ts#L46)); add
    `this.on('dblclick', this.handleDblClick)` immediately after the existing
    `this.on('selection', ...)` line ([:56](src/explorer/FileTree.ts#L56)); and
    replace `handleSelection` and add `handleDblClick` per **Internal
    Structure**.

13. **[src/shell/EditorShell.ts](src/shell/EditorShell.ts)** — replace the
    `FileTree({...})` call at [:73](src/shell/EditorShell.ts#L73) with:

    ```typescript
    const tree = FileTree({
        onSelectFile: (path: string) => { void controller.openFile(path, 'temporary') },
        onOpenFile:   (path: string) => { void controller.openFile(path, 'permanent') },
    })
    ```

    Leave `onOpenRecentFile` at [:104](src/shell/EditorShell.ts#L104)
    unchanged — it takes `openFile`'s `'permanent'` default.

14. Checks:
    - `npm run typecheck` — clean.
    - `grep -rn 'onOpenFile' src/` — five matches: four in
      `src/explorer/FileTree.ts` (the `FileTreeParams` field, the private
      field, the constructor assignment, and the `handleDblClick` call) and one
      in `src/shell/EditorShell.ts`. None in `src/EditorController.ts`.
    - `grep -rln 'isTemporary\|setTemporary' src/` — exactly two files,
      `src/editor/FileEditor.ts` and `src/EditorController.ts`.
    - `grep -rln 'dblclick' src/` — exactly one file,
      `src/explorer/FileTree.ts`.
    - `grep -rn '_tempFile\|previewTab' src/` — zero matches; the flag lives on
      `FileEditor`, and "preview" stays the Markdown feature's word.

15. **[README.md](README.md)** — extend the *File tree* bullet
    ([:17-23](README.md#L17)) with a sentence saying a single click opens a file
    in a reusable temp tab and a double click opens it permanently, and the
    *Tabbed editing* bullet ([:24-27](README.md#L24)) with a sentence saying a
    temp tab shows a `~` before its name and becomes permanent on the first
    edit, on a double-click in the tree, or on a *Save As*.

16. **[TODO.md](TODO.md)** — delete the **Temp tabs** bullet
    ([:15-18](TODO.md#L15)), this plan's own backlog entry. Immediately after
    the **Library `Tab.setTabGlyph` / `TabBar.setEntryGlyph`** bullet
    ([:27-31](TODO.md#L27)), add a **Library per-tab label styling** bullet:
    `Tab.setTabName` sets a tab's text but nothing styles it, and `Tab` keeps
    its `TabBar` private, so Loom marks a temp tab with a `~` prefix instead of
    the italics VS Code uses. Change nothing else in the file.

17. Run `npm run typecheck && npm test && npm run build` — all clean; no test
    file changes, so the suite must be green unchanged.

18. Run the manual cases in **Expected Behaviour**.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src/editor/FileEditor.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `src/explorer/FileTree.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

Every case is **manual verification** in the Tauri window
(`npm run tauri:dev`), per the *No new automated tests* decision. Open a project
folder holding at least four files, of at least two different types, none of
them opened earlier in the same session.

1. **A single click opens a temp tab.** Click `a.ts` in the tree: one tab
   appears, labelled `~a.ts`, carrying the same icon the tree shows for it, and
   it is active.
2. **A second single click reuses it.** Click `b.md`: the strip still has one
   tab, now labelled `~b.md` and carrying `b.md`'s own icon, not `a.ts`'s. The
   `a.ts` tab is gone.
3. **Ten clicks leave one tab.** Click through every file in a directory: the
   strip never holds more than one temp tab.
4. **Arrow-key navigation recycles the same tab.** With the tree focused, move
   the selection with ↑/↓: each file row lands in the same one temp tab.
5. **Typing pins the tab.** With `~b.md` showing, type one character: the label
   becomes `b.md •` — the `~` is gone and the dirty dot has appeared. Click
   `a.ts` in the tree: a *new* temp tab `~a.ts` appears and `b.md •` stays.
6. **A double-click pins the tab.** Double-click `c.ts` in the tree: the strip
   ends with one tab labelled `c.ts`, no `~`. Then click `a.ts`: a new `~a.ts`
   tab appears beside it.
7. **Double-clicking the file already in the temp tab pins that tab.** Click
   `d.json` (tab reads `~d.json`), then double-click the same row: the label
   becomes `d.json`, and no second tab appears.
8. **A permanent open leaves the temp tab alone.** With `~a.ts` showing, use
   *File > Open Recent* to reopen a file: a second tab is added and `~a.ts`
   stays.
9. **Opening an already-open permanent file does not make it temporary.** With
   `b.md` pinned, single-click `b.md` in the tree: its tab activates, keeps its
   plain label, and any other temp tab is untouched.
10. **Undo does not un-pin.** Type in a temp tab (it pins), then Ctrl+Z back to
    the file as opened: the dirty dot clears, the `~` does not come back, and a
    later single-click elsewhere opens a new temp tab rather than replacing it.
11. **Format pins the tab.** *Edit > Format Document* on a temp tab that the
    format actually changes: the tab pins and shows the dirty dot.
12. **Save As pins the tab.** With a temp tab active, *File > Save As…* to a
    new name: the tab is relabelled to the new base name with no `~`.
13. **Closing a temp tab prompts nothing and frees the slot.** Click the temp
    tab's ✕: it closes with no unsaved-changes prompt, and the next single
    click in the tree opens a fresh temp tab.
14. **Recycling never prompts.** Rapid-click five files in a row: no dialog
    appears at any point.
15. **The last tab recycling shows no welcome-screen flash.** With the temp tab
    as the only open tab, single-click another file: the tab strip stays on
    screen throughout; the *Open Folder…* welcome page must not appear even for
    a frame.
16. **The temp tab moves to the end of the strip when recycled.** With tabs
    `x.ts`, `~a.ts`, `y.ts` (open `x.ts` and `y.ts` permanently around a temp
    open), single-click `z.ts`: the strip reads `x.ts`, `y.ts`, `~z.ts`. This
    is intended, not a bug.
17. **A temp tab restores as a permanent tab.** With a temp tab open, exit and
    relaunch: the file comes back as a normal tab with no `~`.
18. **Browsing does not fill Recent Files.** Note what *File > Open Recent*
    lists, then single-click through four files that are not on that list,
    editing none of them: the menu still lists exactly what it listed before.
    Double-click one of the four and reopen the menu: that one is now listed.
19. **A directory row opens nothing.** Single-click and double-click a
    directory row: no tab is added or recycled; the double-click leaves the
    directory's expansion as the two single clicks left it.
20. **A missing file still errors cleanly.** Delete a file outside the app,
    then single-click its stale tree row: the *Could not open file* dialog
    appears and the existing temp tab is left open and unchanged.
21. **Markdown preview still works in a temp tab.** Single-click a `.md` file
    and toggle its preview: the rendered view appears. Single-click another
    file: the temp tab is recycled with no error in the console.
22. **New File is never temporary.** *File > New File* while a temp tab is
    open: the untitled tab is added beside it with no `~`, and the temp tab
    stays.

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — clean; no test file changes, so the suite must be green
  unchanged.
- `npm run build` — clean.
- `grep -rn 'onOpenFile' src/` — five matches, in `src/explorer/FileTree.ts`
  (four) and `src/shell/EditorShell.ts` (one) only.
- `grep -rln 'isTemporary\|setTemporary' src/` — exactly two files,
  `src/editor/FileEditor.ts` and `src/EditorController.ts`.
- `grep -rn '_tempFile\|previewTab' src/` — zero matches.
- `grep -n "mode: OpenMode = 'permanent'" src/EditorController.ts` — exactly
  one match, `openFile`'s signature.
- `grep -rln "dblclick" src/` — exactly one file, `src/explorer/FileTree.ts`.
- `git diff --name-only` — exactly the six files in the table above.
- `git diff src/data/ src/shell/session.ts src/editor/FileBreadcrumbs.ts` —
  empty.
- Manual: `npm run tauri:dev`, then cases 1-22 above in the app window.

---

## Documentation Impact

- **[README.md](README.md)** — the *File tree* and *Tabbed editing* bullets both
  describe user-visible behaviour this plan changes; step 15 updates them. No
  other bullet mentions how a file gets opened.
- **[TODO.md](TODO.md)** — the **Temp tabs** entry under `## High` is this
  plan's own backlog entry and is deleted, matching how Loom retires a TODO
  entry when its feature lands (commit `3e7329a`, *Document the breadcrumb band
  and retire its TODO entry*). `## High` keeps its other bullets, so no heading
  is removed. A new **Library per-tab label styling** bullet records the library
  gap that keeps the `~` marker in place of italics, beside the existing
  `Tab.setTabGlyph` entry that records the analogous glyph gap.
- Loom has no `docs/` tree and no generated API reference, so there is nothing
  else to regenerate.

---

## Potential Challenges

- **The tree's `"selection"` event is skipped when the selection does not
  change** ([Tree.ts:927-932](node_modules/@jimka/typescript-ui/src/typescript/lib/component/tree/Tree.ts#L927)).
  Clicking the row that is already selected therefore opens nothing — including
  after its tab has been closed. That is today's behaviour and this plan does
  not change it; the double-click path does not inherit it, because
  `"dblclick"` fires regardless of selection and `openFile` opens the file when
  no tab holds it.
- **The active-file listener writes the tree's selection back**
  ([src/shell/EditorShell.ts:131](src/shell/EditorShell.ts#L131)), so a tab
  switch can fire `"selection"` and re-enter `openFile(path, 'temporary')`.
  That lands in the already-open branch, which never marks a tab temporary, so
  a pinned tab cannot be demoted by the sync.
- **Closing the temp tab when it is the only tab.** `Tab.closeEntry` emits
  `"tabclose"` synchronously, and `handleTabClose` defers its `syncActive` to a
  microtask ([src/EditorController.ts:581-590](src/EditorController.ts#L581)),
  by which time `openFile` has already added the replacement tab. The
  welcome-screen toggle therefore never sees an empty strip. Case 15 checks it.
- **Two temporary opens with overlapping reads.** Clicking two files fast
  enough that both reads are in flight ends with whichever read *landed* last
  in the temp tab, not whichever was *clicked* last. The strip still holds
  exactly one temp tab either way, so no mitigation is needed.
- **`pinTab` and `openFile` can both record the same recent file** on a
  permanent open of a file already in the temp tab. `withRecent`
  ([src/data/session.ts:46-48](src/data/session.ts#L46)) filters the path out
  before prepending it, so the duplicate call is a no-op.

---

## Critical Files

- [src/EditorController.ts](src/EditorController.ts) — the class carrying most
  of the change. Read `openFile` ([:258-292](src/EditorController.ts#L258)),
  `addFileTab` ([:294-312](src/EditorController.ts#L294)), `restoreFiles`
  ([:347-378](src/EditorController.ts#L347)), `saveAs`
  ([:407-437](src/EditorController.ts#L407)), `handleDirtyChange`
  ([:535-539](src/EditorController.ts#L535)) and `handleTabClose`
  ([:581-590](src/EditorController.ts#L581)).
- [src/editor/FileEditor.ts:241-244](src/editor/FileEditor.ts#L241) —
  **the precedent this plan mirrors** for the tab mark: per-file state read by
  `getLabel()`, with `EditorController` pushing the result through
  `Tab.setTabName`. The `~` prefix is the same mechanism as the `" •"` dirty
  marker, and the reason no other call site needs to learn about temp tabs.
- [src/explorer/FileTree.ts:56-66](src/explorer/FileTree.ts#L56) — the single
  `"selection"` registration and its handler, the shape both new handlers
  follow.
- [src/shell/EditorShell.ts:71-78](src/shell/EditorShell.ts#L71) — where the
  tree's callbacks are bound to controller methods.
- [node_modules/@jimka/typescript-ui/src/typescript/lib/component/tree/Tree.ts:1222-1250](node_modules/@jimka/typescript-ui/src/typescript/lib/component/tree/Tree.ts#L1222)
  — `_handleDblClick`. Its doc comment records that the first click of the pair
  has already run through `_handleClick` and set the selection, which is why the
  double-click handler only has to pin.
- [node_modules/@jimka/typescript-ui/src/typescript/lib/layout/Tab.ts:1136-1218](node_modules/@jimka/typescript-ui/src/typescript/lib/layout/Tab.ts#L1136)
  — `closeEntry` and `closeTab`: `"tabclose"` is emitted synchronously, the
  content is disposed, a sibling is re-selected silently, and `"beforetabclose"`
  is not consulted on this path.
- [node_modules/@jimka/typescript-ui/src/typescript/lib/component/container/TabPanel.ts:139-154](node_modules/@jimka/typescript-ui/src/typescript/lib/component/container/TabPanel.ts#L139)
  — `addTab`, which appends; there is no insert-at-index counterpart, which is
  why a recycled temp tab lands at the end of the strip.
- [plans/implemented/file-editor-dirty-state-adoption.md](plans/implemented/file-editor-dirty-state-adoption.md)
  — the dirty-state model the edit-pins-the-tab trigger keys off, and the
  *No new automated tests* decision this plan repeats.
- [vitest.config.ts](vitest.config.ts) — records why component behaviour is not
  unit-tested in this project.

---

## Non-Goals

- **No persistence of which tab was temporary.** `SessionState`
  ([src/data/session.ts](src/data/session.ts)) stores a flat list of open file
  paths; adding a temp marker means a schema change for scratch state that
  costs nothing to lose. A restored tab is permanent.
- **No italic tab label.** The library exposes no per-tab label styling and
  keeps its `TabBar` private, so the `~` prefix stands in. TODO.md records the
  gap.
- **No repositioning of a recycled tab.** It lands at the end of the strip,
  because `TabPanel.addTab` appends and there is no insert-at-index API.
- **No temp tab for untitled buffers.** `newFile()` has no path to reopen from
  and nothing to recycle; it always adds a permanent tab.
- **No setting to turn temp tabs off.** Settings of any kind are a separate
  backlog item ([TODO.md:43-48](TODO.md#L43)).
- **No middle-click, Ctrl+click, or context-menu open variants** in the tree.
  Only the existing single click and the new double click open files.
- **No library changes.** `@jimka/typescript-ui` is used exactly as shipped;
  nothing under `../typescript-ui/` is edited.
- **No fix for the stale tab icon after a cross-type *Save As***. Recycling
  builds a fresh tab each time, so a temp tab's icon is always right; the
  pre-existing *Save As* case is untouched.

---

## Notes

[^why-new-tab]: Keeping one `FileEditor` and pushing each newly browsed file
    into it with `CodeEditor.setValue`
    ([CodeEditor.ts:358](node_modules/@jimka/typescript-ui/src/typescript/lib/component/editor/CodeEditor.ts#L358))
    was the obvious reading of "reuse the tab", and it fails on three counts.
    First, undo: `setValue` dispatches an ordinary replace transaction into a
    view built with CodeMirror's `history()` extension
    ([:752](node_modules/@jimka/typescript-ui/src/typescript/lib/component/editor/CodeEditor.ts#L752)),
    and `CodeEditor` exposes no way to reset that history, so one Ctrl+Z after
    browsing three files would pull the previous file's whole text into the
    current one and mark it dirty. Second, the icon: a tab's glyph is passed to
    `TabPanel.addTab` and rendered once by `TabBar.createBarEntry`, with no
    setter anywhere in the library — TODO.md already records that gap for the
    *Save As* case — so one reused tab would show the first browsed file's icon
    forever. Building a new tab per open sidesteps both, because the glyph is
    chosen at construction. Third, the reused editor would carry the previous
    file's scroll position, selection, and Markdown-preview toggle state into
    the next file, each needing its own reset. The cost of the chosen design is
    that the tab is destroyed and rebuilt, which moves it to the end of the
    strip — case 16 in **Expected Behaviour** pins that as intended.

[^flag-not-field]: The alternative, a `private _tempFile: FileEditor | null` on
    `EditorController`, was rejected because it needs clearing on every path
    that can remove the tab — the ✕, *Close File*, a bulk close from the strip's
    context menu, a tear-off — and each missed path leaves a dangling reference
    to a disposed component. With the flag on the `FileEditor`, closing the tab
    destroys the flag along with it and splices the file out of `_openFiles`
    ([src/EditorController.ts:581-590](src/EditorController.ts#L581)), so the
    `find(file => file.isTemporary())` scan simply stops finding anything. The
    scan costs nothing: `_openFiles` holds one entry per open tab.

[^one-entry-point]: The alternative was a second public method,
    `openFileTemporary(path)`, beside the existing `openFile(path)`. It was
    rejected because the two would share almost their whole body — the
    already-open check, the read, the error dialog, the recent-files record,
    the activate — and because a future command palette would then have to know
    which of two methods carries which semantics. A defaulted `mode` parameter
    also means the existing callers at
    [src/shell/EditorShell.ts:104](src/shell/EditorShell.ts#L104) and inside
    `restoreFiles` need no edit at all, so the diff stays on the paths whose
    behaviour actually changes.

[^permanent-leaves-temp]: VS Code discards the preview editor when any file is
    opened non-preview. Loom does not, for two reasons. It would mean a
    deliberate open — *Open Recent*, or a future Ctrl+P — silently closing an
    unrelated tab the user is looking at, which is the kind of surprise a strip
    holding only a handful of tabs does not need. And the rule this plan adopts
    is one sentence long ("only a temporary open recycles the temp tab"), where
    the other needs a second sentence for every non-tree surface. The tree's
    own double-click still ends up replacing the temp tab, because its first
    click already recycled the slot — so the common case matches VS Code
    anyway, as the fourth row of the decision table shows.

[^dirty-is-the-signal]: `FileEditor` has no dirty state of its own; the flag is
    the wrapped `CodeEditor`'s, folded up by `Component`'s parent-to-child relay
    and delivered to `EditorController` through the inherited
    `onDirtyChange` listener registered at
    [src/EditorController.ts:307](src/EditorController.ts#L307). That is the
    model `plans/implemented/file-editor-dirty-state-adoption.md` established,
    and pinning on the same signal means "the user edited the file" has exactly
    one definition in the codebase. It also inherits that model's edge
    behaviour for free: a file typed into and then undone back to its opened
    text stays pinned, because the pin is one-way — matching VS Code, where an
    edited preview tab does not revert to being a preview.

[^tree-stays-dumb]: `FileTree` could have taken a single
    `onOpenFile(path, mode)` callback, but `OpenMode` is declared by
    `EditorController`, and `src/explorer/` imports nothing from the controller
    today. Two gesture-named callbacks keep that boundary and leave the tree
    describing only what the user did, which is the shape
    `FileTreeParams.onOpenFile` already had. `EditorShell` is where the two
    meet, and it is already the module that binds every tree callback to a
    controller method.

[^tilde-prefix]: VS Code italicises a preview tab's title. Loom cannot: a tab's
    label is set through `Tab.setTabName`
    ([Tab.ts:1228](node_modules/@jimka/typescript-ui/src/typescript/lib/layout/Tab.ts#L1228)),
    which takes a string, and `Tab` holds its `TabBar` in a private field, so
    there is no supported route to the `TabButton` that owns the text. That
    leaves the label string as the only channel — the same one the dirty marker
    already uses. `~` was chosen over `*` (reads as "modified", colliding with
    the dirty dot) and over enclosing brackets (two characters of a 200px
    budget, and a real file name can contain them). It goes in front rather
    than behind because the tab strip is configured `widthMode: 'content'` with
    `maxWidth: TAB_MAX_WIDTH` ([src/EditorController.ts:21](src/EditorController.ts#L21)),
    and the label is a truncating `Text`, so a long file name ellipsises its
    tail and would eat a trailing mark. Giving the temp tab a different *glyph*
    instead was considered and rejected: it is settable (the tab is rebuilt on
    every recycle) but it would cost the per-file-type icon the tree and the
    strip otherwise share.

[^pending-opens]: Without `_pendingOpens`, the tree's own double-click can open
    two tabs for one file. The first click fires `"selection"`, which starts
    `openFile(path, 'temporary')`; that call suspends at `await
    readFileText(path)` before any tab exists. If `"dblclick"` arrives while the
    read is still outstanding, `openFile(path, 'permanent')` finds nothing in
    `_openFiles`, reads the file again, and adds a second tab. The window is
    small — a double-click interval is normally longer than a local file read —
    but it is exactly the duplicate-tab outcome this feature exists to prevent,
    and a slow or cold read widens it. Recording the in-flight mode makes both
    interleavings converge on one pinned tab: if the read lands first, the
    double-click takes the already-open branch and pins the tab; if the
    double-click lands first, it upgrades the pending mode and the read builds a
    permanent tab directly. The same guard covers a future command palette
    racing a tree click for the same path.
