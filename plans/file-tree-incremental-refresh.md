---
touches-shared:
  - src/explorer/FileTree.ts
  - src/data/watchEvents.ts
  - tests/watchEvents.test.ts
  - src/shell/EditorShell.ts
  - README.md
  - TODO.md
---

# File Tree Incremental Refresh — Implementation Plan

## Overview

When a folder's listing changes, `FileTree` ([src/explorer/FileTree.ts](src/explorer/FileTree.ts)) re-lists it through `refreshSubtree` → `performRefreshSubtree` → `rebuild` ([FileTree.ts:382-452](src/explorer/FileTree.ts#L382-L452)). `rebuild` assigns fresh `children` and calls `setNodes`, which collapses the whole tree and clears the selection. It then replays expansion (`expandPaths`, which reads every expanded folder below again), selection (`reselect`) and scroll (`setScrollY`). The user sees the tree collapse and re-expand. The same path runs for the watcher, for the tree's own New File / New Folder / Rename / Delete, for `EditorShell.handleFileSaved` after a Save As, and — through `reload()` — for the Show Hidden / Show Ignored toggles.

This plan re-lists a folder in place with the library's new `Tree.setChildren(parent, children)`, passing back the existing node object for every entry that is still there. Surviving entries keep their node identity, expansion, loaded children and selection. New entries appear, vanished ones disappear, and the scroll offset stays put. Nothing in the refresh path calls `setNodes` or replays anything. The toggles move onto the same mechanism. The pure parts — matching a listing against the current children, finding a node by path, and turning watcher paths into refresh targets — live in unit-tested modules.

`Tree.setChildren` exists only on the unmerged typescript-ui branch `feature/tree-node-level-updates`, so Loom builds against that branch through its `node_modules/@jimka/typescript-ui` symlink (step 0). Changes: [src/explorer/FileTree.ts](src/explorer/FileTree.ts), a new pure module [src/explorer/fileTreeNodes.ts](src/explorer/fileTreeNodes.ts), [src/data/watchEvents.ts](src/data/watchEvents.ts), one call and one doc comment in [src/shell/EditorShell.ts](src/shell/EditorShell.ts), tests, and `README.md` / `TODO.md`.

---

## Architecture Decisions

### Re-list a folder with `Tree.setChildren` and the surviving node objects

A refresh reads the folder, builds its new child list from the existing node for each surviving entry plus a fresh node for each new entry, and installs it with `setChildren(folderNode, children)` — or `setChildren(null, children)` for the project root. This is the recipe the library documents for exactly this case: the re-list example in `Tree.md`'s *Updating nodes* section (`/home/jika/typescript/typescript-ui/.worktrees/tree-node-level-updates/packages/lib/docs/components/Tree.md:93-111`) and the recommendation for Loom in the library plan's `^identity-not-keys` footnote (`…/plans/implemented/tree-node-level-updates.md:692`).[^library-recipe]

`Tree` keys every piece of state by node object, so "the same object" is how Loom says "this entry survived". `insertNode`, `removeNode` and `notifyNodeChanged` are not used.[^no-gap]

### A surviving entry is one with the same path and the same kind

An existing child node is reused when the fresh listing has an entry with the same `path` **and** the same `isDir`. Anything else is a new node. A rename and a file↔folder flip therefore both produce a new node: collapsed, unloaded, unselected.[^match-key]

| Current children | Fresh listing | New child list |
|---|---|---|
| `lib/`, `a.ts` | `lib/`, `b.ts` | `lib/` (same object), `b.ts` (new); `a.ts` dropped |
| `x` (file) | `x/` (folder) | `x/` (new) — the kind flipped |
| `old.ts` | `new.ts` | `new.ts` (new) — a rename is a new entry |
| `B.ts`, `a.ts` | `a.ts`, `B.ts` | the same two objects, in listing order |

The list always follows the fresh listing's order (`listDirectory` already sorts folders first, case-insensitively).

### The matching and node lookup live in a new pure module, `src/explorer/fileTreeNodes.ts`

`reconcileChildren` (the table above) and `findNodeByPath` go in `src/explorer/fileTreeNodes.ts`, and `FileTreeNodeData` moves there from `FileTree.ts`. This mirrors [src/explorer/searchResults.ts](src/explorer/searchResults.ts): a pure module beside its tree panel that builds `TreeNode`s, owns the panel's node payload type (`SearchTreeNodeData`, [searchResults.ts:9](src/explorer/searchResults.ts#L9)), and is tested in vitest's `node` environment ([tests/searchResults.test.ts](tests/searchResults.test.ts)).[^pure-module]

`findNodeByPath` walks down from the roots through the one node per level whose path contains the target, instead of today's search over every loaded node. `FileTree.findLoadedNode` becomes a one-line call to it.[^find-descent]

### Each changed folder is re-listed on its own; `minimalRoots` goes

`setChildren` changes only the folder it is given. Re-listing `/p` no longer re-reads `/p/src`, so a batch that changed both must refresh both. Watcher paths become **refresh targets**: `{ path, deep }`. A **shallow** target re-lists that one folder. A **deep** target also re-lists every folder below it that the tree has loaded, top-down. Each changed path produces two targets:

- its parent folder — shallow, or deep when the changed path is a `.gitignore`;
- the changed path itself — deep, in case it is a folder that was replaced in place.[^path-itself]

Targets are then merged: one target per path (deep wins), a target strictly below a deep target is dropped (the deep one covers it), and the rest are sorted ancestors first.[^every-changed-folder] A target that is not a loaded folder when its turn comes is skipped without reading anything — which is what happens to every file path.

| Changed paths (root `/p`) | Targets, in order | Why |
|---|---|---|
| `/p/src/a.ts` | `/p/src` shallow, `/p/src/a.ts` deep | `a.ts` is a file, so its own target is skipped at run time |
| `/p/.gitignore` | `/p` deep | the rules for everything under `/p` changed; `/p/.gitignore` itself is below a deep target |
| `/p/old`, `/p/new` | `/p` shallow, `/p/old` deep, `/p/new` deep | both ends of a rename; neither is a loaded folder afterwards |
| `/p/a.ts`, `/p/src/b.ts` | `/p`, `/p/src` shallow; `/p/a.ts`, `/p/src/b.ts` deep | `/p/src` is kept: re-listing `/p` does not re-list it |
| `/p/src/a.ts`, `/p/src/.gitignore` | `/p/src` deep | deep wins for `/p/src`; both files are below it |
| `/p/lib` (a folder swapped in by a move) | `/p` shallow, `/p/lib` deep | `lib` survives in `/p` by path, then its loaded contents are re-read |
| `/p/.loom/workspace.json`, `/other/x.ts`, `/p` | — | Loom's own state folder, outside the root, the root itself (unchanged rules) |

`refreshTargets` and the new `mergeRefreshTargets` stay in [src/data/watchEvents.ts](src/data/watchEvents.ts), the module that already owns this rule. `minimalRoots` has no caller left and is deleted with its tests.

### A `.gitignore` change re-lists the loaded subtree below it; rules reach unloaded folders through `data.parentChain`

Every node's `data.parentChain` holds the ignore chain governing it from above. After a folder is re-listed, every node in its new child list gets `data.parentChain` set to that folder's fresh chain. A folder node's `loadChildren` reads `data.parentChain` when it runs, not a value captured when the node was built. So:

- a reused folder that has **not** loaded its children picks up the new rules on its first expansion, with no read now;
- a reused folder that **has** loaded its children is re-listed by a deep refresh, which re-reads its own `.gitignore` and repeats the same two rules one level down.

