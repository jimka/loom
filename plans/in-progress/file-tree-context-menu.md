---
depends-on: [filesystem-watching]
touches-shared: [src/explorer/FileTree.ts, src/EditorController.ts, src/shell/EditorShell.ts, src/data/workspace.ts, src/data/paths.ts, src/main.ts, src-tauri/capabilities/default.json, README.md, TODO.md]
---

# File Tree Context Menu — Implementation Plan

## Overview

Loom's file tree, [src/explorer/FileTree.ts:30](src/explorer/FileTree.ts#L30), only opens files —
there is no way to create, rename, or delete anything without leaving the
app. This plan adds a right-click context menu: new file/folder on a
directory or on empty tree space, rename and delete on any entry, and copy
path everywhere.

The menu is built from the library's `Menu` overlay primitive, following its
own documented right-click recipe. Every action that changes the filesystem
ends by calling `FileTree.refreshSubtree(dir)` — the operation
[plans/filesystem-watching.md](plans/filesystem-watching.md) adds for exactly
this purpose ("a future tree context menu calls it after a user-initiated
create, rename, or delete") — so this plan cannot start until that one has
landed. Renaming or deleting a file that is open in a tab is coordinated
through two new [`EditorController`](src/EditorController.ts) methods, which
close or repoint the affected tabs the same way
[`saveAs`](src/EditorController.ts#L407) already repoints a tab after a save
to a new path.

---

## Architecture Decisions

### The menu is the library's `Menu` primitive, wired via its documented recipe

Loom has no context menu anywhere yet, and neither does the `typescript-ui`
library ship a higher-level "tree context menu" component — the closest
precedent is `Menu`'s own rebuild-mode API
([overlay/Menu.ts:100](../typescript-ui/packages/lib/src/typescript/lib/overlay/Menu.ts#L100))
and the worked example in
[`docs/recipes/right-click-menu.md`](../typescript-ui/packages/lib/docs/recipes/right-click-menu.md):
one shared `Menu()` instance, shown per right-click with a fresh item list.
`FileTree` follows it exactly: one `Menu()` built in the constructor, shown
via `menu.show(event.clientX, event.clientY, items)`.

### Row hits and empty-space hits are resolved through two different listeners

`Tree` already resolves "which node was right-clicked" for us: it emits a
typed `"contextmenu"` event carrying the node, but *only* when the click
lands on a row — a click on empty tree space is deliberately left alone
([component/tree/Tree.ts:1176](../typescript-ui/packages/lib/src/typescript/lib/component/tree/Tree.ts#L1176)).
`FileTree` uses that event for a row hit, and a second, raw listener for the
empty-space case: `this.on('contextmenu', ...)` for the resolved node, and
`Event.addSubtreeListener(this, 'contextmenu', ...)` for everything else,
which the second listener recognises by checking `event.defaultPrevented`
[^context-menu-dispatch].

### Naming a new entry or a rename reuses `Dialog`'s content-component + validation-veto pattern

Loom has no text-input prompt yet — `unsavedPrompt.ts` and
`recentProjectPrompt.ts` are both button-only. `Dialog` already supports a
custom `contentComponent`
([overlay/Dialog.ts:114](../typescript-ui/packages/lib/src/typescript/lib/overlay/Dialog.ts#L114))
and an async `onClick` guard that can veto the close and show an inline
error without rebuilding the dialog
([overlay/Dialog.ts:90](../typescript-ui/packages/lib/src/typescript/lib/overlay/Dialog.ts#L90)),
and the validation module's `FieldDecorator` is the library's own
field-error affordance (red outline plus a hover tooltip)
([validation/FieldDecorator.ts:22](../typescript-ui/packages/lib/src/typescript/lib/validation/FieldDecorator.ts#L22)).
A new `src/explorer/fileTreePrompts.ts` builds every name prompt from these
two pieces: a `TextField` wrapped in a `FieldDecorator`, and a primary button
whose `onClick` validates the trimmed name — empty, containing a path
separator, or already existing — before resolving.

### Every mutation ends by refreshing the directory it touched

`FileTree.refreshSubtree(dir)` re-lists `dir` and rebuilds whatever the tree
had loaded below it, restoring expansion and selection
([plans/filesystem-watching.md](plans/filesystem-watching.md), `## Public API`).
Every action in this plan calls it exactly once, on the same directory the
filesystem watcher would itself target for the equivalent external change:

| Action | Refresh target | Matches watcher's own rule for |
|---|---|---|
| New file/folder inside directory `d` | `d` | a file created inside `d` |
| New file/folder at the workspace root | the project root | a file created at the root |
| Rename or delete of `p` | `parentDir(p)` | any change to `p` |

No second reload path is introduced; a directory that was never expanded is
left alone, exactly as `refreshSubtree` already does for the watcher, since
expanding it later lists it fresh anyway.

### Rename changes only an entry's own name, never its directory

The rename prompt is seeded with the entry's current base name and writes
back `joinPath(parentDir(path), newName)` — there is no way to type a new
parent directory. A full move (drag-and-drop, or a path field in the
rename prompt) is a materially bigger feature with its own conflict and
tab-coordination surface, and is out of scope here[^no-move].

### Deleting or renaming an open file's tab is coordinated through `EditorController`

`FileTree` already reports opened files to `EditorController` through an
`onOpenFile` callback in `FileTreeParams`; this plan adds two more —
`onPathDeleted` and `onPathRenamed` — wired the same way in
[`EditorShell`'s constructor](src/shell/EditorShell.ts#L73). `EditorController`
gains `closeFilesUnder(path)` and `relocateOpenFiles(oldPath, newPath)`,
using the same `FileEditor.setPath`
([editor/FileEditor.ts:203](src/editor/FileEditor.ts#L203)) and
`Tab.setTabName`/`closeTab` calls `saveAs`
([EditorController.ts:428](src/EditorController.ts#L428)) already uses after
a save moves a file to a new path. `closeFilesUnder` closes every open tab
under the deleted path with no unsaved-changes prompt: the user already
confirmed the delete, and there is no longer a file on disk to save a dirty
buffer back to[^force-close].

### File creation needs no new native permission; only remove and rename do

`mkdir` is already granted (`fs:allow-mkdir`), and creating a new *file*
reuses the already-granted `writeFileText`
([data/workspace.ts:122](src/data/workspace.ts#L122)), which creates the
file if it does not exist — so this plan adds no `fs:allow-create`
permission at all. Only `remove` and `rename` are new capability grants:
`fs:allow-remove` and `fs:allow-rename`, added to
[src-tauri/capabilities/default.json](src-tauri/capabilities/default.json)'s
`permissions` array[^permission-audit]. No `src-tauri` Rust code changes and
no new Cargo dependency — `tauri-plugin-fs` already exports all four
commands.

### Copy Path is included; Reveal in File Manager is not

Copy Path needs nothing beyond the plain `navigator.clipboard.writeText`
call the library's own notifications recipe already pairs with a context
menu action ("Pair with a context-menu action",
[`docs/recipes/notifications.md`](../typescript-ui/packages/lib/docs/recipes/notifications.md)) —
zero new dependencies, and it is one of the two actions every mainstream
file explorer's tree context menu offers alongside rename/delete. Reveal in
OS File Manager needs `tauri-plugin-shell`, a Tauri plugin Loom does not
depend on today — TODO.md's own Notes section already lists it as a
"relevant if ever wanted" future addition, not something already
available[^reveal-in-file-manager]. Adding a whole native plugin (Cargo
dependency, capability grant, Rust registration) for one convenience action
is disproportionate to this plan's scope; it stays a `## Non-Goals` item.

---

## Public API

```ts
// src/data/paths.ts

/**
 * Whether `name` is usable as a single path segment: non-empty after
 * trimming, and free of path separators (so it can never be misread as a
 * nested path when joined onto a directory).
 */
export function isValidEntryName(name: string): boolean

/**
 * Rewrites `path` — `dir` itself, or any entry under it — onto `newDir`,
 * preserving whatever comes after `dir` unchanged. Used to repoint an open
 * tab's tracked path after the tree renames the file or folder it belongs to.
 */
export function relocatePath(path: string, dir: string, newDir: string): string
```

```ts
// src/errors.ts  (new)

/** Turns a caught value into a display-safe message for a `Dialog.error` call. */
export function messageOf(error: unknown): string
```

```ts
// src/data/workspace.ts

/** Creates an empty directory at `path`. Rejects if a directory already exists at `path` or a parent segment is missing. */
export async function createDirectory(path: string): Promise<void>

/** Renames or moves `oldPath` to `newPath`. */
export async function renamePath(oldPath: string, newPath: string): Promise<void>

/** Deletes the file or directory at `path`. `isDir` must be `true` for a non-empty directory to be removed. */
export async function removePath(path: string, isDir: boolean): Promise<void>
```

```ts
// src/explorer/fileTreePrompts.ts  (new)

/**
 * Prompts for a new file or folder's name inside `dir`, re-showing an inline
 * error (empty name, a `/`/`\` in the name, or an existing entry with the
 * same name) instead of closing. Resolves the new entry's absolute path, or
 * `null` if the user cancels.
 */
export async function promptNewEntryName(dir: string, kind: 'file' | 'folder'): Promise<string | null>

/**
 * Prompts for `path`'s new name, seeded with its current base name selected.
 * Resolves the new absolute path, `null` if the user cancels, and `null`
 * (a no-op, not an error) if they submit the unchanged name.
 */
export async function promptRenameName(path: string, isDir: boolean): Promise<string | null>

/** Confirms deleting `path`, naming it and — for a directory — warning that its contents go with it. */
export async function confirmDelete(path: string, isDir: boolean): Promise<boolean>
```

```ts
// src/explorer/FileTree.ts

export interface FileTreeParams {
    onOpenFile: (path: string) => void
    /** Called after the tree deletes a file or folder, with its path. */
    onPathDeleted: (path: string) => void
    /** Called after the tree renames a file or folder, with its old and new paths. */
    onPathRenamed: (oldPath: string, newPath: string) => void
}
```

```ts
// src/EditorController.ts

/**
 * Closes every open tab whose file is `path` itself or lies under it — called
 * after the tree deletes a file or folder. No unsaved-changes prompt: the
 * delete was already confirmed, and the file no longer exists to save back to.
 *
 * @param path - The deleted file or folder's path.
 */
closeFilesUnder(path: string): void

/**
 * Repoints every open tab under `oldPath` (inclusive) onto its new location
 * after the tree renames a file or folder. Keeps each buffer's content and
 * dirty state; only the tracked path, tab label, and (where the tab strip
 * supports it) icon change.
 *
 * @param oldPath - The renamed entry's previous path.
 * @param newPath - The renamed entry's new path.
 */
relocateOpenFiles(oldPath: string, newPath: string): void
```

---

## Internal Structure

### Resolving a row hit vs. an empty-space hit

```ts
// src/explorer/FileTree.ts, in the constructor
this.on('contextmenu', this.handleNodeContextMenu)
Event.addSubtreeListener(this, 'contextmenu', this.handleBackgroundContextMenu)
```

```ts
/** `Tree`'s own `"contextmenu"` event: fires only when a row is right-clicked, with that row's node already resolved. */
private handleNodeContextMenu = (node: TreeNode, event: MouseEvent): void => {
    const data = node.data as FileTreeNodeData
    const items = data.isDir ? this.buildDirectoryMenuItems(data.path) : this.buildFileMenuItems(data.path)

    this._menu.show(event.clientX, event.clientY, items)
}

/**
 * Raw `contextmenu` listener that fires for every right-click inside the
 * tree, row hits included. `event.defaultPrevented` is what tells a row hit
 * (already shown its own menu by {@link handleNodeContextMenu}, via `Tree`'s
 * own row-matching handler) apart from empty space — see
 * `## Architecture Decisions`.
 */
private handleBackgroundContextMenu = (event: MouseEvent): Event.ListenerResult => {
    if (event.defaultPrevented || this._root === null) {
        return
    }

    this._menu.show(event.clientX, event.clientY, this.buildRootMenuItems(this._root))

    return { prevent: true }
}
```

`handleNodeContextMenu` is registered through `Tree`'s own `on('contextmenu', ...)`
overload, which only fires for a resolved node and already suppresses the
native menu on our behalf. `handleBackgroundContextMenu` is registered
separately, as a raw DOM listener that fires for *every* contextmenu event
inside the tree, row hits included — `event.defaultPrevented` is what tells
the two apart: `Tree`'s own row-matching handler calls `preventDefault()`
before it emits `"contextmenu"`, and registers before `FileTree`'s own
constructor body runs, so by the time `handleBackgroundContextMenu` sees the
event, that flag is already set for a row hit[^context-menu-dispatch].

### Menu item builders

```ts
/** A file row's menu: rename, delete, and copy its path. */
private buildFileMenuItems(path: string): MenuItemConfig[] {
    return [
        { text: 'Rename', glyph: 'pen-to-square', action: () => { void this.renameEntry(path, false) } },
        { text: 'Delete', glyph: 'trash', action: () => { void this.deleteEntry(path, false) } },
        { separator: true },
        { text: 'Copy Path', glyph: 'copy', action: () => { void this.copyPath(path) } },
    ]
}

/** A directory row's menu: create inside it, then rename, delete, and copy its own path. */
private buildDirectoryMenuItems(path: string): MenuItemConfig[] {
    return [
        { text: 'New File', glyph: 'file-circle-plus', action: () => { void this.createFile(path) } },
        { text: 'New Folder', glyph: 'folder-plus', action: () => { void this.createFolder(path) } },
        { separator: true },
        { text: 'Rename', glyph: 'pen-to-square', action: () => { void this.renameEntry(path, true) } },
        { text: 'Delete', glyph: 'trash', action: () => { void this.deleteEntry(path, true) } },
        { separator: true },
        { text: 'Copy Path', glyph: 'copy', action: () => { void this.copyPath(path) } },
    ]
}

/** Empty tree space's menu: create at the workspace root. */
private buildRootMenuItems(root: string): MenuItemConfig[] {
    return [
        { text: 'New File', glyph: 'file-circle-plus', action: () => { void this.createFile(root) } },
        { text: 'New Folder', glyph: 'folder-plus', action: () => { void this.createFolder(root) } },
    ]
}
```

### The action methods

Each method prompts (or confirms), performs the one matching `workspace.ts`
call inside a `try`/`catch` that reports failure via `Dialog.error`, then —
only on success — notifies `EditorController` (rename/delete) and calls
`refreshSubtree`:

```ts
/**
 * Prompts for a new file's name inside `dir`, creates it, and opens it.
 * `selectPath` reveals it even when `dir` was collapsed or never loaded:
 * `refreshSubtree` is then a no-op (see `## Architecture Decisions`), but
 * `selectPath`'s own existing fallback — already used to sync the tree to
 * the active tab — expands and loads whatever is needed to find the new
 * path, so no separate "expand the directory" step is needed here.
 */
private async createFile(dir: string): Promise<void> {
    const path = await promptNewEntryName(dir, 'file')

    if (path === null) {
        return
    }

    try {
        await writeFileText(path, '')
    } catch (error) {
        await Dialog.error('Could not create file', messageOf(error))

        return
    }

    await this.refreshSubtree(dir)
    await this.selectPath(path)
    this._onOpenFile(path)
}
```

```ts
/** Prompts for `path`'s new name, renames it on disk, relocates any open tab under it, and refreshes/reselects the tree. */
private async renameEntry(path: string, isDir: boolean): Promise<void> {
    const newPath = await promptRenameName(path, isDir)

    if (newPath === null) {
        return
    }

    try {
        await renamePath(path, newPath)
    } catch (error) {
        await Dialog.error('Could not rename', messageOf(error))

        return
    }

    this._onPathRenamed(path, newPath)
    await this.refreshSubtree(parentDir(path))
    await this.selectPath(newPath)
}
```

`createFolder` and `deleteEntry` follow the same shape (see
`## Ordered Implementation Steps`); `deleteEntry` calls `confirmDelete`
instead of a name prompt, and calls `this._onPathDeleted(path)` before
refreshing. `copyPath` has no fs call and no refresh:

```ts
/** Copies `path` to the clipboard and shows a brief success toast — the only action with no visible tree change of its own. */
private async copyPath(path: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(path)
        Notification.show('Path copied.', 'success')
    } catch (error) {
        await Dialog.error('Could not copy path', messageOf(error))
    }
}
```

### `EditorController`'s tab coordination

```ts
// src/EditorController.ts
closeFilesUnder(path: string): void {
    const affected = this._openFiles.filter(file => {
        const filePath = file.getPath()

        return filePath !== null && isUnderRoot(path, filePath)
    })

    for (const file of affected) {
        this.tabs.getTab().closeTab(file)
    }
}

relocateOpenFiles(oldPath: string, newPath: string): void {
    for (const file of this._openFiles) {
        const filePath = file.getPath()

        if (filePath !== null && isUnderRoot(oldPath, filePath)) {
            file.setPath(relocatePath(filePath, oldPath, newPath))
            this.tabs.getTab().setTabName(file, file.getLabel())
        }
    }

    this.syncActive()
}
```

`isUnderRoot(a, b)` is already true when `a === b`
([data/paths.ts:182](src/data/paths.ts#L182)), so one call covers both "the
renamed/deleted entry is itself an open file" and "an open file sits under
the renamed/deleted directory" — no separate exact-match check is needed.
`closeFilesUnder` snapshots the matching files into `affected` before
closing any of them, because `closeTab` triggers `handleTabClose`
([EditorController.ts:581](src/EditorController.ts#L581)), which splices
`_openFiles` — iterating `_openFiles` directly while closing would skip
entries. `relocateOpenFiles`'s final `syncActive()` call refreshes the
window title when the active tab is one of the files just relocated; it is
the same call `handleActivate`/`handleDirtyChange` already make after any
other change to an open file's state.

### The shared name-prompt dialog

```ts
// src/explorer/fileTreePrompts.ts

/**
 * Prompts for a name via a text field inside a modal dialog, re-showing an
 * inline validation error (via `FieldDecorator`) instead of closing when
 * `validate` rejects the trimmed value.
 *
 * @param title - The dialog's title.
 * @param confirmLabel - The primary button's label.
 * @param initialValue - The field's starting text, pre-selected.
 * @param validate - Checked on confirm; returns an error message, or `null` when the name is acceptable.
 * @returns The trimmed, accepted name, or `null` if the user cancels.
 */
async function promptName(
    title: string, confirmLabel: string, initialValue: string,
    validate: (name: string) => Promise<string | null>,
): Promise<string | null> {
    const field = TextField({ text: initialValue })
    const body = Container({ layoutManager: Fit(), components: [field] })
    const decorator = FieldDecorator(field, body)

    field.select()
    field.on('change', () => decorator.clearError())

    let confirmed: string | null = null

    await Dialog.show({
        title,
        contentComponent: body,
        initialFocus: field,
        buttons: [
            { text: 'Cancel', result: 'cancel' },
            {
                text: confirmLabel,
                result: 'confirm',
                primary: true,
                onClick: async () => {
                    const name = field.getValue().trim()
                    const problem = await validate(name)

                    if (problem !== null) {
                        decorator.showError(problem)

                        return false
                    }

                    confirmed = name

                    return true
                },
            },
        ],
    })

    return confirmed
}
```

`promptNewEntryName` and `promptRenameName` each build a `validate` closure
and call `promptName`:

```ts
// src/explorer/fileTreePrompts.ts
export async function promptNewEntryName(dir: string, kind: 'file' | 'folder'): Promise<string | null> {
    const validate = async (name: string): Promise<string | null> => {
        if (!isValidEntryName(name)) {
            return 'Enter a name with no "/" or "\\".'
        }

        if (await pathExists(joinPath(dir, name))) {
            return `"${name}" already exists here.`
        }

        return null
    }

    const title = kind === 'file' ? 'New File' : 'New Folder'
    const name = await promptName(title, 'Create', '', validate)

    return name === null ? null : joinPath(dir, name)
}

export async function promptRenameName(path: string, isDir: boolean): Promise<string | null> {
    const dir = parentDir(path)
    const currentName = baseName(path)

    const validate = async (name: string): Promise<string | null> => {
        if (!isValidEntryName(name)) {
            return 'Enter a name with no "/" or "\\".'
        }

        const target = joinPath(dir, name)

        if (target !== path && await pathExists(target)) {
            return `"${name}" already exists here.`
        }

        return null
    }

    const name = await promptName(`Rename "${currentName}"`, 'Rename', currentName, validate)

    if (name === null) {
        return null
    }

    const newPath = joinPath(dir, name)

    return newPath === path ? null : newPath
}
```

`promptRenameName`'s `validate` excludes `path` itself from the conflict
check (`target !== path`) — otherwise every unchanged submission would flag
"already exists" against its own current file. The final `newPath === path`
check is what turns an unchanged submission into a `null` (no-op) result:
`validate` accepted it (it isn't a conflict with itself), so `promptName`
resolved it as confirmed, and this is the one place that recognises nothing
actually needs to change.

### The delete confirmation

```ts
// src/explorer/fileTreePrompts.ts
export async function confirmDelete(path: string, isDir: boolean): Promise<boolean> {
    const name = baseName(path)
    const message = isDir
        ? `"${name}" and everything inside it will be permanently deleted. This can't be undone.`
        : `"${name}" will be permanently deleted. This can't be undone.`

    const result = await Dialog.show({
        title: `Delete "${name}"?`,
        message,
        buttons: [
            { text: 'Cancel', result: 'cancel' },
            { text: 'Delete', result: 'confirm', primary: true },
        ],
    })

    return result === 'confirm'
}
```

The explicit `'Delete'`/`'Cancel'` button pair mirrors `Dialog`'s own
class-level `@example` for exactly this case
([overlay/Dialog.ts:636](../typescript-ui/packages/lib/src/typescript/lib/overlay/Dialog.ts#L636))
rather than the generic `Dialog.confirm(title, message)` helper, whose
"Confirm" button reads ambiguous for a destructive action — the same reason
`unsavedPrompt.ts` builds its own dialog instead of using that helper.

---

## Ordered Implementation Steps

1. **Grant the two new permissions.** In
   [src-tauri/capabilities/default.json](src-tauri/capabilities/default.json)
   add `"fs:allow-remove"` and `"fs:allow-rename"` to the `permissions`
   array, alongside the existing `fs:allow-*` entries. No Cargo or Rust
   change. Checkpoint: `grep -n 'allow-remove\|allow-rename'
   src-tauri/capabilities/default.json` — two matches.

2. **Add the fs wrappers.** In [src/data/workspace.ts](src/data/workspace.ts),
   add `rename` and `remove` to the existing `@tauri-apps/plugin-fs` import
   on line 7, and add `createDirectory`, `renamePath`, `removePath` from
   `## Public API` below `pathExists`. `npm run typecheck` — clean.

3. **Extract the shared error-formatting helper.** Create
   `src/errors.ts` with `messageOf` from `## Public API` (move the existing
   private function body out of
   [src/EditorController.ts:16](src/EditorController.ts#L16)). Delete the
   private declaration in `EditorController.ts` and import `{ messageOf }`
   from `./errors` instead; its four existing call sites are unchanged.
   `npm run typecheck` — clean.

4. **Add `isValidEntryName` and `relocatePath` (test-first).** Write the
   cases from `## Expected Behaviour` into `tests/paths.test.ts`, following
   its existing `describe`/`it` groups per function. `npm test` fails to
   resolve the two names, then add both functions to
   [src/data/paths.ts](src/data/paths.ts) per `## Public API`. `npm test`
   goes green.

5. **Register the new glyphs.** In [src/main.ts](src/main.ts), import
   `folder_plus`, `trash`, and `copy` from their
   `@jimka/typescript-ui/glyphs/solid/*` paths (mirroring the existing
   imports on lines 4–13) and add them to the `Glyph.register(...)` call on
   line 24. `pen-to-square` and `folder` are already registered and reused
   for Rename and the directory icon.

6. **Create `src/explorer/fileTreePrompts.ts`.** Implement `promptName`,
   `promptNewEntryName`, `promptRenameName`, and `confirmDelete` per
   `## Internal Structure` (*The shared name-prompt dialog* and *The delete
   confirmation*) and `## Public API`. Imports: `Container` from
   `@jimka/typescript-ui/core`; `Fit` from `@jimka/typescript-ui/layout`;
   `TextField` from `@jimka/typescript-ui/component/input`; `Dialog` from
   `@jimka/typescript-ui/overlay`; `FieldDecorator` from
   `@jimka/typescript-ui/validation`; `pathExists` from `../data/workspace`;
   `joinPath`, `baseName`, `parentDir`, `isValidEntryName` from
   `../data/paths`. `npm run typecheck` — clean.

7. **Extend `FileTreeParams` and wire the context-menu listeners.** In
   [src/explorer/FileTree.ts](src/explorer/FileTree.ts): add `onPathDeleted`
   and `onPathRenamed` to `FileTreeParams` (lines 21–24) and store them as
   `_onPathDeleted`/`_onPathRenamed` fields, assigned in the constructor next
   to the existing `_onOpenFile` assignment (line 46). Import `Event` from
   `@jimka/typescript-ui/core`, `Menu` and `Notification` and `Dialog` from
   `@jimka/typescript-ui/overlay`, `MenuItemConfig` from
   `@jimka/typescript-ui/component/container`, `messageOf` from `../errors`,
   the three prompt functions from `./fileTreePrompts`, and
   `writeFileText`/`createDirectory`/`renamePath`/`removePath` alongside the
   existing `../data/workspace` import. Add `parentDir` to the existing
   `../data/paths` import (currently just `joinPath`, line 8). Add
   `private readonly _menu = Menu()` and the two `this.on(...)` /
   `Event.addSubtreeListener(...)` registrations from `## Internal Structure`
   at the end of the constructor. `npm run typecheck` — clean.

8. **Add the menu builders and action methods.** In the same file, add
   `buildFileMenuItems`, `buildDirectoryMenuItems`, `buildRootMenuItems`,
   `handleNodeContextMenu`, `handleBackgroundContextMenu`, and
   `createFile`/`createFolder`/`renameEntry`/`deleteEntry`/`copyPath` from
   `## Internal Structure`. `createFolder` mirrors `createFile` but calls
   `createDirectory` and does not call `_onOpenFile`; `deleteEntry` mirrors
   `renameEntry` but calls `confirmDelete` (returning early when it resolves
   `false`), `removePath(path, isDir)`, and `this._onPathDeleted(path)`
   instead of a rename. `npm run typecheck` — clean.

9. **Add the `EditorController` coordination methods.** In
   [src/EditorController.ts](src/EditorController.ts), add `relocatePath` to
   the existing `./data/paths` import (line 9, alongside `isUnderRoot`, which
   is already imported), and add `closeFilesUnder` and `relocateOpenFiles`
   from `## Internal Structure` (signatures also in `## Public API`) near
   `getOpenFilePaths`. `npm run typecheck` — clean.

10. **Wire the two new callbacks in `EditorShell`.** In
    [src/shell/EditorShell.ts:73](src/shell/EditorShell.ts#L73), extend the
    `FileTree({ ... })` call with
    `onPathDeleted: (path: string) => controller.closeFilesUnder(path)` and
    `onPathRenamed: (oldPath: string, newPath: string) => controller.relocateOpenFiles(oldPath, newPath)`.
    `npm run typecheck` — clean.

11. **Checkpoint.** `npm run typecheck` and `npm test` — clean.
    `grep -rn 'messageOf' src/EditorController.ts` — one match (the import),
    zero remaining local declarations.

12. **Update the docs** per `## Documentation Impact`.

13. **Run `## Verification`.**

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src-tauri/capabilities/default.json` |
| Modify | `src/data/workspace.ts` |
| Modify | `src/data/paths.ts` |
| Modify | `tests/paths.test.ts` |
| Create | `src/errors.ts` |
| Modify | `src/main.ts` |
| Create | `src/explorer/fileTreePrompts.ts` |
| Modify | `src/explorer/FileTree.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### `isValidEntryName` — unit-testable

| Input | Result | Why |
|---|---|---|
| `'notes.md'` | `true` | ordinary name |
| `''` | `false` | empty |
| `'   '` | `false` | whitespace-only |
| `'a/b'` | `false` | contains `/` |
| `'a\\b'` | `false` | contains `\` |
| `'  notes.md  '` | `true` | surrounding whitespace is trimmed before the check |

### `relocatePath` — unit-testable

| `path` | `dir` | `newDir` | Result |
|---|---|---|---|
| `/p/old` | `/p/old` | `/p/new` | `/p/new` (the renamed entry itself) |
| `/p/old/a.ts` | `/p/old` | `/p/new` | `/p/new/a.ts` (a file under a renamed directory) |
| `/p/old/sub/a.ts` | `/p/old` | `/p/new` | `/p/new/sub/a.ts` (a nested descendant) |

### Tree behaviour — manual verification in `npm run tauri:dev`

Open the Loom repo itself as the project folder.

- **New File / New Folder on a directory.** Right-click `src/data`: the menu
  shows New File, New Folder, a separator, Rename, Delete, a separator, Copy
  Path — in that order. New File prompts, creating `probe.ts` under
  `src/data` opens it in a new tab, selects its row, and the row appears
  without collapsing `src`. New Folder does the same but does not open a tab.
- **New File / New Folder on empty space.** Collapse everything, right-click
  below the last row: the menu shows only New File and New Folder, and the
  created entry lands at the project root.
- **New File inside a collapsed, never-expanded directory.** Collapse `src`
  (or restart so it was never expanded), right-click it → New File: the
  directory expands to reveal the new file's row, selected — `selectPath`'s
  existing reveal fallback does this even though `refreshSubtree` itself was
  a no-op for a directory the tree had never loaded (see `## Internal
  Structure` ▸ *The action methods*).
- **Rename on a file.** Right-click `README.md` → Rename: the field shows
  `README.md` selected. Submitting `READYOU.md` renames the file on disk,
  updates the tree row, and re-selects it under the new name. Rename it back
  to `README.md` afterward the same way.
- **Delete on a file.** Right-click a scratch file → Delete → confirm: the
  file is removed from disk and its row disappears.
- **Delete on a directory.** Create a scratch folder with a scratch file
  inside, expand it, then delete the folder: both the folder and its child
  disappear from the tree in one refresh.
- **Naming conflict is handled inline, not thrown.** Right-click `src` →
  New Folder → type `data` (already exists): the dialog stays open, the
  field shows a red outline, and hovering it shows
  `"data" already exists here.` — no unhandled rejection, no closed dialog.
- **Empty and separator-containing names are rejected the same way.** Same
  New Folder prompt, submit `` (empty) or `a/b`: the dialog stays open with
  an inline error in both cases.
- **Renaming to the same name is a silent no-op.** Right-click a file →
  Rename → submit the field unchanged: the dialog closes, nothing is written
  to disk, and no refresh happens.
- **Deleting an open file's tab.** Open `src/data/probe.ts` (create it first
  if needed), then delete it from the tree: its tab closes immediately, with
  no unsaved-changes prompt, even if the buffer was dirty.
- **Deleting a directory closes every tab under it.** Open two files inside a
  scratch folder, then delete the folder from the tree: both tabs close.
- **Renaming an open file's tab repoints it, not closes it.** Open
  `src/data/probe.ts`, dirty it (type something, don't save), then rename it
  to `probe2.ts` from the tree: the tab stays open, keeps its edited content
  and its dirty indicator, and its label changes to `probe2.ts`.
- **Renaming a directory relocates every open tab under it.** Open a file
  inside a scratch folder, then rename the folder from the tree: the open
  tab's breadcrumbs and window title (if it's the active tab) update to the
  new path with no interruption.
- **Copy Path.** Right-click any file → Copy Path: a "Path copied." success
  toast appears, and pasting elsewhere yields the file's absolute path.
- **A background right-click with no project open does nothing.** Close the
  project (or launch fresh with none restored) and right-click the empty
  tree area: no menu appears, no console error.

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — the new `tests/paths.test.ts` cases green alongside the
  existing suites.
- `grep -n 'allow-remove\|allow-rename' src-tauri/capabilities/default.json`
  — two matches.
- `grep -rn 'messageOf' src/EditorController.ts` — one match (the import).
- `cargo check --manifest-path src-tauri/Cargo.toml` — clean (capabilities
  changed, no Cargo.toml edit).
- `npm run build` — frontend production build succeeds.
- `npm run tauri:dev`, then walk every case in `## Expected Behaviour` ▸
  *Tree behaviour*.

---

## Documentation Impact

- [README.md](README.md) — the *File tree* bullet in `## Highlights` gains a
  sentence: right-click offers new file/folder, rename, delete, and copy
  path.
- [TODO.md](TODO.md) — delete the **Context menu in FileTree** bullet from
  `## High` (it is fully addressed: create, rename, delete, plus copy path).

There is no docs site or export barrel to update; every module this plan
touches is app-internal.

---

## Potential Challenges

- **A cross-extension rename leaves a stale open tab icon.** `Tab` has no
  `setTabGlyph` (see TODO.md's *Library `Tab.setTabGlyph`* and *Stale tab
  icon* items), so renaming an open `notes.md` to `notes.txt` from the tree
  updates its label but not its icon — the same pre-existing limitation a
  cross-type Save As already has. Not fixed here; it needs the same
  not-yet-existing library API.
- **`navigator.clipboard.writeText` can reject** (no user-gesture context,
  or a locked-down webview). `copyPath`'s `try`/`catch` turns that into a
  `Dialog.error` instead of an unhandled rejection; worth confirming on
  Linux/WebKitGTK during manual verification, per the existing WebKitGTK
  quirks noted in TODO.md.
- **A conflict check racing a concurrent external change.** `pathExists`
  is checked once, when the button is clicked; a file created by another
  process in the same instant could still collide. The underlying `mkdir`/
  `writeTextFile`/`rename` call is the real guard — its rejection still
  surfaces via `Dialog.error` rather than corrupting anything.

---

## Critical Files

- [src/explorer/FileTree.ts](src/explorer/FileTree.ts) — the class every
  new method is added to; its constructor, `FileTreeParams`, and
  `refreshSubtree`/`selectPath` are what every action calls into.
- [plans/filesystem-watching.md](plans/filesystem-watching.md) — defines
  `refreshSubtree(dir)`'s exact contract and no-op rule; read it before
  calling the method from any new code path.
- [../typescript-ui/packages/lib/src/typescript/lib/overlay/Menu.ts](../typescript-ui/packages/lib/src/typescript/lib/overlay/Menu.ts) —
  the rebuild-mode API (`show`) this plan's single shared instance uses.
- [../typescript-ui/packages/lib/docs/recipes/right-click-menu.md](../typescript-ui/packages/lib/docs/recipes/right-click-menu.md) —
  the pattern `FileTree`'s context-menu wiring follows.
- [../typescript-ui/packages/lib/src/typescript/lib/component/tree/Tree.ts](../typescript-ui/packages/lib/src/typescript/lib/component/tree/Tree.ts) —
  `_handleContextMenu` (line 1188) is what the empty-space listener's
  `event.defaultPrevented` check relies on.
- [../typescript-ui/packages/lib/src/typescript/lib/overlay/Dialog.ts](../typescript-ui/packages/lib/src/typescript/lib/overlay/Dialog.ts) —
  `contentComponent`, the `onClick` veto, and the class's own `@example`
  (the `'Delete'`/`'Cancel'` button pair `confirmDelete` mirrors).
- [../typescript-ui/packages/lib/src/typescript/lib/validation/FieldDecorator.ts](../typescript-ui/packages/lib/src/typescript/lib/validation/FieldDecorator.ts) —
  `showError`/`clearError`, used directly (not through the heavier
  `Binding`/`ValidationRule` engine, since the conflict check is async).
- [src/EditorController.ts](src/EditorController.ts) — `saveAs` (line 407)
  is the precedent `relocateOpenFiles` mirrors for repointing an open tab
  after its path changes; `closeActive`/`confirmThenClose` (lines 495, 557)
  are what `closeFilesUnder` deliberately bypasses.
- [src/data/workspace.ts](src/data/workspace.ts) — the sole `@tauri-apps/*`
  entry point; read its header comment before adding the three new wrappers.
- [src-tauri/capabilities/default.json](src-tauri/capabilities/default.json) —
  the permission list this plan adds two entries to.

---

## Non-Goals

- **Reveal in OS File Manager.** Needs `tauri-plugin-shell`, a dependency
  Loom does not have; see the Architecture Decision above.
- **Copy Relative Path**, alongside the absolute-path Copy Path. One path
  action is enough for a first version; a second, near-identical menu item
  is more clutter than value until someone asks for it.
- **Moving an entry to a different directory** (drag-and-drop, or a
  directory field in the rename prompt). Rename only changes the base name.
- **Cut/copy/paste of files.** No precedent in this codebase and a much
  larger surface (clipboard-held path state, paste-target resolution,
  cross-app paste) than this plan's scope.
- **Inline (in-tree) rename editing.** `Tree` has no editable-label mode;
  building one is a separate library feature, not a consumer-side task.
- **Multi-select context-menu actions.** A right-click never changes the
  tree's selection (`Tree`'s own documented behaviour) and always targets
  the node under the cursor; bulk rename/delete over a multi-selection is a
  separate feature.
- **Keyboard shortcuts** (Delete key, F2 rename) for these actions. The task
  is a right-click menu; shortcuts are a natural follow-on, not required here.
- **Renaming or deleting the open project folder itself.** The tree never
  renders a row for its own root — only the root's children are rows — so
  this isn't reachable through the tree at all.
- **Entering an inline rename-mode right after creating an entry**, the way
  some file explorers let a freshly-created file's name be typed in place.
  `Tree` has no editable-label mode (see the inline-rename Non-Goal above),
  so the new entry's dialog-based name is final once created; renaming it
  again goes through the same Rename menu item as any other entry.

---

## Notes

[^context-menu-dispatch]: `Event`'s dispatcher keeps one array of listener
    entries per `(component, event type)` pair and runs them in registration
    order on every matching event
    ([core/Event.ts:438](../typescript-ui/packages/lib/src/typescript/lib/core/Event.ts#L438),
    `registerEntry`/`baseListener`). `Tree`'s own subtree listener is
    registered inside `Tree`'s constructor, which — because `FileTree extends
    Tree` — always finishes running before any statement in `FileTree`'s own
    constructor body executes. So `FileTree`'s `Event.addSubtreeListener`
    registration is always the second entry for `(this, 'contextmenu')`, and
    always sees the event after `Tree`'s own handler has already run for the
    same dispatch. On a row hit, `Tree`'s handler calls the real DOM
    `event.preventDefault()` before returning; on empty space it calls
    nothing. `event.defaultPrevented` is a standard, directly-inspectable DOM
    flag reflecting exactly that — no custom "handled" bookkeeping is needed,
    and the check only ever has to be correct about something JavaScript's
    own constructor-ordering guarantee already fixes.

[^no-move]: A rename-to-move prompt would need its own directory picker (or
    a full path field with its own validation and a different conflict
    story — moving into an existing directory of the same name is legal,
    unlike a plain rename), plus deciding whether it drags open tabs across
    an arbitrarily different subtree the same way `relocateOpenFiles`
    already does for a same-directory rename. None of that is asked for
    here; F2-style rename (name only) is what every mainstream file
    explorer offers as its default "Rename" action, with drag-and-drop
    handling the move case separately.

[^force-close]: Two options were weighed for a dirty tab whose file gets
    deleted from the tree. Routing it through the same `promptUnsavedChanges`
    dialog `closeActive` uses would ask the user to confirm losing changes
    *twice* for one action — once at `confirmDelete`, once again per open
    tab — for a file whose on-disk copy the first confirmation already
    destroyed; saving over it is not even a coherent choice once the delete
    has happened. Force-closing via `closeTab` (documented as the
    unguarded, veto-free path) is what this plan uses instead: one
    confirmation, matching what actually happened on disk.

[^permission-audit]: Verified against the vendored crate
    (`tauri-plugin-fs-2.5.1/permissions/autogenerated/commands/*.toml`):
    `create`, `remove`, `rename`, and `mkdir` each define their own
    `allow-*`/`deny-*` permission pair, prefixed `fs:` in a capabilities
    file exactly like the already-granted `fs:allow-mkdir` and
    `fs:allow-write-text-file`. `mkdir` and `write-text-file` are already
    granted (session-persistence's `.loom` folder and file-saving both use
    them), so only `fs:allow-remove` and `fs:allow-rename` are new; the
    `create` command's own permission (`fs:allow-create`) is never added,
    since this plan never calls the `create` command — file creation goes
    through the already-permitted `write_text_file`.

[^reveal-in-file-manager]: `tauri-plugin-shell`'s `open` command opens a
    path (or URL) with the OS default handler/app — the mechanism a Reveal
    in File Manager action would need. TODO.md's Notes section already
    names it as a plugin "if ever wanted," listed alongside
    `plugin-clipboard-manager` and `plugin-notification` as native
    capabilities Loom has deliberately not added yet. Adding it for this one
    menu item is a heavier change (new Cargo dependency, new capability
    grant, new Rust plugin registration in `src-tauri/src/lib.rs`) than
    everything else in this plan combined.

---

## Implementation Notes

**No codebase drift beyond line numbers.** Every symbol, API, and precedent
the plan cites — `FileTree.refreshSubtree`/`selectPath`, `Menu`'s rebuild-mode
`show`, `Dialog`'s `contentComponent`/async `onClick` veto, `FieldDecorator`,
`TextField`, `EditorController.saveAs`, `isUnderRoot` — was unchanged in
substance on this branch's start point. Only a handful of cited line numbers
had shifted by a few lines (e.g. the `_onOpenFile` constructor assignment the
plan cites at `FileTree.ts:46` sits at line 63 on this branch; the
`FileTree({ ... })` call the plan cites at `EditorShell.ts:73` sits at line
74). No adaptation beyond following the current line was needed; every
snippet in `## Internal Structure` was used as written.

**The "Tree behaviour" manual-verification pass in `## Verification` was not
run live in this environment.** Two prior plans on this branch chain
(`drag-and-drop-open.md`, and others referenced in `TODO.md`'s history) were
verified against a real `npm run tauri:dev` process using an isolated Xvfb
display driven by `xdotool`/`python-xlib`, and this implementation attempted
the same: extracting a local `Xvfb` (via `apt-get download` + `dpkg-deb -x`,
no root, mirroring the technique those earlier passes used) and working
around its missing `/usr/bin/xkbcomp` dependency with an unprivileged
`unshare --mount` + overlayfs bind trick. That got as far as a working,
standalone `Xvfb :98` process with a correct keymap. Every attempt to keep it
running past a single foreground command — backgrounding it, `run_in_background`,
even a bare `pkill -f "Xvfb :98"` cleanup call with no `unshare` involved —
was killed by this session's own sandbox before completing, consistently and
reproducibly, unlike every other command run during this implementation. That
pattern reads as this sandbox actively disallowing a spawned X/display-server
process specifically (not a flaky environment or a fixable dependency gap),
so the attempt was abandoned rather than fought further per the implement
skill's guidance not to route around a deliberate restriction.

None of the plan's 14 manual `## Expected Behaviour` ▸ *Tree behaviour* cases
were therefore driven live. They remain exactly as the plan already describes
them — expected behaviour was written down before this code existed, and the
code was implemented to match it — but confirming them against the real app
is left as a genuine manual step: run `npm run tauri:dev` and walk each case
in that section. This is the escape hatch's honest "documented manual-verify
step," not a silent skip: the gap is recorded here rather than left
unmentioned, and every unit-testable piece of this plan (`isValidEntryName`,
`relocatePath`) is covered by a real, passing, contract-derived test in
`tests/paths.test.ts` instead.

**The `^context-menu-dispatch` footnote's ordering claim is wrong, and
`FileTree.handleBackgroundContextMenu` was changed to not depend on it.** The
footnote asserts `Tree`'s own subtree listener for `"contextmenu"` "is
registered inside `Tree`'s constructor," always finishing "before any
statement in `FileTree`'s own constructor body executes." It isn't: tracing
`Tree.ts` shows that registration
(`Event.addSubtreeListener(this, "contextmenu", this._handleContextMenu)`)
lives in `Tree.init()`, not `Tree`'s constructor — `init()` runs only from
`Component.render()`, itself invoked lazily on first `getElement(true)`
(i.e. first real DOM mount), which for `FileTree` happens well after its own
constructor has already run (in `main.ts`, `EditorShell`'s constructor —
which builds `FileTree` — finishes fully before `Body.getInstance().
addComponent(shell)` triggers that first mount). So `FileTree`'s own
`Event.addSubtreeListener(this, 'contextmenu', this.handleBackgroundContextMenu)`,
registered eagerly in its constructor, is always the *earlier* entry in
`Event`'s shared per-`(this, 'contextmenu')` dispatch list — the reverse of
the footnote's claim — meaning a synchronous `event.defaultPrevented` check
in `handleBackgroundContextMenu` would always read `false`, row hits
included.

This was previously masked, not caught by manual verification, because
`Menu.show()` unconditionally tears down and rebuilds its item list on every
call: a row hit still ended up showing the *correct* menu, because `Tree`'s
own row-matching handler runs second (still within the same synchronous
dispatch) and its resulting `handleNodeContextMenu` call rebuilds the menu
a second time before either ever paints — an accidental last-write-wins, not
the ordering guarantee the footnote describes, and fragile against a future
change to either `Menu`'s rebuild-per-call behaviour or `Tree`'s own
handler. `handleBackgroundContextMenu` now defers its check to a
`queueMicrotask`, which drains only once the whole synchronous dispatch for
that event — `Tree`'s handler included — has already run, so
`event.defaultPrevented` is reliably settled by the time it's read,
regardless of which listener happened to register first. This makes the
row/background split correct by construction instead of by coincidence,
without changing any of the plan's `## Expected Behaviour` outcomes. The
`{ prevent: true }` return `handleBackgroundContextMenu` previously gave on
a background hit is dropped along with the synchronous check — reading
`core/Body.ts`'s `setNativeContextMenu` confirms Loom's own
`Body.init({ layoutManager: Fit(), favicon: APP_FAVICON })` call (no
`nativeContextMenu` override) already suppresses the browser's native
context menu page-wide unconditionally, so that return value was always
redundant here, not the mechanism keeping the native menu off.
