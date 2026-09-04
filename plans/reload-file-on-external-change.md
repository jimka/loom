---
depends-on: [filesystem-watching, file-editor-dirty-state-adoption]
touches-shared: [src/EditorController.ts, src/editor/FileEditor.ts, src/explorer/FileTree.ts, src/shell/EditorShell.ts, src/data/watchEvents.ts, tests/watchEvents.test.ts, README.md, TODO.md]
---

# Reload An Open File When It Changes On Disk — Implementation Plan

## Overview

Loom's filesystem watcher only feeds the tree. `FileTree` starts one recursive
watch per project root at [src/explorer/FileTree.ts:627](src/explorer/FileTree.ts#L627),
turns each batch of changed paths into directories to re-list at
[src/explorer/FileTree.ts:657](src/explorer/FileTree.ts#L657), and stops there.
An already-open `FileEditor` keeps whatever text it was opened with, so a file
rewritten by another editor, a `git checkout`, or a build tool shows stale
content until the user closes and reopens the tab.

This plan routes the same watch batch to `EditorController`, which already owns
the open-file registry and already reacts to filesystem events against open
files — `closeFilesUnder` at [src/EditorController.ts:182](src/EditorController.ts#L182)
and `relocateOpenFiles` at [src/EditorController.ts:203](src/EditorController.ts#L203).
Each open `FileEditor` gains one new piece of state: the text Loom last read
from, or wrote to, disk. Comparing that text against a fresh read is what
separates a genuine outside change from Loom's own save, and comparing it
against the buffer's dirty flag is what decides between a silent reload and a
prompt.

The conflict case — the file changed on disk *and* the buffer has unsaved
changes — gets a two-button modal built the same way as the existing
unsaved-changes prompt at [src/shell/unsavedPrompt.ts:17](src/shell/unsavedPrompt.ts#L17).
No new UI chrome, no diff view.

---

## Architecture Decisions

### `FileTree` forwards the raw watch batch through a new callback

`FileTreeParams` at [src/explorer/FileTree.ts:35](src/explorer/FileTree.ts#L35)
gains `onPathsChanged`, invoked from `handleFileSystemChange` with the batch
exactly as the watcher reported it. `EditorShell` wires it to the controller,
alongside the `onPathDeleted`/`onPathRenamed` callbacks it already wires
there.[^one-watch]

The batch is forwarded unfiltered — including paths under `<root>/.loom`, which
`refreshTargets` drops from the tree's own refresh targets.[^loom-not-filtered]

### The unit of state is one string per open file: its on-disk text

`FileEditor` gains `_syncedText`, holding the file's content as Loom last read
or wrote it. The constructor seeds `_syncedText` from the text the file was
opened with; every successful save replaces it with the bytes just written;
every reload replaces it with the bytes just read.

A fresh read that equals `_syncedText` means the file on disk has not changed
since Loom last wrote or read it, which is exactly what Loom's own save looks
like from the watcher's side. That comparison is the whole self-write
suppression mechanism — no flags, no timers, no coordination with
`save()`.[^why-content-not-mtime]

### One rule decides the outcome, and it lives in `src/data/watchEvents.ts`

`externalChangeOutcome(diskText, syncedText, dirty)` returns `'unchanged'`,
`'reload'`, or `'conflict'`. It joins `refreshTargets` and `isContentChangeKind`
in the app's existing pure watch-decision module, so it is unit-testable in
vitest's `node` environment like they are.

| `diskText` | `syncedText` | buffer dirty | outcome | why |
|---|---|---|---|---|
| `"a"` | `"a"` | no | `unchanged` | disk holds what Loom last wrote — Loom's own save |
| `"a"` | `"a"` | yes | `unchanged` | same, and the local changes are not at risk |
| `"b"` | `"a"` | no | `reload` | disk moved; there is nothing local to lose |
| `"b"` | `"a"` | yes | `conflict` | disk moved and there are unsaved changes |

### Active-vs-background is one flag, resolved at two moments

Every open file matching a changed path is flagged `_externalChange`. That flag
is resolved — read the file, apply the rule above — immediately if the file is
the active tab, and otherwise the next time `handleActivate` makes it active.
There is no second code path and no stashed disk text.[^flag-not-stash]

Because resolution only ever runs against the active file, a reload always
happens in front of the user — which is what makes a status-bar message the
right feedback for a reload.

### The conflict prompt has two answers, and the safe one is the default

`src/shell/externalChangePrompt.ts` exports `promptExternalChange(name)`,
returning `'reload'` or `'keep'`, built with the same
`Dialog.show`-plus-`onClick`-closure pattern as `promptUnsavedChanges` and
`promptRecentDirectoryIntent` at [src/shell/recentProjectPrompt.ts:19](src/shell/recentProjectPrompt.ts#L19).
Escape, the backdrop, and the ✕ all bypass `onClick`, so the closure variable
starts at `'keep'` — a stray dismissal never destroys unsaved changes.

There is no third "show me a diff" answer.[^no-diff]

### A reload is `CodeEditor.setValue()`, and it loses scroll and caret

`@jimka/typescript-ui`'s `CodeEditor` offers exactly one whole-document write,
`setValue()`, and it dispatches a full-document replace transaction carrying no
`selection` and no `scrollIntoView`. A reload therefore collapses the caret and
scrolls the view to the top, and lands one step in the undo history. That cost
is accepted here rather than worked around.[^setvalue-cost]

### Reloading must not pin the strip's temp tab

`setValue()` flips the editor dirty before `markClean()` settles it, and
`Component`'s dirty relay fires synchronously, so that transient flip reaches
`handleDirtyChange` at [src/EditorController.ts:764](src/EditorController.ts#L764)
— which pins the temp tab and records the file as recently used. The reload
helper clears the temporary flag for the duration of the swap and restores it
afterwards; `pinTab` early-returns on an already-pinned tab, so the flip becomes
a no-op.[^temp-tab-flip]

---

## Public API

```ts
// src/data/watchEvents.ts

/** What a watcher-reported change to an open file means for its buffer. */
export type ExternalChangeOutcome = 'unchanged' | 'reload' | 'conflict'

export function externalChangeOutcome(
    diskText: string,
    syncedText: string,
    dirty: boolean,
): ExternalChangeOutcome
```

```ts
// src/shell/externalChangePrompt.ts  (new file)

/** The user's answer to the file-changed-on-disk prompt. */
export type ExternalChangeChoice = 'reload' | 'keep'

export async function promptExternalChange(name: string): Promise<ExternalChangeChoice>
```

```ts
// src/editor/FileEditor.ts

class FileEditor extends Container {
    /** Backing field for the file's on-disk text, seeded from `params.text`. */
    private _syncedText: string
    /** Backing field for the pending-external-change flag. */
    private _externalChange: boolean = false

    /** The file's content as Loom last read it from, or wrote it to, disk. */
    getSyncedText(): string

    /** Records `text` as the file's on-disk content, leaving the document and the dirty flag alone. */
    setSyncedText(text: string): void

    /** Records `text` as the file's on-disk content, drops the external-change flag, and accepts the document as clean. */
    markSynced(text: string): void

    /** Replaces the document with `text` and marks it synced. */
    adoptDiskText(text: string): void

    /** Whether the watcher has reported a change to this file that is not resolved yet. */
    hasExternalChange(): boolean

    /** Records that the watcher reported a change to this file. */
    markExternalChange(): void

    /** Drops the external-change flag. */
    clearExternalChange(): void

    // markClean() is deleted — markSynced() replaces both of its call sites.
}
```

```ts
// src/explorer/FileTree.ts

export interface FileTreeParams {
    onSelectFile: (path: string) => void
    onOpenFile: (path: string) => void
    onPathDeleted: (path: string) => void
    onPathRenamed: (oldPath: string, newPath: string) => void
    /** Called with the raw batch of changed paths the watcher reported, before any tree filtering. */
    onPathsChanged: (paths: string[]) => void
}
```

```ts
// src/EditorController.ts

class EditorController {
    /** Flags every open file the batch names, and resolves the active one now. */
    markExternalChanges(paths: string[]): void
}
```

---

## Internal Structure

### `EditorController` private state

```ts
/** How long a status-bar message stays up, in milliseconds — long enough to notice, short enough not to linger. */
const STATUS_MESSAGE_DURATION_MS = 2000

/**
 * Paths whose external-change resolution is in flight. A second batch naming
 * the same path while its read or its prompt is outstanding is dropped rather
 * than opening a second prompt for one file — the same "join, don't duplicate"
 * role `_pendingOpens` plays for an in-flight open.
 */
private readonly _resolvingExternal: Set<string> = new Set()
```

### `EditorController.markExternalChanges`

```ts
markExternalChanges(paths: string[]): void {
    const active = this.getActiveFile()

    for (const path of new Set(paths)) {
        const file = this._openFiles.find(candidate => candidate.getPath() === path)

        if (!file) {
            continue
        }

        file.markExternalChange()

        if (file === active) {
            void this.resolvePendingExternalChange(file)
        }
    }
}
```

### `EditorController.resolvePendingExternalChange`

The flag is cleared on entry, not at the end: a change landing while the prompt
is open re-arms it, and the re-armed flag is picked up the next time that tab is
activated.

```ts
private async resolvePendingExternalChange(file: FileEditor): Promise<void> {
    const path = file.getPath()

    if (path === null || !file.hasExternalChange() || this._resolvingExternal.has(path)) {
        return
    }

    this._resolvingExternal.add(path)
    file.clearExternalChange()

    try {
        let diskText: string

        try {
            diskText = await readFileText(path)
        } catch {
            // Externally deleted, unreadable, or grown past readFileText's size
            // limit: the buffer is the only surviving copy, so it is left exactly
            // as it is — and no dialog is raised, since the user did not ask for
            // anything here.
            return
        }

        const outcome = externalChangeOutcome(diskText, file.getSyncedText(), file.isDirty())

        if (outcome === 'reload') {
            this.reloadFromDisk(file, diskText)
        } else if (outcome === 'conflict') {
            await this.resolveExternalConflict(file, diskText)
        }
    } finally {
        this._resolvingExternal.delete(path)
    }
}
```

### `EditorController.resolveExternalConflict`

`'keep'` still records `diskText` as the file's on-disk text, so the same
disk content cannot raise a second prompt; the buffer and its dirty flag are
untouched, and the next save overwrites the outside change, which is what
keeping the local changes means.

```ts
private async resolveExternalConflict(file: FileEditor, diskText: string): Promise<void> {
    if (await promptExternalChange(file.getName()) === 'reload') {
        this.reloadFromDisk(file, diskText)

        return
    }

    file.setSyncedText(diskText)
}
```

### `EditorController.reloadFromDisk`

```ts
private reloadFromDisk(file: FileEditor, diskText: string): void {
    const wasTemporary = file.isTemporary()

    file.setTemporary(false)
    file.adoptDiskText(diskText)
    file.setTemporary(wasTemporary)
    this.tabs.getTab().setTabName(file, file.getLabel())
    this.statusBar.setMessage(`Reloaded ${file.getLabel()}`, STATUS_MESSAGE_DURATION_MS)
}
```

### `FileEditor`'s new methods

```ts
setSyncedText(text: string): void {
    this._syncedText = text
}

markSynced(text: string): void {
    this._syncedText = text
    this._externalChange = false
    this._editor.markClean()
}

adoptDiskText(text: string): void {
    this._editor.setValue(text)
    this.markSynced(text)
}
```

---

## Ordered Implementation Steps

1. **`tests/watchEvents.test.ts`** — add a `describe('externalChangeOutcome')`
   block with one `it` per row of the table in `## Expected Behaviour`, and
   import `externalChangeOutcome` alongside the three existing imports. Run
   `npm test` — the new block fails, because the function does not exist yet.

2. **`src/data/watchEvents.ts`** — add the `ExternalChangeOutcome` type and the
   `externalChangeOutcome(diskText, syncedText, dirty)` function, with a JSDoc
   block documenting all three parameters and the return value. Implement it as:
   `diskText === syncedText` → `'unchanged'`; otherwise
   `dirty ? 'conflict' : 'reload'`. Run `npm test` — the whole suite passes.
   Every step after this one is manual-verify only.

3. **`src/data/watchEvents.ts`** — update the module's header comment (lines
   1–8). It enumerates the module's callers by name; add `EditorController`'s
   external-change resolution as the third, asking *what a change to an
   already-open file means for its buffer*.

4. **`src/editor/FileEditor.ts`** — add the `_syncedText: string` and
   `_externalChange: boolean = false` fields, seed `_syncedText` from
   `params.text` in the constructor beside the existing `this._path`/`this._name`
   assignments, and add `getSyncedText`, `setSyncedText`, `markSynced`,
   `adoptDiskText`, `hasExternalChange`, `markExternalChange`, and
   `clearExternalChange` per `## Public API` and `## Internal Structure`. Leave
   the existing `markClean()` method at
   [src/editor/FileEditor.ts:249](src/editor/FileEditor.ts#L249) in place for
   now — step 10 deletes it, once both of its call sites are gone.

5. **`src/shell/externalChangePrompt.ts`** — new file, modelled line for line
   on [src/shell/unsavedPrompt.ts](src/shell/unsavedPrompt.ts). Its JSDoc must
   say why `choice` starts at `'keep'` (Escape, the backdrop, and the ✕ all
   bypass `onClick`, and losing unsaved changes to a stray dismissal is the one
   outcome to rule out). Body:

   ```ts
   export async function promptExternalChange(name: string): Promise<ExternalChangeChoice> {
       let choice: ExternalChangeChoice = 'keep'

       await Dialog.show({
           title: 'File changed on disk',
           message: `"${name}" changed on disk while you have unsaved changes here. Reload it from disk and lose your changes, or keep yours?`,
           buttons: [
               {
                   text: 'Reload from Disk',
                   result: 'confirm',
                   onClick: () => {
                       choice = 'reload'

                       return true
                   },
               },
               {
                   text: 'Keep My Changes',
                   result: 'cancel',
                   primary: true,
                   onClick: () => {
                       choice = 'keep'

                       return true
                   },
               },
           ],
       })

       return choice
   }
   ```

6. **`src/EditorController.ts`** — rename the module constant
   `SAVE_MESSAGE_DURATION_MS` at [src/EditorController.ts:20](src/EditorController.ts#L20)
   to `STATUS_MESSAGE_DURATION_MS`, updating its doc comment to say "status-bar
   message" rather than "Saved <name>" message, and update both existing call
   sites (lines 532 and 566). Check: `grep -rn 'SAVE_MESSAGE_DURATION_MS' src/`
   — expect zero matches.

7. **`src/EditorController.ts`** — add the imports: `externalChangeOutcome` from
   `./data/watchEvents`, and `promptExternalChange` from
   `./shell/externalChangePrompt`.

8. **`src/EditorController.ts`** — add the `_resolvingExternal` field beside
   `_pendingOpens` at [src/EditorController.ts:43](src/EditorController.ts#L43),
   with the doc comment from `## Internal Structure`.

9. **`src/EditorController.ts`** — in `saveAs` at
   [src/EditorController.ts:504](src/EditorController.ts#L504), hoist the text
   being written into a local *after* `formatBeforeSave` has run
   (`const text = file.getEditor().getValue()`), pass that local to
   `writeFileText(target, text)`, and replace `file.markClean()` on line 528
   with `file.markSynced(text)`.

10. **`src/EditorController.ts`** — apply the same three changes to `save` at
    [src/EditorController.ts:548](src/EditorController.ts#L548):
    `const text = file.getEditor().getValue()` after `formatBeforeSave`,
    `writeFileText(path, text)`, and `file.markSynced(text)` in place of
    `file.markClean()` on line 565. Then delete
    `FileEditor.markClean()` — both of its call sites are now `markSynced`, and
    `markSynced` calls the wrapped editor's own `markClean()` directly. Check:
    `grep -rn '\.markClean()' src/` — expect exactly one match, the
    `this._editor.markClean()` inside `FileEditor.markSynced`.

11. **`src/EditorController.ts`** — add the public `markExternalChanges(paths)`
    method and the private `resolvePendingExternalChange`,
    `resolveExternalConflict`, and `reloadFromDisk` methods, verbatim from
    `## Internal Structure`, each with a JSDoc block. Place
    `markExternalChanges` next to `relocateOpenFiles`, and the three private
    methods next to `pinTab` at [src/EditorController.ts:726](src/EditorController.ts#L726).
    `reloadFromDisk`'s doc comment must record *why* the temporary flag is
    cleared and restored around the swap (see the `## Architecture Decisions`
    entry on temp-tab pinning) — the two `setTemporary` calls look removable
    otherwise.

12. **`src/EditorController.ts`** — extend `handleActivate` at
    [src/EditorController.ts:825](src/EditorController.ts#L825) to resolve the
    newly active file's pending change after `syncActive()`:

    ```ts
    private handleActivate = (): void => {
        this.syncActive()

        const file = this.getActiveFile()

        if (file) {
            void this.resolvePendingExternalChange(file)
        }
    }
    ```

    `resolvePendingExternalChange` returns immediately when the flag is unset, so
    an ordinary tab switch costs one boolean read.

13. **`src/explorer/FileTree.ts`** — add
    `onPathsChanged: (paths: string[]) => void` to `FileTreeParams` at
    [src/explorer/FileTree.ts:35](src/explorer/FileTree.ts#L35) with the doc
    comment from `## Public API`, add the matching
    `private readonly _onPathsChanged: (paths: string[]) => void` field beside
    the other four callback fields, and assign it in the constructor beside
    `this._onPathRenamed`.

14. **`src/explorer/FileTree.ts`** — add `this._onPathsChanged(paths)` to
    `handleFileSystemChange` at [src/explorer/FileTree.ts:657](src/explorer/FileTree.ts#L657),
    on the line immediately after the `this._root === null` guard and before the
    `refreshTargets` loop. Pass `paths` unchanged — no root check, no `.loom`
    filtering, no dedupe; the controller owns all of that.

15. **`src/shell/EditorShell.ts`** — add
    `onPathsChanged: (paths: string[]) => controller.markExternalChanges(paths),`
    to the `FileTree({ … })` call at
    [src/shell/EditorShell.ts:89](src/shell/EditorShell.ts#L89), after
    `onPathRenamed`.

16. **`npm run typecheck`** then **`npm test`** — both must pass before the
    manual pass.

17. **`README.md`** — the Highlights list's file-tree bullet says "The tree
    follows changes made outside the app" at
    [README.md:22](README.md#L22). Add a sentence to the **Tabbed editing**
    bullet at [README.md:36](README.md#L36) saying open tabs follow those
    changes too: a buffer with no unsaved changes reloads, and one with unsaved
    changes asks whether to reload from disk or keep them.

18. **`TODO.md`** — delete the *Refresh an open file when it changes on disk*
    entry from `## High` (lines 40–47). Leave the *Saving a file that I'm
    currently editing…* entry in place — it is a separate bug with its own plan.
    Check: `grep -n 'changes on disk' TODO.md` — expect zero matches.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src/data/watchEvents.ts` |
| Modify | `tests/watchEvents.test.ts` |
| Modify | `src/editor/FileEditor.ts` |
| Create | `src/shell/externalChangePrompt.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `src/explorer/FileTree.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### `externalChangeOutcome` — unit-testable

| `diskText` | `syncedText` | `dirty` | result |
|---|---|---|---|
| `"a"` | `"a"` | `false` | `'unchanged'` |
| `"a"` | `"a"` | `true` | `'unchanged'` |
| `"b"` | `"a"` | `false` | `'reload'` |
| `"b"` | `"a"` | `true` | `'conflict'` |
| `""` | `"a"` | `false` | `'reload'` (an externally emptied file is a change) |
| `""` | `""` | `false` | `'unchanged'` (an empty file Loom itself last wrote) |

### App behaviour — manual verification in `npm run tauri:dev`

Open a project folder, then for each case edit the file from a second program
(another editor, `echo … >`, `git checkout`) and wait out the watcher's ~250 ms
coalescing window.

1. **Active tab, no unsaved changes** — the buffer shows the new content, the
   tab keeps no dirty dot, and the status bar shows `Reloaded <name>`.
2. **Active tab, unsaved changes, "Reload from Disk"** — the prompt names the
   file; choosing Reload replaces the buffer with the disk content and clears
   the dirty dot.
3. **Active tab, unsaved changes, "Keep My Changes"** — the buffer and the dirty
   dot are untouched. Touching the file again with the *same* content raises no
   second prompt; writing *different* content does.
4. **Active tab, unsaved changes, Escape / backdrop / ✕** — same as case 3: the
   unsaved changes survive.
5. **Background tab, no unsaved changes** — nothing happens while the tab is in
   the background. Switching to it shows the new content and the
   `Reloaded <name>` message.
6. **Background tab, unsaved changes** — no prompt appears while the tab is in
   the background. Switching to it raises the prompt then.
7. **Loom's own save** — Ctrl/Cmd+S on a modified file, with `formatOnSave` both
   on and off, produces no prompt and no `Reloaded` message.
8. **Save, then keep typing** — save and continue typing immediately, inside the
   watcher's window. No prompt: the recorded on-disk text is what the save
   wrote, so the disk has not moved.
9. **External delete** — delete an open file from outside. The tree drops its
   row; the tab stays open with its buffer intact, and no prompt or error dialog
   appears. If that buffer has unsaved changes, *Save* still writes it back to
   the same path, recreating the file.
10. **Temp tab** — single-click a file in the tree (a `~` tab), then change it
    outside. It reloads, keeps its `~`, stays the tab a further single-click
    recycles, and does **not** appear under *File > Open Recent*.
11. **Markdown preview** — open a `.md` file, turn its preview on, change the
    file outside. The rendered view picks up the new content.
12. **Rename from the tree** — renaming an open file via the tree's context menu
    raises no prompt and no `Reloaded` message.
13. **Outside the project folder** — *File > Open Settings* opens the app-wide
    `settings.json`, which lives outside the project root. Editing it from
    outside Loom does not reload it; the watch is rooted at the project folder.
14. **Accepted regression** — reloading a file scrolled halfway down moves the
    view to the top and collapses the caret, and one Ctrl/Cmd+Z brings the
    pre-reload content back (leaving the buffer dirty).

---

## Verification

- `npm run typecheck` — strict, no emit.
- `npm test` — the new `externalChangeOutcome` block plus the existing suite.
- `grep -rn 'SAVE_MESSAGE_DURATION_MS' src/` — expect zero matches.
- `grep -rn '\.markClean()' src/` — expect one match, inside
  `FileEditor.markSynced`.
- `grep -n 'changes on disk' TODO.md` — expect zero matches.
- `npm run tauri:dev`, then walk the fourteen numbered cases in
  `## Expected Behaviour`. Every one of them is exercised from the tab strip and
  a second program writing files in the open project folder; none needs a
  special build.

---

## Documentation Impact

- **`README.md`** — the Tabbed editing bullet in Highlights gains the
  open-tab-follows-disk sentence (step 17). No other page describes editor
  behaviour.
- **`TODO.md`** — the backlog entry this plan closes is deleted (step 18),
  matching how earlier plans retired theirs.
- **`src/data/watchEvents.ts`'s header comment** — it names its callers and what
  each asks of the module, so the third caller has to be added there (step 3).
- No `@jimka/typescript-ui` API changes, so nothing in the library's docs moves.

---

## Potential Challenges

- **A reload loses scroll position and the caret.** `CodeEditor.setValue()`'s
  full-document replace carries no `selection` and no `scrollIntoView`. Accepted
  and documented as case 14; the fix belongs in `CodeEditor`, not here.
- **A reload lands an undo step.** `setValue()`'s transaction is recorded by
  CodeMirror's `history()` extension, so Ctrl/Cmd+Z after a reload restores the
  pre-reload text and re-dirties the buffer. Accepted; a save then writes what
  the user sees, which is the honest outcome.
- **The transient dirty flip during a reload.** Mitigated inside
  `reloadFromDisk` by clearing and restoring the temporary flag (see
  `## Architecture Decisions`).
- **An outside write landing while the conflict prompt is open.** The flag is
  re-armed but not resolved until that tab is activated again, so the reload can
  be one write behind. Narrow enough to accept: the watcher already coalesces
  `FS_WATCH_DELAY_MS` (250 ms, [src/data/workspace.ts:36](src/data/workspace.ts#L36))
  of writes into one batch, and the user is being asked about this exact file at
  that moment.
- **A tab switch during the disk read.** The read is started for the active file
  and the prompt could therefore appear just after the user switched away. The
  prompt names the file, so the situation is legible; no extra re-check is added.
- **A file written in several chunks by another program** can be read
  mid-write. The watcher's 250 ms coalescing covers the common case, and a later
  chunk produces another event that reloads again, so the buffer converges.
- **`<root>/.loom/workspace.json` opened as a tab** reloads once after each tab
  switch, because Loom's own session autosave rewrites that file on
  `"activate"`. The content shown is genuinely new each time, so this is noise
  rather than incorrectness.

---

## Critical Files

- [src/EditorController.ts](src/EditorController.ts) — the class every new
  method lands in. Read `closeFilesUnder` (line 182) and `relocateOpenFiles`
  (line 203) for the "walk `_openFiles`, filter by path, act" precedent this
  plan follows; `_pendingOpens` (line 43) for the in-flight-guard precedent
  `_resolvingExternal` copies; `handleDirtyChange` (line 764) and `pinTab`
  (line 726) for why `reloadFromDisk` juggles the temporary flag; `save`
  (line 548) and `saveAs` (line 504) for the write sites that must record the
  synced text.
- [src/editor/FileEditor.ts](src/editor/FileEditor.ts) — the wrapper that owns
  the `CodeEditor` and the per-file state the new fields join.
- [src/explorer/FileTree.ts](src/explorer/FileTree.ts) — `FileTreeParams`
  (line 35), `startWatching` (line 627), and `handleFileSystemChange` (line 657).
- [src/data/watchEvents.ts](src/data/watchEvents.ts) — the whole file; 76 lines,
  and the new rule joins it.
- [src/shell/unsavedPrompt.ts](src/shell/unsavedPrompt.ts) — the prompt module
  `externalChangePrompt.ts` is modelled on, line for line.
- [src/shell/EditorShell.ts](src/shell/EditorShell.ts) — the single `FileTree`
  construction site (line 89) and `handleFileSaved` (line 254), the existing
  post-save tree hook.
- `@jimka/typescript-ui`'s `CodeEditor` —
  `packages/lib/src/typescript/lib/component/editor/CodeEditor.ts` in the
  sibling checkout. Read `setValue()` (line 358), `markClean()` (line 385), and
  `format()` (line 546); comparing the first and the last is what establishes
  that no selection-preserving whole-document write exists.

---

## Non-Goals

- **No diff or merge view.** The conflict prompt offers reload or keep, nothing
  more.
- **No preserved scroll or caret across a reload.** That needs a `CodeEditor`
  change in the library.
- **Not fixing the save-scroll-jump bug** still listed in `TODO.md` ("Saving a
  file that I'm currently editing… moves the scrollbar to the top"). It shares
  the whole-document-replace root cause described in `## Architecture
  Decisions`, and a selection- and scroll-preserving whole-document write on
  `CodeEditor` would close both, but that bug is planned separately and its
  entry stays in `TODO.md`.
- **No watching of files outside the open project folder.** The watch is
  `FileTree`'s, rooted at the project folder; the app-wide `settings.json` and
  any file opened from elsewhere are out of its reach. Adding per-file watches
  is a separate piece of work.
- **No setting to turn reloading off.** Nothing in `src/data/settings.ts` gains
  a key.
- **No reload for untitled buffers.** A path-less buffer has no disk content to
  compare against, and every entry point skips a `null` path.
- **No "reload all" or "revert file" command.** The menu bar and the command
  palette are untouched.

---

## Notes

[^one-watch]: A second `watchDirectory` call from `EditorShell` was the obvious
    alternative and is worse on every axis: two recursive native watches per
    project rather than one — `startWatching`'s own `catch` already names an OS
    watch-descriptor limit as a real failure mode — two independently debounced
    event streams to reason about, and a second `startWatching`/`stopWatching`
    lifecycle to keep in step with `setProjectRoot`. Hoisting the single watch
    out of `FileTree` into `EditorShell` was also considered: it is a larger
    refactor of working code, and it would move watch ownership away from the
    component whose lifetime already matches the watch's, which
    `plans/implemented/filesystem-watching.md`'s *`FileTree` owns the watcher*
    decision chose deliberately.

[^loom-not-filtered]: `refreshTargets` drops `<root>/.loom` paths to break a
    feedback loop that is specific to the tree: a tree refresh emits `"expand"`
    events, the session autosave writes `.loom/workspace.json` in response, and
    that write would trigger another refresh. The reload path writes nothing, so
    it has no loop to break — and a file the user deliberately opened from
    inside `.loom` (via *File > Open Workspace Settings*) deserves the same
    freshness as any other open file.

[^why-content-not-mtime]: Recording the file's modification time after each
    write and comparing `stat` results was the alternative. It is cheaper in
    memory but strictly less correct: `writeTextFile` resolves before the app
    can `stat`, so an outside write landing in that gap would have *its* mtime
    recorded as Loom's own and would then never be noticed. Comparing content
    records the bytes Loom itself wrote at the moment it wrote them, so the same
    interleaving is detected instead of swallowed. The cost is one extra copy of
    each open document in memory, bounded by `readFileText`'s existing 5 MiB
    per-file limit.

[^flag-not-stash]: The alternative was to read the file the moment the event
    arrives and, for a background tab with unsaved changes, stash the disk text
    until that tab is activated. It needs a nullable string field instead of a
    boolean, a second entry point that consumes it, and a rule for what happens
    when a second change arrives before the first stash is consumed. Flagging
    and re-reading at activation needs none of that, does less disk I/O when a
    background file is rewritten repeatedly, and matches how the backlog entry
    framed the requirement — a background tab reloads *at the point* it becomes
    active.

[^no-diff]: `@jimka/typescript-ui` has no diff or merge component anywhere in
    its twelve component packages — the editor package offers `CodeEditor` and
    `MarkdownEditor` and nothing else — so a third answer would mean building a
    side-by-side view and a merge model inside Loom. That is a feature in its
    own right, not a branch of a conflict prompt, and the app has no other
    multi-pane surface to host one (split-pane editing is itself still on the
    backlog, waiting on `Dock`).

[^setvalue-cost]: `CodeEditor.format()` dispatches its own whole-document
    replace *with* a mapped `selection`, which is what makes the absence of one
    in `setValue()` a deliberate difference rather than an oversight, and there
    is no third whole-document write on the class. The only ways to preserve
    scroll and caret across a reload would be to add an API to the library or to
    reach past `CodeEditor` into CodeMirror — the view is private and
    `getScrollElement()` is `protected`, so the second is not available to Loom
    at all. The shared root cause with the separate `TODO.md` save bug named in
    `## Non-Goals` is the whole-document replace itself: it discards the view's
    scroll anchor, which is why saving with format-on-save enabled jumps to the
    top of the document even though `format()` maps the caret back. One
    library-side whole-document write that restored scroll as well as selection
    would close that bug and this plan's case 14 together.

[^temp-tab-flip]: `Component.setDirty` fires `"dirtychange"` synchronously
    (`_fireDirtyChangeIfFlipped`, called straight from `setDirty`), and
    `CodeEditor.setValue()` routes through `onDocChange`, which calls
    `setDirty(value !== this._cleanValue)` before Loom gets a chance to call
    `markClean()`. So reloading a clean file momentarily reports it dirty.
    Reaching `handleDirtyChange` in that state would pin the strip's temp tab
    *and* push the file into the recent-files list via `pinTab` — an outside
    write would silently promote a preview tab the user only single-clicked.
    Clearing the flag first makes `pinTab`'s own `if (!file.isTemporary())`
    early-out fire, which skips the recent-files record too, so restoring the
    flag afterwards fully restores the tab's state.