A changed `.gitignore` gets a deep refresh of its folder; an ordinary create, delete or rename gets a shallow one.[^gitignore-deep] Each re-listed folder is installed as soon as its own listing lands, so a deep refresh updates top-down over several renders.[^progressive]

### The root level goes through `setChildren(null, …)`; `setProjectRoot` keeps `setNodes`

A target equal to the project root re-lists it under `_rootChain` and installs the result with `setChildren(null, children)`, reconciled against `getNodes()`. After the listing lands, a root-level refresh does nothing when `_root` no longer equals the folder it read.[^root-guard] `setProjectRoot` still calls `setNodes`: a new project is a new dataset, and resetting it is correct.

### The refresh path keeps its serialisation and drops the replay

| Today | After this plan |
|---|---|
| `refreshSubtree(dir)` (public) | renamed `refreshDirectory(dir)`: a shallow refresh of `dir`[^rename-method] |
| `performRefreshSubtree(dir)` | `performRefresh(target)`: finds the folder node, skips non-loaded targets |
| `rebuild` | replaced by `relistDirectory`: read, reconcile, `setChildren`, then recurse when deep. No snapshot, no `setNodes`, no replay |
| `_refreshChain` | kept. Every refresh — watcher, actions, Save As, the toggles — still runs one at a time[^refresh-chain] |
| `_pendingDirs: Set<string>` | `_pendingTargets: RefreshTarget[]`, merged with `mergeRefreshTargets` at flush time |
| `findLoadedNode` | kept; delegates to `findNodeByPath` |
| `expandPaths` | kept for session restore and `EditorShell.openProjectRoot`; no longer part of a refresh |
| `reselect`, `selectedPath` | deleted |
| `setScrollY(scrollY)` after a rebuild | dropped: `setChildren` keeps the offset, clamping only when the content gets shorter |
| `reload()` | deleted; the toggles call `refilterTree()` |
| `toNodes` | `toNode(item, chain)`: one node, with `loadChildren` reading `data.parentChain` at call time |
| `loadDirectory` | split into `readListing` (list, extend chain, filter) and `loadDirectory` (map to nodes) |

### The tree reports a dropped selection to the properties panel itself

`setChildren` removes a node silently: no `"selection"` event when the selected node goes, and no `"collapse"` when an expanded one does. `FileTree.applyChildren` wraps every `setChildren` call: it reads `getSelectedNode()` before and after, and calls `notifySelectedEntry()` only when the anchor node changed. This is the rule `reselect` follows today — report only when the refresh changed the selection.[^selection-notify] A selection that survives is left alone; a change to that entry itself still reaches the panel through `onPathsChanged`, unchanged.

A removed expanded folder no longer fires `"collapse"`, so it does not schedule a session save. The next save (any expand, collapse, tab change, or exit) records the smaller expanded set, and a stale path in a saved set is already skipped by `expandPaths`.

### Show Hidden / Show Ignored re-filter in place through the same deep refresh

`setShowHidden` and `setShowIgnored` set their flag, then `await refilterTree()`: a deep refresh of the project root queued on `_refreshChain`. Toggling no longer collapses the tree.[^toggles] Both keep returning a promise that settles when the re-filter is done, which `EditorShell.openProjectRoot` still awaits before restoring expansion.

### Loom builds against the unmerged library branch through the shared symlink

`node_modules/@jimka/typescript-ui` in the main Loom tree is repointed at `/home/jika/typescript/typescript-ui/.worktrees/tree-node-level-updates/packages/lib`, built with `npm run build:lib` in that worktree first (step 0). Loom worktrees link the main tree's `node_modules`, so the repoint applies to every Loom checkout until it is undone. It stays repointed when this plan is finished. Restore it only after `feature/tree-node-level-updates` merges into typescript-ui's `master`:

```sh
cd /home/jika/typescript/typescript-ui && npm run build:lib
ln -sfn /home/jika/typescript/typescript-ui/packages/lib /home/jika/typescript/loom/node_modules/@jimka/typescript-ui
```

This Loom branch must not merge into Loom's `main` before the library branch merges. Do not run `qa/runqa.sh` while the link is repointed: its exit trap re-points the link at `QA_MAIN_LIB` (default: the main library checkout, [qa/runqa.sh:20](qa/runqa.sh#L20), [qa/runqa.sh:50-52](qa/runqa.sh#L50-L52)), which silently puts Loom back on a library without `setChildren`. The real-shell check in `## Verification` starts Vite directly and never touches the link.[^symlink]

---

## Public API

```typescript
// src/explorer/FileTree.ts — class FileTree extends Tree (unchanged base)
async refreshDirectory(dir: string): Promise<void>;   // replaces refreshSubtree(dir); shallow refresh of dir
async setShowHidden(value: boolean): Promise<void>;   // signature unchanged; now re-filters in place
async setShowIgnored(value: boolean): Promise<void>;  // signature unchanged; now re-filters in place

// src/data/watchEvents.ts
export interface RefreshTarget {
    path: string;   // a folder to re-list, or a changed path that may be one
    deep: boolean;  // also re-list every loaded folder below `path`
}
export function refreshTargets(root: string, changedPaths: string[]): RefreshTarget[];   // return type changed
export function mergeRefreshTargets(targets: readonly RefreshTarget[]): RefreshTarget[]; // new
// minimalRoots — deleted

// src/explorer/fileTreeNodes.ts — new module
export interface FileTreeNodeData { path: string; isDir: boolean; parentChain: IgnoreChain }  // moved from FileTree.ts
export function reconcileChildren(
    existing: readonly TreeNode[],
    items: readonly DirectoryItem[],
    createNode: (item: DirectoryItem) => TreeNode,
): TreeNode[];
export function findNodeByPath(nodes: readonly TreeNode[], path: string): TreeNode | null;
```

`fileTreeNodes.ts` uses only `import type` for `TreeNode` (`@jimka/typescript-ui/component/tree`), `DirectoryItem` (`../data/workspace`) and `IgnoreChain` (`../data/gitignore`), plus a value import of `isUnderRoot` from `../data/paths`. It must never import a value from `../data/workspace`, which calls Tauri's `platform()` at load time.

---

## Internal Structure

Every new function and method gets full JSDoc per `~/.claude/CODE_CONVENTIONS.md` — description, then `@param` / `@returns` where they add information. Some `FileTree` snippets below abbreviate theirs.

### `src/explorer/fileTreeNodes.ts` — the whole module

