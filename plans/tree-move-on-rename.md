---
touches-shared: [README.md, TODO.md, src/EditorController.ts, src/explorer/FileTree.ts, src/data/workspace.ts]
---

# Tree Move on Rename — Implementation Plan

## Overview

A folder renamed in the file tree comes back collapsed today, with nothing loaded under it. The re-list that follows a rename matches entries by path and kind ([src/explorer/fileTreeNodes.ts:34](src/explorer/fileTreeNodes.ts#L34)), and a rename changes the path, so the renamed entry gets a new node. This plan carries the existing node over to its new name with the library's new `Tree.moveNode(node, parent, index)`, so a renamed or moved entry keeps its expansion, its loaded children and its selection.

Two kinds of rename reach `FileTree` ([src/explorer/FileTree.ts](src/explorer/FileTree.ts)):

- **Loom's own Rename**, from the tree's context menu (`renameEntry`, [FileTree.ts:258](src/explorer/FileTree.ts#L258)). It knows both paths. It renames files and folders, always within the same parent folder. Loom has no drag-move in the tree.
- **A rename made outside Loom**, reported by the file watcher (`watchDirectory`, [src/data/workspace.ts:285](src/data/workspace.ts#L285)). The native watcher already pairs a rename's two paths into one event, but `watchDirectory` flattens it to plain paths. This plan passes the pair through and follows it for folders only.

Open tabs under a renamed path are already repointed for Loom's own Rename by `EditorController.relocateOpenFiles` ([src/EditorController.ts:304](src/EditorController.ts#L304)), which uses `relocatePath` ([src/data/paths.ts:217](src/data/paths.ts#L217)). A folder renamed outside Loom now goes through the same callback. `TODO.md`'s known issue *A renamed or moved folder comes back collapsed* is narrowed to files renamed outside Loom.

---

## Architecture Decisions

### Carry the node over with `Tree.moveNode`, following the library's rename recipe

A rename rewrites the node's paths in place, relabels it, moves it to its sorted position with `moveNode`, and repaints it with `notifyNodeChanged`. This is the recipe in the library's Tree docs, *Moving and renaming a node* (`/home/jika/typescript/typescript-ui/packages/lib/docs/components/Tree.md`, line 134). It continues the approach of the incremental refresh, which keeps state by keeping the same node object (`reconcileChildren`, [fileTreeNodes.ts:34](src/explorer/fileTreeNodes.ts#L34)).[^precedent]

### Paths are rewritten in place on the existing `data` objects, with `relocatePath`

A new pure helper, `relocateLoadedPaths`, sets `data.path` to `relocatePath(data.path, oldPath, newPath)` on the moved node and on every loaded node under it. It changes the existing `data` objects and never replaces them. A folder's `loadChildren` closure holds its `data` object and reads `data.path` when it runs ([FileTree.ts:681-694](src/explorer/FileTree.ts#L681-L694)). An in-place write is therefore what makes a folder that has not loaded yet list its new path. `relistDirectory` already writes `data.parentChain` in place the same way ([FileTree.ts:455-459](src/explorer/FileTree.ts#L455-L459)). `relocatePath` is the helper tabs already use, so the tree and the tabs remap paths with the same rule.

| Node before | Rename `/p/src` → `/p/lib` | Node after |
|---|---|---|
| `/p/src` | moved node | `/p/lib` |
| `/p/src/a.ts` | loaded child | `/p/lib/a.ts` |
| `/p/src/util/b.ts` | loaded grandchild | `/p/lib/util/b.ts` |
| `C:\p\src\a.ts` (rename `C:\p\src` → `C:\p\lib`) | Windows separators | `C:\p\lib\a.ts` |

### The new position comes from the directory listing's own sort rule

`sortDirEntries`' comparison is extracted from [paths.ts:123-142](src/data/paths.ts#L123-L142) as `compareDirEntries`. A new helper, `sortedChildIndex(siblings, node)`, counts the siblings other than `node` that sort before it. That count is the `index` for `moveNode`, which means "where the node ends up". The docs recipe's `localeCompare` is not used.[^sort-rule]

| Siblings, in order | Node (after relabel) | Index |
|---|---|---|
| `lib/`, `src/`, `a.ts`, `c.ts` | `src/` relabelled `app` | 0 |
| `lib/`, `src/`, `a.ts`, `c.ts` | `a.ts` relabelled `d.ts` | 3 |
| `lib/`, `src/`, `a.ts` | `zeta/`, arriving from another folder | 2 |
| `a.ts`, `c.ts` | `B.ts`, arriving from another folder | 1 |

### Moves run on the refresh queue, and the re-list that follows fixes the ignore chains

Every move is queued on `_refreshChain` ([FileTree.ts:75-79](src/explorer/FileTree.ts#L75-L79)), the same queue every refresh uses. `queueRefresh` ([FileTree.ts:389-395](src/explorer/FileTree.ts#L389-L395)) is split so that its queueing part, `queueOnRefreshChain(work)`, can run any step.[^queue]

A move does not touch `parentChain`. A re-list always follows the move and rewrites the chains: the shallow re-list of the new parent folder fixes the moved node's own chain, and a deep re-list of the new path fixes the chains below it. The watcher's own refresh targets already include both ([src/data/watchEvents.ts:279-280](src/data/watchEvents.ts#L279-L280)). Loom's own Rename of a folder queues the deep re-list of the new path explicitly.[^chains]

### A move whose destination is not shown is left to the re-list

`moveLoadedNode(oldPath, newPath)` does nothing in each of these cases, and the re-lists that follow put the tree right:

| Case | Why nothing is moved |
|---|---|
| No loaded node at `oldPath` | Nothing on screen to keep. This includes the watcher's echo: its own report of a Loom Rename, which arrives about 250 ms after the node has already moved. |
| A loaded node already exists at `newPath` | The destination is already shown; the parent's re-list reconciles the two. |
| `parentDir(newPath)` is neither the project root nor a loaded folder | The library's `moveNode` into an unloaded lazy folder would make the moved node that folder's only child.[^unloaded-parent] |

### A watcher rename comes from the event's own kind

A new pure function, `renamePairOf(kind, paths)` in [src/data/watchEvents.ts](src/data/watchEvents.ts), returns `{ from, to }` when a native event's kind is a two-path rename, and `null` otherwise. `watchDirectory` passes the result to its callback as a third argument. The function takes `kind` as `unknown`, as `isListingChangeKind` and `changesListing` already do ([watchEvents.ts:388-416](src/data/watchEvents.ts#L388-L416)), so the module stays free of Tauri imports and testable.[^pairing]

| `kind` | `paths` | Result |
|---|---|---|
| `{ modify: { kind: 'rename', mode: 'both' } }` | `['/p/a', '/p/b']` | `{ from: '/p/a', to: '/p/b' }` |
| `{ modify: { kind: 'rename', mode: 'from' } }` | `['/p/a']` | `null` |
| `{ modify: { kind: 'rename', mode: 'to' } }` | `['/p/b']` | `null` |
| `{ modify: { kind: 'rename', mode: 'both' } }` | `['/p/a']` | `null` |
| `{ modify: { kind: 'data', mode: 'content' } }` | `['/p/a', '/p/b']` | `null` |
| `{ create: { kind: 'folder' } }`, `'any'`, `'other'`, `null` | `['/p/a', '/p/b']` | `null` |

### Renames made outside Loom are followed for folders only

`FileTree.followExternalRename` follows a watcher rename only when `to` is a folder (one `isDirectory(to)` call, [workspace.ts:245](src/data/workspace.ts#L245)), and only when both paths sit strictly inside the project root. A file renamed outside Loom keeps today's behaviour: a new, unselected row, and an open tab that keeps the old path. Editors save files by renaming them, so following file renames would move the selection and the open tab onto a backup file.[^files-excluded]

### A folder renamed outside Loom repoints open tabs through `onPathRenamed`

`followExternalRename` calls the existing `onPathRenamed(oldPath, newPath)` callback, so tabs under a folder renamed outside Loom follow it, as they already do for Loom's own Rename. `EditorController.relocateOpenFiles` now calls `syncActive()` only when the active file was one of the tabs it repointed. That change makes the watcher's echo of Loom's own Rename a no-op.[^echo]

---

## Public API

All of these are Loom module exports. Nothing in the library changes.

```typescript
// src/data/paths.ts — the comparison sortDirEntries already uses, extracted.
export function compareDirEntries(a: SortableEntry, b: SortableEntry): number
```

```typescript
// src/data/watchEvents.ts
/** The two ends of a rename the watcher reported as one event. */
export interface RenamePair {
    from: string
    to: string
}

export function renamePairOf(kind: unknown, paths: readonly string[]): RenamePair | null
```

```typescript
// src/explorer/fileTreeNodes.ts
/** Rewrites data.path in place on `node` and every loaded node under it. Never replaces a data object; never touches label or parentChain. */
export function relocateLoadedPaths(node: TreeNode, oldPath: string, newPath: string): void

/** How many of `siblings`, other than `node` itself, sort before `node` (by compareDirEntries on { name: label, isDir }). */
export function sortedChildIndex(siblings: readonly TreeNode[], node: TreeNode): number
```

```typescript
// src/data/workspace.ts — gains a third callback argument.
export async function watchDirectory(
    dir: string,
    onChange: (paths: string[], listingChanged: boolean, renamed: RenamePair | null) => void,
): Promise<StopWatching>
```

---

## Implementation

`FileTree`'s new private members. These snippets show the logic; the implementer adds JSDoc and blank lines per the conventions.

```typescript
/** Runs `work` after every step already queued on _refreshChain. */
private queueOnRefreshChain(work: () => Promise<void> | void): Promise<void> {
    const run = this._refreshChain.then(work)

    this._refreshChain = run.then(() => undefined, () => undefined)

    return run
}

// queueRefresh's body becomes:
//     return this.queueOnRefreshChain(() => this.performRefresh(target))

/** The child list of the loaded folder `dir` and its node (`null` for the project root), or `null` when `dir` is not a loaded folder. */
private findLoadedFolder(dir: string): { node: TreeNode | null, children: TreeNode[] } | null {
    if (dir === this._root) {
        return { node: null, children: this.getNodes() }
    }

    const node = this.findLoadedNode(dir)

    if (node === null || node.children === undefined) {
        return null
    }

    return { node, children: node.children }
}

/** Carries the loaded node for `oldPath` over to `newPath`; a no-op in the cases the decisions table lists. */
private moveLoadedNode(oldPath: string, newPath: string): void {
    const node = this.findLoadedNode(oldPath)
    const folder = this.findLoadedFolder(parentDir(newPath))

    if (node === null || folder === null || this.findLoadedNode(newPath) !== null) {
        return
    }

    relocateLoadedPaths(node, oldPath, newPath)
    node.label = baseName(newPath)
    this.moveNode(node, folder.node, sortedChildIndex(folder.children, node))
    this.notifyNodeChanged(node)

    const selected = this.getSelectedNode()?.data as FileTreeNodeData | undefined

    if (selected !== undefined && isUnderRoot(newPath, selected.path)) {
        this.notifySelectedEntry()
    }
}

/** Follows a folder renamed outside Loom: moves its node and repoints open tabs under it. */
private followExternalRename(rename: RenamePair): void {
    const root = this._root

    void this.queueOnRefreshChain(async () => {
        if (root === null || this._root !== root) {
            return
        }

        const inside = (path: string): boolean => path !== root && isUnderRoot(root, path)

        if (!inside(rename.from) || !inside(rename.to) || !(await isDirectory(rename.to))) {
            return
        }

        this.moveLoadedNode(rename.from, rename.to)
        this._onPathRenamed(rename.from, rename.to)
    })
}
```

`renameEntry`'s new body after the `renamePath` try/catch:

```typescript
await this.queueOnRefreshChain(() => { this.moveLoadedNode(path, newPath) })
this._onPathRenamed(path, newPath)
await this.refreshDirectory(parentDir(path))

if (isDir) {
    await this.queueRefresh({ path: newPath, deep: true })
}

await this.selectPath(newPath)
```

The move comes before `_onPathRenamed`. `relocateOpenFiles` can call `syncActive`, whose active-file listener calls `tree.selectPath(activePath)`. With the node already moved, that lookup finds the moved row cheaply. The final `selectPath(newPath)` keeps today's rule that a rename selects the renamed entry.

---

## Ordered Implementation Steps

0. **Set up.** In the worktree: `npm ci`, then `rm -rf node_modules/@jimka/typescript-ui && ln -s /home/jika/typescript/typescript-ui/packages/lib node_modules/@jimka/typescript-ui`. Do not change `package.json` (the range stays `^0.11.0` until the library releases). Check that the linked build has the method: `grep -c moveNode node_modules/@jimka/typescript-ui/dist/lib/types/component/tree/Tree.d.ts`, which should be non-zero. If it is zero, run `npm run build` in `/home/jika/typescript/typescript-ui/packages/lib`. Baseline: `npm run typecheck` is clean and `npm test` passes 549 tests.

1. **[src/data/paths.ts](src/data/paths.ts)**: extract the `sort` callback of `sortDirEntries` (lines 124-141) into `export function compareDirEntries(a: SortableEntry, b: SortableEntry): number`, with JSDoc. `sortDirEntries` becomes `return [...items].sort(compareDirEntries)`. Add a `describe('compareDirEntries')` block to [tests/paths.test.ts](tests/paths.test.ts) (cases P1-P3). The existing `sortDirEntries` tests must still pass.

2. **[src/data/watchEvents.ts](src/data/watchEvents.ts)**: add `RenamePair` and `renamePairOf` (see *Public API*). `renamePairOf` returns a pair only when `kind` is an object with a `modify` object whose `kind === 'rename'` and `mode === 'both'`, and `paths.length === 2`. Read the fields as `isListingChangeKind` does (`'modify' in kind`, then `typeof … === 'object'`). Extend the header comment (lines 1-11) to say that `watchDirectory` also asks whether an event is one rename (`renamePairOf`). Add `describe('renamePairOf')` to [tests/watchEvents.test.ts](tests/watchEvents.test.ts) using the six rows of the decision table (W1-W6).

3. **[src/explorer/fileTreeNodes.ts](src/explorer/fileTreeNodes.ts)**: add `relocateLoadedPaths` (recursive over `node.children` when defined) and `sortedChildIndex` (filter out `node`, count the siblings for which `compareDirEntries({ name: sibling.label, isDir }, { name: node.label, isDir })` is negative). Import `relocatePath` and `compareDirEntries` from `../data/paths`. Extend the header comment to name the two new rules. Add the `describe` blocks to [tests/fileTreeNodes.test.ts](tests/fileTreeNodes.test.ts), reusing its `node()` and `pathOf()` helpers (cases N1-N9).

4. **[src/data/workspace.ts](src/data/workspace.ts)**: import `renamePairOf` and `type RenamePair` from `./watchEvents` (line 16). In `watchDirectory` (lines 285-295), change `onChange`'s type to the one in *Public API* and call `onChange(event.paths, changesListing(event.type, event.paths), renamePairOf(event.type, event.paths))`. Add the third argument to the `@param onChange` doc.

5. **[src/EditorController.ts](src/EditorController.ts)** `relocateOpenFiles` (lines 295-315): read `const active = this.getActiveFile()` before the loop. Set `activeMoved = true` when the repointed `file === active`. Call `this.syncActive()` only when `activeMoved` is true. Update the JSDoc: the method is also called for a folder renamed outside Loom, and it re-syncs the title, status bar and tree only when the active tab moved.

6. **[src/explorer/FileTree.ts](src/explorer/FileTree.ts)**:
   1. Imports: add `isDirectory` to the `../data/workspace` import (line 7); add `baseName, isUnderRoot` to the `../data/paths` import (line 14); add `relocateLoadedPaths, sortedChildIndex` to the `./fileTreeNodes` import (line 22); add `RenamePair` to the `../data/watchEvents` type import (line 12).
   2. Add `queueOnRefreshChain` and reroute `queueRefresh` through it (see *Implementation*). In the `_refreshChain` doc comment (lines 75-79), add tree moves to the list of steps it serializes.
   3. Add `findLoadedFolder` and `moveLoadedNode` (see *Implementation*), with JSDoc. `moveLoadedNode`'s JSDoc names the three no-op cases.
   4. Replace `renameEntry`'s body after the `renamePath` try/catch (lines 273-275) with the sequence in *Implementation*. Update its JSDoc (line 253): the renamed entry keeps its row, expansion and loaded children.
   5. Add `followExternalRename` (see *Implementation*), with JSDoc that names the folders-only rule and points at the `TODO.md` entry.
   6. `startWatching` (line 708): forward the third argument, `(paths, listingChanged, renamed) => { this.handleFileSystemChange(paths, listingChanged, renamed) }`.
   7. `handleFileSystemChange` (lines 739-755): add the parameter `renamed: RenamePair | null`, with a `@param`. Right after `this._onPathsChanged(paths, listingChanged)`, add `if (renamed !== null) { this.followExternalRename(renamed) }`. It must come before the `listingChanged` check, so the move is queued ahead of the debounced re-list.
   8. `FileTreeParams.onPathRenamed` doc (line 48): "Called after the tree renames a file or folder, or after the watcher reports a folder renamed outside Loom, with its old and new paths."
   - Check: `npm run typecheck` is clean. `grep -n "queueOnRefreshChain" src/explorer/FileTree.ts` shows four uses: the definition, `queueRefresh`, `renameEntry` and `followExternalRename`.

7. **[README.md](README.md)**:
   - In the *File tree* bullet, replace the sentence "A renamed entry counts as a new one, so a renamed folder comes back collapsed." with: "A renamed or moved folder keeps its row: it stays open, with everything loaded under it, and a selected row stays selected. This holds after the tree's own *Rename* and after a rename or move made outside Loom. A file renamed outside Loom counts as a new entry."
   - In the *Tabbed editing* bullet, after "a background tab catches up when it is next shown.", add: "A tab whose file sits inside a folder renamed or moved outside Loom follows it to the new path."

8. **[TODO.md](TODO.md)**: replace the *Known issues* entry "**A renamed or moved folder comes back collapsed.** …" (the whole bullet, through "…not rename pairs.") with:

   > - **A file renamed outside Loom comes back as a new row.** A rename made outside Loom is followed only for a folder: its row keeps its expansion, its loaded children and its selection, and open tabs under it follow. A renamed file is a new row, unselected, and an open tab on it keeps the old path. Editors save by renaming (vim, for one, renames the file to a backup before writing the new one), and the watcher reports that as a rename too, so following file renames would move the selection and the tab onto the backup. A folder rename the watcher does not report as a single rename event still comes back collapsed, as before.

9. **Verify** (see *Verification*).

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src/data/paths.ts` |
| Modify | `src/data/watchEvents.ts` |
| Modify | `src/explorer/fileTreeNodes.ts` |
| Modify | `src/data/workspace.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `src/explorer/FileTree.ts` |
| Modify | `tests/paths.test.ts` |
| Modify | `tests/watchEvents.test.ts` |
| Modify | `tests/fileTreeNodes.test.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Unit-testable (vitest)

**`compareDirEntries`**
- **P1** `{ name: 'src', isDir: true }` vs `{ name: 'a.ts', isDir: false }` is negative; swapped, it is positive.
- **P2** `{ name: 'b.ts' }` vs `{ name: 'A.ts' }` (both files) is positive, because the comparison is case-insensitive.
- **P3** `{ name: 'Test' }` vs `{ name: 'test' }` (both files) is negative (the raw-name tie-break), and an entry compared with itself is `0`.

**`renamePairOf`**: the six rows of the decision table, **W1-W6**.

**`relocateLoadedPaths`**
- **N1** A tree `/p/src` → [`/p/src/util` → [`/p/src/util/b.ts`], `/p/src/a.ts`], relocated `/p/src` → `/p/lib`, gives the paths `/p/lib`, `/p/lib/util`, `/p/lib/util/b.ts`, `/p/lib/a.ts`.
- **N2** Every node's `data` object is the same reference before and after (`toBe`), and its `parentChain` is the same reference.
- **N3** A folder node with no `children` (not loaded) has only its own path rewritten, and no error is raised.
- **N4** A file node `/p/a.ts` relocated to `/p/b.ts` gets path `/p/b.ts`. Its `label` is left as `a.ts`, because relabelling is `FileTree`'s job.
- **N5** Windows: `C:\p\src` with child `C:\p\src\a.ts`, relocated to `C:\p\lib`, gives `C:\p\lib` and `C:\p\lib\a.ts`.

**`sortedChildIndex`**
- **N6-N9** The four rows of the sort decision table. In the first two, `node` is inside `siblings` and is skipped; in the last two, it is not.
- An empty `siblings` gives `0` (part of N9's block).

### Manual, in the real app (`npm run tauri:dev`)

The browser shell cannot check this feature. Its `rename` stub is a no-op and its watcher is silent ([browser-shell/tauri-stubs/plugin-fs.ts](browser-shell/tauri-stubs/plugin-fs.ts)).[^browser-shell] The implementer records these as the user's by-eye checks. Use a scratch folder inside the project with `src/util/b.ts`, `src/a.ts` and `docs/x.md`.

- **M1** Expand `src` and `src/util`, open `src/a.ts` in a tab, and select `src/util/b.ts`. Use *Rename* on `src` to name it `app`. `app` sorts first among the folders and stays expanded, `app/util` stays expanded, `app` is selected, and *Properties* shows `…/app`. The tab's breadcrumbs show `app/a.ts`, and saving it writes `app/a.ts`.
- **M2** Use *Rename* on `a.ts` to name it `z.md`. The row moves below the other files, and its tree icon and tab icon change to Markdown.
- **M3** With `src` expanded, a file under it selected, and a tab open on `src/a.ts`, run `mv src lib` in a terminal. `lib` appears at its sorted place, still expanded, and the file under it is still selected. *Properties* shows the new path, and the tab now points at `lib/a.ts` (breadcrumbs, and a save lands in `lib/`).
- **M4** With both `src` and `docs` expanded, run `mv docs src/docs`. `docs` appears under `src`, still expanded.
- **M5** With `docs` expanded and `src/util` collapsed and never opened, run `mv docs src/util/docs`. `docs` disappears. Expanding `src/util` shows `docs`, collapsed.
- **M6** With `src/a.ts` selected and open in a tab, run `mv src/a.ts src/c.ts`. `c.ts` appears unselected, and the tab keeps `src/a.ts` (the narrowed known issue).
- **M7** Use *Rename* on a folder while it is expanded, then wait one second. The watcher's echo of the rename changes nothing: the selection does not move to the active tab's file, and the folder stays expanded.
- **M8** Expand a folder, use *Rename* on it, quit, and relaunch. The folder comes back expanded under its new name.
- **M9** With Show Hidden off, use *Rename* on a selected folder to name it `.hidden`. The row disappears and *Properties* shows that nothing is selected.

---

## Verification

- `npm run typecheck`: clean.
- `npm test`: the 549 existing tests plus P1-P3, W1-W6 and N1-N9 pass.
- `grep -n "renamePairOf" src/data/workspace.ts`: exactly one call.
- `grep -rn "localeCompare" src/explorer/`: no matches (the sort rule is `compareDirEntries`).
- `npm run build`: succeeds.
- Manual M1-M9 in `npm run tauri:dev`, run by the user. Optionally, as a smoke check, `npm run dev:browser -- --port 1430 --strictPort` with `window.__FAKE_PROJECT_ROOT__` set to a folder inside the checkout, then *Open Folder…*. Expanding folders, right-clicking and opening the *Rename* prompt must work with no console errors. A completed rename there snaps back to the old name, collapsed; that is the stub's doing.[^browser-shell]

---

## Potential Challenges

- **The watcher's echo of Loom's own Rename.** About 250 ms after a Loom rename, the watcher reports the same pair. Each step is a no-op the second time: no node at `from`, and no tab under `from`, so `relocateOpenFiles` neither repoints nor re-syncs. M7 checks this.
- **A lazy load in flight on the moved folder.** If the load read the old path before the rename, it commits children with old paths. The deep re-list of the new path replaces them if the load lands first. If it lands after, the watcher's own deep refresh of `to` replaces them. A rare race with a self-correcting outcome; no extra handling.
- **Ignore chains are stale between the move and the re-list.** A folder expanded in that window (at most one debounce, 150 ms) is filtered with the old chain until the deep re-list rewrites it.
- **The library's `dist` may be older than its source.** Step 0's `grep` catches a build that lacks `moveNode`.

---

## Critical Files

- [src/explorer/FileTree.ts](src/explorer/FileTree.ts): `renameEntry`, `queueRefresh`, `relistDirectory`, `toNode`, `handleFileSystemChange`, `notifySelectedEntry`.
- [src/explorer/fileTreeNodes.ts](src/explorer/fileTreeNodes.ts) and [tests/fileTreeNodes.test.ts](tests/fileTreeNodes.test.ts): the precedent for pure node-list rules and their test helpers.
- [src/data/watchEvents.ts](src/data/watchEvents.ts): `isListingChangeKind` / `changesListing` are the precedent for reading a native event kind as `unknown`.
- [src/data/paths.ts](src/data/paths.ts): `sortDirEntries`, `relocatePath`, `isUnderRoot`.
- [src/EditorController.ts](src/EditorController.ts): `relocateOpenFiles` (line 304), `syncActive` (line 1503).
- `/home/jika/typescript/typescript-ui/packages/lib/docs/components/Tree.md`: *Updating nodes* and *Moving and renaming a node*.
- `/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/component/tree/Tree.ts`: `moveNode` (line 547), `notifyNodeChanged` (line 628).
- [plans/implemented/file-tree-incremental-refresh.md](plans/implemented/file-tree-incremental-refresh.md): its `[^match-key]` footnote is the decision this plan revises.

---

## Non-Goals

- **Following a file renamed outside Loom.** Excluded because editors save by renaming; it stays in `TODO.md`.
- **A drag-move in the tree, or a *Move to…* command.** Loom's Rename changes only a name ([plans/implemented/file-tree-context-menu.md](plans/implemented/file-tree-context-menu.md), *Rename changes only an entry's own name*). `moveLoadedNode` already handles a cross-folder move for the watcher's sake, but no new gesture is added.
- **Saving the session right after a rename.** `moveNode` emits no `expand`/`collapse`, so the autosave is not scheduled. The renamed paths are written at the next autosave trigger or on exit, which M8 covers.[^autosave]
- **Library changes.** `moveNode` and `notifyNodeChanged` cover everything this plan needs; no gap was found.

---

## Notes

[^precedent]: Precedent search. Nothing in Loom or SQLAdmin (`/home/jika/typescript/sqladmin/src`) calls `moveNode` yet; the method was added to the library for this use. `llms.txt` points at `Tree` for trees, and its docs page holds the rename recipe this plan follows. Inside Loom, the incremental refresh established that a row keeps its state only while the same node object stays in the tree (`reconcileChildren`, `applyChildren`). `removeNode` followed by `insertNode` drops that state, which is why the known issue existed until the library gained a move.

[^sort-rule]: The tree's order comes from `listDirectory`, which returns `sortDirEntries` order ([workspace.ts:131-141](src/data/workspace.ts#L131-L141)): folders first, case-insensitive, then a raw-name tie-break. The docs recipe's `label.localeCompare` would place nodes differently (it ignores the folders-first rule and is locale-dependent), and the next re-list would then reorder the rows. Counting the siblings that sort before the node, rather than searching for the first one that sorts after it, gives the right answer without assuming the siblings are already sorted.

[^queue]: `_refreshChain` exists so that an older listing never lands over a newer one. A move changes the same child lists that a refresh reconciles. If a move ran while a refresh of the same folder was halfway through, the refresh could install a listing read before the rename on top of the moved node, dropping it. Queued, the move runs after the in-flight refresh has finished. The refreshes the rename itself triggers queue behind the move: the explicit `refreshDirectory` in `renameEntry`, and the watcher's batch, which is debounced 150 ms.

[^chains]: An `IgnoreLayer` records the absolute folder its `.gitignore` sits in (`IgnoreLayer.dir`, [src/data/gitignore.ts:13-16](src/data/gitignore.ts#L13-L16)). After a folder move, a layer from a `.gitignore` inside the moved folder no longer matches the new paths, and a cross-folder move also changes the governing chain from above. A deep re-list recomputes all of that through the existing `relistDirectory`, so no chain-rewriting code is needed. The cost is one listing read per loaded folder under the moved one, the same bound the incremental refresh accepted for a `.gitignore` change. With the watcher running, Loom's own Rename pays that read twice (once explicitly, once for the echo). The explicit read keeps the rename correct when no watcher is running (OS watch limits, see `startWatching`). A shallow refresh alone, as the incremental-refresh plan reasoned, is enough only when the path does not change.

[^unloaded-parent]: The Tree docs say that `moveNode` into a lazy node that has not loaded "makes the moved node its only child", and recommend `removeNode` when the folder's listing should still come from `loadChildren`. Doing nothing has the same end result here. The old parent's re-list, which every rename triggers, drops the node, and the destination's first expand lists it fresh.

[^pairing]: `tauri-plugin-fs` 2.5.2's `watch` with `delayMs` runs `notify-debouncer-full` 0.6 (`watcher.rs`). That debouncer joins a rename's `From` and `To` halves into one `Modify(Name(Both))` event whose `paths` are `[from, to]`. It matches the halves by the backend's tracker (the inotify cookie on Linux) or by file id (macOS, Windows). The plugin serializes `notify` with `serialization-compat-6`, so the kind reaches JavaScript as `{ modify: { kind: 'rename', mode: 'both' } }`, which is what `@tauri-apps/plugin-fs`'s `WatchEventKindModify` type declares. The `[^match-key]` footnote of the incremental-refresh plan called pairing "guesswork" because `watchDirectory` drops the kind; the pair was available all along. When a rename cannot be paired (a move into or out of the project, or a backend that gives neither cookie nor id), the debouncer reports plain removes and creates, and the tree falls back to today's behaviour.

[^files-excluded]: Two common saves are renames. One is a temp file renamed onto the target. The debouncer turns that into a create, because the temp file was created inside the same window, so it never reaches `renamePairOf`. The other is the target renamed to a backup before the new file is written; vim does this with `backupcopy=no`, and `auto` can choose it. That arrives as a genuine pair `[file, file~]`. Following it would move the selected row and the open tab onto the backup, and the tab would then save into the backup. A folder is never renamed as part of a save. A folder is also where the state worth keeping lives (expansion and loaded children); a file row has only its selection. Testing `to` with `isDirectory` after the event is reliable because a rename never changes an entry's kind.

[^echo]: Without the guard, the echo's `relocateOpenFiles` call would still run `syncActive()`. `syncActive` fires the active-file listener, which calls `tree.selectPath(activePath)` ([src/shell/EditorShell.ts:431](src/shell/EditorShell.ts#L431)) and would pull the selection off the folder the user just renamed. `syncActive` only refreshes state that belongs to the active file (window title, language readout, caret readouts, tree selection), so skipping it when the active file did not move changes nothing else. Today's Loom Rename also runs `syncActive` when the active file is elsewhere. That was invisible only because `renameEntry`'s final `selectPath` re-selected the renamed entry straight after.

[^browser-shell]: In `npm run dev:browser`, `rename` resolves without touching disk, and `watch` never fires. A *Rename* there moves the node, then the parent's re-list reads the unchanged disk: the old name comes back as a new, collapsed row, and the moved row is dropped. That is an artefact of the stub, not of this change; on real disk the re-list finds the new name. Making the stub rename for real would be a change to the dev tooling, which is outside this plan.

[^autosave]: The session's tree expansion is read live from `getExpandedPaths()` (which reads `data.path`) whenever a snapshot is written. A snapshot written after the rename therefore already has the new paths. A crash before any later trigger leaves the old paths in the saved session, and `expandPaths` skips unknown paths, so the worst case is today's behaviour: the folder comes back collapsed.
