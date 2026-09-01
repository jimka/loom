---
touches-shared: [src/main.ts, src/EditorController.ts, src/shell/EditorShell.ts, src/explorer/FileTree.ts, src/data/workspace.ts, src-tauri/capabilities/default.json]
---

# Session Persistence Across Restarts — Implementation Plan

Loom forgets everything when it exits. The next launch shows an empty tree, an
empty tab strip, and the default split. This plan makes the app write a small
JSON file whenever the session changes, and replay it on the next launch: the
last project folder, which directories were expanded in the tree, which files
were open (and which was active), and how wide the explorer pane was.

The file is written to a per-platform-cased `loom`/`Loom` folder under Tauri's config directory through
[`src/data/workspace.ts:1`](src/data/workspace.ts#L1), the app's only
`@tauri-apps/*` entry point. Everything that decides *what* goes into the file
lives in two new modules: [`src/data/session.ts`](src/data/session.ts) holds the
record shape plus its parser (pure, unit-tested, no Tauri imports, alongside
[`src/data/paths.ts:1`](src/data/paths.ts#L1)), and
[`src/shell/session.ts`](src/shell/session.ts) holds the capture/restore/autosave
wiring (alongside [`src/shell/shortcuts.ts:107`](src/shell/shortcuts.ts#L107)).

The state itself is spread across three owners today, so all three grow a small
read/write surface: [`src/explorer/FileTree.ts:58`](src/explorer/FileTree.ts#L58)
owns the project root and the expanded directories,
[`src/EditorController.ts:34`](src/EditorController.ts#L34) owns the open files
and the active tab, and the `Split` built at
[`src/shell/EditorShell.ts:33`](src/shell/EditorShell.ts#L33) owns the pane
sizes. [`src/shell/EditorShell.ts:30`](src/shell/EditorShell.ts#L30) is the only
place that holds all three, so it is where restore and autosave are hooked up.

---

## Architecture Decisions

### A JSON file in a per-platform-cased `loom`/`Loom` folder under Tauri's config directory, not the identifier-scoped app-config directory

The session is stored as `session.json` in a folder named after the app's own
`APP_NAME` ([`src/appIdentity.ts:5`](src/appIdentity.ts#L5)) — inside Tauri's
generic `$CONFIG` directory: `~/.config/loom/session.json` on Linux,
`~/Library/Application Support/Loom/session.json` on macOS,
`%APPDATA%\Loom\session.json` on Windows. Read and written with the
already-installed `@tauri-apps/plugin-fs`.[^storage]

`$APPCONFIG` — `$CONFIG` plus the app's bundle identifier,
`com.jimka.loom` ([`src-tauri/tauri.conf.json:5`](src-tauri/tauri.conf.json#L5))
— was the first choice, since `fs:default` already grants it read access and
`mkdir`. It is deliberately not used: the identifier is reverse-DNS-styled for
eventual OS bundling (a real requirement once code signing and a bundle matrix
happen, per `TODO.md`'s *Low* section), not a name anyone would expect to find
under `~/.config`, `~/Library/Application Support`, or `%APPDATA%`. Using the
bare `$CONFIG` directory with the app's own `APP_NAME` as the subfolder
decouples the two: the identifier stays reverse-DNS for bundling, and the
config folder stays a name recognizable under each platform's own directory.

That decoupling costs the automatic grants: `fs:default`'s directory access is
a fixed scope over the five identifier-based app directories
(`$APPCONFIG`/`$APPDATA`/`$APPLOCALDATA`/`$APPCACHE`/`$APPLOG`) and does not
extend to `$CONFIG` at all, so both the scope and the `mkdir` command need
their own explicit grants.[^capability]

### The folder name is cased per platform: lowercase on Linux, `APP_NAME` as-is elsewhere

`~/.config` is Linux's own convention, and the apps that follow it use a
lowercase folder matching their binary or package name — `~/.config/nvim`,
`~/.config/git`, `~/.config/discord`. `~/Library/Application Support` and
`%APPDATA%` are macOS's and Windows's own conventions instead, and the apps
that follow *those* keep their display-name casing as-is —
`.../Application Support/Slack`, `...\AppData\Roaming\Discord`. VS Code
does not: it capitalizes `Code` on Linux too, an Electron default
(`app.getPath('userData')` uses the product name verbatim, uncased) rather
than a deliberate platform choice. This plan follows each platform's actual
convention instead of that default, which means the folder name is no longer
a fixed string: `src/data/workspace.ts` computes it as
`platform() === 'linux' ? APP_NAME.toLowerCase() : APP_NAME`, using the new
`@tauri-apps/plugin-os` dependency's synchronous `platform()` (`##
Ordered Implementation Steps`, step 3).[^os-plugin]

### The snapshot mirrors the library's own layout-serialization shape

`SessionState` is a `version`-stamped record whose split entry is the
`LayoutSize[]` the library already defines for exactly this purpose. The library's
`SplitNode`/`LayoutState` in
[`../typescript-ui/packages/lib/src/typescript/lib/layout/LayoutSerialization.ts:76`](../typescript-ui/packages/lib/src/typescript/lib/layout/LayoutSerialization.ts#L76)
is the precedent for the envelope; its `serializeLayout` is not called.[^serializer]

### The split restores through `Split`'s constructor, not a post-layout re-apply

`EditorShell` passes the persisted sizes to `new Split({ paneSizes, collapsedPanes })`
rather than calling `applyPaneSizes` after the shell is on screen. `Split` drains
both options on its first layout, so the window paints once, already at the saved
width.[^split-options]

The explorer's saved width is captured with `Split.getPaneSizes()`, not
`getPaneRatios()`. Loom pins the explorer pane with `weight: 0`, which makes its
width an absolute pixel quantity; a ratio would move the pane whenever the window
is a different size than it was at save time.[^pane-sizes]

The persisted split state is sizes **plus** each pane's collapsed flag. *Toggle
Explorer* is implemented as a pane collapse
([`src/shell/EditorShell.ts:45`](src/shell/EditorShell.ts#L45)), so restoring the
size alone would reopen an explorer the user deliberately hid.

### Tree expansion is persisted as directory paths, replayed parents-first

`TreeNode` objects are rebuilt on every launch, so the expanded set is stored as
the absolute paths behind those nodes. On restore the paths are replayed shortest
first, which guarantees a directory is expanded (and therefore loaded) before any
directory inside it is looked for.[^expansion-order]

`Tree.revealByPredicate` is not used to replay the expanded set.[^no-reveal]

### Stale entries degrade field by field, and arrays whole

Restore never fails as a unit. A missing project folder leaves the tree empty but
still reopens the tabs; a deleted file is skipped and the rest of the tabs still
open; a session file that does not parse is treated as no session at all. Nothing
is reported to the user — no dialog, no status message.[^silent]

Inside the parser, each array is taken whole or dropped whole rather than
repaired entry by entry, matching the discard rule the library applies to a stale
`LayoutSize[]` in
[`../typescript-ui/packages/lib/src/typescript/lib/layout/LayoutSizes.ts:114`](../typescript-ui/packages/lib/src/typescript/lib/layout/LayoutSizes.ts#L114).

### Saves are debounced, and flushed through the existing exit hook

Every change schedules a save 500 ms later, coalescing the burst of events one
user action produces. The close path flushes that pending save before the window
goes, chained inside the single `onCloseRequested` handler `EditorController`
already owns ([`src/EditorController.ts:309`](src/EditorController.ts#L309)) — a
second Tauri close listener must not be registered.[^one-close-listener]

The flush always writes, whether or not a save was pending. That is what carries
a tab drag-reorder into the file: `Tab` reorders its contents without emitting any
public event, so a reorder is invisible to the autosave until something else
triggers it or the app exits.[^reorder]

---

## Public API

### `src/data/session.ts` (new — pure, no Tauri imports)

```ts
import type { LayoutSize } from '@jimka/typescript-ui/layout'

/** One saved session: what the app should look like on the next launch. */
export interface SessionState {
  version: 1
  /** The last opened project folder, or `null` when none was open. */
  projectRoot: string | null
  /** Absolute paths of the directories expanded in the tree. */
  expandedDirs: string[]
  /** Absolute paths of the open files, in tab order. */
  openFiles: string[]
  /** The active tab's file path, or `null` when no file was open. */
  activeFile: string | null
  /** The `Split`'s pane sizes, in pane order (explorer first). */
  paneSizes: LayoutSize[]
  /** Indices of the collapsed panes. */
  collapsedPanes: number[]
}

/** A fresh, empty session — what a first launch (or an unusable file) gets. */
export function emptySession(): SessionState

/** Reads a session out of a file's text, degrading to {@link emptySession} on anything unusable. */
export function parseSession(text: string): SessionState

/** Renders a session as the JSON text written to disk. */
export function serializeSession(state: SessionState): string

/** Orders directory paths so an ancestor always precedes its descendants. */
export function expansionOrder(paths: string[]): string[]
```

### `src/data/workspace.ts` (modified)

```ts
/** Reads the app-config session file's text, or `null` when it is absent or unreadable. */
export async function readSessionText(): Promise<string | null>

/** Writes `text` to the app-config session file, creating the directory if needed. */
export async function writeSessionText(text: string): Promise<void>
```

### `src/explorer/FileTree.ts` (modified)

```ts
/** The folder {@link setProjectRoot} last loaded successfully, or `null` when it never has. */
getProjectRoot(): string | null

/** The absolute paths of the currently expanded directory nodes. */
getExpandedPaths(): string[]

/** Expands each of `paths` that still exists, ancestors first; unknown paths are skipped. */
async expandPaths(paths: string[]): Promise<void>
```

### `src/EditorController.ts` (modified)

```ts
/** The open files' paths, in tab order. */
getOpenFilePaths(): string[]

/** The active tab's file path, or `null` when the strip is empty. */
getActiveFilePath(): string | null

/** Reopens `paths` in order, skipping any that no longer read, then activates `activePath`. */
async restoreFiles(paths: string[], activePath: string | null): Promise<void>

/** Injects a hook awaited on the way out, after the unsaved-changes decision. */
setBeforeExitListener(fn: () => Promise<void>): void
```

### `src/shell/session.ts` (new)

```ts
/** The three state owners a session snapshot is captured from and restored into. */
export interface SessionTargets {
  controller: EditorController
  tree: FileTree
  split: Split
}

/** Queues and forces session writes. */
export interface SessionAutosave {
  /** Queues a save of the current snapshot, coalescing calls within the debounce window. */
  schedule: () => void
  /** Writes the current snapshot immediately, pending save or not. */
  flush: () => Promise<void>
}

/** Reads and parses the stored session. */
export async function loadSession(): Promise<SessionState>

/** The current state of the tree, tabs, and split. */
export function captureSession(targets: SessionTargets): SessionState

/** Replays `state` into the live tree and tab strip. The split is restored by `EditorShell`. */
export async function applySession(state: SessionState, targets: SessionTargets): Promise<void>

/** Subscribes to every event that changes the session and returns the save controls. */
export function installSessionAutosave(targets: SessionTargets): SessionAutosave
```

### `src/shell/EditorShell.ts` (modified)

```ts
class EditorShell extends Container {
  /** @param session - The stored session; its split entries seed the `Split`. */
  constructor(controller: EditorController, session: SessionState)

  /** Replays `state` into the tree and tabs, then starts autosaving. */
  async restoreSession(state: SessionState): Promise<void>
}
```

---

## Internal Structure

### The session file

```json
{
  "version": 1,
  "projectRoot": "/home/jika/typescript/loom",
  "expandedDirs": ["/home/jika/typescript/loom/src", "/home/jika/typescript/loom/src/data"],
  "openFiles": ["/home/jika/typescript/loom/src/main.ts", "/home/jika/typescript/loom/README.md"],
  "activeFile": "/home/jika/typescript/loom/README.md",
  "paneSizes": [{ "unit": "px", "value": 300 }, { "unit": "ratio", "value": 1 }],
  "collapsedPanes": []
}
```

### What `parseSession` does with a damaged file

A parse failure, a non-object, or any `version` other than `1` discards the whole
file. Past that, each field is read independently: a field that is absent or the
wrong shape takes its empty default, and the rest of the session survives.

| Input | Result |
|---|---|
| `""` or `"not json"` | empty session |
| `{"version": 2, "openFiles": ["/p/a.ts"]}` | empty session — version is not `1` |
| `{"version": 1, "openFiles": ["/p/a.ts"]}` | that `openFiles`; every other field at its empty default |
| `{"version": 1, "openFiles": ["/p/a.ts", 7]}` | `openFiles: []` — one bad entry drops the array |
| `{"version": 1, "paneSizes": [{"unit": "em", "value": 3}]}` | `paneSizes: []` — `unit` is neither `"px"` nor `"ratio"` |
| `{"version": 1, "recentProjects": []}` | unknown fields ignored |

### Replaying expanded directories

`expansionOrder` sorts by path length ascending. A parent directory's path is
always a strict prefix of a directory inside it, so it is always shorter, so it is
always replayed first; two paths of equal length can never be ancestor and
descendant, so their relative order does not matter.

| Persisted `expandedDirs` | Replay order |
|---|---|
| `["/p/src/data", "/p", "/p/src"]` | `/p`, `/p/src`, `/p/src/data` |

`FileTree.expandPaths` then walks each path in that order:

```ts
for (const path of expansionOrder(paths)) {
  const node = this.findLoadedNode(path)

  if (node) {
    await this.expandNodeAsync(node)
  }
}
```

`findLoadedNode` is a depth-first walk over `getNodes()` and each node's
already-loaded `children`, comparing `(node.data as FileTreeNodeData).path` — it
performs no I/O of its own. It finds a nested directory only because its parent
was expanded (and therefore loaded) by an earlier iteration.

### Choosing the active tab on restore

The persisted active file wins when it opened. Otherwise the first file that did
open becomes active, so a restored window is never left with tabs and no
selection.

| `openFiles` | `activeFile` | On disk | Tabs opened | Active tab |
|---|---|---|---|---|
| `[a, b, c]` | `b` | all three | `a, b, c` | `b` |
| `[a, b, c]` | `b` | `b` deleted | `a, c` | `a` |
| `[a, b]` | `null` | both | `a, b` | `a` |
| `[a]` | `a` | `a` deleted | none | none — window title falls back to `Loom` |

---

## Ordered Implementation Steps

1. **`src/data/session.ts` (new).** Add `SessionState`, `emptySession`,
   `parseSession`, `serializeSession`, and `expansionOrder` exactly as given in
   `## Public API`. Import `LayoutSize` as a **type-only** import from
   `@jimka/typescript-ui/layout` so the module pulls in no runtime dependency —
   `tests/` runs in vitest's `node` environment (`vitest.config.ts:9`) and this
   module must import nothing that needs a DOM or a Tauri runtime.
   `serializeSession` uses `JSON.stringify(state, null, 2)`.

2. **`tests/session.test.ts` (new).** Write the unit tests listed under
   `## Expected Behaviour` → *Parsing and ordering*, following
   [`tests/paths.test.ts:1`](tests/paths.test.ts#L1)'s one-`describe`-per-export
   shape. Run `npm test` — these fail until step 1's logic is right, and must pass
   before continuing.

3. **Add `@tauri-apps/plugin-os`, then `src/data/workspace.ts`.**
   - **The dependency, first.** `npm install @tauri-apps/plugin-os@^2.3.2`; in
     `src-tauri/`, `cargo add tauri-plugin-os@2.3.2` (matching the precise
     pinning style `tauri-plugin-fs`/`tauri-plugin-dialog` already use in
     [`src-tauri/Cargo.toml`](src-tauri/Cargo.toml)). Register it in
     [`src-tauri/src/lib.rs:4`](src-tauri/src/lib.rs#L4)'s `tauri::Builder`
     chain — `.plugin(tauri_plugin_os::init())`, alongside the existing
     `tauri_plugin_fs`/`tauri_plugin_dialog` registrations. No capability
     entry is needed: `platform()` (below) reads a value the plugin injects
     into `window.__TAURI_OS_PLUGIN_INTERNALS__` when the webview loads, not
     an `invoke`d command, so it isn't gated by the permission system at
     all.[^os-plugin]
   - **`readSessionText`/`writeSessionText`.** Import `mkdir` and
     `BaseDirectory` from `@tauri-apps/plugin-fs`, `platform` from
     `@tauri-apps/plugin-os`, and `APP_NAME` from
     [`../appIdentity`](src/appIdentity.ts#L5), alongside the existing imports
     at [`src/data/workspace.ts:6`](src/data/workspace.ts#L6). Add two
     module-level constants:
     ```ts
     /** The app's own subfolder name under Tauri's `$CONFIG` directory — lowercased on Linux to match that platform's own convention (`~/.config/nvim`), left as {@link APP_NAME} elsewhere to match those platforms' own (`.../Application Support/Slack`); see `## Architecture Decisions`. Deliberately not the `com.jimka.loom` bundle identifier either way. */
     const CONFIG_DIR_NAME = platform() === 'linux' ? APP_NAME.toLowerCase() : APP_NAME

     /** The session file's name inside {@link CONFIG_DIR_NAME}. */
     const SESSION_FILE_NAME = 'session.json'
     ```
   - `readSessionText` wraps
     `readTextFile(\`${CONFIG_DIR_NAME}/${SESSION_FILE_NAME}\`, { baseDir: BaseDirectory.Config })`
     in a `try`/`catch` and returns `null` on any throw — an absent file on first
     launch is the common case, not an error.
   - `writeSessionText` resolves `const dir = await join(await configDir(), CONFIG_DIR_NAME)`
     (import `configDir` and `join` from `@tauri-apps/api/path`), calls
     `await mkdir(dir, { recursive: true })` first (idempotent; the directory does
     not exist on first launch), then
     `writeTextFile(\`${CONFIG_DIR_NAME}/${SESSION_FILE_NAME}\`, text, { baseDir: BaseDirectory.Config })`.
     `mkdir` takes a resolved absolute path rather than the `baseDir`-relative
     form used for the reads and writes, mirroring how the directory was
     resolved before this plan swapped `appConfigDir()` for `configDir()` plus
     `join(..., CONFIG_DIR_NAME)`.

4. **`src-tauri/capabilities/default.json`.** Add `"fs:allow-mkdir"` to the
   `permissions` array (`fs:default`'s bundled `mkdir` grant only covers the
   identifier-scoped app directories, not `$CONFIG`) and add both
   `{ "path": "$CONFIG/loom" }`/`{ "path": "$CONFIG/loom/*" }` and
   `{ "path": "$CONFIG/Loom" }`/`{ "path": "$CONFIG/Loom/*" }` to the existing
   `fs:scope` allow list. Capability scope paths are matched literally against
   the resolved filesystem path — there is no case-insensitive match, and a
   capability file cannot reference a runtime value like `CONFIG_DIR_NAME` to
   pick the right one — so both casings are granted; whichever platform a
   given build actually runs on only ever resolves and uses one of
   them.[^dual-scope] The permissions array reads:
   ```json
   [
     "core:default",
     "core:window:allow-set-title",
     "core:window:allow-close",
     "core:window:allow-destroy",
     "dialog:default",
     "fs:default",
     "fs:allow-read-text-file",
     "fs:allow-write-text-file",
     "fs:allow-read-dir",
     "fs:allow-stat",
     "fs:allow-mkdir",
     { "identifier": "fs:scope", "allow": [{ "path": "$HOME/**" }, { "path": "$CONFIG/loom" }, { "path": "$CONFIG/loom/*" }, { "path": "$CONFIG/Loom" }, { "path": "$CONFIG/Loom/*" }] }
   ]
   ```
   `fs:allow-read-text-file` and `fs:allow-write-text-file` are already granted
   on lines 15–16 and are not scope-specific, so no further command permission
   is needed for the reads and writes themselves.

5. **`src/explorer/FileTree.ts`.** Add a `private _root: string | null = null`
   field, and split `setProjectRoot`
   ([`src/explorer/FileTree.ts:58`](src/explorer/FileTree.ts#L58)) so the root is
   recorded only once the listing succeeds — a failed listing must leave the
   previous root in place:
   ```ts
   const items = await listDirectory(root)

   this.setNodes(this.toNodes(items))
   this._root = root
   ```
   Add `getProjectRoot`, `getExpandedPaths`
   (`this.getExpandedNodes().map(node => (node.data as FileTreeNodeData).path)`),
   `expandPaths`, and the private `findLoadedNode` from `## Internal Structure`.
   Import `expansionOrder` from `../data/session`.

6. **`src/EditorController.ts`.** Split the tab-creation half out of `openFile`
   ([`src/EditorController.ts:91`](src/EditorController.ts#L91)) into a private
   `addFileTab(path: string, text: string): FileEditor` that constructs the
   `FileEditor`, calls `this.tabs.addTab(...)`, and records it in `_openFiles` —
   and does **not** activate it. `openFile` keeps its existing behaviour: return
   early for an already-open path, `await readFileText(path)` inside a `try`, show
   `Dialog.error('Could not open file', …)` on a throw, then `addFileTab`,
   `setActiveContent`, `syncActive`.

7. **`src/EditorController.ts`.** Add `getOpenFilePaths` — the `_openFiles` values
   sorted by `this.tabs.getTab().indexOfContent(file)`, mapped to `getPath()` —
   and `getActiveFilePath`. Sorting by `indexOfContent` is what makes a
   drag-reordered strip round-trip; `_openFiles`' own insertion order is the order
   files were *opened*, which is not the order they are shown in.

8. **`src/EditorController.ts`.** Add `restoreFiles(paths, activePath)`: loop over
   `paths`, skip any already in `_openFiles`, `await readFileText(path)` in a
   `try`/`catch` whose `catch` body is empty apart from a comment (a stale path is
   expected, not an error), `addFileTab` on success, and remember the first file
   that opened. After the loop, activate `this._openFiles.get(activePath)` when it
   opened, else the first one that did, then call `syncActive()`. Do **not** show a
   dialog anywhere in this method.

9. **`src/EditorController.ts`.** Add a
   `private _beforeExitListener: (() => Promise<void>) | null = null` field and its
   `setBeforeExitListener` setter, next to `setProjectRootListener`
   ([`src/EditorController.ts:60`](src/EditorController.ts#L60)). Rework
   `confirmExit` ([`src/EditorController.ts:309`](src/EditorController.ts#L309)) so
   it returns `false` early when files are dirty and `Dialog.confirm` is declined,
   then `await this._beforeExitListener?.()` and returns `true`. The session must
   be written only on the path that actually closes the window, and before it does.

10. **`src/shell/session.ts` (new).** Add `SessionTargets`, `SessionAutosave`, and
    `loadSession` (`parseSession((await readSessionText()) ?? '')`).
    Add `captureSession`:
    ```ts
    const paneSizes = targets.split.getPaneSizes()

    return {
      version: 1,
      projectRoot: targets.tree.getProjectRoot(),
      expandedDirs: targets.tree.getExpandedPaths(),
      openFiles: targets.controller.getOpenFilePaths(),
      activeFile: targets.controller.getActiveFilePath(),
      paneSizes,
      collapsedPanes: paneSizes.map((_, index) => index).filter(index => targets.split.isPaneCollapsed(index)),
    }
    ```

11. **`src/shell/session.ts`.** Add `applySession`: when `state.projectRoot` is not
    `null`, `await targets.tree.setProjectRoot(state.projectRoot)` inside a
    `try`/`catch` (a moved or deleted folder leaves the tree empty and the rest of
    the restore continues), and on success `await targets.tree.expandPaths(state.expandedDirs)`.
    Then `await targets.controller.restoreFiles(state.openFiles, state.activeFile)`,
    unconditionally — an open file may live outside the project folder, so tabs are
    restored even when the folder is gone.

12. **`src/shell/session.ts`.** Add `installSessionAutosave`. Hold a
    `let timer: ReturnType<typeof setTimeout> | null = null`; `schedule` clears and
    re-arms it for `SESSION_SAVE_DEBOUNCE_MS`, whose callback writes the snapshot;
    `flush` clears the timer and awaits the write directly. Both write via
    `writeSessionText(serializeSession(captureSession(targets)))`, wrapped in a
    `try`/`catch` that swallows the error — a failed session write must never
    interrupt editing. Subscribe `schedule` to all six of `targets.tree.on('expand', …)`,
    `targets.tree.on('collapse', …)`, `targets.controller.tabs.getTab().on('activate', …)`,
    `targets.controller.tabs.getTab().on('tabclose', …)`,
    `targets.split.on('paneresize', …)`, and `targets.split.on('panecollapse', …)`.
    Every one of these is an additional listener on an event `EditorController`
    may already listen to; the library's listener bags allow that. Define
    ```ts
    /**
     * How long a session change waits before it is written, in milliseconds.
     * Long enough to coalesce the several events one user action emits (opening
     * a file from the tree fires a tree "expand" and a tab "activate"), short
     * enough that an abrupt kill loses at most the last action.
     */
    const SESSION_SAVE_DEBOUNCE_MS = 500
    ```

13. **`src/shell/EditorShell.ts`.** Change the constructor to
    `constructor(controller: EditorController, session: SessionState)`. Pass
    `paneSizes: session.paneSizes` and `collapsedPanes: session.collapsedPanes` to
    `new Split(...)` at [`src/shell/EditorShell.ts:33`](src/shell/EditorShell.ts#L33)
    — both are inert when empty, so a first launch behaves exactly as today. Add
    `private readonly _tree: FileTree`, `private readonly _split: Split`,
    `private readonly _controller: EditorController`, and
    `private _autosave: SessionAutosave | null = null`. The `tree` and `split`
    locals must stay locals until `super(...)` has run, so assign the three
    `readonly` fields immediately after the `super(...)` call, beside the existing
    post-`super` wiring.

14. **`src/shell/EditorShell.ts`.** Replace the project-root listener at
    [`src/shell/EditorShell.ts:62`](src/shell/EditorShell.ts#L62) with
    `controller.setProjectRootListener(root => { void this.openProjectRoot(root) })`
    and add `private async openProjectRoot(root: string): Promise<void>`, which
    awaits `this._tree.setProjectRoot(root)` and then calls `this._autosave?.schedule()`.
    Do not add a `catch`: a failed listing keeps exactly the unhandled rejection it
    has today, and that is out of scope here.

15. **`src/shell/EditorShell.ts`.** Add `restoreSession(state)`: build the
    `SessionTargets`, `await applySession(state, targets)`, then
    `const autosave = installSessionAutosave(targets)`, store it in `this._autosave`,
    and `this._controller.setBeforeExitListener(() => autosave.flush())`. Installing
    the listeners **after** the restore is what stops the restore from saving its own
    half-finished state — there is no suppression flag anywhere in this design, and
    none should be added.

16. **`src/main.ts`.** Leave `Glyph.register` and `Body.init` at module scope where
    they are ([`src/main.ts:19`](src/main.ts#L19) and
    [`src/main.ts:21`](src/main.ts#L21)) and move the three lines below them into an
    `async function start(): Promise<void>` invoked as `void start()`:
    ```ts
    const session = await loadSession()
    const controller = new EditorController()
    const shell = EditorShell(controller, session)

    Body.getInstance().addComponent(shell)

    void shell.restoreSession(session)
    ```
    A wrapper function rather than a top-level `await` — the shell is on screen
    before the restore's file reads begin, so the window paints immediately.

17. **Checks.** `npm run typecheck` and `npm test` both clean.
    `grep -rn '@tauri-apps' src/ --include=*.ts` — expect matches only in
    `src/data/workspace.ts`, preserving the single-entry-point rule the README
    states.

18. **Docs.** Apply `## Documentation Impact`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `src/data/session.ts` |
| Create | `src/shell/session.ts` |
| Create | `tests/session.test.ts` |
| Modify | `src/main.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `src/explorer/FileTree.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `src/data/workspace.ts` |
| Modify | `src-tauri/capabilities/default.json` |
| Modify | `package.json` |
| Modify | `src-tauri/Cargo.toml` |
| Modify | `src-tauri/src/lib.rs` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Parsing and ordering — unit-testable (`tests/session.test.ts`)

- `parseSession('')` returns a session equal to `emptySession()`.
- `parseSession('not json')` returns `emptySession()`.
- `parseSession('[]')` and `parseSession('null')` return `emptySession()` — the
  top level must be an object.
- `parseSession('{"version":2,"openFiles":["/p/a.ts"]}')` returns `emptySession()`.
- `parseSession` of a complete, valid document returns every field verbatim.
- `parseSession('{"version":1,"openFiles":["/p/a.ts"]}')` returns that `openFiles`
  and empty defaults for the other fields.
- `parseSession('{"version":1,"openFiles":["/p/a.ts",7]}')` returns `openFiles: []`.
- `parseSession('{"version":1,"paneSizes":[{"unit":"em","value":3}]}')` returns
  `paneSizes: []`; `{"unit":"px","value":300}` is kept.
- `parseSession('{"version":1,"projectRoot":5}')` returns `projectRoot: null`.
- `parseSession('{"version":1,"recentProjects":[]}')` ignores the unknown field.
- `parseSession(serializeSession(state))` deep-equals `state`, for a state with
  every field populated.
- `expansionOrder(['/p/src/data', '/p', '/p/src'])` returns
  `['/p', '/p/src', '/p/src/data']`.
- `expansionOrder([])` returns `[]`.
- `expansionOrder` leaves its input array unmutated.

### Session lifecycle — manual verification (`npm run tauri:dev`)

The vitest suite runs in a `node` environment with no DOM and no Tauri runtime,
so everything below is verified by hand.

- **Cold start, no file.** With `~/.config/loom/session.json` deleted,
  the app launches exactly as it does today: empty tree, no tabs, explorer at its
  300 px default.
- **Round trip.** Open a folder, expand two nested directories, open three files,
  activate the second, drag the split narrower, quit, relaunch: the same folder,
  the same expanded directories, the same three tabs in the same order, the second
  one active, and the same explorer width.
- **Collapsed explorer.** *Toggle Explorer* (Ctrl/Cmd+B), quit, relaunch — the
  explorer is still collapsed, and toggling it back restores the saved width.
- **Reordered tabs.** Drag a tab to a new position, quit, relaunch — the new order
  is restored (this is the case the exit flush covers; no event fires on reorder).
- **Deleted file.** Quit with three files open, delete one outside the app,
  relaunch — the other two open, no dialog appears, and the active tab is the
  persisted one if it survived, otherwise the first that opened.
- **Deleted folder.** Quit with a folder open, rename it outside the app, relaunch
  — the tree is empty, no dialog appears, and any open file that still exists is
  still reopened.
- **Corrupt file.** Replace `session.json` with `{`, relaunch — a clean empty
  launch, and the next change overwrites the file with a valid one.
- **Unsaved changes on exit.** Quitting with a dirty file still shows the existing
  "Unsaved changes" prompt; declining it leaves the window open and does not
  write a session; accepting it writes the session and closes.
- **Dev reload.** With `npm run tauri:dev` running, edit a source file to trigger
  Vite's reload — the tree, tabs, and split come back (unsaved buffer text does
  not; that is not persisted).

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — the new `tests/session.test.ts` passes alongside the existing
  `paths` and `languages` suites.
- `grep -rn '@tauri-apps' src/ --include=*.ts` — matches only in
  `src/data/workspace.ts`.
- `grep -rn 'serializeLayout\|restoreLayout\|revealByPredicate\|getPaneRatios' src/` —
  expect zero matches; each is a deliberately rejected approach.
- `npm run tauri:dev`, then the *Session lifecycle* checklist above. The session
  file to inspect between runs is `~/.config/loom/session.json` (Linux),
  `~/Library/Application Support/Loom/session.json` (macOS), or
  `%APPDATA%\Loom\session.json` (Windows).

---

## Documentation Impact

- **`README.md`** — add a *Highlights* bullet for session restore, next to the
  *File tree* and *Tabbed editing* bullets. The *Architecture* paragraph's claim
  that `src/data/workspace.ts` is "the app's sole `@tauri-apps/*` entry point"
  stays true and needs no edit.
- **`TODO.md`** — remove the *Session persistence across restarts* bullet from
  *High*. In *Notes*, the *Frontend hot reload today is a full page reload* bullet
  predicts this feature would fix reload state loss as a side effect; reword it to
  say it now does, still excepting unsaved buffer contents. Leave the
  *Per-workspace session persistence* and *Recent projects / recent files list*
  bullets in place — both are separate items.

---

## Potential Challenges

- **The app-config directory does not exist on a first launch.** `writeSessionText`
  calls `mkdir(..., { recursive: true })` before every write; it is idempotent, so
  no existence check is needed.
- **A `readDir` on a moved project folder rejects.** `applySession` wraps
  `setProjectRoot` in a `try`/`catch`; the folder-picker path is untouched and keeps
  today's behaviour.
- **A restored file exceeds the 5 MiB `readFileText` guard.** It throws like any
  other unreadable file and is skipped by `restoreFiles`' `catch`.
- **A future change to the shell's pane weights invalidates a saved `paneSizes`.**
  `Split.applyPaneSizes` discards a whole array whose units no longer match the
  live panes, so a stale entry silently falls back to the default split.
- **On a first launch, a capture taken before the split's first layout would record
  a zero explorer width.** `Split` has no stored pane sizes until it lays out, and
  reports `0` px for the pinned pane until then. (A launch that *is* restoring a
  saved width is immune: `getPaneSizes` reports the undrained `paneSizes` option
  instead.) Installing the autosave only at the end of `restoreSession` — after
  `applySession`'s awaited disk reads, by which point the shell has laid out — is
  what keeps that snapshot from ever being taken; a zero that did get through would
  still be clamped up to the tree's own 160 px `minSize` on the next layout.
- **`tabclose` fires before `Tab` picks the next active tab.**
  `EditorController.handleTabClose` already defers its resync to a microtask for
  that reason; the 500 ms debounce means the session snapshot is always taken well
  after `_openFiles` and the active tab have settled.
- **Two windows are not a concern.** Loom is single-window
  (`src-tauri/tauri.conf.json`), so there is no last-writer-wins race on the file.

---

## Critical Files

- [`src/shell/shortcuts.ts:107`](src/shell/shortcuts.ts#L107) — `installAccelerators`,
  the precedent for a `src/shell/` module that takes a bag of targets and installs
  cross-cutting behaviour on them.
- [`src/data/paths.ts:1`](src/data/paths.ts#L1) and
  [`tests/paths.test.ts:1`](tests/paths.test.ts#L1) — the precedent for a pure,
  import-free `src/data/` module with a matching vitest suite; `src/data/session.ts`
  and `tests/session.test.ts` mirror both.
- [`src/data/workspace.ts:1`](src/data/workspace.ts#L1) — the app's only
  `@tauri-apps/*` importer, and its header comment stating why it is untested.
- [`src-tauri/src/lib.rs:1`](src-tauri/src/lib.rs#L1) — the `tauri::Builder`
  plugin chain `tauri_plugin_os::init()` joins.
- [`src/appIdentity.ts:5`](src/appIdentity.ts#L5) — `APP_NAME`, the config
  folder name derives from.
- [`src/EditorController.ts:309`](src/EditorController.ts#L309) — `confirmExit` and
  the single-close-handler rule documented above it and at
  [`src/data/workspace.ts:105`](src/data/workspace.ts#L105).
- [`src/shell/EditorShell.ts:30`](src/shell/EditorShell.ts#L30) — the only place
  holding the tree, the split, and the controller at once.
- [`../typescript-ui/packages/lib/src/typescript/lib/layout/Split.ts:864`](../typescript-ui/packages/lib/src/typescript/lib/layout/Split.ts#L864) —
  `getPaneSizes` / `applyPaneSizes` and the `paneSizes` / `collapsedPanes`
  constructor options at lines 70–72.
- [`../typescript-ui/packages/lib/src/typescript/lib/layout/LayoutSerialization.ts:76`](../typescript-ui/packages/lib/src/typescript/lib/layout/LayoutSerialization.ts#L76) —
  `SplitNode` and `LayoutState`, the shape `SessionState` mirrors.
- [`../typescript-ui/packages/lib/src/typescript/lib/component/tree/Tree.ts:351`](../typescript-ui/packages/lib/src/typescript/lib/component/tree/Tree.ts#L351) —
  `getExpandedNodes`, `expandNodeAsync` (line 763), and `setNodes`' expansion reset
  (line 255).

---

## Non-Goals

- **Unsaved buffer contents.** A dirty file's text is not persisted; the existing
  exit prompt still decides whether it is saved or discarded, and restore reads
  from disk.
- **Cursor position, scroll offset, and tree selection.** Not part of what TODO.md
  asks for here, and each needs its own capture surface.
- **Window size and position.** `plugin-window-state` covers that, as TODO.md's
  *Notes* records; it is a separate dependency and a separate item.
- **Per-workspace session files** and a **recent projects / recent files list.**
  Both are their own TODO.md items with their own plans. `SessionState` is shaped
  so they extend it — the parser ignores unknown fields, and `parseSession` /
  `serializeSession` know nothing about where the text came from — but neither is
  designed or built here.
- **A welcome / empty state** when nothing restores. Separate TODO.md item; a
  restore that yields nothing simply shows today's empty window.
- **Fixing the folder picker's unhandled `setProjectRoot` rejection.** It exists
  today and survives this change unaltered.

---

## Notes

[^storage]: Three storage mechanisms were weighed. `localStorage` needs no
    dependency and no permission at all, but it is webview state: it is scoped to
    the page's origin, which differs between `npm run tauri:dev`
    (`http://localhost:1420`) and a bundled build (`tauri://localhost`), so a
    session saved while dogfooding would not be the one a packaged Loom restores;
    it is also invisible to the user and, on the Linux/WebKitGTK target this
    project already tracks rendering quirks against in TODO.md, its durability
    across restarts is the webview's business rather than the app's.
    `tauri-plugin-store` is a purpose-built key-value store, but it adds one npm
    dependency plus one Cargo dependency plus a `lib.rs` registration, and buys
    nothing over `JSON.stringify` for one small record. The fs plugin
    is already a dependency, already the app's storage seam for every file it
    reads and writes, and produces a file the user can inspect and delete.

[^capability]: The `fs:default` set in the capability file pulls in
    `read-app-specific-dirs-recursive` and `create-app-specific-dirs`, but both
    resolve their scope against a fixed list of five identifier-based
    directories (`$APPCONFIG`, `$APPDATA`, `$APPLOCALDATA`, `$APPCACHE`,
    `$APPLOG`) baked into the plugin's own permission definitions — confirmed
    against this project's generated
    [`src-tauri/gen/schemas/acl-manifests.json`](src-tauri/gen/schemas/acl-manifests.json),
    whose `fs.permissions["scope-app-index"]` and
    `fs.permissions["scope-app-recursive"]` list exactly those five path
    variables and nothing else. `$CONFIG` is not one of them, so choosing it
    over `$APPCONFIG` (`## Architecture Decisions`) means neither the read/mkdir
    scope nor the `mkdir` command itself carries over, and both need an explicit
    grant: the four `fs:scope` entries added in step 4 (one bare directory plus
    one glob, per casing — see `[^dual-scope]`), and `fs:allow-mkdir` (the
    plugin's own "no pre-configured scope" variant of the command, bounded here
    by the scope entries rather than a bundled one). `fs:allow-read-text-file`
    and `fs:allow-write-text-file` are already granted on lines 15–16 and, unlike
    `mkdir`, were never scope-restricted to the app-specific directories in the
    first place, so they need no equivalent replacement.

[^os-plugin]: `@tauri-apps/plugin-os` is a new dependency for a single fact:
    which OS the app is running on, so the config folder can be cased to match.
    Weighed against not adding it — e.g. defaulting to `APP_NAME` uncased
    everywhere, the way `## Architecture Decisions` notes Electron apps
    (VS Code included) do on Linux — the dependency is close to free: `platform()`
    resolves synchronously with no `invoke` round trip (confirmed against the
    published package's own `dist-js/index.js`, `2.3.2`, which reads
    `window.__TAURI_OS_PLUGIN_INTERNALS__.platform` directly), needs no
    capability entry, and the plugin adds nothing else this plan would need to
    audit for unrelated surface area — unlike `tauri-plugin-store`, rejected in
    `[^storage]` for exactly that reason.

[^dual-scope]: Tauri capability files can be restricted to specific platforms
    via a top-level `"platforms"` array, which would let a `linux`-only file
    grant `$CONFIG/loom` and a `macOS`/`windows`-only file grant `$CONFIG/Loom`,
    each never seeing the casing it doesn't need. This plan does not introduce
    that split: `default.json` is currently the project's only capability file,
    applied uniformly, and splitting it is a structural change with its own
    consequences (every other permission in it would need sorting into shared
    vs. per-platform files) that nothing else in this plan needs. Granting both
    casings in the one file is redundant on any given platform — exactly one of
    the two is ever resolved and used at runtime — but redundant is not unsafe:
    an unused scope grant permits a directory the app never asks to touch,
    rather than one it does.

[^serializer]: `serializeLayout`/`restoreLayout` capture arrangement only, keyed by
    `Component.getId()`, and `restoreLayout` requires a `LayoutFactory` that
    synchronously returns the *same live component instance* for each id. On a cold
    start no instances exist: each `FileEditor` has to be built from an awaited disk
    read first. Even once they were built and added, the serializer would contribute
    only the split ratios and the tab order — it captures neither the file paths
    behind the tabs, nor the project root, nor tree expansion — while its restore
    path tears down and rebuilds the container tree, which is heavy machinery for a
    fixed two-pane shell. Loom writes its own snapshot and reuses the library's data
    shapes.

[^split-options]: `SplitOptions.paneSizes` and `SplitOptions.collapsedPanes` are
    held as `_pendingSizes`/`_pendingCollapsed` and drained on the first layout at
    which the panes are resolvable
    (`../typescript-ui/packages/lib/src/typescript/lib/layout/Split.ts:1471`).
    `getPaneSizes` deliberately reports an undrained pending array rather than the
    live one, so an autosave that fires before the first layout cannot overwrite the
    state being restored. Applying the sizes after the shell is mounted would instead
    paint the default split first and jump.

[^pane-sizes]: `Split` classifies a pane with an explicit `weight: 0` constraint as
    resize-pinned and persists it as `{ unit: "px" }`; every other pane persists as
    `{ unit: "ratio" }`. `EditorShell` adds the tree with `weight: 0` and the tabs
    with `weight: 1`, so a capture reads
    `[{ unit: "px", value: 300 }, { unit: "ratio", value: 1 }]` — the explorer keeps
    its exact width and the editor takes whatever is left, which is what a sidebar
    should do when the window is resized between runs. `getPaneRatios` would record
    the explorer as a fraction of the old window and widen or narrow it on restore.

[^expansion-order]: The alternative is to store the expanded set as a nested tree
    mirroring the directory structure, which would make the parent-first ordering
    implicit. A flat path list plus a sort is smaller on disk, trivially validated
    (an array of strings), and survives a directory being deleted without leaving an
    orphaned branch behind.

[^no-reveal]: `Tree.revealByPredicate` walks the tree depth-first and awaits every
    lazy branch's `loadChildren` on the way, stopping at the first match — so
    revealing one deep directory can read every directory that sorts before it,
    `node_modules` included. Replaying a known list of paths from the root needs no
    search: each step's parent was loaded by the previous step.

[^silent]: A dialog on launch would be the wrong trade for a feature whose whole
    point is that the user does not think about it: a folder the user moved
    deliberately would greet them with an error every time. The empty tree is itself
    the report. `EditorController.openFile`'s existing `Dialog.error` is kept for
    the case it was written for — a file the user explicitly clicked — which is why
    `restoreFiles` needs its own silent path rather than calling `openFile`.

[^one-close-listener]: Each `getCurrentWindow().onCloseRequested(handler)` call
    registers a listener that awaits its own handler and then calls
    `this.destroy()` itself unless that handler called `preventDefault`. Two
    registered handlers therefore race: a session-flush listener would destroy the
    window while the unsaved-changes dialog was still open. `EditorController`
    already owns the app's single registration, so the flush is chained inside it.

[^reorder]: `Tab._onBarReordered` re-sorts its internal `_contents` and schedules a
    layout without emitting any of the events `Tab` exposes
    (`../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts:1077`), so
    there is nothing for the autosave to subscribe to. Making the exit flush
    unconditional closes the gap without a library change; the residual exposure is
    a reorder followed by a kill that never reaches the close handler.