```typescript
// The file tree's node payload and its pure node-list rules — matching a
// fresh directory listing against the nodes already shown, and finding a
// loaded node by path — split out of FileTree.ts so they stay unit testable in
// vitest's `node` environment: FileTree.ts imports ../data/workspace, the
// app's Tauri entry point. The same split searchResults.ts makes for
// SearchPanel.ts.
import type { TreeNode } from '@jimka/typescript-ui/component/tree'
import type { DirectoryItem } from '../data/workspace'
import type { IgnoreChain } from '../data/gitignore'
import { isUnderRoot } from '../data/paths'

/** Domain payload `FileTree` attaches to every node via `TreeNode.data`. */
export interface FileTreeNodeData {
    path: string
    isDir: boolean
    /** The ignore chain governing this node from above — what `FileTree`'s
     *  listing takes as its `parentChain`. Rewritten in place each time the
     *  node's parent folder is re-listed. */
    parentChain: IgnoreChain
}

/**
 * The child list for a re-listed folder: `items`, in listing order, each
 * mapped to the node in `existing` with the same path and the same kind when
 * there is one, and to `createNode(item)` otherwise. Nodes in `existing` that
 * match no item are left out. Always returns a new array and never changes
 * `existing`.
 *
 * @param existing - The folder's current children.
 * @param items - The folder's fresh listing, already filtered.
 * @param createNode - Builds the node for an entry with no surviving match.
 * @returns The children to hand to `Tree.setChildren`.
 */
export function reconcileChildren(
    existing: readonly TreeNode[],
    items: readonly DirectoryItem[],
    createNode: (item: DirectoryItem) => TreeNode,
): TreeNode[] {
    const byPath = new Map<string, TreeNode>()

    for (const node of existing) {
        byPath.set((node.data as FileTreeNodeData).path, node)
    }

    return items.map(item => {
        const match = byPath.get(item.path)

        return match !== undefined && (match.data as FileTreeNodeData).isDir === item.isDir ? match : createNode(item)
    })
}

/**
 * Finds the loaded node for `path`, walking down from `nodes` through the one
 * node per level whose path is `path` or an ancestor of it. Performs no I/O:
 * a path below a folder that has not loaded its children is not found.
 *
 * @param nodes - The root nodes to start from.
 * @param path - The absolute path to find.
 * @returns The matching node, or `null` when it isn't loaded.
 */
export function findNodeByPath(nodes: readonly TreeNode[], path: string): TreeNode | null {
    let level: readonly TreeNode[] | undefined = nodes

    while (level !== undefined) {
        const next: TreeNode | undefined = level.find(node => isUnderRoot((node.data as FileTreeNodeData).path, path))

        if (next === undefined) {
            return null
        }

        if ((next.data as FileTreeNodeData).path === path) {
            return next
        }

        level = next.children
    }

    return null
}
```

### `src/data/watchEvents.ts` — targets

```typescript
/** One path the tree must re-list after a watcher batch. */
export interface RefreshTarget {
    /** A folder to re-list, or a changed path that may be one; the refresh
     *  skips a target that is not a loaded folder when it runs. */
    path: string
    /** Whether to also re-list every loaded folder below `path`, re-reading
     *  each `.gitignore` on the way down. */
    deep: boolean
}

export function refreshTargets(root: string, changedPaths: string[]): RefreshTarget[] {
    const stateDir = joinPath(root, WORKSPACE_DIR_NAME)
    const targets: RefreshTarget[] = []

    for (const path of changedPaths) {
        if (!isUnderRoot(root, path) || isUnderRoot(stateDir, path)) {
            continue
        }

        const dir = parentDir(path)

        if (!isUnderRoot(root, dir)) {
            continue
        }

        targets.push({ path: dir, deep: baseName(path) === GITIGNORE_NAME })
        targets.push({ path, deep: true })
    }

    return mergeRefreshTargets(targets)
}

export function mergeRefreshTargets(targets: readonly RefreshTarget[]): RefreshTarget[] {
    const deepByPath = new Map<string, boolean>()

    for (const target of targets) {
        deepByPath.set(target.path, (deepByPath.get(target.path) ?? false) || target.deep)
    }

    const merged = [...deepByPath].map(([path, deep]) => ({ path, deep }))
    const deepPaths = merged.filter(target => target.deep).map(target => target.path)

    return merged
        .filter(target => !deepPaths.some(other => other !== target.path && isUnderRoot(other, target.path)))
        .sort((a, b) => a.path.length - b.path.length)
}
```

