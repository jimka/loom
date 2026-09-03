---
depends-on: [tree-filtering]
touches-shared: [src/explorer/FileTree.ts, src/data/workspace.ts, src/data/workspaceState.ts, src/shell/EditorShell.ts, src-tauri/Cargo.toml, src-tauri/Cargo.lock, src-tauri/capabilities/default.json, README.md, TODO.md]
---

# Filesystem Watching — Implementation Plan

## Overview

Loom's file tree only ever reads a directory once — when the user expands it.
A file created, deleted, or renamed by another editor, a `git checkout`, or a
build tool never appears, and there is no manual refresh either. The one
existing repair path, [src/explorer/FileTree.ts:124](src/explorer/FileTree.ts#L124)'s
`refresh()`, rebuilds the *whole* tree and is called from exactly one place:
after Loom itself saves a file.

This plan puts a filesystem watcher behind the tree. Tauri's already-installed
`fs` plugin gains its optional `watch` feature, `src/data/workspace.ts` gains
one wrapper around it, and `FileTree` gains one public operation —
**`refreshSubtree(dir)`** — that re-lists a directory and everything the tree
had loaded below it. A new pure module, `src/data/watchEvents.ts`, turns a
batch of changed paths into the smallest set of directories that operation has
to run on.

`refreshSubtree` re-lists through the existing
[`loadDirectory`](src/explorer/FileTree.ts#L242)/[`isEntryVisible`](src/explorer/FileTree.ts#L263)
pair, so the hidden-file and `.gitignore` filters are re-applied by the same
code that applied them the first time. No hand-written Rust; no npm dependency
is added.

---

## Architecture Decisions

### The watcher is Tauri's `fs` plugin, enabled by a Cargo feature

`@tauri-apps/plugin-fs` already exports `watch`, and the matching Rust crate
already ships the `notify`-backed implementation behind an optional `watch`
Cargo feature. Turning it on is two edits — `features = ["watch"]` in
[src-tauri/Cargo.toml:26](src-tauri/Cargo.toml#L26) and the `fs:allow-watch` /
`fs:allow-unwatch` permissions in
[src-tauri/capabilities/default.json:8](src-tauri/capabilities/default.json#L8).
[src-tauri/src/lib.rs](src-tauri/src/lib.rs) is not touched.[^why-plugin-fs]

The call is wrapped in [src/data/workspace.ts](src/data/workspace.ts), which
that module's own header declares to be the app's only importer of
`@tauri-apps/*`. The wrapper hands its caller a plain `string[]` of changed
paths, so the plugin's `WatchEvent` type never leaves the module.

### One operation repairs the tree: `refreshSubtree(dir)`

`FileTree.refreshSubtree(dir)` re-lists `dir` and rebuilds every directory
below it that the tree had already loaded. It is the only repair operation:
the watcher calls it, `EditorShell`'s post-save hook calls it, and a future
tree context menu calls it after a user-initiated create, rename, or delete.
`refresh()` is deleted — `refreshSubtree(root)` is the same thing.

The rebuild re-lists through `loadDirectory`, which re-reads the directory's
own `.gitignore` and re-runs `isEntryVisible` on every entry. Filtering is
therefore re-applied, never duplicated.[^reuse-loaddirectory]

### A changed `.gitignore` needs no special case

A `.gitignore` file's rules govern everything below its own directory, so a
change to it invalidates that whole subtree. `refreshSubtree` is subtree-scoped
by construction, and a `.gitignore`'s directory is simply `parentDir` of the
changed path — the same target rule every other changed path gets.

| Changed path | Target directory | Why |
|---|---|---|
| `/p/src/a.ts` | `/p/src` | the changed file's own directory is re-listed |
| `/p/.gitignore` | `/p` | the directory whose rules changed; `refreshSubtree` rebuilds everything below it |
| `/p/old` **and** `/p/new` (a rename) | `/p` | both ends of the rename share one parent |
| `/p/a.ts` **and** `/p/src/b.ts` | `/p` | `/p/src` is dropped: `/p` is already a target and covers it |
| `/p/.loom/workspace.json` | — | Loom's own session write (see below) |
| `/other/x.ts` | — | outside the project root |
| `/p` | — | the root itself; its parent is outside the project |

The new rules reach the descendants because the rebuild recomputes ignore
chains top-down. An ignore chain is the stack of `.gitignore` layers governing
one directory, outermost first — `IgnoreChain` in
[src/data/gitignore.ts:19](src/data/gitignore.ts#L19). Re-listing `/p` reads
`/p/.gitignore` again and produces fresh child nodes carrying the fresh chain,
and each expanded descendant is then re-listed through those fresh nodes' own
`loadChildren` closures.

### Each directory node carries the ignore chain it was listed under

`FileTreeNodeData` gains a `parentChain: IgnoreChain` field — the chain
governing the node from above, which is exactly the second argument
`loadDirectory` needs to re-list that node. Without it, re-listing an
arbitrary directory would mean rebuilding its chain from the root
downward.[^chain-on-node]

### Expansion is restored by replaying the expanded paths

Replacing a node's `children` needs the tree re-flattened, and the library's
only public way to force that is `setNodes`, which clears the expanded set.
The rebuild therefore snapshots `getExpandedPaths()` before and replays it
with the existing `expandPaths` after. Directories *outside* the rebuilt
subtree keep their node objects, so replaying their expansion costs no disk
reads at all; only directories inside the subtree are re-listed.[^setnodes-reflatten]

### Events are translated to targets by a pure module

`src/data/watchEvents.ts` holds `refreshTargets` and `minimalRoots` — the
whole rule in the table above, with no Tauri and no `FileTree` dependency, so
it is unit-testable in vitest's node environment. This mirrors
[src/data/gitignore.ts](src/data/gitignore.ts) and
[src/data/session.ts](src/data/session.ts), which keep their decision logic
out of the native module for the same reason.

### The batch window is fixed, not sliding

The first relevant event arms a `TREE_REFRESH_DEBOUNCE_MS` timer; further
events land in the same batch without re-arming it. The timer field and its
cancel helper mirror `FileEditor`'s preview debounce at
[src/editor/FileEditor.ts:154](src/editor/FileEditor.ts#L154), which itself
mirrors [`installSessionAutosave`](src/shell/session.ts#L121).[^fixed-window]

### `FileTree` owns the watcher, re-armed by `setProjectRoot`

The watcher's lifetime is the project root's lifetime, and `setProjectRoot` is
the only place that changes. `FileTree` holds the stop function, re-arms it
after a successful `setProjectRoot`, and releases it in `destructor()` — the
same teardown hook `FileEditor` uses at
[src/editor/FileEditor.ts:251](src/editor/FileEditor.ts#L251).

Starting the watch is *not* awaited: a recursive watch on a large project can
take a noticeable moment to register, and the tree is already usable before it
finishes.[^dont-await-watch]

### Loom's own `.loom` writes are ignored

Every changed path at or under `<root>/.loom` is dropped before it becomes a
target. Loom writes `.loom/workspace.json` itself, and a refresh emits the
tree `"expand"` events that trigger that write — so without this rule the two
feed each other forever.[^loom-feedback]

`WORKSPACE_DIR_NAME` moves from its private declaration at
[src/data/workspace.ts:44](src/data/workspace.ts#L44) into
[src/data/workspaceState.ts](src/data/workspaceState.ts) and is exported, so
the pure module and the native module share one definition of the name.

---

## Public API

```ts
// src/data/workspaceState.ts  (moved here from src/data/workspace.ts, now exported)

/** The per-project settings folder's name, mirroring the app's own product name. */
export const WORKSPACE_DIR_NAME = '.loom'
```

```ts
// src/data/watchEvents.ts  (new — pure, no Tauri imports)

/**
 * The directories the tree must refresh for a batch of changed filesystem
 * paths: each path's own directory, dropping paths outside `root`, paths
 * inside `root`'s `.loom` folder, and any directory another target already
 * covers.
 */
export function refreshTargets(root: string, changedPaths: string[]): string[]

/** `dirs` with any entry that has a strict ancestor in `dirs` removed, deduplicated. */
export function minimalRoots(dirs: string[]): string[]
```

```ts
// src/data/workspace.ts

/** Stops a watch started by {@link watchDirectory}. */
export type StopWatching = () => void

/**
 * Watches `dir` and everything under it, calling `onChange` with the changed
 * paths. Rejects when the platform or the app's filesystem scope refuses the
 * watch.
 */
export async function watchDirectory(dir: string, onChange: (paths: string[]) => void): Promise<StopWatching>
```

```ts
// src/explorer/FileTree.ts  (on class FileTree)

/**
 * Re-lists `dir` and rebuilds every directory the tree had loaded below it,
 * re-applying the hidden/ignored filters and re-reading every `.gitignore` on
 * the way down. Expansion and selection are preserved where the entries still
 * exist. A no-op when `dir` is not the project root and not a directory whose
 * listing the tree has loaded.
 */
async refreshSubtree(dir: string): Promise<void>
```

`FileTree.refresh()` is removed. `FileTreeParams` is unchanged.

The domain payload gains one field:

```ts
interface FileTreeNodeData {
    path: string
    isDir: boolean
    /** The ignore chain governing this node from above — what `loadDirectory` takes as its `parentChain`. */
    parentChain: IgnoreChain
}
```

---

## Internal Structure

### Module constants

```ts
// src/data/workspace.ts

/** How long the native watcher coalesces events before delivering them, in
 *  milliseconds. Long enough that one editor's save — which arrives as a
 *  create, a write, and a rename — crosses the IPC bridge once; short enough
 *  that the tree still feels live. */
const FS_WATCH_DELAY_MS = 250
```

```ts
// src/explorer/FileTree.ts

/** How long changed paths accumulate before the tree refreshes, in
 *  milliseconds. Batches the several messages one native flush still delivers
 *  into a single rebuild. */
const TREE_REFRESH_DEBOUNCE_MS = 150
```

### `watchDirectory`

```ts
export async function watchDirectory(dir: string, onChange: (paths: string[]) => void): Promise<StopWatching> {
    return watch(dir, event => { onChange(event.paths) }, { recursive: true, delayMs: FS_WATCH_DELAY_MS })
}
```

`watch` and the type `UnwatchFn` come from `@tauri-apps/plugin-fs`, alongside
the imports already on [src/data/workspace.ts:7](src/data/workspace.ts#L7).
`StopWatching` is declared as `() => void` rather than re-exporting
`UnwatchFn`, so no `@tauri-apps` type escapes the module.

### `src/data/watchEvents.ts`

```ts
export function refreshTargets(root: string, changedPaths: string[]): string[] {
    const stateDir = joinPath(root, WORKSPACE_DIR_NAME)
    const dirs: string[] = []

    for (const path of changedPaths) {
        if (!isUnderRoot(root, path) || isUnderRoot(stateDir, path)) {
            continue
        }

        const dir = parentDir(path)

        if (isUnderRoot(root, dir)) {
            dirs.push(dir)
        }
    }

    return minimalRoots(dirs)
}

export function minimalRoots(dirs: string[]): string[] {
    const unique = [...new Set(dirs)]

    return unique.filter(dir => !unique.some(other => other !== dir && isUnderRoot(other, dir)))
}
```

`isUnderRoot` treats a path as being under itself, which is what makes both
guards work: `isUnderRoot(stateDir, path)` drops `.loom` itself as well as
everything inside it, and the `other !== dir` test in `minimalRoots` is what
narrows the remaining check to *strict* ancestors. `isUnderRoot(root, dir)`
is what rejects the root's own parent when the changed path is the root.

### The rebuild

```ts
async refreshSubtree(dir: string): Promise<void> {
    if (this._root === null) {
        return
    }

    if (dir === this._root) {
        await this.rebuild(dir, null, this._rootChain)

        return
    }

    const node = this.findLoadedNode(dir)

    // A directory the tree never listed contributes nothing on screen, so
    // there is nothing to repair — and re-listing it here would eagerly load
    // a branch the user never opened.
    if (node === null || node.children === undefined) {
        return
    }

    const data = node.data as FileTreeNodeData

    if (!data.isDir) {
        return
    }

    await this.rebuild(dir, node, data.parentChain)
}

/**
 * Re-lists `dir` under `parentChain` and installs the result as `node`'s
 * children — or as the root node set when `node` is `null` — then replays the
 * expansion and selection `setNodes` cleared.
 */
private async rebuild(dir: string, node: TreeNode | null, parentChain: IgnoreChain): Promise<void> {
    const expanded = this.getExpandedPaths()
    const selected = this.selectedPath()
    const children = await this.loadDirectory(dir, parentChain)

    if (node === null) {
        this.setNodes(children)
    } else {
        node.children = children
        this.setNodes(this.getNodes())
    }

    await this.expandPaths(expanded)
    this.reselect(selected)
}

/** The selected row's path, or `null` when nothing is selected. */
private selectedPath(): string | null {
    const data = this.getSelectedNode()?.data as FileTreeNodeData | undefined

    return data?.path ?? null
}

/**
 * Re-selects `path` when the rebuild left a node for it. Deliberately not
 * `selectPath`: that falls back to `revealByPredicate`, which would load every
 * unloaded branch hunting for a path the refresh may have just removed.
 */
private reselect(path: string | null): void {
    const node = path === null ? null : this.findLoadedNode(path)

    if (node !== null) {
        this.selectNode(node)
    }
}
```

`setNodes(this.getNodes())` re-flattens without changing which nodes are in
the tree. Every node object outside the rebuilt subtree keeps its populated
`children`, which is why `expandPaths` re-expands them without issuing a
single directory read.

The existing private `reload()` stays exactly as it is: `setShowHidden` and
`setShowIgnored` deliberately collapse the tree, and this plan does not change
that (see `## Non-Goals`).

### The watcher

```ts
private _stopWatching: StopWatching | null = null
private _pendingDirs = new Set<string>()
private _refreshTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Points the watcher at `root`, replacing any watch already running. Not
 * awaited by `setProjectRoot`: registering a recursive watch on a large
 * project takes time the tree does not need to wait for. A watch that lands
 * after the root has moved on again is closed immediately rather than stored.
 */
private startWatching(root: string): void {
    this.stopWatching()

    void watchDirectory(root, paths => { this.handleFileSystemChange(paths) })
        .then(stop => {
            if (this._root === root) {
                this._stopWatching = stop
            } else {
                stop()
            }
        })
        .catch(() => {
            // No watcher: a browser-only `npm run dev` session with no Tauri
            // plugins, or an OS watch-descriptor limit. The tree still works,
            // it just does not follow outside changes.
        })
}

/** Releases the running watch, if any. */
private stopWatching(): void {
    this._stopWatching?.()
    this._stopWatching = null
}

/** Records the directories a batch of changed paths affects, and arms the refresh. */
private handleFileSystemChange(paths: string[]): void {
    if (this._root === null) {
        return
    }

    for (const dir of refreshTargets(this._root, paths)) {
        this._pendingDirs.add(dir)
    }

    if (this._pendingDirs.size > 0) {
        this.scheduleRefresh()
    }
}

/** Arms the batch window. Already-armed is left alone, so a continuous stream
 *  of events still flushes every `TREE_REFRESH_DEBOUNCE_MS`. */
private scheduleRefresh(): void {
    if (this._refreshTimer !== null) {
        return
    }

    this._refreshTimer = setTimeout(() => {
        this._refreshTimer = null
        void this.flushPendingRefresh()
    }, TREE_REFRESH_DEBOUNCE_MS)
}

/** Drops any armed batch window. */
private cancelScheduledRefresh(): void {
    if (this._refreshTimer !== null) {
        clearTimeout(this._refreshTimer)
        this._refreshTimer = null
    }
}

/** Refreshes each pending directory, one awaited rebuild at a time so two
 *  never interleave. `minimalRoots` has already removed any target another
 *  target covers, so the order between the survivors does not matter. */
private async flushPendingRefresh(): Promise<void> {
    const dirs = minimalRoots([...this._pendingDirs])

    this._pendingDirs.clear()

    for (const dir of dirs) {
        try {
            await this.refreshSubtree(dir)
        } catch {
            // A directory that vanished between the event and the refresh
            // leaves the tree as it was.
        }
    }
}

/** Releases the watch and any armed refresh before the base class tears down. */
protected destructor(): void {
    this.cancelScheduledRefresh()
    this.stopWatching()
    super.destructor()
}
```

`minimalRoots` runs again at flush time because `_pendingDirs` accumulates
across several event batches, each of which was only minimised against itself.

---

## Ordered Implementation Steps

1. **Enable the Rust feature.** In [src-tauri/Cargo.toml:26](src-tauri/Cargo.toml#L26)
   change `tauri-plugin-fs = "2.5.1"` to
   `tauri-plugin-fs = { version = "2.5.1", features = ["watch"] }`. Run
   `cargo check --manifest-path src-tauri/Cargo.toml` — it fetches `notify` and
   `notify-debouncer-full` and updates `src-tauri/Cargo.lock`. Confirm with
   `grep -n 'notify-debouncer-full' src-tauri/Cargo.lock` — expect a match.

2. **Grant the permissions.** In
   [src-tauri/capabilities/default.json](src-tauri/capabilities/default.json)
   add `"fs:allow-watch"` and `"fs:allow-unwatch"` to the `permissions` array,
   after `"fs:allow-exists"` on line 20. Do not touch the `fs:scope` entry:
   `$HOME/**` already covers a project under the user's home directory, and a
   folder outside it is covered by the picker's runtime grant.

3. **Move `WORKSPACE_DIR_NAME`.** Delete the private declaration at
   [src/data/workspace.ts:44](src/data/workspace.ts#L44), add the exported
   constant (with the same doc comment) to
   [src/data/workspaceState.ts](src/data/workspaceState.ts) below its
   `VALID_LAYOUT_SIZE_UNITS` declaration, and import it into `workspace.ts`
   from `./workspaceState`. Checkpoint:
   `grep -rn "'\.loom'" src/` — expect exactly one match, in `workspaceState.ts`.
   `npm run typecheck` — clean.

4. **Create `tests/watchEvents.test.ts` (test-first).** Write the cases in
   `## Expected Behaviour` for `refreshTargets` and `minimalRoots`. Follow
   [tests/session.test.ts](tests/session.test.ts)'s style: plain `describe`/`it`
   with literal path strings, no fakes needed — both functions are pure.
   `npm test` fails to resolve the module.

5. **Create `src/data/watchEvents.ts`.** Implement the two exports per
   `## Internal Structure`. It imports `joinPath`, `parentDir`, and
   `isUnderRoot` from `./paths` and `WORKSPACE_DIR_NAME` from
   `./workspaceState`. Give the module a header comment stating it is pure and
   has no Tauri imports, matching
   [src/data/session.ts:1](src/data/session.ts#L1). `npm test` goes green.

6. **Add `watchDirectory` to `src/data/workspace.ts`.** Add `watch` to the
   existing `@tauri-apps/plugin-fs` import on
   [line 7](src/data/workspace.ts#L7), declare `FS_WATCH_DELAY_MS` beside the
   other module constants, and add the `StopWatching` type and the
   `watchDirectory` function from `## Internal Structure` below `pathExists`.
   `npm run typecheck` — clean.

7. **Carry the ignore chain on node data.** In
   [src/explorer/FileTree.ts:15](src/explorer/FileTree.ts#L15) add
   `parentChain: IgnoreChain` to `FileTreeNodeData`. In
   [`toNodes`](src/explorer/FileTree.ts#L277) add `parentChain: chain` to both
   the directory and the file object literals. `npm run typecheck` — clean:
   every other `as FileTreeNodeData` read site only touches `path`/`isDir`.

8. **Replace `refresh()` with `refreshSubtree()`.** In
   [src/explorer/FileTree.ts](src/explorer/FileTree.ts), delete `refresh()`
   (lines 119–133) and add `refreshSubtree`, `rebuild`, `selectedPath`, and
   `reselect` from `## Internal Structure`. Leave `reload()`,
   `setShowHidden`, and `setShowIgnored` untouched.

9. **Add the watcher to `FileTree`.** Add the three fields, the six private
   methods, and the `destructor` override from `## Internal Structure`. Import
   `watchDirectory` and the type `StopWatching` from `../data/workspace`, and
   `refreshTargets` / `minimalRoots` from `../data/watchEvents`. Declare
   `TREE_REFRESH_DEBOUNCE_MS` above the class. Call
   `this.startWatching(root)` as the last statement of
   [`setProjectRoot`](src/explorer/FileTree.ts#L79), after `_root` and
   `_rootChain` are assigned — a failed listing must leave the previous root's
   watch running, which is what placing the call after those assignments
   guarantees.

10. **Point the post-save hook at the new operation.** In
    [src/shell/EditorShell.ts:195](src/shell/EditorShell.ts#L195) replace
    `await this._tree.refresh()` with
    `await this._tree.refreshSubtree(parentDir(path))`, and add `parentDir` to
    the existing `../data/paths` import on
    [line 14](src/shell/EditorShell.ts#L14). Update the method's doc comment to
    say it refreshes the saved file's own directory.

11. **Checkpoint.** `grep -rn '\.refresh()' src/` — expect zero matches.
    `grep -rn '@tauri-apps' src/ --include=*.ts | grep -v 'src/data/workspace.ts'`
    — expect zero matches. `npm run typecheck` and `npm test` — clean.

12. **Update the docs** per `## Documentation Impact`.

13. **Run `## Verification`.**

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src-tauri/Cargo.toml` |
| Modify | `src-tauri/Cargo.lock` |
| Modify | `src-tauri/capabilities/default.json` |
| Create | `src/data/watchEvents.ts` |
| Modify | `src/data/workspace.ts` |
| Modify | `src/data/workspaceState.ts` |
| Modify | `src/explorer/FileTree.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Create | `tests/watchEvents.test.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### `minimalRoots` — unit-testable

| Input | Result |
|---|---|
| `['/p', '/p/src']` | `['/p']` |
| `['/p/src', '/p']` | `['/p']` (order does not matter) |
| `['/p/a', '/p/b']` | `['/p/a', '/p/b']` (siblings both survive) |
| `['/p', '/p']` | `['/p']` (deduplicated) |
| `['/p', '/px/a']` | `['/p', '/px/a']` (a shared prefix is not containment) |
| `[]` | `[]` |

### `refreshTargets` — unit-testable

With `root` = `/p`, each row of the table in
`## Architecture Decisions ▸ A changed .gitignore needs no special case`:

- `refreshTargets('/p', ['/p/src/a.ts'])` is `['/p/src']`.
- `refreshTargets('/p', ['/p/.gitignore'])` is `['/p']`.
- `refreshTargets('/p', ['/p/old', '/p/new'])` is `['/p']`.
- `refreshTargets('/p', ['/p/a.ts', '/p/src/b.ts'])` is `['/p']`.
- `refreshTargets('/p', ['/p/.loom/workspace.json'])` is `[]`.
- `refreshTargets('/p', ['/p/.loom'])` is `[]` — the folder itself, not only
  its contents.
- `refreshTargets('/p', ['/other/x.ts'])` is `[]`.
- `refreshTargets('/p', ['/p'])` is `[]` — the root's own parent is outside
  the project.
- `refreshTargets('/p', [])` is `[]`.
- A Windows-shaped batch resolves the same way:
  `refreshTargets('C:\\p', ['C:\\p\\src\\a.ts'])` is `['C:\\p\\src']`.

### Tree behaviour — manual verification in `npm run tauri:dev`

Open the Loom repo itself as the project folder, both View toggles off, and
expand `src` and `src/data`. Then, from a separate shell:

- **Create.** `touch src/data/probe.ts` — a `probe.ts` row appears under
  `src/data` within about a second, in sorted position, with the TypeScript
  icon. `src` and `src/data` stay expanded.
- **Delete.** `rm src/data/probe.ts` — the row disappears; expansion is
  unchanged.
- **Rename.** `mv README.md READYOU.md` then back — the root row's label
  follows both moves.
- **New directory.** `mkdir src/data/probe` — a collapsed `probe` row appears;
  expanding it lists it live.
- **Selection survives.** Select `src/data/paths.ts`, then `touch
  src/data/probe.ts` from the shell — the highlight stays on `paths.ts`.
- **Nothing collapses or jumps.** With `src`, `src/data`, and `tests` all
  expanded, scroll partway down the tree and `touch tests/probe.test.ts` — all
  three stay expanded and the scroll position does not move.
- **`.gitignore` invalidates its subtree, and only it.** Append
  `src/data/` to the repo's root `.gitignore`. Everything under `src/data`
  disappears from the tree along with the `src/data` row itself, while
  `src/editor`, `src/shell`, and `tests` stay listed with their expansion
  intact. Remove the line again and the `src/data` branch comes back,
  collapsed.
- **A nested `.gitignore` only reaches its own directory.** Expand
  `src-tauri`, then write `capabilities/` into `src-tauri/.gitignore` (a file
  that already exists) — `src-tauri/capabilities` disappears, and the
  root-level `src` and `tests` branches keep every row they had.
- **Ignored subtrees produce no repeated churn.** With `src` expanded, run
  `npm run build` twice. The second run — by which point `dist/` already
  exists — leaves the tree completely still, because `dist` is ignored and
  therefore never loaded, so none of the files written into it produce a
  target.
- **No self-triggering.** Leave the app idle with a project open for a minute
  and watch the status bar and tree: nothing repeatedly rebuilds. (This is the
  `.loom` rule; without it the session autosave and the refresh would drive
  each other in a loop.)
- **Save still lands immediately.** *File > New File*, type something, *Save*
  into `src/data/` — the row appears at once, before the watcher's own event
  for the same write arrives.
- **A missing watcher degrades quietly.** `npm run dev` and open
  `http://localhost:1420` in a browser: the app loads with no console error
  thrown out of `setProjectRoot`. (Folder access itself does not work in a
  browser — the check is only that the watcher's absence adds no new failure.)

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — `tests/watchEvents.test.ts` green alongside the existing suites.
- `grep -rn '\.refresh()' src/` — zero matches.
- `grep -rn "'\.loom'" src/` — exactly one match, in `src/data/workspaceState.ts`.
- `grep -rn '@tauri-apps' src/ --include=*.ts | grep -v 'src/data/workspace.ts'`
  — zero matches.
- `grep -n 'allow-watch' src-tauri/capabilities/default.json` — one match.
- `cargo check --manifest-path src-tauri/Cargo.toml` — clean.
- `npm run build` — frontend production build succeeds.
- `npm run tauri:dev`, then **File ▸ Open Folder…** on the Loom repo, and walk
  the manual cases in `## Expected Behaviour`.

---

## Documentation Impact

- [README.md](README.md) — the *File tree* bullet in `## Highlights` gains a
  sentence: the tree follows changes made outside the app, and editing a
  `.gitignore` re-filters everything below its own directory.
- [TODO.md](TODO.md) — delete the **Filesystem watching** bullet from `## High`.
  Extend the **Context menu in FileTree** bullet in the same section to note
  that each file operation should finish by calling
  `FileTree.refreshSubtree(dir)` on the directory it touched. In
  `## Known issues / loose ends`, cut the *Stale tab icon* bullet's sentences
  about the tree showing no row until the directory is loaded again; the tab
  icon itself is still stale and that half of the bullet stays.

There is no docs site or export barrel to update; every module this plan
touches is app-internal.

---

## Potential Challenges

- **An OS watch limit refuses the watch.** Linux registers one inotify
  descriptor per directory, recursively, including `node_modules` and build
  output. `startWatching` catches the rejection and leaves the tree
  un-watched rather than failing the project open.
- **WSL2 does not deliver inotify events for Windows-side drives.** A project
  under `/mnt/c` gets no events at all; a project on the Linux filesystem
  works normally. Nothing to fix in the app — worth knowing before filing the
  feature as broken.
- **A save refreshes twice.** `EditorShell.handleFileSaved` refreshes
  immediately and the watcher's own event for the same write arrives a few
  hundred milliseconds later. The second pass re-lists the same directory and
  produces the same rows, so the only cost is one extra listing.
- **A user expansion in flight when a rebuild lands is dropped.** `setNodes`
  clears the tree's pending-expansion map, and the library's identity check
  makes the orphaned load commit nothing. The batch window makes the overlap
  rare, and clicking the caret again works.
- **A directory emptied by a new `.gitignore` rule still renders a caret.**
  Same pre-existing cosmetic case the tree-filtering plan recorded:
  `hasChildren: true` is set before the contents are known.
- **`notify-debouncer-full` must be fetched on the first build.** Enabling the
  Cargo feature adds two crates to `Cargo.lock`, so the first
  `cargo check` after step 1 needs network access.

---

## Critical Files

- [src/explorer/FileTree.ts](src/explorer/FileTree.ts) — the class being
  extended. `loadDirectory` at line 242 and `isEntryVisible` at line 263 are
  the filter pipeline the rebuild reuses; `expandPaths` at line 190 and
  `findLoadedNode` at line 209 are what make the rebuild cheap outside the
  refreshed subtree; `refresh()` at line 124 is what `refreshSubtree` replaces.
- [src/data/gitignore.ts](src/data/gitignore.ts) — `IgnoreChain`,
  `extendIgnoreChain` at line 63, and `isIgnoredByChain` at line 83; the chain
  a rebuilt subtree recomputes top-down.
- [plans/implemented/tree-filtering.md](plans/implemented/tree-filtering.md) —
  the filter's own design, including the `[^watch-seam]` footnote that named
  the subtree-invalidation requirement this plan implements.
- [src/data/workspace.ts](src/data/workspace.ts) — the sole `@tauri-apps/*`
  entry point; read its header comment before adding `watchDirectory`.
- [src/data/paths.ts](src/data/paths.ts) — `parentDir` at line 72 and
  `isUnderRoot` at line 182, the two helpers `watchEvents.ts` is built from.
- [src/editor/FileEditor.ts](src/editor/FileEditor.ts) — the debounce-timer
  precedent at line 154 and the `destructor` teardown precedent at line 251.
- [src/shell/session.ts](src/shell/session.ts) — `installSessionAutosave` at
  line 104, the debounce this plan's batch window mirrors, and the writer whose
  `.loom/workspace.json` output the `.loom` rule exists to ignore.
- [src-tauri/capabilities/default.json](src-tauri/capabilities/default.json) —
  the permission list and the `fs:scope` entry that decides whether a watch is
  allowed.

---

## Non-Goals

- **A manual *Refresh* menu command.** The watcher makes the tree live; a menu
  item would be a second entry point to the same operation with no case left
  to serve.
- **Preserving expansion across the two View toggles.** `setShowHidden` and
  `setShowIgnored` still collapse the tree through `reload()`. The
  tree-filtering plan chose that behaviour deliberately; changing it is a
  separate decision, not a side effect of this one.
- **Reacting to a `.gitignore` above the opened folder.** The watch is scoped
  to the project root, so a repository-level `.gitignore` outside the opened
  subfolder is not seen. Reopening the folder rebuilds the chain.
- **Watching open editor buffers for outside edits.** This plan changes the
  tree only; a file whose contents change on disk while open in a tab is left
  alone, with no reload prompt and no conflict detection.
- **Per-directory watches instead of one recursive watch.** Watching only the
  directories the tree has loaded would use far fewer OS watch descriptors,
  but the tree would have to tear down and re-register its whole watch list on
  every expansion, losing any event that fell in the gap.
- **Removing `EditorShell.handleFileSaved`'s refresh** now that the watcher
  covers the same case. It is the faster of the two paths and it works when
  the watcher failed to start.
- **Any hand-written Rust.** [src-tauri/src/lib.rs](src-tauri/src/lib.rs)
  stays a plugin-registration file and the app still defines no
  `#[tauri::command]`; the only Rust-side edits are the Cargo feature flag and
  the two capability permissions.

---

## Notes

[^why-plugin-fs]: Two mechanisms were weighed. A **Rust-side `notify` watcher**
    in `src-tauri/src/lib.rs`, emitting through Tauri's event system, would
    mean the app's first `#[tauri::command]` and its first hand-written
    Rust — a seam [plans/implemented/tree-filtering.md](plans/implemented/tree-filtering.md)'s
    `[^why-ignore-package]` footnote already declined to open for the ignore
    matcher. The **`fs` plugin's own `watch`** is the same `notify` crate
    (version 8, plus `notify-debouncer-full` 0.6) wrapped by the plugin,
    reached through a `Channel` the plugin manages, and gated behind a Cargo
    feature and two permissions. Verified in the vendored crate: the commands
    are registered under `#[cfg(feature = "watch")]` in
    `tauri-plugin-fs-2.5.1/src/lib.rs`, the feature pulls exactly those two
    crates, and the JavaScript side already ships `watch`/`watchImmediate` in
    the installed `@tauri-apps/plugin-fs@2.5.1`. `watch` (debounced) is chosen
    over `watchImmediate` because a `git checkout` or an `npm install` would
    otherwise push one IPC message per touched file; the Rust-side debouncer
    collapses that burst before it crosses the bridge. The plugin resolves a
    watched path against the same filesystem scope as every other `fs`
    command, so `$HOME/**` and the folder picker's runtime grant already cover
    it and `fs:scope` needs no new entry.

[^reuse-loaddirectory]: The refresh must re-run the hidden/`.gitignore` filter,
    not merely relist — a directory whose `.gitignore` changed can gain or
    lose entries without any of its own files changing. Reusing
    `loadDirectory` rather than adding a second listing path is what
    guarantees it: that one function reads the directory, extends the chain
    with the directory's own `.gitignore`, and filters through
    `isEntryVisible`, so a rebuild and a first-time expansion cannot drift
    apart. It is also the seam the tree-filtering plan's `[^watch-seam]`
    footnote reserved for exactly this feature.

[^chain-on-node]: The chain governing a directory is currently reachable only
    inside the closure `toNodes` builds for `loadChildren`, so a caller
    holding a node has no way to re-list it. Two alternatives were rejected.
    Rebuilding the chain by walking from the root down to the target on every
    refresh costs one `.gitignore` probe per level, per refresh, for
    information the node already had. Keeping a side map from directory path
    to chain adds a second structure to invalidate in step with the nodes —
    the node payload is already the tree's per-node store, and adding one
    field to it cannot fall out of sync with the node it sits on.

[^setnodes-reflatten]: `Tree` exposes no way to replace one node's children
    and re-render: `_reflattenAndRender` is private, and every public entry
    point that reaches it (`setNodes`, `expandAll`, `expandNode`,
    `revealByPredicate`) either replaces the whole node set or only expands.
    `setNodes(this.getNodes())` re-flattens the existing set, at the cost of
    clearing the expanded, selected, and loaded sets. Replaying expansion
    afterwards is cheap because of how `Tree._expand` decides whether to load:
    it skips `loadChildren` when the node already carries a non-empty
    `children` array, and `setNodes` does not clear node objects' `children`.
    So nodes outside the rebuilt subtree re-expand with no I/O, while nodes
    inside it — freshly built and therefore unloaded — re-list through their
    new `loadChildren` closures and pick up the new ignore chain. The one
    exception is a directory whose visible listing is empty: its `children` is
    `[]`, which fails that non-empty test, so it is re-listed once. Replaying
    in `expansionOrder` (already used by `expandPaths`) is what makes the
    descent work at all — `findLoadedNode` can only find a nested directory
    after its parent has loaded.

[^fixed-window]: A sliding debounce — the shape `FileEditor` and
    `installSessionAutosave` both use, where each new event re-arms the timer —
    starves under a continuous event stream: a long `cargo build` or `npm
    install` would push the refresh back indefinitely and the tree would stay
    stale for as long as the build ran. A fixed window fires
    `TREE_REFRESH_DEBOUNCE_MS` after the *first* event of a batch regardless of
    what follows, which bounds staleness at one window. The divergence from
    the two existing debounces is deliberate and limited to the re-arm rule;
    the field, the cancel helper, and the teardown are the same shape.

[^dont-await-watch]: `notify`'s inotify backend registers one descriptor per
    directory, walking the whole subtree synchronously, so awaiting the watch
    inside `setProjectRoot` would stall *Open Folder…* on a large project for
    as long as that walk takes. Not awaiting introduces one ordering hazard:
    two quick project switches leave two watches in flight, and the first to
    resolve could overwrite the second. The `this._root === root` test closes
    it — a watch whose root is no longer current is stopped instead of stored,
    so at most one watch survives and it is always the current root's.

[^loom-feedback]: The loop is real and it closes without this rule. A refresh
    replays expansion, which emits the tree's `"expand"` event;
    `installSessionAutosave` listens on that event and writes
    `<root>/.loom/workspace.json` 500ms later; that write is a filesystem
    change under the root, which schedules another refresh. Filtering on the
    *changed path* rather than on its parent directory is what makes the rule
    complete: it drops both `<root>/.loom/workspace.json` and `<root>/.loom`
    itself. Note that the hidden-file filter alone is not a defence — with
    **Show Hidden Files** on and `.loom` expanded, the folder is a loaded
    directory like any other.
