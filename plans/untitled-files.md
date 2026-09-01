---
touches-shared: [README.md, TODO.md, src/data/workspace.ts]
---

# New / Untitled Files — Implementation Plan

## Overview

Loom can only edit files that already exist on disk. Every tab is created by
[`EditorController.openFile`](src/EditorController.ts#L91), and
[`FileEditor.getPath()`](src/editor/FileEditor.ts#L52) returns a non-nullable
`string`. This plan adds a *File > New File* command (Ctrl/Cmd+N) that opens an
empty buffer with no path, named `Untitled-1`, and makes the path nullable
everywhere it is read.

The new buffer gets a path the first time it is saved. *Save* on a path-less
buffer opens the native save dialog — the same dialog
[`saveAs`](src/EditorController.ts#L144) already shows — and on confirm calls
the existing [`FileEditor.setPath`](src/editor/FileEditor.ts#L62), which
repoints the editor and re-resolves its syntax language from the new
extension. From that point the buffer is an ordinary open file.

The source changes are confined to loom: `src/editor/FileEditor.ts`,
`src/EditorController.ts`, `src/editor/languages.ts`, `src/data/workspace.ts`,
`src/shell/shortcuts.ts`, `src/shell/EditorShell.ts`, and `src/main.ts`. No
change to `@jimka/typescript-ui` is needed.

---

## Architecture Decisions

### A path-less buffer is an ordinary `FileEditor` with `path: null`

`FileEditorParams.path` becomes `string | null` and `getPath()` returns
`string | null`. No new class, no separate "untitled document" type — the
untitled state is one nullable field, and `setPath` is already the transition
into the saved state.[^reuse-setpath]

### `FileEditor` carries its own display name

`FileEditorParams` gains a required `name`, stored in `_name` and returned by a
new `getName()`. `setPath` overwrites `_name` with the new path's base name, so
the two never drift. Callers that today compute `baseName(file.getPath())` call
`file.getName()` instead.[^name-field]

### The controller's open-file registry becomes a list

`EditorController._openFiles` changes from `Map<string, FileEditor>` to
`FileEditor[]`. A path-less buffer has no key, so a path-keyed map cannot hold
one — and a buffer missing from the registry would be invisible to
[`confirmExit`](src/EditorController.ts#L309), which decides whether the window
may close.[^registry-list]

### `save()` is the single place that decides Save-As-instead

[`EditorController.save`](src/EditorController.ts#L182) starts by reading the
file's path; when it is `null`, `save` delegates to `saveAs` and returns its
result. Both methods return `Promise<boolean>` — `true` only when bytes reached
disk. Nothing else in the controller branches on a null path.[^save-routing]

### `needsSave()` replaces `isActiveDirty()` as the Save-enablement rule

*Save* must be available for a path-less buffer even when it is clean, because
a clean untitled buffer still has no copy on disk. `FileEditor` gains
`needsSave()` (`dirty || path === null`), and `EditorController.isActiveDirty`
is renamed to `canSaveActive`, delegating to it — the same one-line shape the
old method had.[^needs-save]

### Untitled names are numbered once and never reused

A counter on the controller increments per new buffer: `Untitled-1`,
`Untitled-2`, and so on. Closing `Untitled-2` does not free the number 2.
Untitled names are display text only; nothing looks a buffer up by
name.[^no-reuse]

### The save dialog opens inside the open project folder

`EditorController` remembers the folder chosen in
[`openProjectFolder`](src/EditorController.ts#L75). Saving a path-less buffer
defaults the dialog to that folder joined with the buffer's untitled name. With
no folder open, the dialog is given no default path at all.[^default-path]

---

## Public API

### `src/editor/FileEditor.ts`

```ts
export interface FileEditorParams {
  /** The file's absolute path on disk, or `null` for a buffer never yet saved. */
  path: string | null
  /** The initial display name: `baseName(path)` for a real file, `"Untitled-N"` for a path-less buffer. */
  name: string
  /** The file's text, as read from disk — `""` for a new buffer. */
  text: string
  /** Notified whenever this editor's dirty state changes — including a `markClean` after save. */
  onDirtyChange: (file: FileEditor) => void
}

class FileEditor extends Container {
  private _path: string | null
  private _name: string

  /** The file's absolute path on disk, or `null` while it has never been saved. */
  getPath(): string | null

  /** Repoints this editor at a new path (first save or Save As), renaming it and re-resolving its language. */
  setPath(path: string): void

  /** The file's display name: its base name once saved, its untitled name before that. */
  getName(): string

  /** Whether Save would do anything: the document is dirty, or has no path yet. */
  needsSave(): boolean

  // Unchanged signatures: getEditor(), isDirty(), markClean(), getLabel()
  // (getLabel()'s body switches to _name; see step 4)
}
```

### `src/EditorController.ts`

```ts
class EditorController {
  private readonly _openFiles: FileEditor[]
  private _projectRoot: string | null
  private _untitledCount: number

  /** Opens an empty untitled buffer in a new tab and activates it. */
  newFile(): void

  /** Whether the active file needs saving — read by the File menu's Save item. */
  canSaveActive(): boolean          // replaces isActiveDirty()

  /** Saves the active file when it needs saving. */
  async saveActive(): Promise<void>

  /** Shows the save dialog for `file`, writes it to the chosen path, and re-tracks it there. */
  async saveAs(file: FileEditor): Promise<boolean>   // was Promise<void>

  /** Writes `file` to its own path, or runs {@link saveAs} when it has none. */
  async save(file: FileEditor): Promise<boolean>
}
```

### `src/editor/languages.ts`

```ts
/** Resolves the CodeEditor language id for a file. A path-less buffer has none. */
export function languageForPath(path: string | null): string | null
```

### `src/data/workspace.ts`

```ts
/** Shows the native save dialog, defaulted to `defaultPath` when one is given. */
export async function pickSaveTarget(defaultPath: string | null): Promise<string | null>
```

### `src/shell/shortcuts.ts`

```ts
export const NEW_FILE_SHORTCUT = 'Ctrl/Cmd+N'

/** Whether a keydown is the New-File chord (Ctrl/Cmd+N). */
export function isNewFileChord(event: KeyboardEvent): boolean

export interface AcceleratorActions {
  /** Ctrl/Cmd+N — opens a new untitled buffer. */
  onNewFile: () => void
  // …existing members unchanged
}
```

---

## Implementation

`newFile` mirrors the tail of `openFile` exactly — add tab, register, activate,
resync:

```ts
newFile(): void {
  this._untitledCount += 1

  const file = FileEditor({
    path: null,
    name: `Untitled-${this._untitledCount}`,
    text: '',
    onDirtyChange: this.handleDirtyChange,
  })

  this.tabs.addTab(file, file.getLabel(), { closeable: true })
  this._openFiles.push(file)
  this.tabs.getTab().setActiveContent(file)
  this.syncActive()
}
```

`save` gains one leading branch; the rest of its body is unchanged apart from
reading the path into a local:

```ts
async save(file: FileEditor): Promise<boolean> {
  const path = file.getPath()

  if (path === null) {
    return this.saveAs(file)
  }

  try {
    await writeFileText(path, file.getEditor().getValue())
  } catch (error) {
    await Dialog.error('Could not save file', messageOf(error))

    return false
  }

  file.markClean()
  this.statusBar.setMessage(`Saved ${file.getLabel()}`, SAVE_MESSAGE_DURATION_MS)

  return true
}
```

`saveAs` picks its default path, checks the target against the other open
files by identity rather than by map key, and reports success:

```ts
async saveAs(file: FileEditor): Promise<boolean> {
  const target = await pickSaveTarget(file.getPath() ?? this.defaultSaveTarget(file))

  if (target === null) {
    return false
  }

  if (this._openFiles.some(other => other !== file && other.getPath() === target)) {
    await Dialog.error('Cannot save here', 'That file is already open in another tab. Close it first.')

    return false
  }

  try {
    await writeFileText(target, file.getEditor().getValue())
  } catch (error) {
    await Dialog.error('Could not save file', messageOf(error))

    return false
  }

  file.setPath(target)
  file.markClean()
  this.tabs.getTab().setTabName(file, file.getLabel())
  this.statusBar.setMessage(`Saved ${file.getLabel()}`, SAVE_MESSAGE_DURATION_MS)
  this.syncActive()

  return true
}
```

`setPath` must run before `markClean` and `setTabName`, so the tab picks up the
new name rather than the untitled one.

```ts
/**
 * The path the save dialog opens to for a file that has none — the buffer's
 * untitled name inside the open project folder, or `null` when no folder is
 * open, leaving the dialog to choose its own directory.
 */
private defaultSaveTarget(file: FileEditor): string | null {
  return this._projectRoot === null ? null : joinPath(this._projectRoot, file.getName())
}
```

---

## Ordered Implementation Steps

1. **`src/editor/languages.ts`** — widen `languageForPath` to
   `(path: string | null): string | null` and return `null` immediately for a
   `null` path. Update its JSDoc to say a path-less buffer has no language.

2. **`tests/languages.test.ts`** — add `it('resolves a null path to null', …)`
   asserting `languageForPath(null)` is `null`. Run `npm test`: 29 passing.

3. **`src/editor/FileEditor.ts`** — change `FileEditorParams.path` to
   `string | null`, add the required `name` field with the JSDoc from
   `## Public API`, and change the `_path` field to `string | null`. Add
   `private _name: string`, assigned `params.name` in the constructor.

4. **`src/editor/FileEditor.ts`** — change `getPath()`'s return type to
   `string | null`; add `getName()` returning `_name`; add `needsSave()`
   returning `this._dirty || this._path === null`; make `setPath` also set
   `this._name = baseName(path)`; make `getLabel()` read `this._name` instead
   of `baseName(this._path)`.

5. **`src/data/workspace.ts`** — widen `pickSaveTarget`'s parameter to
   `string | null` and call `save({ defaultPath: defaultPath ?? undefined })`.

6. **`src/EditorController.ts`** — replace the `_openFiles` map with
   `private readonly _openFiles: FileEditor[] = []`, and add
   `private _projectRoot: string | null = null` and
   `private _untitledCount = 0`. Add `import { baseName, joinPath } from './data/paths'`
   (replacing the `baseName`-only import).

7. **`src/EditorController.ts`** — convert every registry access to the list:
   `openFile`'s lookup becomes `this._openFiles.find(candidate => candidate.getPath() === path)`;
   its insert becomes `this._openFiles.push(file)`, and it now passes
   `name: baseName(path)` to `FileEditor`; `handleTabClose` removes by identity
   with `indexOf`/`splice`; `confirmExit` becomes
   `this._openFiles.some(file => file.isDirty())`. Set `this._projectRoot = root`
   in `openProjectFolder` before invoking `_projectRootListener`.

8. **`src/EditorController.ts`** — rename `isActiveDirty()` to
   `canSaveActive()` and have it return `this.getActiveFile()?.needsSave() ?? false`.
   Change `saveActive()` to `const file = this.getActiveFile(); if (file?.needsSave()) { await this.save(file) }`.

9. **`src/EditorController.ts`** — replace `save` and `saveAs` with the bodies
   in `## Implementation`, and add the private `defaultSaveTarget`. Change
   `confirmThenClose` to call `promptUnsavedChanges(file.getName())` and
   `syncActive` to read `const name = file.getName()`. `syncActive`'s
   `languageForPath(file.getPath())` call now compiles unchanged against the
   widened signature.

10. **`src/EditorController.ts`** — add `newFile()` from `## Implementation`,
    placed directly above `openFile`.

11. **`src/shell/shortcuts.ts`** — add `NEW_FILE_SHORTCUT = 'Ctrl/Cmd+N'`
    beside the other labels, `isNewFileChord` (`isCtrlChord(event, 'n')`) beside
    the other chord helpers, `onNewFile` to `AcceleratorActions`, and a leading
    `if (isNewFileChord(event)) { actions.onNewFile() }` branch in
    `installAccelerators`'s ladder.

12. **`src/shell/EditorShell.ts`** — rename `MenuBarActions.isActiveDirty` to
    `canSaveActive`; wire `onNewFile: () => controller.newFile()` and
    `canSaveActive: () => controller.canSaveActive()` into `actions`; import
    `NEW_FILE_SHORTCUT`. In `buildMenuBar`, insert
    `{ text: 'New File', glyph: 'file-circle-plus', shortcut: NEW_FILE_SHORTCUT, action: actions.onNewFile }`
    as the File menu's first item, and change the Save item's `enabled` to
    `actions.canSaveActive()` (dropping the now-redundant `hasActiveFile()`
    conjunct).

13. **`src/main.ts`** — add
    `import { file_circle_plus } from '@jimka/typescript-ui/glyphs/solid/file_circle_plus'`
    and append `file_circle_plus` to the `Glyph.register(...)` call.

14. **Checkpoint** — `grep -rn 'isActiveDirty' src/` and
    `grep -rn '_openFiles\.\(get\|set\|delete\|has\)\b' src/` must each return
    zero matches; `npm run typecheck` and `npm test` both pass.

15. **`README.md`** — add a *New files* bullet to `## Highlights`, above the
    *Save / Save As* bullet.

16. **`TODO.md`** — delete the `**New / untitled files.**` bullet from
    `## High`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src/editor/languages.ts` |
| Modify | `src/editor/FileEditor.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `src/data/workspace.ts` |
| Modify | `src/shell/shortcuts.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `src/main.ts` |
| Modify | `tests/languages.test.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Unit-testable

Only `languageForPath` is reachable from the test suite: `vitest.config.ts`
runs in the `node` environment with no DOM, so `FileEditor` and
`EditorController` cannot be constructed there.

- `languageForPath(null)` returns `null`.
- Every existing `languageForPath` case still returns what it returns today.

### Manual verification — naming

Run `npm run tauri:dev` and exercise the File menu.

| Action | Tab label | Window title |
|---|---|---|
| *New File* | `Untitled-1` | `Untitled-1 — Loom` |
| type one character | `Untitled-1 •` | `• Untitled-1 — Loom` |
| *Save* → `/proj/notes.md` | `notes.md` | `notes.md — Loom` |
| *New File* again | `Untitled-2` | `Untitled-2 — Loom` |
| close `Untitled-2`, *New File* | `Untitled-3` | `Untitled-3 — Loom` |

### Manual verification — Save routing

| Active file | Dirty | Ctrl/Cmd+S does | File > Save |
|---|---|---|---|
| `/proj/a.ts` | no | nothing | greyed out |
| `/proj/a.ts` | yes | writes `/proj/a.ts` | enabled |
| `Untitled-1`, never edited | no | opens the save dialog | enabled |
| `Untitled-1` | yes | opens the save dialog | enabled |
| no tabs open | — | nothing | greyed out |

### Manual verification — the rest

- Ctrl/Cmd+N and *File > New File* both open a new untitled tab, and the new
  tab becomes the active one.
- A new buffer starts empty, clean, and with no language: the status bar's
  right-hand language text is blank.
- Saving `Untitled-1` as `notes.md` turns on Markdown highlighting in the same
  editor, and the status bar language text becomes `markdown`.
- Saving any file — through *Save* or *Save As* — shows `Saved <name>` in the
  status bar for two seconds.
- Cancelling the save dialog for `Untitled-1` writes nothing, leaves the tab
  named `Untitled-1`, and leaves it dirty if it was dirty.
- With a project folder open, the save dialog for `Untitled-1` opens in that
  folder with `Untitled-1` in its file-name box. With no folder open, the
  dialog still appears and still saves.
- Closing a dirty `Untitled-1` prompts `"Untitled-1" has unsaved changes.`;
  choosing *Save* opens the save dialog, and the tab closes only after a
  successful write. Cancelling the dialog leaves the tab open.
- Closing a clean, never-edited `Untitled-1` closes it immediately with no
  prompt.
- Exiting with a dirty untitled buffer open raises the *Unsaved changes*
  exit confirmation, exactly as a dirty saved file does.
- Saving `Untitled-1` onto a path that another tab already has open shows
  *Cannot save here* and writes nothing.
- Opening `/proj/notes.md` from the tree after `Untitled-1` was saved there
  activates that existing tab instead of opening a second one.

---

## Verification

- `npm run typecheck` — passes.
- `npm test` — 29 tests pass.
- `grep -rn 'isActiveDirty' src/` — zero matches.
- `grep -rn '_openFiles\.\(get\|set\|delete\|has\)\b' src/` — zero matches
  (the map API is gone).
- `grep -rn 'baseName(file.getPath())' src/` — zero matches (replaced by
  `getName()`).
- `npm run build` — succeeds.
- `npm run tauri:dev`, then work through `## Expected Behaviour`'s manual
  sections in the File menu and the tab strip.

---

## Documentation Impact

Loom has no docs site; its prose lives in two files.

- `README.md` `## Highlights` — add a *New files* bullet covering *File > New
  File* and *Save* prompting for a location the first time.
- `TODO.md` `## High` — remove the `**New / untitled files.**` bullet, which
  this plan closes.

---

## Potential Challenges

- **Ctrl+N on macOS.** `isCtrlChord` accepts `ctrlKey` *or* `metaKey`, so
  CodeMirror's macOS emacs-style `Ctrl-N` (move cursor down) would also open a
  new file. Every existing chord has the same shape, so this plan keeps that
  shape rather than diverging; note the collision in the smoke test if a Mac
  is available.
- **The webview may claim Ctrl+N.** `installAccelerators` calls
  `preventDefault()` for chords it handles, which stops the webview's own
  new-window default in the normal case; confirm under `npm run tauri:dev`
  rather than `npm run dev`.
- **`markClean()` already relabels the tab.** It invokes `handleDirtyChange`,
  which calls `setTabName` and `syncActive`. `saveAs`'s own `setTabName` and
  `syncActive` calls after it are therefore redundant but harmless; the
  `## Implementation` body keeps them, matching today's code.

---

## Critical Files

- [`src/EditorController.ts`](src/EditorController.ts) — the whole file; every
  registry access, both save paths, and the close/exit prompts live here.
- [`src/editor/FileEditor.ts`](src/editor/FileEditor.ts) — the nullable-path
  change and the new `getName()`/`needsSave()` accessors.
- [`src/EditorController.ts:144`](src/EditorController.ts#L144) — today's
  `saveAs`, the precedent the untitled-save flow reuses: pick a target, refuse
  an already-open one, write, `setPath`, `markClean`, relabel.
- [`src/EditorController.ts:70`](src/EditorController.ts#L70) — today's
  `isActiveDirty`, whose `getActiveFile()?.x() ?? false` shape `canSaveActive`
  copies.
- [`src/shell/shortcuts.ts`](src/shell/shortcuts.ts) — the label + chord helper
  + `AcceleratorActions` + dispatch-ladder chain a new command must extend in
  all four places.
- [`src/shell/EditorShell.ts:74`](src/shell/EditorShell.ts#L74) —
  `buildMenuBar`, where the File menu's items and their `enabled` providers
  live.
- [`src/main.ts:19`](src/main.ts#L19) — the single `Glyph.register` call every
  menu glyph must be added to.
- [`tests/languages.test.ts`](tests/languages.test.ts) — the shape a new
  `languageForPath` case follows.

---

## Non-Goals

- **Persisting untitled buffers across restarts.** Unsaved buffer contents
  survive nothing today; session persistence is its own `TODO.md` item.
- **A file-name prompt inside the app.** The native save dialog is the only
  naming surface, matching how every other file operation in loom works.
- **Creating files from the tree** (a *New File* context-menu item on a folder
  row). `FileTree` has no context menu at all; adding one is separate work.
- **Refreshing the tree after a save creates a file on disk.** The tree does
  not watch the filesystem and has no manual refresh — a known `TODO.md` gap
  this plan does not close.
- **A language picker for a path-less buffer.** An untitled buffer stays plain
  text until it is saved and its extension resolves a language.
- **Reusing freed untitled numbers.** The counter only ever increases, so
  closing `Untitled-2` does not make the number 2 available again.

---

## Notes

[^reuse-setpath]: `setPath` already exists for *Save As* and does exactly what
    the first save of an untitled buffer needs — repoint `_path` and call
    `CodeEditor.setLanguage` with the new extension's language. Introducing an
    `UntitledEditor` subclass or a separate document model was rejected: both
    would need every `EditorController` call site to branch on the type, where
    a nullable field lets most call sites stay as they are.

[^name-field]: The alternative was deriving the display name on demand —
    `_path === null ? _untitledName : baseName(_path)` — with `_untitledName`
    only meaningful for path-less buffers. That leaves a constructor parameter
    that means nothing for most files. A single always-populated `_name` keeps
    one rule ("`_name` is what the tab shows"), and `setPath` is the only
    writer, so it cannot go stale. It also collapses the two existing
    `baseName(file.getPath())` calls in `EditorController` onto `getName()`.

[^registry-list]: A list also removes bookkeeping from `saveAs`, which today
    deletes the old key and inserts the new one after a rename; identity
    membership needs neither. The scan cost is irrelevant — the list holds one
    entry per open tab. Keeping the map and adding a parallel array for
    path-less buffers was rejected: two registries that have to be kept in
    agreement is the shape of bug that would leave `confirmExit` blind in the
    first place.

[^save-routing]: Concentrating the branch in `save` means `saveActive` and
    `confirmThenClose` need no null-path knowledge at all — `confirmThenClose`
    already reads `if (await this.save(file))` and keeps working unchanged once
    `saveAs` reports success. That is why `saveAs` changes from `Promise<void>`
    to `Promise<boolean>`: the unsaved-changes prompt must not close a tab when
    the user cancelled the save dialog. The status-bar `Saved <name>` message
    moves into `saveAs` as well, so both routes report identically; today
    *Save As* is silently different, and leaving it that way would make a first
    save of an untitled buffer feel like nothing happened.

[^needs-save]: `saveActive` currently returns early on a clean file, so a
    never-edited untitled buffer would be unsaveable if dirtiness stayed the
    only test. Putting the predicate on `FileEditor` rather than duplicating
    `dirty || path === null` in both `canSaveActive` and `saveActive` keeps one
    definition. The rename from `isActiveDirty` is deliberate: the method now
    answers "can Save do something", and a name saying "dirty" would mislead
    the next reader of the File menu's `enabled` expression.

[^no-reuse]: VS Code reuses the lowest free number, which needs a scan of the
    open buffers' names on every *New File*. Loom gains nothing from it: the
    names are labels, `_openFiles` is keyed by identity, and duplicate untitled
    names are impossible under a monotonic counter. The visible cost is that a
    long session of create-and-close reaches high numbers.

[^default-path]: Tauri's `save({ defaultPath })` treats a non-directory path as
    a file name plus a starting folder, so a bare `"Untitled-1"` gives it no
    folder to open in. Joining the project root produces a well-defined
    starting point. `EditorController` does not track the project root today —
    `openProjectFolder` hands the chosen root straight to the shell's listener —
    so one field is added there. Passing `null` for every untitled save was
    rejected: it drops the user into whatever directory the OS last used, which
    is rarely the project.