Both need full JSDoc in the implementation (the `refreshTargets` block replaces the current one at [watchEvents.ts:16-43](src/data/watchEvents.ts#L16-L43)). The sort is ancestors first because an ancestor's path is always shorter, the same ordering `expansionOrder` uses ([src/data/session.ts:135](src/data/session.ts#L135)); `Array.prototype.sort` is stable, so equal lengths keep first-seen order. `refreshTargets` and `mergeRefreshTargets` never mutate their input.

### `src/explorer/FileTree.ts` — the refresh path

New module-private interface, where `FileTreeNodeData` was ([FileTree.ts:27-33](src/explorer/FileTree.ts#L27-L33)):

```typescript
/** A folder's visible entries and the ignore chain that governs them. */
interface DirectoryListing {
    items: DirectoryItem[]
    chain: IgnoreChain
}
```

Fields: `_pendingDirs` ([FileTree.ts:72](src/explorer/FileTree.ts#L72)) becomes `private _pendingTargets: RefreshTarget[] = []`. `_refreshChain` stays, with its doc comment saying every refresh — watcher, tree actions, Save As, the toggles — chains onto it so they run one at a time.

Methods replacing `refreshSubtree`, `performRefreshSubtree`, `rebuild`, `selectedPath` and `reselect` ([FileTree.ts:365-495](src/explorer/FileTree.ts#L365-L495)); `notifySelectedEntry` stays as it is:

```typescript
    /**
     * Re-lists `dir` in place: entries still there keep their rows,
     * expansion, loaded children and selection; new entries appear; vanished
     * ones disappear. Folders below `dir` are not re-read. A no-op when `dir`
     * is neither the project root nor a folder the tree has loaded.
     */
    async refreshDirectory(dir: string): Promise<void> {
        return this.queueRefresh({ path: dir, deep: false })
    }

    /** Runs `target`'s refresh after every refresh already queued on {@link _refreshChain}. */
    private queueRefresh(target: RefreshTarget): Promise<void> {
        const run = this._refreshChain.then(() => this.performRefresh(target))

        this._refreshChain = run.then(() => undefined, () => undefined)

        return run
    }

    /** Finds `target`'s folder node and re-lists it; skips a target that is not a loaded folder. */
    private async performRefresh(target: RefreshTarget): Promise<void> {
        if (this._root === null) {
            return
        }

        if (target.path === this._root) {
            await this.relistDirectory(null, target.path, this._rootChain, target.deep)

            return
        }

        const node = this.findLoadedNode(target.path)

        // A folder the tree never listed contributes nothing on screen, so
        // there is nothing to repair — and re-listing it here would eagerly
        // load a branch the user never opened. A file target lands here too.
        if (node === null || node.children === undefined) {
            return
        }

        const data = node.data as FileTreeNodeData

        if (!data.isDir) {
            return
        }

        await this.relistDirectory(node, target.path, data.parentChain, target.deep)
    }

    /**
     * Reads `dir`, reconciles the listing against `node`'s current children
     * (or the root level when `node` is `null`), writes the fresh chain into
     * every child's `parentChain`, and installs the result. With `deep`,
     * then does the same for every loaded folder among the new children.
     */
    private async relistDirectory(node: TreeNode | null, dir: string, parentChain: IgnoreChain, deep: boolean): Promise<void> {
        const listing = await this.readListing(dir, parentChain)

        // The project changed while the listing was read: this root-level
        // result belongs to the previous project.
        if (node === null && this._root !== dir) {
            return
        }

        const existing = node === null ? this.getNodes() : (node.children ?? [])
        const children = reconcileChildren(existing, listing.items, item => this.toNode(item, listing.chain))

        for (const child of children) {
            const data = child.data as FileTreeNodeData
            data.parentChain = listing.chain
        }

        this.applyChildren(node, children)

        if (deep) {
            await this.relistLoadedChildren(children)
        }
    }

    /** A deep refresh's recursion: re-lists each folder in `children` that has loaded its own children. */
    private async relistLoadedChildren(children: TreeNode[]): Promise<void> {
        for (const child of children) {
            const data = child.data as FileTreeNodeData

            if (!data.isDir || child.children === undefined) {
                continue
            }

            try {
                await this.relistDirectory(child, data.path, data.parentChain, true)
            } catch {
                // A folder removed while the refresh walked down; the removal
                // is its parent's own next watcher event.
            }
        }
    }

    /**
     * Installs `children` under `parent` with `Tree.setChildren`, then tells
     * the properties panel when that call dropped the selected row —
     * `setChildren` removes a node without emitting `"selection"`.
     */
    private applyChildren(parent: TreeNode | null, children: TreeNode[]): void {
        const selected = this.getSelectedNode()

        this.setChildren(parent, children)

        if (this.getSelectedNode() !== selected) {
            this.notifySelectedEntry()
        }
    }
```

A new folder node never has `children` (it is lazy and unloaded), so in `relistLoadedChildren` the check `child.children !== undefined` means "a reused folder that had loaded its contents". The `children` array handed to `setChildren` is stored by reference by the library; nothing in `FileTree` mutates it afterwards.

Toggles — replace `reload()` ([FileTree.ts:535-543](src/explorer/FileTree.ts#L535-L543)) with `refilterTree`, and have `setShowHidden` / `setShowIgnored` ([FileTree.ts:513](src/explorer/FileTree.ts#L513), [FileTree.ts:530](src/explorer/FileTree.ts#L530)) call `await this.refilterTree()` instead of `await this.reload()`:

```typescript
    /**
     * Re-applies the hidden/ignored toggles to every loaded folder in place,
     * through the same deep refresh a changed root `.gitignore` gets. A no-op
     * before any root is set.
     */
    private async refilterTree(): Promise<void> {
        if (this._root === null) {
            return
        }

        await this.queueRefresh({ path: this._root, deep: true })
    }
```

Listing and node construction — replace `loadDirectory` and `toNodes` ([FileTree.ts:597-657](src/explorer/FileTree.ts#L597-L657)); keep the existing JSDoc reasoning about checking for a `.gitignore` before filtering:

```typescript
    private async readListing(dir: string, parentChain: IgnoreChain): Promise<DirectoryListing> {
        const items = await listDirectory(dir)
        const chain = items.some(item => !item.isDir && item.name === GITIGNORE_NAME)
            ? extendIgnoreChain(parentChain, dir, await tryReadTextFile(joinPath(dir, GITIGNORE_NAME)))
            : parentChain

        return { items: items.filter(item => this.isEntryVisible(item, chain)), chain }
    }

    private async loadDirectory(dir: string, parentChain: IgnoreChain): Promise<TreeNode[]> {
        const listing = await this.readListing(dir, parentChain)

        return listing.items.map(item => this.toNode(item, listing.chain))
    }

    /**
     * Builds one entry's node. A folder's `loadChildren` reads the node's own
     * `data.parentChain` when it runs, so a refresh that rewrites that field
     * reaches a folder that has not loaded yet.
     */
    private toNode(item: DirectoryItem, chain: IgnoreChain): TreeNode {
        const data: FileTreeNodeData = { path: item.path, isDir: item.isDir, parentChain: chain }

        if (!item.isDir) {
            return { label: item.name, data }
        }

        return {
            label: item.name,
            hasChildren: true,
            loadChildren: () => this.loadDirectory(data.path, data.parentChain),
            data,
        }
    }
```

The `data` object in the closure must be the same object placed on the node — not a copy — or the rewrite in `relistDirectory` never reaches it.

`findLoadedNode` ([FileTree.ts:577-595](src/explorer/FileTree.ts#L577-L595)) keeps its signature and becomes `return findNodeByPath(this.getNodes(), path)`.

Watcher — in `handleFileSystemChange` ([FileTree.ts:713-719](src/explorer/FileTree.ts#L713-L719)) and `flushPendingRefresh` ([FileTree.ts:751-764](src/explorer/FileTree.ts#L751-L764)):

```typescript
        this._pendingTargets.push(...refreshTargets(this._root, paths))

        if (this._pendingTargets.length > 0) {
            this.scheduleRefresh()
        }
```

```typescript
    private async flushPendingRefresh(): Promise<void> {
        const targets = mergeRefreshTargets(this._pendingTargets)

        this._pendingTargets = []

        for (const target of targets) {
            try {
                await this.queueRefresh(target)
            } catch {
                // A folder that vanished between the event and the refresh
                // leaves the tree as it was.
            }
        }
    }
```

---

## Ordered Implementation Steps

0. **Library build and symlink** (no repository file changes).
   - `cd /home/jika/typescript/typescript-ui/.worktrees/tree-node-level-updates && git branch --show-current` → `feature/tree-node-level-updates`. Then `npm run build:lib`. Check: `grep -n "setChildren" packages/lib/dist/lib/types/component/tree/Tree.d.ts` shows the declaration.
   - `readlink /home/jika/typescript/loom/node_modules/@jimka/typescript-ui` → note the current target (expected `/home/jika/typescript/typescript-ui/packages/lib`).
   - `ln -sfn /home/jika/typescript/typescript-ui/.worktrees/tree-node-level-updates/packages/lib /home/jika/typescript/loom/node_modules/@jimka/typescript-ui`. Check: `readlink` prints the worktree path.
   - In the Loom implementation worktree, if it has no `node_modules`: `ln -s ../../node_modules node_modules` from its root. Check: `npm run typecheck` is clean before any source change.
1. **Tests first** (red).
   - Create `tests/fileTreeNodes.test.ts` with every U1–U13 case in `## Expected Behaviour`. Build fixtures as plain literals, e.g. `{ label: 'a.ts', data: { path: '/p/a.ts', isDir: false, parentChain: EMPTY_IGNORE_CHAIN } }`, and `createNode` as a `vi.fn` returning a fresh literal.
   - In `tests/watchEvents.test.ts`: delete the `describe('minimalRoots', …)` block ([watchEvents.test.ts:6-30](tests/watchEvents.test.ts#L6-L30)); rewrite the `refreshTargets` block to U14–U23; add a `describe('mergeRefreshTargets', …)` block with U24–U30; drop `minimalRoots` from the import and add `mergeRefreshTargets`.
   - Check: `npx vitest run tests/fileTreeNodes.test.ts tests/watchEvents.test.ts` fails only on the new and changed cases.
2. **`src/explorer/fileTreeNodes.ts`** — create it exactly as in `## Internal Structure`. Check: `npx vitest run tests/fileTreeNodes.test.ts` passes.
3. **`src/data/watchEvents.ts`** — add `RefreshTarget`; replace `refreshTargets`; add `mergeRefreshTargets`; delete `minimalRoots` ([watchEvents.ts:45-55](src/data/watchEvents.ts#L45-L55)). `joinPath`, `parentDir`, `isUnderRoot` and `baseName` are already imported. Update the header comment ([watchEvents.ts:1-10](src/data/watchEvents.ts#L1-L10)): `(refreshTargets/minimalRoots)` → `(refreshTargets/mergeRefreshTargets)`, and "*which* directories" → "*which* paths". Check: `npx vitest run tests/watchEvents.test.ts` passes. `npm run typecheck` now fails in `FileTree.ts` only (the `minimalRoots` import); steps 4–6 fix it.
4. **`src/explorer/FileTree.ts` — nodes and lookup.**
   - Delete the local `FileTreeNodeData` ([FileTree.ts:27-33](src/explorer/FileTree.ts#L27-L33)); add `import { reconcileChildren, findNodeByPath } from './fileTreeNodes'` and `import type { FileTreeNodeData } from './fileTreeNodes'`; add the `DirectoryListing` interface.
   - Replace `loadDirectory` / `toNodes` with `readListing`, `loadDirectory`, `toNode` as in `## Internal Structure`. `setProjectRoot` keeps calling `loadDirectory` unchanged.
   - Make `findLoadedNode` delegate to `findNodeByPath`, and update its JSDoc: it walks down along the path, still with no I/O.
5. **`src/explorer/FileTree.ts` — refresh path.**
   - Imports: `import { refreshTargets, mergeRefreshTargets } from '../data/watchEvents'` and `import type { RefreshTarget } from '../data/watchEvents'`.
   - Replace `_pendingDirs` with `_pendingTargets`; rewrite the `_refreshChain` doc comment.
   - Delete `refreshSubtree`, `performRefreshSubtree`, `rebuild`, `selectedPath`, `reselect`. Add `refreshDirectory`, `queueRefresh`, `performRefresh`, `relistDirectory`, `relistLoadedChildren`, `applyChildren`.
   - Replace the four `this.refreshSubtree(` calls in `createFile`, `createFolder`, `renameEntry`, `deleteEntry` ([FileTree.ts:219](src/explorer/FileTree.ts#L219), [245](src/explorer/FileTree.ts#L245), [270](src/explorer/FileTree.ts#L270), [295](src/explorer/FileTree.ts#L295)) with `this.refreshDirectory(`; in `createFile`'s JSDoc ([FileTree.ts:197](src/explorer/FileTree.ts#L197)) change `refreshSubtree` to `refreshDirectory`.
   - Update `handleFileSystemChange` and `flushPendingRefresh` as in `## Internal Structure`, with their JSDoc: `handleFileSystemChange` "records the batch's refresh targets"; `flushPendingRefresh` "merges the pending targets (see `mergeRefreshTargets`) and queues each on `_refreshChain`, ancestors first".
   - `TREE_REFRESH_DEBOUNCE_MS` doc ([FileTree.ts:22-24](src/explorer/FileTree.ts#L22-L24)): "into a single rebuild" → "into a single refresh pass".
6. **`src/explorer/FileTree.ts` — toggles.** Add `refilterTree`; delete `reload`; point `setShowHidden` / `setShowIgnored` at it. Rewrite their JSDoc: setting the flag re-filters every loaded folder in place — expansion, selection and scroll are kept — and the returned promise settles when the re-filter is done. Remove the "collapses every expansion" wording.
7. **`src/shell/EditorShell.ts`.**
   - `handleFileSaved` ([EditorShell.ts:529](src/shell/EditorShell.ts#L529)): `refreshSubtree` → `refreshDirectory`.
   - `openProjectRoot`'s JSDoc ([EditorShell.ts:475-484](src/shell/EditorShell.ts#L475-L484)): replace the sentence from "Settings reapplication is" through "collapse it right back." with: "Settings reapplication is `await`ed and finishes *before* the expansion restore starts, not just ordered before it in source: `FileTree.setShowHidden`/`setShowIgnored` each re-filter every loaded folder and return that re-filter's own promise, and a saved expanded folder that only the new toggles reveal — a hidden `.github`, say — exists in the tree only once the re-filter has landed." Keep the rest of the comment.
8. **Checks.**
   - `npm run typecheck` — clean. `npm test` — clean.
   - `grep -rn "refreshSubtree\|minimalRoots\|reselect\|selectedPath\|\.reload()\|_pendingDirs" src tests` — zero matches.
   - `grep -n "this.setNodes(" src/explorer/FileTree.ts` — exactly one match, in `setProjectRoot`.
   - `grep -n "setScrollY\|_scroller" src/explorer/FileTree.ts` — zero matches.
   - `grep -n "this.setChildren(" src/explorer/FileTree.ts` — exactly one match, in `applyChildren`.
9. **Docs** — `README.md` and `TODO.md` per `## Documentation Impact`.
10. **Real-shell check** — run `## Verification`'s QA-shell procedure (M1–M13). Leave the symlink repointed afterwards, and say so in the closing report.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `src/explorer/fileTreeNodes.ts` |
| Create | `tests/fileTreeNodes.test.ts` |
| Modify | `src/explorer/FileTree.ts` |
| Modify | `src/data/watchEvents.ts` |
| Modify | `tests/watchEvents.test.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

Outside the repository: `/home/jika/typescript/loom/node_modules/@jimka/typescript-ui` (symlink, step 0).

---

## Expected Behaviour

### Unit-testable — `reconcileChildren` (`tests/fileTreeNodes.test.ts`)

Fixtures: `node(path, isDir)` returns a literal with `data: { path, isDir, parentChain: EMPTY_IGNORE_CHAIN }`; `item(path, isDir)` returns `{ name: baseName(path), path, isDir }`.

- **U1** Existing `[lib/, a.ts]`, listing `[lib/, b.ts]`: result `[0]` is the same object as the existing `lib/` (`toBe`); result `[1]` has path `/p/b.ts`; the result has length 2 (no `a.ts`); `createNode` was called once, with the `b.ts` item.
- **U2** Kind flip: existing `[x]` (file), listing `[x/]` (folder): result `[0]` is not the existing object; `createNode` was called with the folder item.
- **U3** Rename: existing `[old.ts]`, listing `[new.ts]`: result is one new node for `new.ts`.
- **U4** Order: existing `[B.ts, a.ts]`, listing `[a.ts, B.ts]`: result is `[existing a.ts, existing B.ts]` by identity; `createNode` never called.
- **U5** Empty listing → `[]`.
- **U6** Empty `existing` → one `createNode` call per item, result in listing order.
- **U7** The result is a new array (`not.toBe(existing)`), and `existing` still has its original length and elements.

### Unit-testable — `findNodeByPath` (`tests/fileTreeNodes.test.ts`)

Fixture: roots `[/p/src/ (children [/p/src/a.ts, /p/src/lib/ (children undefined)]), /p/readme.md]`.

- **U8** `/p/readme.md` → the root-level node.
- **U9** `/p/src/a.ts` → the nested node (`toBe`).
- **U10** `/p/src/lib/x.ts` → `null` (its folder has not loaded).
- **U11** `/p/missing.ts` → `null`; `[]` roots → `null`.
- **U12** With an extra root `/p/srcx/` holding `/p/srcx/b.ts`, `/p/srcx/b.ts` is found under `/p/srcx/`, not confused with `/p/src/`.
- **U13** A file `/p/f` and the query `/p/f/g` → `null` (a file is never descended into).

### Unit-testable — `refreshTargets` (`tests/watchEvents.test.ts`, root `/p`)

- **U14** `['/p/src/a.ts']` → `[{ path: '/p/src', deep: false }, { path: '/p/src/a.ts', deep: true }]`.
- **U15** `['/p/.gitignore']` → `[{ path: '/p', deep: true }]`.
- **U16** `['/p/old', '/p/new']` → `[{ path: '/p', deep: false }, { path: '/p/old', deep: true }, { path: '/p/new', deep: true }]`.
- **U17** `['/p/a.ts', '/p/src/b.ts']` → `[{ path: '/p', deep: false }, { path: '/p/src', deep: false }, { path: '/p/a.ts', deep: true }, { path: '/p/src/b.ts', deep: true }]`.
- **U18** `['/p/src/a.ts', '/p/src/.gitignore']` → `[{ path: '/p/src', deep: true }]`.
- **U19** `['/p/lib/.gitignore', '/p/lib/x/y.ts']` → `[{ path: '/p/lib', deep: true }]`.
- **U20** `['/p/.loom/workspace.json']` → `[]`; `['/p/.loom']` → `[]`.
- **U21** `['/other/x.ts']` → `[]`; `['/p']` → `[]`; `[]` → `[]`.
- **U22** Windows: root `C:\p`, `['C:\\p\\src\\a.ts']` → `[{ path: 'C:\\p\\src', deep: false }, { path: 'C:\\p\\src\\a.ts', deep: true }]`.
- **U23** A folder swapped in: `['/p/lib']` → `[{ path: '/p', deep: false }, { path: '/p/lib', deep: true }]`.

### Unit-testable — `mergeRefreshTargets` (`tests/watchEvents.test.ts`)

Here `T('/p', true)` is shorthand for `{ path: '/p', deep: true }`; write the full objects in the tests.

- **U24** `[T('/p/a', false), T('/p/a', true)]` → `[T('/p/a', true)]`, and the same for the reverse input order (deep wins).
- **U25** `[T('/p', true), T('/p/src', false)]` → `[T('/p', true)]`.
- **U26** `[T('/p', false), T('/p/src', false)]` → `[T('/p', false), T('/p/src', false)]`.
- **U27** `[T('/p', false), T('/p/src', true)]` → `[T('/p', false), T('/p/src', true)]` (a deep target below a shallow one is kept).
- **U28** `[T('/p', true), T('/px/a', false)]` → `[T('/p', true), T('/px/a', false)]` (a shared prefix is not containment).
- **U29** `[T('/p/src', false), T('/p', false)]` → `[T('/p', false), T('/p/src', false)]` (ancestors first, whatever the input order).
- **U30** `[]` → `[]`; a non-empty input array still has its original elements afterwards.

### Manual — real shell (QA Vite server, see `## Verification`)

`<wt>` is the Loom implementation worktree's root; `<fx>` is `<wt>/aaa-refresh-fixture`. Each case: make the disk change in a shell, then drive the watcher handler with `await __drive([...])`. Before each drive, reset `__events` to zeros and record `__snap()`; after it, compare. "Kept" means: `__tree.findLoadedNode('<fx>/keep') === __keep` and it is still in `__tree.getExpandedPaths()`; the selected path is unchanged; `__tree._scroller.getScrollY()` is unchanged; `__events` is all zeros; the Properties section still describes the same entry.

| # | Disk change (from `<wt>`) | Drive with | Expected |
|---|---|---|---|
| M1 | `touch aaa-refresh-fixture/new.ts` | `['<fx>/new.ts']` | `new.ts` row appears after the folders, before `selected.ts`; everything kept; screenshots before/after differ only by the new row (no collapse) |
| M2 | `rm aaa-refresh-fixture/sibling.ts` | `['<fx>/sibling.ts']` | `sibling.ts` gone; everything kept |
| M3 | `printf '*.tmpx\n' > aaa-refresh-fixture/.gitignore` | `['<fx>/.gitignore']` | `x.tmpx` vanishes from under `keep`; everything kept |
| M4 | `rm aaa-refresh-fixture/.gitignore` | `['<fx>/.gitignore']` | `x.tmpx` is back under `keep`; everything kept |
| M5 | `rm -rf aaa-refresh-fixture/keep && mkdir aaa-refresh-fixture/keep && touch aaa-refresh-fixture/keep/fresh.ts` | `['<fx>/keep']` only | `keep` is the same object, still expanded, and now lists only `fresh.ts` |
| M6 | `await __tree.expandPaths(['<fx>/many'])`, `__tree.setScrollY(600)`, record `__snap().scrollY` (non-zero), then `touch aaa-refresh-fixture/many/f30b.ts` | `['<fx>/many/f30b.ts']` | scroll offset equals the recorded value; `f30b.ts` listed in `many` after `f30.ts` |
| M7 | `rm aaa-refresh-fixture/selected.ts` | `['<fx>/selected.ts']` | row gone; `__tree.getSelectedNode()` is `null`; Properties shows "Select a file or folder in the tree."; `__events.selection` is 0 |
| M8 | `touch aaa-refresh-fixture/flip`, drive, `await __tree.selectPath('<fx>/flip')`; then `rm aaa-refresh-fixture/flip && mkdir aaa-refresh-fixture/flip` | `['<fx>/flip']` | `flip` now sorts among the folders with a folder icon, unselected; Properties shows its empty line |
| M9 | `mv aaa-refresh-fixture/new.ts aaa-refresh-fixture/renamed.ts` | `['<fx>/new.ts', '<fx>/renamed.ts']` | `new.ts` gone, `renamed.ts` present; `keep` kept |
| M10 | `touch aaa-refresh-root.ts` | `['<wt>/aaa-refresh-root.ts']` | row appears among the root-level files; `__tree.findLoadedNode('<fx>') === __fx` and it is still expanded |
| M11 | — | `await __tree.setShowHidden(true)`, then `false`; same for `setShowIgnored` | hidden (resp. ignored) entries appear and disappear, at the root and inside expanded folders; `__fx` and `__keep` are still the nodes found for their paths, and still expanded; scroll offset unchanged. With the root `.gitignore` shown and selected via `selectPath`, hiding it clears the selection and Properties shows its empty line |
| M12 | `touch aaa-refresh-fixture/made.ts` | `await __tree.refreshDirectory('<fx>'); await __tree.selectPath('<fx>/made.ts')` | `made.ts` selected, Properties describes it, `keep` kept — the sequence `createFile` runs after its write |
| M13 | `rm -rf aaa-refresh-fixture aaa-refresh-root.ts` | `['<fx>', '<wt>/aaa-refresh-root.ts']` | both rows gone; then `git status --short` in `<wt>` lists no fixture path |

### Manual — real Tauri app (the user, `npm run tauri:dev`)

The QA stubs make `writeTextFile`, `mkdir`, `rename`, `remove` and `save` no-ops and the watcher silent, so these need the real app:

- **T1** With two folders expanded and a file selected, the context menu's New File, New Folder, Rename and Delete each change only their own row; the rest of the tree does not collapse. New File selects and opens the new file. Rename of a folder leaves it collapsed under its new name, selected.
- **T2** Save As of an untitled buffer into an expanded folder adds its row in place.
- **T3** Outside changes: create and delete files from a terminal, `git checkout` a branch with different files, and save a `.gitignore` edit from Loom itself — each updates only the affected rows.
- **T4** View → Show Hidden Files / Show Ignored Files with folders expanded: entries appear and disappear in place.

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — clean, including `tests/fileTreeNodes.test.ts` (U1–U13) and `tests/watchEvents.test.ts` (U14–U30).
- `npm run build` — clean.
- The grep checks in step 8.
- `readlink /home/jika/typescript/loom/node_modules/@jimka/typescript-ui` — still the library worktree's `packages/lib`.
- **QA-shell check (M1–M13), Chromium via the chrome-devtools MCP tools.**[^chromium]
  1. Create the fixture from `<wt>`: `mkdir -p aaa-refresh-fixture/keep aaa-refresh-fixture/many && touch aaa-refresh-fixture/keep/inner.ts aaa-refresh-fixture/keep/x.tmpx aaa-refresh-fixture/selected.ts aaa-refresh-fixture/sibling.ts && for i in $(seq -w 1 60); do touch aaa-refresh-fixture/many/f$i.ts; done`.
  2. Make sure nothing listens on port 1420 (`ss -ltnp | grep :1420`), then from `<wt>` run `npx vite --config qa/vite.config.qa.ts` in the background. **Do not use `qa/runqa.sh`** (see `## Architecture Decisions`). The QA config serves `<wt>`'s source and reads `<wt>`'s files through `/__fsops`.
  3. `new_page` → `http://localhost:1420/` (no `?qa=`, so the perf harness stays idle). `evaluate_script`: `window.__FAKE_PROJECT_ROOT__ = '<wt>'`, then click the welcome screen's *Open Folder…* button (`take_snapshot` + `click`, or a DOM click on the button whose text includes `Open Folder`). Wait until `.FileTree .TreeRow` elements appear.
  4. `evaluate_script` to find the tree and install the helpers:

     ```javascript
     async () => {
         const { Body } = await import('/@fs/home/jika/typescript/typescript-ui/.worktrees/tree-node-level-updates/packages/lib/dist/lib/core.es.js')
         const stack = [Body.getInstance()]

         while (stack.length > 0 && window.__tree === undefined) {
             const component = stack.pop()

             if (component.constructor.name === 'FileTree') {
                 window.__tree = component
             } else {
                 stack.push(...(component.getComponents?.() ?? []))
             }
         }

         window.__events = { selection: 0, expand: 0, collapse: 0 }

         for (const name of Object.keys(window.__events)) {
             window.__tree.on(name, () => { window.__events[name] += 1 })
         }

         window.__drive = async paths => {
             window.__tree.handleFileSystemChange(paths, true)
             await new Promise(resolve => setTimeout(resolve, 500))
         }
         window.__snap = () => ({
             selected: window.__tree.getSelectedNode()?.data.path ?? null,
             expanded: window.__tree.getExpandedPaths().sort(),
             scrollY: window.__tree._scroller.getScrollY(),
         })

         return window.__tree !== undefined
     }
     ```

     If it returns `false`, the import URL is not the module instance the app loaded: read the exact `core.es.js` URL from `list_network_requests` and import that.
  5. Setup, in one `evaluate_script` (`async () => { … }`): `await __tree.expandPaths(['<fx>', '<fx>/keep'])`, `await __tree.selectPath('<fx>/selected.ts')`, `window.__fx = __tree.findLoadedNode('<fx>')`, `window.__keep = __tree.findLoadedNode('<fx>/keep')`. `selectPath` selects without opening a tab.
  6. Run M1–M13 in order, with a `take_screenshot` before and after M1 and M5.
  7. Stop Vite by its port (`ss -ltnp` → `kill <pid>`), never with `pkill -f`. Confirm `git status --short` in `<wt>` lists no fixture path and `readlink` still shows the library worktree.

---

## Documentation Impact

No library documentation changes. `FileTree.refreshDirectory` is app-internal; no doc names `refreshSubtree`.

- **`README.md`**, *Highlights → File tree* ([README.md:28-34](README.md#L28-L34)):
  - "toggles bring each class back independently." → "toggles bring each class back independently, without collapsing any open folder."
  - After "leaves the tree as it is." insert: "A re-listed folder changes in place: new entries appear and vanished ones disappear, while open folders stay open, the selected row stays selected, and the scroll position holds. A renamed entry counts as a new one, so a renamed folder comes back collapsed."
- **`TODO.md`**: delete the known-issue entry "A created, deleted, or renamed entry still rebuilds the whole tree." ([TODO.md:140-150](TODO.md#L140-L150)) and put this entry in its place, under *Known issues / loose ends*:

  > - **A renamed or moved folder comes back collapsed.** A re-listed folder keeps every entry that is still there, matched by path and kind, but a rename or move changes the path, so the entry is a new one: collapsed, with nothing loaded under it, and — when the rename came from outside Loom — unselected. Keeping it open would mean carrying the old node, and the path of everything loaded under it, over to the new name. `Tree` has no move primitive (`removeNode` then `insertNode` drops the node's state in between), and the watcher hands the tree plain paths, not rename pairs.

---

## Potential Challenges

- **The repointed symlink is shared.** Every Loom checkout — the main tree and every worktree — builds against the library branch until the link is restored. Other work in progress sees the branch's library meanwhile.
- **`qa/runqa.sh` silently restores the link on exit.** Don't run it during this work; if a perf run is needed, set `QA_MAIN_LIB=/home/jika/typescript/typescript-ui/.worktrees/tree-node-level-updates/packages/lib` and check `readlink` afterwards.
- **A removed library worktree leaves the link dangling.** Once the library branch merges and its worktree is removed, Vite shows a resolve-error overlay and `tsc` fails until the link is restored (see *Loom builds against the unmerged library branch through the shared symlink*).
- **`npm run typecheck` fails between steps 3 and 6.** Expected; it is clean again after step 6.
- **A lazy load already running during a deep refresh uses the old rules.** A folder the user expands just before a `.gitignore` refresh rewrites its `parentChain` still filters its listing with the old chain. The window is one directory read; the next change to that folder corrects it.
- **A deep refresh renders once per loaded folder.** Toggling Show Hidden in a heavily expanded tree updates top-down over the time the reads take, not in one frame. Nothing collapses in between.
- **`setChildren` stores the array by reference.** Never mutate an array after passing it; `reconcileChildren` always returns a fresh one.
- **`revealByPredicate` racing a refresh** (a `selectPath` for a never-loaded path while a refresh replaces a folder's children) can walk nodes the refresh just detached. This predates the plan (`setNodes` had the same effect) and is a stated non-goal of the library plan.

---

## Critical Files

- [src/explorer/FileTree.ts](src/explorer/FileTree.ts) — the whole refresh path (365-495), toggles (497-543), `findLoadedNode` (577), listing (597-657), watcher (692-764).
- [src/explorer/searchResults.ts](src/explorer/searchResults.ts) and [tests/searchResults.test.ts](tests/searchResults.test.ts) — the pure TreeNode-module precedent `fileTreeNodes.ts` mirrors.
- [src/data/watchEvents.ts](src/data/watchEvents.ts) and [tests/watchEvents.test.ts](tests/watchEvents.test.ts) — the target rules being rewritten.
- [src/data/gitignore.ts](src/data/gitignore.ts) — `IgnoreChain`, `extendIgnoreChain`.
- [src/data/paths.ts:182](src/data/paths.ts#L182) — `isUnderRoot` (inclusive: `path` equal to `root` counts).
- [src/shell/EditorShell.ts](src/shell/EditorShell.ts) — `handleFileSaved` (525), `openProjectRoot` (466-514), the toggle wiring (174-175, 367-369).
- Library, on the branch: `/home/jika/typescript/typescript-ui/.worktrees/tree-node-level-updates/packages/lib/src/typescript/lib/component/tree/Tree.ts` — `setChildren` (399), `_pruneDetachedState` (997), `_supersedeLoad` (1029), `_commitStructureChange` (1054); `…/packages/lib/docs/components/Tree.md` *Updating nodes* (93); `…/plans/implemented/tree-node-level-updates.md`, including its Implementation Notes.
- [plans/implemented/filesystem-watching.md](plans/implemented/filesystem-watching.md) — the design this plan replaces (its *Expansion is restored by replaying the expanded paths* decision).
- [qa/README.md](qa/README.md), [qa/runqa.sh](qa/runqa.sh), [qa/vite.config.qa.ts](qa/vite.config.qa.ts) — the QA server and its symlink handling.

---

## Non-Goals

- **Keeping a renamed or moved folder expanded.** A rename is a new entry; the new `TODO.md` entry records it.
- **Scroll anchoring.** The offset is kept as a number, as `setChildren` does; rows inserted above the viewport shift the view by whole rows.
- **`setProjectRoot` without `setNodes`.** Opening a project is a new dataset.
- **Watching ignore rules outside the project folder** (a repository-root `.gitignore` above the opened folder, `.git/info/exclude`). Unchanged from today.
- **Revealing an entry created inside a collapsed folder whose contents are loaded.** `selectPath` finds the node but `selectNode` does nothing under a collapsed parent. This predates the plan and is unchanged by it.
- **Dropping pending refresh targets on a project switch.** Unchanged from today.
- **Any change to typescript-ui.** No gap was found. If the implementation hits one, stop and ask rather than working around it (Loom's `CLAUDE.md`).
- **A WebKitGTK performance run.** The change removes work (no collapse, no replayed reads); it needs no measurement to land.

---

## Notes

[^library-recipe]: The library manifest (`node_modules/@jimka/typescript-ui/llms.txt`) lists `Tree` as the only component for an expandable tree of plain nodes; `TreeStore`/`TreeTable` are the store-bound table hierarchy and would mean rewriting `FileTree` wholesale. Within `Tree`, the library plan weighed three shapes for this exact re-list and chose `setChildren` with reused survivors: one pass and one render per folder, versus one `insertNode`/`removeNode` call (and render) per changed entry, versus a keyed reconcile inside `Tree` that the library rejected. Loom's `SearchPanel` still rebuilds its results tree with `setNodes`, but it replaces its whole dataset on each run, so it is not a precedent for a partial update.

[^no-gap]: `notifyNodeChanged` would be needed only if a reused node's label or icon could change; a node is reused only when its path and kind match, so both are unchanged (the icon resolver reads `data.path` and `data.isDir`). `insertNode` / `removeNode` would give one render per entry instead of one per folder. No other capability was missing: the library keeps expansion, selection, focus, loaded state and scroll for every node still reachable, prunes state for removed nodes, and emits nothing.

[^match-key]: A kind flip cannot reuse the node. A folder node carries `hasChildren`, `loadChildren` and possibly loaded `children`; a file node carries none of them, and `Tree` has no way to return a node to "not loaded". A fresh node is the only clean answer. A rename cannot reuse the node either: the old node's `data.path`, and the path of every node loaded under it, would all be wrong, and the watcher reports only plain paths, so pairing a rename's two ends is guesswork. Today's rebuild loses a renamed folder's expansion and selection too (`expandPaths` and `reselect` look up the old path), so this is not a regression.

[^pure-module]: `FileTree.ts` cannot load in vitest's `node` environment because it imports `../data/workspace`, which calls Tauri's `platform()` at load time. `entryProperties.ts` and `searchResults.ts` exist for the same kind of reason: the panels they serve cannot load in that environment. Type-only imports are erased at build time, so `fileTreeNodes.ts` can name `TreeNode` and `DirectoryItem` without loading either module. `FileTreeNodeData` moves with the helpers because they read it, the same way `SearchTreeNodeData` lives in `searchResults.ts`.

[^find-descent]: Today's `findLoadedNode` visits every loaded node. With `minimalRoots` gone and every changed path now producing its own target, a flush looks up roughly two targets per changed path instead of a handful of merged roots; a `git checkout` touching a few hundred files against a few thousand loaded nodes would mean millions of comparisons. Walking down along the path costs one scan of each level's siblings. The result is identical for any tree whose node paths follow the folder structure, which `FileTree` always builds. Moving the walk into the pure module makes it testable.

[^every-changed-folder]: `minimalRoots` was correct only because a rebuild of `/p` re-read every expanded folder below it through `expandPaths`. The library plan's `^identity-not-keys` footnote calls this out: with `setChildren`, Loom must re-list each changed, loaded folder. Dropping a target below a *deep* target keeps the one useful part of the old coalescing, since a deep refresh does re-read those folders. Ancestors go first so a folder removed by its parent's refresh is skipped instead of failing its own read.

[^path-itself]: A folder can be replaced without any event naming its contents: `mv build /tmp/old && mv /tmp/new build` reports only `build` itself. The parent's re-list keeps the `build` node (same path, still a folder) together with its stale loaded children. Today's rebuild hid this by re-reading every expanded folder. Treating the changed path as a deep target re-reads `build` and everything loaded under it. The extra target costs nothing in the common cases: for a file, a deleted folder, or a new (unloaded) folder, `performRefresh` finds no loaded folder and returns without reading. Metadata-only events never produce targets, because `watchDirectory` flags each event separately and `FileTree` ignores events whose `listingChanged` is `false`.

[^gitignore-deep]: A folder's filtered-out entries are never kept in the tree, so a rule change that un-ignores something needs the disk listing again; re-filtering the nodes already held cannot bring an entry back. Loaded folders are therefore re-listed. Unloaded ones only need the right chain for their eventual first load, which the `data.parentChain` rewrite gives them without a read. The I/O is bounded by what the user has opened: every loaded folder below the changed `.gitignore`. Today's rebuild re-read every expanded folder below the target, so the cost is the same order. An ordinary create, delete or rename cannot change any chain (only a `.gitignore` event can), so a shallow re-list is enough; the fresh chain it writes into reused children is equal in content to the old one.

[^progressive]: Reading every listing first and then applying all the `setChildren` calls in one synchronous pass would give one visual update. It would also run one reachability walk, one flatten and one render per folder back to back in a single task, which can block a frame for a large tree. Installing each folder as it lands spreads that work between the reads. A batched multi-parent commit in `Tree` would be an optimisation, not a missing capability, and this plan does not need it.

[^root-guard]: `setProjectRoot` does not queue on `_refreshChain`. If the project changes while a root-level refresh waits for its listing, `setChildren(null, …)` would put the old project's entries into the new tree. `setNodes` in today's `rebuild` has the same hole. A non-root refresh caught the same way only touches a node the new tree no longer holds, which `setChildren` handles harmlessly, so only the root case needs the check.

[^rename-method]: The method no longer rebuilds a subtree; it re-lists one folder. Keeping the old name would tell a reader the opposite of what it does. Its callers — `createFile`, `createFolder`, `renameEntry`, `deleteEntry` and `EditorShell.handleFileSaved` — each change one entry in one folder, so the shallow refresh is exactly what they need. Their follow-up `selectPath` still finds the new entry with `findLoadedNode`, since the refresh has already inserted it.

[^refresh-chain]: The old reason — a second rebuild would snapshot expansion the first had not restored yet — is gone, but serialisation still matters. Two overlapping refreshes of one folder could install an older listing over a newer one, and each refresh must reconcile against the children the previous one installed, not a list that is about to be replaced. The toggles now queue on the same chain, which also fixes today's unserialised `reload()` racing a watcher rebuild.

[^selection-notify]: The library stays silent on purpose: the caller made the change. Comparing the anchor node (`getSelectedNode()`) by identity is exact here, because a surviving entry keeps its node object and a removed one is pruned to `null`. `notifySelectedEntry` reports the anchor, so a removed non-anchor row of a multi-selection needs no report. `onSelectFile` is not called: a dropped selection selects nothing new, so there is no file to preview.

[^toggles]: A toggle is the same operation as a changed root `.gitignore`: the rule for which entries are visible changed everywhere. Keeping `reload()` would leave the last user action that collapses the tree, and would keep a second path that runs outside `_refreshChain`. The cost moves from one root listing to one listing per loaded folder, the same bound as a `.gitignore` refresh. `openProjectRoot` calls both setters right after `setProjectRoot`, when only the root is loaded, so a project switch still costs two root listings, as today.

[^symlink]: `npm link`-style repointing is how Loom already consumes the library: the link normally targets the main checkout's `packages/lib`, and `qa/runqa.sh` repoints it per run. A version bump or a packed tarball would detach Loom from the branch it has to track while that branch is still in review.

[^chromium]: This is a functional check — rows, identity, selection, scroll — not a timing measurement, so Chromium is enough; the library plan's own manual check of these methods also ran in Chromium. WebKitGTK is required only when paint or layout cost is the question. The QA server is started directly because `qa/runqa.sh` both launches MiniBrowser full-screen on the user's desktop and resets the symlink when it exits.
