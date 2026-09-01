---
touches-shared: [package.json, package-lock.json, src/data/paths.ts, src/data/workspace.ts, src/explorer/FileTree.ts, src/shell/EditorShell.ts, tests/paths.test.ts, README.md, TODO.md]
---

# Hidden-file / `.gitignore`-aware Filtering — Implementation Plan

## Overview

The file tree shows every entry `readDir` returns: `node_modules`, `dist`, `.git`, `.codegraph`. This plan drops two classes of entry from the tree — **hidden** entries (a name starting with `.`) and **ignored** entries (matched by a `.gitignore` rule) — and puts each class behind its own View-menu checkbox so the user can bring them back.

The filter lands in [src/explorer/FileTree.ts:63](src/explorer/FileTree.ts#L63), the lazy-load path that turns a directory listing into tree nodes. `.gitignore` rules are matched in TypeScript by the `ignore` npm package; the matching itself lands in a new pure module, `src/data/gitignore.ts`, unit-tested beside [src/data/paths.ts](src/data/paths.ts). [src/data/workspace.ts](src/data/workspace.ts) gains two thin native wrappers, and [src/shell/EditorShell.ts:89](src/shell/EditorShell.ts#L89) gains two checkbox rows in the View menu.

Nothing about the editor, tabs, or save path changes.

---

## Architecture Decisions

### The filter runs in `FileTree`, not in `listDirectory`

`FileTree.loadDirectory` (replacing today's `loadInto`) lists a directory, drops the entries the current toggles exclude, and maps the survivors to nodes. [`listDirectory`](src/data/workspace.ts#L56) stays a thin `readDir` wrapper.[^filter-in-filetree]

### `.gitignore` is matched in TypeScript with the `ignore` package

Add `ignore` (currently 7.0.8) as a runtime dependency, and do the matching in the frontend.[^why-ignore-package]

### One `IgnoreLayer` per `.gitignore` file, chained outermost-first

A `.gitignore` file's patterns are relative to its own directory, so a compiled matcher is useless without knowing where it sits. An `IgnoreLayer` pairs the two: `{ dir, matcher }`. An `IgnoreChain` is a read-only array of layers, outermost first. The chain is passed into each directory node's `loadChildren` closure, exactly as `item.path` already is at [src/explorer/FileTree.ts:73](src/explorer/FileTree.ts#L73).

Deciding a single entry walks the chain **innermost first** and stops at the first layer with a verdict — git's rule that a deeper `.gitignore` overrides a shallower one. Within one layer, `ignore` already applies git's last-matching-pattern-wins rule.

With `/p/.gitignore` = `*.log` + `build/` and `/p/app/.gitignore` = `!debug.log`:

| Entry | Layer that decides | Result | Why |
|---|---|---|---|
| `/p/app/debug.log` | `/p/app` says un-ignored | shown | the deeper `!debug.log` overrides `/p`'s `*.log` |
| `/p/app/other.log` | `/p/app` is silent, then `/p` says ignored | hidden | `*.log` at `/p` matches `app/other.log` |
| `/p/build` (directory) | `/p` says ignored | hidden | tested as `build/`, which `build/` matches |
| `/p/build.txt` (file) | no layer matches | shown | `build/` is directory-only; `build.txt` does not match |

The last two rows are the trailing-slash rule: **a directory's path is tested with a trailing `/` appended, a file's is not.** Without the slash, `ignore` never matches a directory-only pattern.[^trailing-slash]

### A directory's own `.gitignore` is read from the listing, before filtering

`loadDirectory` looks for a `.gitignore` entry in the listing it already has, and only then issues a read. A directory without one costs no extra call, and the read happens before the hidden-file filter would have dropped `.gitignore` itself.[^gitignore-before-filter]

### The chain above the opened folder is seeded by walking up for `.git`

`buildRootIgnoreChain` walks upward from the opened folder until it finds a `.git` entry or runs out of path. If it finds one, that directory is the repository root; the chain is seeded with `<root>/.git/info/exclude` followed by the `.gitignore` of every directory from the repository root down to (but not including) the opened folder. If no `.git` is found, the chain starts empty.[^walk-up]

Opening `/home/u/proj/src` inside a repository at `/home/u/proj`:

| Order | Anchored at | Source | Added by |
|---|---|---|---|
| 1 | `/home/u/proj` | `/home/u/proj/.git/info/exclude` | `buildRootIgnoreChain` |
| 2 | `/home/u/proj` | `/home/u/proj/.gitignore` | `buildRootIgnoreChain` |
| 3 | `/home/u/proj/src` | `/home/u/proj/src/.gitignore` | the first `loadDirectory` call |

Opening `/home/u/proj` itself instead — the repository root — seeds only layer 1, because `/home/u/proj/.gitignore` is now the opened folder's own file and `loadDirectory` reads it.

### Hidden means a leading dot

`isHiddenName(name)` is `name.startsWith('.')`. The Windows hidden *attribute* is not consulted.[^dotfiles-only]

### Two independent toggles, as `CheckboxMenuRow` rows in the View menu

The View menu gains **Show Hidden Files** and **Show Ignored Files**, both off by default. An entry is shown unless (it is hidden and Show Hidden is off) or (it is ignored and Show Ignored is off).

| Entry | Hidden | Ignored | Both off | Hidden on | Ignored on | Both on |
|---|---|---|---|---|---|---|
| `src/` | no | no | shown | shown | shown | shown |
| `.gitignore` | yes | no | hidden | shown | hidden | shown |
| `node_modules/` | no | yes | hidden | hidden | shown | shown |
| `.codegraph/` | yes | yes | hidden | hidden | hidden | shown |

Each row is a `CheckboxMenuRow` supplied through `MenuItemConfig.row`, mirroring the gutter menu at [../typescript-ui/packages/lib/src/typescript/lib/layout/Split.ts:1130](../typescript-ui/packages/lib/src/typescript/lib/layout/Split.ts#L1130). The menu panel stays open across a toggle, so both can be flipped in one open.[^two-toggles]

### `FileTree` owns the two flags; the menu reads them live

`FileTree` holds `_showHidden` and `_showIgnored` and exposes getters and setters. The menu's item provider calls the getters each time the menu opens and the row handlers call the setters — the same live-read shape `onToggleExplorer` already uses against `Split` at [src/shell/EditorShell.ts:45](src/shell/EditorShell.ts#L45).

### Matching is case-sensitive

Every matcher is built as `ignore({ ignorecase: false })`.[^case-sensitive]

---

## Public API

```ts
// src/data/paths.ts

/** The parent directory of `path`; a path with no parent above it returns itself. */
export function parentDir(path: string): string

/** `path` relative to `parent` with `/` separators, or `null` when `path` is not inside `parent`. */
export function relativePath(parent: string, path: string): string | null
```

```ts
// src/data/gitignore.ts  (new)
import type { Ignore } from 'ignore'

/** The file name whose contents define one layer of ignore rules. */
export const GITIGNORE_NAME = '.gitignore'

/** One `.gitignore` file's compiled rules, tagged with the directory they are relative to. */
export interface IgnoreLayer {
  readonly dir: string
  readonly matcher: Ignore
}

/** The ignore rules governing one directory, outermost layer first. */
export type IgnoreChain = readonly IgnoreLayer[]

/** The chain for a directory governed by no ignore rules at all. */
export const EMPTY_IGNORE_CHAIN: IgnoreChain

/** Reads a text file, resolving `null` when it is missing or unreadable. */
export type TryReadTextFile = (path: string) => Promise<string | null>

/** Whether a filesystem path exists. */
export type PathExists = (path: string) => Promise<boolean>

export function isHiddenName(name: string): boolean
export function extendIgnoreChain(chain: IgnoreChain, dir: string, text: string | null): IgnoreChain
export function isIgnoredByChain(chain: IgnoreChain, path: string, isDir: boolean): boolean

export function buildRootIgnoreChain(
  root: string,
  tryReadTextFile: TryReadTextFile,
  pathExists: PathExists,
): Promise<IgnoreChain>
```

```ts
// src/data/workspace.ts

/** Reads `path` as UTF-8 text, resolving `null` when it is missing or unreadable. */
export async function tryReadTextFile(path: string): Promise<string | null>

/** Whether `path` exists and is reachable under the app's filesystem scope. */
export async function pathExists(path: string): Promise<boolean>
```

```ts
// src/explorer/FileTree.ts  (on class FileTree)

isShowingHidden(): boolean
setShowHidden(value: boolean): void
isShowingIgnored(): boolean
setShowIgnored(value: boolean): void
```

`FileTreeParams` is unchanged: both flags default to `false` in their field initialisers.

---

## Internal Structure

`extendIgnoreChain` returns `chain` unchanged when `text` is `null`, so a missing or unreadable file adds no layer.

`isIgnoredByChain` walks backwards and skips a layer whose directory does not contain `path`:

```ts
for (let index = chain.length - 1; index >= 0; index -= 1) {
  const layer = chain[index]
  const relative = relativePath(layer.dir, path)

  if (relative === null) {
    continue
  }

  const result = layer.matcher.test(isDir ? `${relative}/` : relative)

  if (result.ignored) {
    return true
  }

  if (result.unignored) {
    return false
  }
}

return false
```

The `relative === null` guard is load-bearing: `Ignore.test` throws a `RangeError` on an absolute path and a `TypeError` on an empty one.

`FileTree`'s listing path, replacing `loadInto`:

```ts
private async loadDirectory(dir: string, parentChain: IgnoreChain): Promise<TreeNode[]> {
  const items = await listDirectory(dir)
  const chain = items.some(item => !item.isDir && item.name === GITIGNORE_NAME)
    ? extendIgnoreChain(parentChain, dir, await tryReadTextFile(joinPath(dir, GITIGNORE_NAME)))
    : parentChain

  return this.toNodes(items.filter(item => this.isVisible(item, chain)), chain)
}

private isVisible(item: DirectoryItem, chain: IgnoreChain): boolean {
  if (!this._showHidden && isHiddenName(item.name)) {
    return false
  }

  return this._showIgnored || !isIgnoredByChain(chain, item.path, item.isDir)
}
```

`toNodes(items, chain)` passes `chain` — not the child's own extended chain — into each directory node's `loadChildren`, because the child extends it with its own `.gitignore` when it is listed.

---

## Ordered Implementation Steps

1. **Add the dependency.** Run `npm install ignore@^7.0.8` from the repo root. Confirm `package.json` lists `"ignore"` under `dependencies` and that `npm run typecheck` still passes. No `vite.config.ts` or `tsconfig.json` change is needed.[^no-config-change]

2. **Extend `src/data/paths.ts` (test-first).** Append `describe('parentDir', …)` and `describe('relativePath', …)` blocks to [tests/paths.test.ts](tests/paths.test.ts) covering the cases in `## Expected Behaviour`, run `npm test` to see them fail, then add `parentDir` and `relativePath` to [src/data/paths.ts](src/data/paths.ts) below `joinPath` and re-run. `relativePath` must convert `\` to `/` and must reject a sibling whose name merely shares a prefix (`relativePath('/p', '/px/a')` is `null`).

3. **Create `tests/gitignore.test.ts` (test-first).** Write the cases in `## Expected Behaviour` for `isHiddenName`, `extendIgnoreChain`, `isIgnoredByChain`, and `buildRootIgnoreChain`. `buildRootIgnoreChain`'s two dependencies are injected, so the test passes plain in-memory fakes — a `Map<string, string>` for `tryReadTextFile` and a `Set<string>` for `pathExists`. Run `npm test`; the suite fails to resolve the module.

4. **Create `src/data/gitignore.ts`.** Implement the exports in `## Public API` against `## Internal Structure`. It imports `joinPath`, `parentDir`, and `relativePath` from `./paths`, and `ignore` from `ignore`. Build every matcher as `ignore({ ignorecase: false }).add(text)`. Build the exclude-file path with a private one-line helper — `joinPath(joinPath(joinPath(dir, '.git'), 'info'), 'exclude')` — rather than embedding `'.git/info/exclude'` as one name, because `joinPath` takes a single segment and picks the parent's own separator. Re-run `npm test` — the new suite goes green.

5. **Add the two native wrappers to `src/data/workspace.ts`.** `tryReadTextFile` calls `readTextFile` inside a `try`/`catch` returning `null`; `pathExists` calls the already-imported `stat` inside a `try`/`catch` returning `false`. Both belong beside `readFileText`, and both are covered by the existing `fs:allow-read-text-file` and `fs:allow-stat` grants in [src-tauri/capabilities/default.json:15](src-tauri/capabilities/default.json#L15) — do not edit that file.

6. **Rework `src/explorer/FileTree.ts`.** Add the imports it does not yet have: `joinPath` from `../data/paths`, `tryReadTextFile` and `pathExists` from `../data/workspace`, and `GITIGNORE_NAME`, `EMPTY_IGNORE_CHAIN`, `isHiddenName`, `extendIgnoreChain`, `isIgnoredByChain`, `buildRootIgnoreChain` plus the type `IgnoreChain` from `../data/gitignore`. Add the fields `_root: string | null = null`, `_rootChain: IgnoreChain = EMPTY_IGNORE_CHAIN`, `_showHidden = false`, `_showIgnored = false`. Replace `loadInto` with `loadDirectory` and add `isVisible`, per `## Internal Structure`. `setProjectRoot` stores `root`, awaits `buildRootIgnoreChain(root, tryReadTextFile, pathExists)` into `_rootChain`, then awaits a new private `reload()`. `reload()` returns early when `_root` is `null`, otherwise calls `this.setNodes(await this.loadDirectory(this._root, this._rootChain))`. Add the four accessors from `## Public API`; each setter assigns its field and then calls `void this.reload()`.

7. **Checkpoint.** `grep -n 'loadInto' src/` — expect zero matches. `npm run typecheck` — expect clean.

8. **Add the View-menu rows in `src/shell/EditorShell.ts`.** Import `CheckboxMenuRow` from `@jimka/typescript-ui/component/container`. Add four members to `MenuBarActions` — `isShowingHidden: () => boolean`, `onToggleHidden: (value: boolean) => void`, and the matching `isShowingIgnored` / `onToggleIgnored` pair — and wire them in the `actions` literal as `isShowingHidden: () => tree.isShowingHidden()`, `onToggleHidden: (value: boolean) => tree.setShowHidden(value)`, and the same two for ignored. The getters must stay thunks, not eager calls, so the menu reads live state each time it opens. Do **not** touch `AcceleratorActions` or [src/shell/shortcuts.ts](src/shell/shortcuts.ts): these two toggles get no keyboard accelerator. In `buildMenuBar`, extend the View menu after the existing Toggle Explorer item with a `{ separator: true }` and two `row:` configs:

   ```ts
   { row: () => {
       const row = CheckboxMenuRow({ text: 'Show Hidden Files', checked: actions.isShowingHidden() })

       row.on('action', () => { actions.onToggleHidden(row.isChecked()) })

       return row
     } },
   ```

   The factory must construct a fresh row on every call — `Menu` disposes its item list on each rebuild, so a hoisted instance is dead after the first open.

9. **Update the docs.** In [README.md](README.md), extend the *File tree* highlight bullet to mention that hidden and `.gitignore`-ignored entries are filtered out, with View-menu toggles for each. In [TODO.md](TODO.md), delete the **Hidden-file / `.gitignore`-aware filtering** bullet from the High section, and append to the **Filesystem watching** bullet in Medium that a refresh must re-run the tree filter (a changed `.gitignore` invalidates the whole subtree below it).

10. **Run `## Verification`.**

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `package.json` |
| Modify | `package-lock.json` |
| Modify | `src/data/paths.ts` |
| Create | `src/data/gitignore.ts` |
| Modify | `src/data/workspace.ts` |
| Modify | `src/explorer/FileTree.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Create | `tests/gitignore.test.ts` |
| Modify | `tests/paths.test.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### `parentDir` — unit-testable

| Input | Result |
|---|---|
| `/p/src/main.ts` | `/p/src` |
| `/p` | `/` |
| `/` | `/` (its own parent — the upward walk's stop signal) |
| `C:\p\src` | `C:\p` |
| `C:` | `C:` |

### `relativePath` — unit-testable

| `parent` | `path` | Result |
|---|---|---|
| `/p` | `/p/src/main.ts` | `src/main.ts` |
| `C:\p` | `C:\p\src\main.ts` | `src/main.ts` (separators normalised) |
| `/` | `/p` | `p` |
| `/p` | `/p` | `null` (a directory is not relative to itself) |
| `/p` | `/px/a` | `null` (prefix match is not containment) |
| `/p/a` | `/p` | `null` |

### `isHiddenName` — unit-testable

`.gitignore`, `.git`, `.env` are hidden. `src`, `README.md`, `a.b.c` are not. `''` is not.

### `isIgnoredByChain` — unit-testable

Build the chain from `/p/.gitignore` = `"*.log\nbuild/\n"` and `/p/app/.gitignore` = `"!debug.log\n"`, then assert the four rows of the precedence table in `## Architecture Decisions`, plus:

- `isIgnoredByChain(EMPTY_IGNORE_CHAIN, '/p/a.log', false)` is `false`.
- A path outside every layer's directory — `isIgnoredByChain(chain, '/other/a.log', false)` — is `false` and does not throw.
- Case matters: in a one-layer chain at `/p` built from `"*.LOG\n"`, `/p/a.log` is **not** ignored.
- A nested match reaches the outermost layer: in a one-layer chain at `/p` built from `"node_modules\n"`, the directory `/p/app/node_modules` is ignored.

### `extendIgnoreChain` — unit-testable

- A `null` `text` returns the same chain, unchanged and same length.
- A non-`null` `text` returns a chain one longer, with the new layer last, and leaves the input array untouched.

### `buildRootIgnoreChain` — unit-testable

Using fakes where `pathExists` knows `/home/u/proj/.git` and `tryReadTextFile` knows `/home/u/proj/.git/info/exclude` and `/home/u/proj/.gitignore`:

- `buildRootIgnoreChain('/home/u/proj/src', …)` returns two layers, both anchored at `/home/u/proj`: the exclude file first, then the `.gitignore`.
- `buildRootIgnoreChain('/home/u/proj', …)` — the opened folder *is* the repository root — returns **one** layer, the exclude file. The opened folder's own `.gitignore` is never read here; `loadDirectory` adds it when it lists the folder.
- Given a third `.gitignore` at `/home/u/proj/src`, `buildRootIgnoreChain('/home/u/proj/src/app', …)` returns three layers, ordered: `/home/u/proj` exclude, `/home/u/proj` gitignore, `/home/u/proj/src` gitignore.
- With a `pathExists` that knows nothing, any root returns `EMPTY_IGNORE_CHAIN` and the walk terminates rather than looping.

### Tree behaviour — manual verification in `npm run tauri:dev`

Open the Loom repo itself as the project folder. Its root `.gitignore` lists `node_modules`, `dist`, `src-tauri/target/`, `.codegraph/`, `.worktrees/`; there is a second, nested `.gitignore` at `src-tauri/` listing `/target/` and `/gen/schemas`.

- Both toggles off (the default): the root shows the directories `src`, `src-tauri`, `tests` and the tracked top-level files (`CLAUDE.md`, `README.md`, `TODO.md`, `index.html`, `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`). `node_modules`, `dist`, `.git`, `.gitignore`, `.claude`, `.codegraph`, `.worktrees` are all absent.
- Expanding `src-tauri` shows `capabilities`, `gen`, `icons`, `src`, `Cargo.lock`, `Cargo.toml`, `build.rs`, `icon-source.svg`, `tauri.conf.json`. `target` is absent and `.gitignore` is absent.
- Expanding `src-tauri/gen` shows an empty branch: its only child, `schemas`, is matched by the nested layer's `/gen/schemas`. This is the nested-`.gitignore` case — the pattern is anchored at `src-tauri/`, not at the project root.
- **Show Hidden Files** on, Show Ignored off: `.git`, `.gitignore`, `.claude` appear at the root, and `src-tauri/.gitignore` appears. `node_modules`, `dist`, `.codegraph`, `.worktrees` stay absent — `.codegraph` and `.worktrees` are both hidden *and* ignored.
- **Show Ignored Files** on, Show Hidden off: `node_modules` and `dist` appear at the root and `target` appears under `src-tauri`; every dot-prefixed entry stays absent.
- Both on: every entry `readDir` returns is present.
- The menu panel stays open when a checkbox is clicked, and its checkmark flips in place; reopening the View menu shows the checkmarks in their current state.
- Toggling collapses the tree back to the root and clears the selection. Open tabs are unaffected.
- **The walk-up case**, which needs a scratch repository because nothing in Loom's own tree isolates it. It must live under `$HOME`, which is the app's whole filesystem scope. In a shell: `mkdir -p ~/loom-scratch/sub/build`, `cd ~/loom-scratch`, `git init`, write `build/` into `~/loom-scratch/.gitignore`, and create `~/loom-scratch/sub/keep.txt`. Open `~/loom-scratch/sub` as the project folder with both toggles off: `keep.txt` shows and `build` is absent, which is only possible if `buildRootIgnoreChain` walked up to `~/loom-scratch`, found `.git`, and seeded the chain with the `.gitignore` beside it.

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — `tests/paths.test.ts` and `tests/gitignore.test.ts` green.
- `grep -n 'loadInto' src/` — zero matches.
- `grep -n '"ignore"' package.json` — listed under `dependencies`, not `devDependencies`.
- `npm run build` — frontend production build succeeds with `ignore` bundled.
- `npm run tauri:dev`, then **File ▸ Open Folder…** on the Loom repo, and walk the manual cases in `## Expected Behaviour`. The toggles live under **View**.

---

## Documentation Impact

- [README.md](README.md) — the *File tree* bullet in `## Highlights` gains the filtering behaviour and names the two View-menu toggles.
- [TODO.md](TODO.md) — the **Hidden-file / `.gitignore`-aware filtering** bullet leaves the High section. The Medium **Filesystem watching** bullet gains a sentence that a refresh must re-run the filter.

There is no docs site or export barrel to update; `src/data/gitignore.ts` is app-internal.

---

## Potential Challenges

- **A toggle collapses the tree.** `Tree.setNodes` clears expanded, selected, loading, and loaded state, so rebuilding from the root loses every expansion. Accepted; restoring expansion is a `## Non-Goals` item.
- **`Ignore.test` throws on a path it cannot interpret.** A `RangeError` on an absolute path, a `TypeError` on an empty string. The `relative === null` guard in `isIgnoredByChain` is the only thing preventing both — keep it, and keep the test case that pins it.
- **A directory-only pattern needs the trailing `/`.** Testing `build` instead of `build/` silently fails to match `build/`. The `isDir` argument to `isIgnoredByChain` exists solely for this.
- **The upward walk can leave the app's filesystem scope.** `stat` on a path outside `$HOME/**` rejects; `workspace.pathExists` must swallow that and return `false`, so the walk simply keeps going up and finds no repository.
- **A directory emptied by the filter still renders an expand caret.** `hasChildren: true` is set before its contents are known, so expanding shows an empty branch. Cosmetic; Loom's own `src-tauri/gen` is the live instance and it is in the manual checklist.
- **A stale Vite pre-bundle after installing `ignore`.** Restart `npm run tauri:dev` once after the install if the dev server reports the module as unresolvable.

---

## Critical Files

- [src/explorer/FileTree.ts](src/explorer/FileTree.ts) — the whole listing path being reworked; `loadInto` at line 63 and `toNodes` at line 68.
- [src/data/workspace.ts](src/data/workspace.ts) — the sole `@tauri-apps/*` entry point; read its header comment before adding the two wrappers.
- [src/data/paths.ts](src/data/paths.ts) — the pure path helpers `parentDir` and `relativePath` join; `joinPath` at line 44 shows the two-separator handling to mirror.
- [tests/paths.test.ts](tests/paths.test.ts) — the test style both new suites follow.
- [src/shell/EditorShell.ts](src/shell/EditorShell.ts) — the `MenuBarActions` bag and `buildMenuBar`; `onToggleExplorer` at line 45 is the live-read precedent the two getters follow.
- [../typescript-ui/packages/lib/src/typescript/lib/layout/Split.ts:1128](../typescript-ui/packages/lib/src/typescript/lib/layout/Split.ts#L1128) — the `MenuItemConfig.row` + `CheckboxMenuRow` precedent, including the `row.on('action', …)` / `row.isChecked()` shape.
- [../typescript-ui/packages/lib/src/typescript/lib/component/container/MenuItem.ts:124](../typescript-ui/packages/lib/src/typescript/lib/component/container/MenuItem.ts#L124) — `MenuItemConfig.row`'s contract, including the never-share-an-instance rule.

---

## Non-Goals

- **The global gitignore** (`core.excludesFile`, `~/.config/git/ignore`). Finding it means parsing `~/.gitconfig`, including its `[include]` directives — disproportionate to the benefit.
- **The Windows `FILE_ATTRIBUTE_HIDDEN` attribute.** `readDir` returns only `name`/`isDirectory`/`isFile`/`isSymlink`, so honouring it would cost a `stat` round trip per entry.
- **Preserving expansion and selection across a toggle.** `Tree.revealByPredicate` could restore a saved path set later; it is not worth the bookkeeping for a menu action.
- **Persisting the two toggles across restarts.** That belongs to the session-persistence backlog item, which owns where app state is stored.
- **Re-running the filter on filesystem changes.** The filesystem-watching backlog item owns that; this plan only makes it possible by putting the filter in one function.[^watch-seam]
- **Shelling out to `git`.** No `tauri-plugin-shell` is installed and none is added.
- **Keyboard accelerators for the two toggles.** [src/shell/shortcuts.ts](src/shell/shortcuts.ts) is untouched.
- **`.ignore` / `.rgignore` files, or a per-workspace exclude setting.**

---

## Implementation Notes

**`isVisible` collides with `Component`'s own inherited method.** The plan's
private `FileTree.isVisible(item, chain)` (`## Internal Structure`) narrows
`Component.isVisible(): boolean | null` — a component's own on-screen
visibility, unrelated to per-entry filtering — which `Tree` inherits.
`tsc` rejects the override (`TS2416`), and the resulting private/public
mismatch also broke `FileTree`'s structural match against `Component`
wherever it's passed as one (`EditorShell.ts`'s `splitBody.addComponent(tree,
…)`). Renamed to `isEntryVisible`; behaviour, callers, and every other name
in `## Public API` are exactly as the plan describes. The same class of
collision (`FileBreadcrumbs.render()` vs. `Component.render()`) was already
recorded in `file-breadcrumbs.md`'s own Implementation Notes on this branch's
start point.

**`relativePath` is implemented in terms of the pre-existing `relativeTo`.**
The plan (drafted before this branch's start point) specifies `relativePath`
in `src/data/paths.ts` without knowing that `relativeTo(root: string | null,
path: string): string | null` already exists there, added by an earlier
phase on this batch's stack. Both share the same prefix-and-sibling-rejection
logic; `relativePath` differs only in normalising `\` to `/` (required by the
`ignore` package, its sole caller) and taking a non-nullable `parent`. Rather
than duplicate that logic, `relativePath` delegates to `relativeTo` and
normalises its result — every case in `## Expected Behaviour`'s
`relativePath` table still passes verbatim; `relativeTo` itself is untouched.
One divergence needed its own fix: `relativeTo(parent, parent + sep)`
resolves `''` rather than `null` (pinned by the pre-existing
`tests/paths.test.ts`'s `relativeTo` suite), which is a real path
`Ignore.test` throws a `TypeError` on. `relativePath` now folds that case
into `null` too — the plan's own contract is "`null` when `path` does not sit
strictly below `parent`", and the bare-trailing-separator spelling of
`parent` itself is exactly that — pinned by a new test in both
`tests/paths.test.ts` and `tests/gitignore.test.ts`. Caught by audit's first
round.

**`setProjectRoot` keeps its pre-existing atomicity, diverging from the
plan's literal step order.** Plan step 6 specifies "`setProjectRoot` stores
`root`, awaits `buildRootIgnoreChain(...)`, then awaits a new private
`reload()`" — writing `_root` first. Implemented literally, a failed
`loadDirectory` (a restored project folder later moved or deleted) left
`_root` pointing at the dead path: the next autosave (`session.ts`'s
`captureSession`) would persist it, and `EditorController.openProjectFolder`
deliberately leaves its own `_projectRoot` unset on such a failure, so tree
and controller would disagree. The base implementation's own doc comment
already named this invariant ("The root is recorded only once the listing
succeeds"). `setProjectRoot` now computes the chain and the listing into
locals and assigns `_root`/`_rootChain` only after both succeed; `reload()`
itself, and its use by `setShowHidden`/`setShowIgnored`, are unchanged from
the plan. Caught by audit's first round.

**`buildRootIgnoreChain`'s "opened folder is the repository root" test only
pinned a count, not an identity.** `tests/gitignore.test.ts`'s single-layer
case asserted `chain.length === 1` but never which file that one layer came
from, even though `## Expected Behaviour`'s contract for this case is two
claims: one layer, **the exclude file** — never the opened folder's own
`.gitignore`, which `loadDirectory` reads instead. Gave the two fixture
files conflicting content and asserted the resulting precedence via
`isIgnoredByChain`, so the wrong file landing in that one slot now fails the
test; verified by temporarily mutating `buildRootIgnoreChain` two ways (both
reverted after) — reading the `.gitignore` path into the exclude slot, and
dropping the `root === repoRoot` special case entirely — and confirming
each breaks the test. Caught by audit's second round.

**Manual verification substitute.** `npm run tauri:dev` cannot launch in this
environment: its `beforeDevCommand` is `npm run dev` = `tsc --noEmit && vite`,
and `tsc --noEmit` fails on four pre-existing errors in
`src/EditorController.ts` (`TabCloseController`, a `"beforetabclose"` event
overload, and two `Tab.setTabName` calls) that are absent from the currently
published `@jimka/typescript-ui@0.8.0` on the npm registry. This is
reproducible with a clean `npm ci` at this branch's own start point
(`feature/file-breadcrumbs`'s tip, before any commit on this branch),
unrelated to this plan's file set, and blocks `npm run build` and
`npm run tauri:dev` identically on every branch in this batch until the
library's `0.8.0` publish is fixed upstream — not something this plan's
scope can or should fix.

With the live app unreachable, the plan's "Tree behaviour" manual-verify
bullets were substituted with a throwaway vitest file (never committed,
deleted immediately after) that called the real (not faked)
`buildRootIgnoreChain`/`extendIgnoreChain`/`isIgnoredByChain`/`isHiddenName`
from `src/data/gitignore.ts` against the real Loom repo tree on disk via
plain `node:fs`, replicating `FileTree.loadDirectory`/`isEntryVisible`'s
exact decision sequence, plus a real temporary git repository for the
walk-up case. It confirmed: the repo root's listing with both toggles off
matches the plan's expected set (`node_modules`, `dist`, `.git`,
`.gitignore`, `.claude`, `.codegraph`, `.worktrees` all absent; `src`,
`src-tauri`, `tests`, and the tracked top-level files all present);
`src-tauri`'s nested `.gitignore` correctly hides `target` and itself, via
the same layer that this worktree's `src-tauri/gen` — never generated here,
since it's produced by a `cargo tauri build` this same blocker prevents —
could not itself be exercised; Show Hidden and Show Ignored each reveal only
their own class of entry independently; both together return every entry;
and a real scratch git repository confirms the upward walk finds a `.git`
above the opened folder and applies its `.gitignore`. Not exercised by this
substitute: the `CheckboxMenuRow` click/keymap behaviour and the menu panel
staying open across a toggle — both are the same `MenuItemConfig.row` +
`CheckboxMenuRow` shape already live at `Split.ts`'s gutter menu, not new
behaviour this plan introduces.

---

## Notes

[^filter-in-filetree]: [src/data/workspace.ts:1](src/data/workspace.ts#L1) states in its header that it is not unit-tested because "it has no logic of its own beyond the size guard", and every branch would need a real Tauri runtime. Putting a filter there would move real decision logic behind that untestable boundary. The domain shaping already sits outside it: `listDirectory` hands raw entries to [`sortDirEntries`](src/data/paths.ts#L64) and `FileTree.toNodes`. Filtering is one more shaping step in the same place.

[^why-ignore-package]: Three options were weighed. **`git check-ignore`** is the most accurate — it is git itself, so global gitignore, `.git/info/exclude`, nested files, and negations all come free — but it needs `tauri-plugin-shell` added to `Cargo.toml`, `lib.rs`, and `capabilities/default.json`, a `git` binary on the user's machine, and a process spawn per directory expansion; the app currently spawns nothing. **The Rust `ignore` crate** (ripgrep's) is equally accurate and needs no external binary, but the app has no `#[tauri::command]` at all today — [src-tauri/src/lib.rs](src-tauri/src/lib.rs) is scaffolding plus three `plugin(...)` calls — so it would introduce a Rust/TypeScript command seam for this one feature, and it moves the matching rule out of reach of `npm test`, which runs in a plain node environment ([vitest.config.ts:1](vitest.config.ts#L1)). **The `ignore` npm package** is a spec-complete JavaScript implementation of gitignore matching used by eslint among others, shipping as one 43 KB source file with no dependencies of its own. It keeps the rule in a pure module beside `paths.ts` where the existing test suite already lives, and costs no native surface at all. Its gaps against git — the global gitignore, and the fact that it cannot know whether a path is a directory — are handled explicitly by this plan (the first as a `## Non-Goals` item, the second by the trailing-slash rule).

[^trailing-slash]: Verified against `ignore@7.0.8`. With `dist/` added, `test('dist')` returns `{ ignored: false }` and `test('dist/')` returns `{ ignored: true }`. Appending the slash is safe for non-directory-only patterns too: with `node_modules` added, both `test('node_modules')` and `test('node_modules/')` return `{ ignored: true }`. So the rule is unconditional — append `/` whenever `isDir`, never otherwise.

[^gitignore-before-filter]: Two orderings are wrong here and both are easy to write by accident. Reading `<dir>/.gitignore` unconditionally costs a failed IPC round trip for every directory that has none, which is most of them; checking the listing first costs nothing because the listing is already in hand. And filtering before reading would drop `.gitignore` itself as a hidden dotfile, so with the default toggles no project would ever have any ignore rules applied.

[^walk-up]: Without the walk, opening a subdirectory of a repository applies none of the repository's rules — opening `~/proj/src` would show every build artefact `~/proj/.gitignore` covers. The walk costs one `stat` per level and terminates on `parentDir(p) === p`, so a folder outside any repository probes a handful of paths and stops. `.git` is probed with `stat` rather than `exists` because `fs:allow-stat` is already granted and `fs:allow-exists` is not; `stat` also succeeds for a linked worktree, whose `.git` is a file rather than a directory. `.git/info/exclude` is placed before `<root>/.gitignore` because git gives the tracked `.gitignore` the higher precedence of the two.

[^dotfiles-only]: Tauri's `DirEntry` carries only `name`, `isDirectory`, `isFile`, and `isSymlink`; the Windows attribute bits live on `FileInfo.fileAttributes`, which only `stat` returns, and only on Windows. Honouring the attribute would therefore mean one extra IPC round trip per entry on every expansion, on every platform, to serve a case that barely arises: the app is scoped to `$HOME/**` and its live test platform is Linux (see TODO.md's WebKitGTK note). Dotfiles are also what every code editor means by "hidden" in a project tree, whatever the OS.

[^two-toggles]: One combined toggle was considered and rejected: hidden and ignored are different sets that barely overlap — `node_modules` is ignored but not hidden, `.gitignore` is hidden but not ignored — so a single switch cannot serve "show me my dotfiles but not my build output", which is the common request. The extra cost is one field, one accessor pair, and one menu row. `CheckboxMenuRow` is chosen over `MenuItemConfig.checked` because these are exactly the multi-select case the library added it for: the panel survives a toggle, so both switches can be flipped in one open. `MenuItemConfig.checked` would close the menu on each click.

[^case-sensitive]: `ignore` defaults to `ignorecase: true`, which diverges from git on a case-sensitive filesystem. Passing `false` matches git's behaviour on Linux, the project's live test platform, and fails in the safer direction elsewhere: on a case-insensitive filesystem the worst outcome is that an ignored file is still shown, whereas case-insensitive matching could hide a file git actually tracks. A platform-dependent default is not reachable anyway — `ignore`'s own Windows path handling keys off `process.platform`, which is undefined inside the webview.

[^no-config-change]: Verified against Loom's exact `tsconfig.json` with TypeScript 6.0.3: `ignore@7.0.8` uses `export = ignore`, and both `import ignore from 'ignore'` and `import type { Ignore } from 'ignore'` typecheck cleanly, because `moduleResolution: "bundler"` implies `allowSyntheticDefaultImports`. `esModuleInterop` does not need to be added. At runtime the package sets `module.exports = factory` and `factory.default = factory`, so Vite's CJS pre-bundling and Node's ESM interop under vitest both resolve the default import to the factory function.

[^watch-seam]: `FileTree.loadDirectory` is the only function that turns a listing into nodes, so a future watcher re-runs it for the changed directory and gets filtering for free. The one case that does not reduce to a single directory is a changed `.gitignore`: its layer governs everything below its own directory, so that subtree has to be rebuilt from the layer's directory downwards. Designing the watcher is out of scope; this note only records what it will have to honour.
