---
depends-on: [session-persistence]
touches-shared: [src/main.ts, src/shell/EditorShell.ts, src/shell/session.ts, src/data/workspace.ts, src/data/paths.ts, src-tauri/capabilities/default.json]
---

# Per-Workspace Session Persistence — Implementation Plan

TODO.md's High-priority list asks for session state to be "save[d] to a
workspace settings file, distinct from the app-wide restart persistence" that
[`plans/session-persistence.md`](session-persistence.md) already designs. This
plan is that second, per-project file: a `.loom/workspace.json` written inside
each opened project folder, holding the state that only makes sense for that
one project — its expanded tree directories, its open tabs, and its split
geometry — while the app-wide `session.json` (`~/.config/loom/session.json`
on Linux) keeps only what doesn't belong to any one project: the last project
folder itself.

This plan builds directly on `session-persistence.md`'s finished design and
must be implemented after it.[^depends-on] It adds one new pure module,
`src/data/workspaceState.ts`, alongside the existing `src/data/session.ts`
(defined in [`session-persistence.md`](session-persistence.md)) and
[`src/data/paths.ts:1`](src/data/paths.ts#L1); extends
`src/data/workspace.ts` with two more file-IO functions; and wires the load
and save paths into `src/shell/session.ts`, `src/shell/EditorShell.ts`, and
`src/main.ts` — every file `session-persistence.md` itself already touches or
creates. `src/data/session.ts` and `SessionState`'s shape are not modified by
this plan.

---

## Architecture Decisions

### A `.loom/` folder inside the project root, mirroring `.vscode/`

The workspace state is stored as `workspace.json` inside a `.loom/` folder at
the top of the opened project — `<root>/.loom/workspace.json`. No file or
folder in this codebase already solves "per-project tool state," since Loom
has no prior feature that writes into the project folder itself; the
precedent is the general convention other editors use for exactly this
(`.vscode/`, `.idea/`), not any file in this repository.[^new-pattern] `.loom`
mirrors the app's own product name, `APP_NAME` in
[`src/appIdentity.ts:5`](src/appIdentity.ts#L5) — the same source
`session-persistence.md`'s `$CONFIG` folder name derives from — but always
lowercase, unconditionally, unlike that folder: a leading-dot project folder
follows the `.vscode`/`.idea` convention, which is always lowercase regardless
of platform, where `session-persistence.md`'s folder instead matches each
platform's own native app-data casing convention (lowercase on Linux,
`APP_NAME` as-is on macOS/Windows — its `## Architecture Decisions` and
`[^os-plugin]`).

### Tree expansion, open tabs, and split geometry are workspace-scoped; only the project root stays app-wide

`.loom/workspace.json` holds `expandedDirs`, `openFiles`, `activeFile`,
`paneSizes`, and `collapsedPanes` — every `SessionState` field except
`projectRoot`. `projectRoot` is the one field that has to stay app-wide: it is
what tells the app which project's `.loom/` folder to look inside in the first
place, so there is no workspace file to read it from until after it is already
known.

`paneSizes`/`collapsedPanes` moving to per-project is a reversal of this
plan's own first draft, which kept them app-wide on the reasoning that the
explorer's width is a preference about the user's monitor and reading habits,
constant regardless of which project is open.[^panesizes-workspace] Treating
split geometry as project-specific instead means a project with deeply nested
paths can be given a wider tree pane without changing the width every other
project opens at — the same tradeoff the first draft considered and set aside,
now taken the other way.

### A workspace file's `openFiles`/`activeFile` never point outside its own project

`src/data/paths.ts` gains `isUnderRoot(root, path)`. Both the write path
(`workspaceStateFromSession`) and the read path (`applyWorkspaceOverlay`) use
it to drop any path that is not inside the workspace's own root before it
reaches `.loom/workspace.json` or the live session.[^root-filter] Tree
expansion needs no such filter — `FileTree.getExpandedPaths()` only ever
returns nodes that are already in the tree, which are always under the
current root.

### An absent or unusable workspace file falls back to the app-wide session; a present, valid one replaces those five fields wholesale

`parseWorkspaceState` returns `null` — not an empty record — when `text`
isn't a usable workspace document at all (not JSON, not an object, wrong
`version`). This is a deliberate difference from `parseSession`, which never
returns `null` and instead degrades an unusable document to
`emptySession()`.[^parse-null] The distinction matters here because "no
override" (fall back to `session.json`'s own `expandedDirs`/`openFiles`/
`activeFile`/`paneSizes`/`collapsedPanes`) and "override with an empty
workspace" (a project that really had nothing open, at its default split) are
different outcomes, and only a three-way return can tell them apart. Once a
document does parse, all five of its fields replace the app-wide session's
copies together — there is no field-by-field merge between the two files.

| App session `projectRoot` | `.loom/workspace.json` | Effective `expandedDirs` / `openFiles` / `activeFile` / `paneSizes` / `collapsedPanes` |
|---|---|---|
| `null` | (no root to look under) | `session.json`'s own values |
| `/p` | absent | `session.json`'s own values |
| `/p` | `{` (invalid JSON) | `session.json`'s own values |
| `/p` | `{"version":2,...}` | `session.json`'s own values — version mismatch |
| `/p` | `{"version":1}` | all five become empty — a real "nothing was open, default split" save |
| `/p` | `{"version":1,"openFiles":["/p/a.ts","/q/b.ts"]}` | `openFiles: ["/p/a.ts"]` — `/q/b.ts` is outside `/p`; `paneSizes`/`collapsedPanes` are copied as given, unfiltered |

### Cold start restores everything together; a live folder switch restores only the tree

`main.ts` applies the full overlay above once, before the app's existing
restore pipeline runs, so `EditorShell.restoreSession` and `applySession`
need no changes for the cold-start path. Switching projects mid-session
through *Open Folder…* is different: `EditorShell.openProjectRoot`
(`session-persistence.md` step 14) now also loads the newly-chosen root's
`.loom/workspace.json` and expands its saved directories, but does not touch
the open tabs, active file, or split geometry.[^live-switch-scope] It also
flushes the outgoing project's own pending autosave before switching, so that project's
last change reaches its own `.loom/workspace.json` rather than being
overwritten mid-flight by the new root's state.[^flush-before-switch]

### `.loom/` is gitignored by default, not shared like `.vscode/settings.json`

The first time `writeWorkspaceStateText` creates a project's `.loom/` folder,
it also writes `.loom/.gitignore` containing `*`, so the folder — and
everything in it, including that `.gitignore` itself — never shows up as
untracked in the project's own `git status`, without editing the project's
own top-level `.gitignore`.[^gitignore-precedent] This is the opposite
default from `.vscode/settings.json`, which teams often commit: `openFiles`
and `expandedDirs` are absolute, machine-specific paths and change on nearly
every save, so they behave like transient UI state (closer to JetBrains'
`.idea/workspace.xml`, which the same tools gitignore) rather than shared
project preferences.

---

## Public API

### `src/data/paths.ts` (modified)

```ts
/** Whether `path` is `root` itself or lives anywhere under it, comparing path segments so `/p/src2` is not mistaken for being under `/p/src`. */
export function isUnderRoot(root: string, path: string): boolean
```

### `src/data/workspaceState.ts` (new — pure, no Tauri imports)

```ts
import type { LayoutSize } from '@jimka/typescript-ui/layout'
import type { SessionState } from './session'

/** One project's own saved state: the slice of `SessionState` that only makes sense for the project it was captured in — every field except `projectRoot`. */
export interface WorkspaceState {
  version: 1
  /** Absolute paths of the directories expanded in this project's tree. */
  expandedDirs: string[]
  /** Absolute paths of this project's open files, in tab order. */
  openFiles: string[]
  /** The active tab's file path, or `null`. */
  activeFile: string | null
  /** The `Split`'s pane sizes, in pane order (explorer first). */
  paneSizes: LayoutSize[]
  /** Indices of the collapsed panes. */
  collapsedPanes: number[]
}

/** A fresh, empty workspace state — what a project with no `.loom/workspace.json` yet gets once one is written. */
export function emptyWorkspaceState(): WorkspaceState

/** Parses `text` as a workspace state, degrading an unusable field to its empty default. Returns `null` when `text` is not a usable document at all — not JSON, not an object, or a `version` other than `1` — so the caller can fall back to the app-wide session instead of overlaying a blank record. */
export function parseWorkspaceState(text: string): WorkspaceState | null

/** Renders `state` as the JSON text written to `.loom/workspace.json`. */
export function serializeWorkspaceState(state: WorkspaceState): string

/** Extracts the workspace-scoped slice of `session` — `expandedDirs`/`openFiles`/`activeFile` filtered to `session.projectRoot`, plus `paneSizes`/`collapsedPanes` copied verbatim. Returns {@link emptyWorkspaceState} when `session.projectRoot` is `null`. */
export function workspaceStateFromSession(session: SessionState): WorkspaceState

/** Replaces `session`'s `expandedDirs`/`openFiles`/`activeFile`/`paneSizes`/`collapsedPanes` with `workspace`'s — the path fields filtered to `session.projectRoot`, the split fields copied verbatim. Returns `session` unchanged when `workspace` is `null` or `session.projectRoot` is `null`. */
export function applyWorkspaceOverlay(session: SessionState, workspace: WorkspaceState | null): SessionState
```

### `src/data/workspace.ts` (modified)

```ts
/** Reads `root`'s workspace state file's text, or `null` when it (or its `.loom` folder) is absent or unreadable. */
export async function readWorkspaceStateText(root: string): Promise<string | null>

/** Writes `text` to `root`'s workspace state file, creating its `.loom` folder — and a matching `.gitignore` inside it, the first time — if needed. */
export async function writeWorkspaceStateText(root: string, text: string): Promise<void>
```

### `src/shell/session.ts` (modified)

```ts
/** Reads and parses `root`'s workspace state file. */
export async function loadWorkspaceState(root: string): Promise<WorkspaceState | null>
```

`installSessionAutosave`'s exported shape (`SessionAutosave`, `schedule`,
`flush`) does not change; its internal write step gains a second file write,
covered in `## Internal Structure`.

---

## Internal Structure

### The workspace file

```json
{
  "version": 1,
  "expandedDirs": ["/home/jika/typescript/loom/src", "/home/jika/typescript/loom/src/data"],
  "openFiles": ["/home/jika/typescript/loom/src/main.ts", "/home/jika/typescript/loom/README.md"],
  "activeFile": "/home/jika/typescript/loom/README.md",
  "paneSizes": [{ "unit": "px", "value": 300 }, { "unit": "ratio", "value": 1 }],
  "collapsedPanes": []
}
```

### `filterToRoot` — the shared root filter

`workspaceStateFromSession` and `applyWorkspaceOverlay` both need "keep only
the paths under this root," so it is one private helper in
`src/data/workspaceState.ts`:

```ts
function filterToRoot(root: string, paths: string[], active: string | null): { paths: string[]; active: string | null } {
  return {
    paths: paths.filter(path => isUnderRoot(root, path)),
    active: active !== null && isUnderRoot(root, active) ? active : null,
  }
}
```

`workspaceStateFromSession` calls it with `session.projectRoot` (once
confirmed non-`null`), `session.openFiles`, `session.activeFile`, and copies
`session.paneSizes`/`session.collapsedPanes` straight across afterward — they
are not paths, so `filterToRoot` does not apply to them. `applyWorkspaceOverlay`
calls `filterToRoot` the same way, with `workspace.openFiles`/
`workspace.activeFile` in place of `session`'s, and likewise copies
`workspace.paneSizes`/`workspace.collapsedPanes` straight into the result.

### `installSessionAutosave`'s write step (`src/shell/session.ts`)

The write callback `session-persistence.md` step 12 builds gains an `if`
branch after its existing `writeSessionText` call:

```ts
const write = async (): Promise<void> => {
  try {
    const session = captureSession(targets)

    await writeSessionText(serializeSession(session))

    if (session.projectRoot !== null) {
      await writeWorkspaceStateText(session.projectRoot, serializeWorkspaceState(workspaceStateFromSession(session)))
    }
  } catch {
    // A failed session write must never interrupt editing.
  }
}
```

Both writes share the one `captureSession(targets)` call — `WorkspaceState`
is always derived from the `SessionState` just captured, never captured
separately.

### `EditorShell.openProjectRoot` (`src/shell/EditorShell.ts`)

```ts
private async openProjectRoot(root: string): Promise<void> {
  await this._autosave?.flush()
  await this._tree.setProjectRoot(root)

  const workspace = await loadWorkspaceState(root)

  if (workspace) {
    await this._tree.expandPaths(workspace.expandedDirs)
  }

  this._autosave?.schedule()
}
```

### `main.ts`'s `start()`

`session-persistence.md` step 16's `start()` gains the overlay between
loading the app-wide session and building the shell:

```ts
async function start(): Promise<void> {
  const appSession = await loadSession()
  const workspace = appSession.projectRoot !== null ? await loadWorkspaceState(appSession.projectRoot) : null
  const session = applyWorkspaceOverlay(appSession, workspace)
  const controller = new EditorController()
  const shell = EditorShell(controller, session)

  Body.getInstance().addComponent(shell)

  void shell.restoreSession(session)
}
```

---

## Ordered Implementation Steps

1. **`src/data/paths.ts`.** Add `isUnderRoot` from `## Public API`, splitting
   both `root` and `path` on `/[/\\]/` and filtering out empty segments (a
   leading separator produces one), then checking that every one of `root`'s
   segments equals `path`'s segment at the same index. Place it after
   `sortDirEntries` ([`src/data/paths.ts:64`](src/data/paths.ts#L64)).

2. **`tests/paths.test.ts`.** Add a `describe('isUnderRoot', ...)` block
   after `sortDirEntries`'s ([`tests/paths.test.ts:62`](tests/paths.test.ts#L62)),
   covering the cases in `## Expected Behaviour` → *Path containment*. Run
   `npm test` — must pass before continuing.

3. **`src/data/workspaceState.ts` (new).** Add `WorkspaceState`,
   `emptyWorkspaceState`, `parseWorkspaceState`, `serializeWorkspaceState`,
   the private `filterToRoot`, `workspaceStateFromSession`, and
   `applyWorkspaceOverlay`, exactly as given in `## Public API` and
   `## Internal Structure`. Import `isUnderRoot` from `./paths`, `SessionState`
   as a **type-only** import from `./session`, and `LayoutSize` as a
   **type-only** import from `@jimka/typescript-ui/layout` — this module must
   stay free of any runtime dependency, importing nothing that needs a DOM or
   a Tauri runtime, the same rule `session-persistence.md` step 1 applies to
   `src/data/session.ts`. `parseWorkspaceState` follows `parseSession`'s
   per-field degrade rule: an `expandedDirs`/`openFiles` entry that is absent
   or contains a non-string entry becomes `[]`; `activeFile` that is not a
   string becomes `null`; `paneSizes` that is absent or contains an entry
   whose `unit` is neither `"px"` nor `"ratio"` becomes `[]`, the identical
   rule `session-persistence.md`'s `## Internal Structure` documents for
   `SessionState.paneSizes`; `collapsedPanes` that is absent or contains a
   non-number entry becomes `[]`. `parseWorkspaceState` returns `null` outright
   when the top level isn't an object, isn't valid JSON, or `version !== 1`.
   `serializeWorkspaceState` uses `JSON.stringify(state, null, 2)`.

4. **`tests/workspaceState.test.ts` (new).** Write the unit tests listed
   under `## Expected Behaviour` → *Parsing, extraction, and overlay*,
   following `tests/paths.test.ts:1`'s one-`describe`-per-export shape. Run
   `npm test` — these fail until step 3's logic is right, and must pass
   before continuing.

5. **`src/data/workspace.ts`.** Add `readWorkspaceStateText` and
   `writeWorkspaceStateText`. Add `exists` to the existing
   `@tauri-apps/plugin-fs` import (which already has `mkdir` from
   `session-persistence.md` step 3). Add three module-level constants next to
   the existing `MAX_OPEN_BYTES` ([`src/data/workspace.ts:25`](src/data/workspace.ts#L25)):
   ```ts
   /** The per-project settings folder's name, mirroring the app's own product name (`APP_NAME`) the way `.vscode` reads as VS Code's. */
   const WORKSPACE_DIR_NAME = '.loom'

   /** The workspace state file's name inside {@link WORKSPACE_DIR_NAME}. */
   const WORKSPACE_STATE_FILE_NAME = 'workspace.json'

   /** Ignore-everything marker written into a project's `.loom` folder so it never appears as untracked in the project's own `git status`, without touching the project's own `.gitignore`. */
   const WORKSPACE_GITIGNORE_CONTENTS = '*\n'
   ```
   - `readWorkspaceStateText` wraps
     `readTextFile(joinPath(joinPath(root, WORKSPACE_DIR_NAME), WORKSPACE_STATE_FILE_NAME))`
     in a `try`/`catch` returning `null` on any throw — a project with no
     `.loom` folder yet is the common case, not an error.
   - `writeWorkspaceStateText` computes `const dir = joinPath(root, WORKSPACE_DIR_NAME)`,
     calls `await mkdir(dir, { recursive: true })`, then checks
     `await exists(joinPath(dir, '.gitignore'))` and writes
     `WORKSPACE_GITIGNORE_CONTENTS` there only when it does not already exist,
     then always writes `text` to `joinPath(dir, WORKSPACE_STATE_FILE_NAME)`.

6. **`src-tauri/capabilities/default.json`.** Add `"fs:allow-exists"` to the
   `permissions` array, after `"fs:allow-mkdir"` (`session-persistence.md`
   step 4 already adds that one, for the unrelated reason that `$CONFIG` needs
   an explicit `mkdir` grant — it covers `.loom/` too, since a command
   permission is not scope-specific). No further `fs:scope` change is needed
   here: `.loom/` sits inside a project root, already covered by the existing
   `$HOME/**` entry. The resulting `permissions` array:
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
     "fs:allow-exists",
     { "identifier": "fs:scope", "allow": [{ "path": "$HOME/**" }, { "path": "$CONFIG/loom" }, { "path": "$CONFIG/loom/*" }, { "path": "$CONFIG/Loom" }, { "path": "$CONFIG/Loom/*" }] }
   ]
   ```

7. **`src/shell/session.ts`.** Add `loadWorkspaceState`
   (`const text = await readWorkspaceStateText(root); return text === null ? null : parseWorkspaceState(text)`).
   Modify `installSessionAutosave`'s write step to the version in
   `## Internal Structure`. Import `readWorkspaceStateText`,
   `writeWorkspaceStateText` from `../data/workspace`;
   `WorkspaceState`, `parseWorkspaceState`, `serializeWorkspaceState`,
   `workspaceStateFromSession` from `../data/workspaceState`.

8. **`src/shell/EditorShell.ts`.** Replace `openProjectRoot`'s body
   (`session-persistence.md` step 14) with the version in
   `## Internal Structure`. Import `loadWorkspaceState` from `./session` —
   that file already exports `loadSession`, `applySession`,
   `installSessionAutosave`, and now also `loadWorkspaceState`, so this is
   one more name added to the existing import.

9. **`src/main.ts`.** Replace `start()`'s body (`session-persistence.md`
   step 16) with the version in `## Internal Structure`. Import
   `loadWorkspaceState` from `./shell/session` (alongside the existing
   `loadSession` import) and `applyWorkspaceOverlay` from
   `./data/workspaceState`.

10. **Checks.** `npm run typecheck` and `npm test` both clean.
    `grep -rn '@tauri-apps' src/ --include=*.ts` — expect matches only in
    `src/data/workspace.ts`, the same invariant `session-persistence.md`
    verifies.
    `grep -rn 'WorkspaceState' src/data/session.ts` — expect zero matches;
    `src/data/session.ts` stays unmodified by this plan.

11. **Docs.** Apply `## Documentation Impact`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `src/data/workspaceState.ts` |
| Create | `tests/workspaceState.test.ts` |
| Modify | `src/data/paths.ts` |
| Modify | `tests/paths.test.ts` |
| Modify | `src/data/workspace.ts` |
| Modify | `src/shell/session.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `src/main.ts` |
| Modify | `src-tauri/capabilities/default.json` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Path containment — unit-testable (`tests/paths.test.ts`)

- `isUnderRoot('/p', '/p/src/a.ts')` returns `true`.
- `isUnderRoot('/p', '/p')` returns `true` — the root itself counts as under itself.
- `isUnderRoot('/p', '/p2/a.ts')` returns `false` — a same-prefix sibling is not a match.
- `isUnderRoot('/p/src', '/p/src2/a.ts')` returns `false` — the same segment-boundary case, one level deeper.
- `isUnderRoot('C:\\p', 'C:\\p\\src\\a.ts')` returns `true` — backslash paths.

### Parsing, extraction, and overlay — unit-testable (`tests/workspaceState.test.ts`)

- `parseWorkspaceState('')` returns `null`.
- `parseWorkspaceState('not json')` returns `null`.
- `parseWorkspaceState('[]')` and `parseWorkspaceState('null')` return `null` — the top level must be an object.
- `parseWorkspaceState('{"version":2,"openFiles":["/p/a.ts"]}')` returns `null`.
- `parseWorkspaceState('{"version":1}')` returns `emptyWorkspaceState()`.
- `parseWorkspaceState('{"version":1,"openFiles":["/p/a.ts"]}')` returns that `openFiles` and empty defaults for the other fields.
- `parseWorkspaceState('{"version":1,"openFiles":["/p/a.ts",7]}')` returns `openFiles: []`.
- `parseWorkspaceState('{"version":1,"activeFile":5}')` returns `activeFile: null`.
- `parseWorkspaceState('{"version":1,"paneSizes":[{"unit":"em","value":3}]}')` returns `paneSizes: []` — the same invalid-unit rule as `parseSession`; `{"unit":"px","value":300}` is kept.
- `parseWorkspaceState('{"version":1,"collapsedPanes":[0,"1"]}')` returns `collapsedPanes: []`.
- `parseWorkspaceState('{"version":1,"futureField":true}')` ignores the unknown field.
- `parseWorkspaceState(serializeWorkspaceState(state))` deep-equals `state`, for a state with every field populated.
- `workspaceStateFromSession` of a session with `projectRoot: null` returns `emptyWorkspaceState()`.
- `workspaceStateFromSession` of a session with `projectRoot: '/p'`, `openFiles: ['/p/a.ts', '/q/b.ts']`, `activeFile: '/q/b.ts'` returns `openFiles: ['/p/a.ts']` and `activeFile: null` — the out-of-root file and the out-of-root active file are both dropped.
- `workspaceStateFromSession` of a session whose `activeFile` is inside `projectRoot` keeps it.
- `workspaceStateFromSession` of a session with `paneSizes: [{"unit":"px","value":420}]`, `collapsedPanes: [0]` returns both verbatim, regardless of `projectRoot`.
- `applyWorkspaceOverlay(session, null)` returns `session` unchanged.
- `applyWorkspaceOverlay(session, workspace)` with `session.projectRoot: null` returns `session` unchanged, even when `workspace` is non-`null`.
- `applyWorkspaceOverlay(session, workspace)` with a matching `projectRoot` returns `session` with `expandedDirs`/`openFiles`/`activeFile`/`paneSizes`/`collapsedPanes` replaced by `workspace`'s, and every other field (`version`, `projectRoot`) unchanged.
- `applyWorkspaceOverlay(session, workspace)` where `workspace.openFiles` contains a path outside `session.projectRoot` drops that path from the result — the same filter `workspaceStateFromSession` applies, now on the read side.
- `applyWorkspaceOverlay(session, workspace)` copies `workspace.paneSizes`/`workspace.collapsedPanes` into the result verbatim, with no root filtering.

### Session lifecycle — manual verification (`npm run tauri:dev`)

Builds on `session-persistence.md`'s own manual checklist, which this plan
does not repeat.

- **First open.** Open a folder with no `.loom/` folder, expand a directory,
  open two files, drag the split narrower, quit — a `.loom/workspace.json` now
  exists inside that folder, and `.loom/.gitignore` contains `*`; `git status`
  run inside that folder (if it is a git repository) does not list `.loom/`.
- **Round trip through a workspace file.** Relaunch with the same folder
  still the last-opened project — the same expanded directory, the same two
  tabs, and the same narrowed split come back, sourced from
  `.loom/workspace.json` rather than `session.json`.
- **Two projects, two workspace files.** Open project A, expand a directory,
  open a file, resize the split, then use *Open Folder…* to switch to project
  B — A's state is flushed to A's own `.loom/workspace.json` before the
  switch; B's tree shows B's own saved expanded directories (if
  `.loom/workspace.json` exists for B) instead of A's; B's previously-saved
  tabs and split width do **not** apply automatically — the tab strip and
  split stay exactly as A left them, untouched by the switch, until the app is
  relaunched with B as the last-opened project.
- **Deleted or corrupt workspace file.** Quit with tabs open, delete
  `.loom/workspace.json` by hand (or replace it with `{`), relaunch — the
  project's tree and tabs restore exactly as they did before per-workspace
  persistence existed, sourced from `session.json`'s own fallback copies.
- **Cross-project path in a workspace file.** Hand-edit
  `.loom/workspace.json` to add a path outside the project to `openFiles`,
  relaunch — that file does not open; the rest of `openFiles` still does.

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — `tests/workspaceState.test.ts` and the extended
  `tests/paths.test.ts` pass alongside the existing suites.
- `grep -rn '@tauri-apps' src/ --include=*.ts` — matches only in
  `src/data/workspace.ts`.
- `grep -rn 'WorkspaceState' src/data/session.ts` — zero matches.
- `npm run tauri:dev`, then the *Session lifecycle* checklist above. The
  files to inspect between runs are `~/.config/loom/session.json` (Linux;
  `~/Library/Application Support/Loom/session.json` on macOS,
  `%APPDATA%\Loom\session.json` on Windows) and
  `<project>/.loom/workspace.json`.

---

## Documentation Impact

- **`README.md`** — extend the session-restore Highlights bullet
  `session-persistence.md` adds, noting that tree expansion, open tabs, and
  split geometry travel with the project folder itself (in
  `.loom/workspace.json`) once one has been written, rather than only living
  in the app-wide file.
- **`TODO.md`** — remove the *Per-workspace session persistence* bullet from
  *High* (the two lines starting `- **Per-workspace session persistence**`).
  Leave the *Recent projects / recent files list* bullet in place — still a
  separate, unbuilt item.

---

## Potential Challenges

- **`.loom/` shows up unfiltered in the file tree.** Loom has no
  hidden-file/`.gitignore`-aware filtering yet (a separate TODO item), so the
  folder appears like any other. No mitigation planned here; it improves once
  that item lands.
- **A project root deleted after being successfully opened could have
  `.loom/` recreated by a later autosave.** `writeWorkspaceStateText`'s
  `mkdir(..., { recursive: true })` would recreate a missing `root` itself as
  an empty folder. This can only happen in the narrow window between a
  successful listing and the root being deleted, since `FileTree.getProjectRoot()`
  only reports a root once `setProjectRoot` has actually listed it
  successfully (`session-persistence.md` step 5) — the same silent,
  unreported-to-the-user degradation the rest of this feature already
  accepts.
- **`fs:allow-mkdir` and `fs:allow-exists` are unscoped commands.** `mkdir` is
  granted globally by `session-persistence.md` step 4 (for its own, unrelated
  reason — `$CONFIG/loom`/`$CONFIG/Loom` needs it, since neither is one of
  `fs:default`'s bundled app-specific directories); `exists` is added by this
  plan's step 6. Neither widens what the app can *reach* — every
  `mkdir`/`exists` call this plan or `session-persistence.md` makes still has
  to land inside one of `fs:scope`'s five allow entries (`$HOME/**`, or the
  four `$CONFIG/loom`/`$CONFIG/Loom` entries — `session-persistence.md`'s
  `[^dual-scope]` explains the two casings), the same boundary every other
  file command in this capability file already trusts.

---

## Critical Files

- [`plans/session-persistence.md`](session-persistence.md) — the app-wide
  persistence design this plan extends; its `## Public API` and numbered
  steps are the authoritative source for the exact shape of
  `src/data/session.ts`, `src/shell/session.ts`, `src/shell/EditorShell.ts`,
  and `src/main.ts` this plan's steps modify further.
- [`src/data/paths.ts:1`](src/data/paths.ts#L1) and
  [`tests/paths.test.ts:1`](tests/paths.test.ts#L1) — the precedent for a
  pure, import-free `src/data/` module with a matching vitest suite;
  `src/data/workspaceState.ts` and `tests/workspaceState.test.ts` follow the
  same shape.
- [`src/data/workspace.ts:1`](src/data/workspace.ts#L1) — the app's only
  `@tauri-apps/*` importer; `readWorkspaceStateText`/`writeWorkspaceStateText`
  join `readSessionText`/`writeSessionText` there.
- [`src-tauri/capabilities/default.json:1`](src-tauri/capabilities/default.json#L1) —
  today's permission set, extended in step 6.
- [`src/appIdentity.ts:5`](src/appIdentity.ts#L5) — `APP_NAME`, the product
  name `.loom` (this plan, always lowercase) and the `loom`/`Loom` folder
  under `$CONFIG` (`session-persistence.md`, cased per platform) both derive
  from.

---

## Non-Goals

- **Recent projects / recent files list.** Its own TODO.md item, unrelated
  to where a single project's own state lives.
- **Treating `.loom/workspace.json` as team-shared config**, the way
  `.vscode/settings.json` sometimes is. Gitignored by default instead — see
  `## Architecture Decisions`.
- **Restoring a switched-to project's open tabs, active file, or split
  geometry during a live *Open Folder…* switch.** Only tree expansion is
  restored live; tabs, active file, and split sizes restore only on app cold
  start.
- **Hidden-file/`.gitignore`-aware tree filtering**, which would keep `.loom/`
  itself out of the visible tree. Its own TODO.md item.
- **Multi-window or multi-instance write coordination for
  `.loom/workspace.json`.** Loom is single-window, the same assumption
  `session-persistence.md` makes for `session.json`.
- **Deleting or migrating a stale `.loom/` folder** when a project is
  renamed or removed.

---

## Notes

[^depends-on]: `src/data/session.ts`, `src/shell/session.ts`,
    `src/shell/EditorShell.ts`'s `openProjectRoot`, and `src/main.ts`'s
    `start()` do not exist in their needed shape until
    `plans/session-persistence.md` is implemented. This plan's steps modify
    those files as `session-persistence.md` leaves them, and cite that plan's
    step numbers rather than line numbers that do not exist yet.

[^new-pattern]: `.env`, `.gitignore`, and similar dotfiles the project already
    reads are the *user's* project files, read generically through
    `listDirectory`/`readFileText`; nothing in Loom today writes its own file
    into an opened project. `.vscode/` and `.idea/` are the closest
    real-world precedent for "an editor's own per-project state folder,"
    which is why this plan follows that shape rather than inventing a new
    one.

[^panesizes-workspace]: An earlier draft of this plan kept `paneSizes`/
    `collapsedPanes` app-wide, on the reasoning that the explorer's width is a
    preference about the user's monitor and reading habits, constant
    regardless of which project is open. This draft takes the opposite call:
    a project with deeply nested paths can be given a wider tree pane without
    changing the width every other project opens at, at the cost of the split
    no longer having one constant width across every project. Either way,
    `EditorShell`'s `Split` construction
    (`session-persistence.md` step 13, `new Split({ paneSizes: session.paneSizes, ... })`)
    needs no code change: it already reads `paneSizes`/`collapsedPanes` off
    the `SessionState` it's handed, and `main.ts`'s `start()` (`## Internal
    Structure`) now folds the workspace's own copies into that `SessionState`
    via `applyWorkspaceOverlay` before `EditorShell` is ever constructed — the
    `session: SessionState` parameter keeps meaning exactly what it means
    today; only what has already been written into it, upstream, changed.

[^root-filter]: Without this filter, a project whose tabs happened to include
    a file from a different, previously-open project (left open across an
    *Open Folder…* switch — see the "cold start vs. live switch" decision
    above) would write that unrelated absolute path into the new project's
    own `.loom/workspace.json`, which is the one thing a per-project file
    must not do if it is ever inspected or shared. Filtering on both the
    write side (`workspaceStateFromSession`) and the read side
    (`applyWorkspaceOverlay`) means the same guarantee holds even for a
    `.loom/workspace.json` that was hand-edited or merged in from a
    different machine's checkout.

[^parse-null]: `parseSession` never needs a `null` return because there is
    nothing to fall back to below the app-wide session — an unusable
    `session.json` simply means "no memory of anything," which
    `emptySession()` already represents correctly. A `.loom/workspace.json`
    that fails to parse is different: without a `null` result, the caller
    could not tell "this project genuinely has nothing saved" (a real,
    intentional empty workspace) apart from "this file could not be read at
    all" (which should leave `session.json`'s own values in place instead of
    erasing them).

[^live-switch-scope]: Reopening a different project's saved tabs on top of
    whatever the user already has open — mid-session, with no warning — risks
    clashing with unsaved work and surprising the user with tabs they did not
    ask for. Resizing the split out from under a user who may be actively
    reading or editing in the pane that just changed size is the same kind of
    surprise, just visual rather than structural — and, unlike tree expansion,
    it also needs `Split.applyPaneSizes` rather than the constructor options
    (`session-persistence.md`'s `[^split-options]`), a live-apply path this
    plan does not otherwise need and so does not add. Restoring tree expansion
    carries no such risk: it only changes which folders are shown open in a
    tree that was just rebuilt from scratch by `setProjectRoot`.

[^flush-before-switch]: Without the flush, a change made to project A
    immediately before switching to project B could still be sitting in the
    500 ms debounce window when `openProjectRoot` reads `session.projectRoot`
    for the write step — by the time the timer fires, `captureSession` would
    already see the new root B, and that pending change to A would never
    reach A's own `.loom/workspace.json`. Flushing first empties the timer
    and writes A's state under A's own root before the switch happens.

[^gitignore-precedent]: JetBrains IDEs write `.idea/.gitignore` for the same
    reason: a project-local ignore file that keeps an editor's own working
    state out of `git status` without requiring the user to edit their
    project's own `.gitignore` by hand. A `.gitignore` file's rules apply
    whether or not the `.gitignore` file itself is tracked, so `*` also
    correctly hides itself.

---

## Implementation Notes

Every unit-testable behaviour in `## Expected Behaviour` — *Path
containment* and *Parsing, extraction, and overlay* — is covered by a test
written before its implementation; all 28 new/updated cases pass alongside
the existing suite (72 total).

This sandboxed session has no `xdotool`/`scrot`/`maim`/`gnome-screenshot`
(or equivalent) to drive the app's window or capture it, and no
passwordless `sudo` to install any — unlike `session-persistence.md`'s own
verification pass, which had a human at the screen. The mouse/keyboard
*Session lifecycle* checklist (folder picker clicks, tab drag, live
mid-session interaction) therefore could not be walked by hand and should
still be, by a human or a session with GUI-automation tooling, before this
is relied on for anything beyond what is verified below.

In place of that, two rounds of a real `npm run tauri:dev` (reusing the
main worktree's Cargo build cache) were used to verify the actual Tauri
file-I/O this plan adds, without needing mouse/keyboard interaction:

- **Round 1 (compile + boot smoke test).** The Rust side compiled clean and
  the app launched under the sandbox's software-rendered WebKitGTK exactly
  as `session-persistence.md`'s own Implementation Notes describe (WSL2, X
  forwarded to a Windows host, no window manager) — no exception or
  rejected promise surfaced. This round is what an independent audit
  correctly flagged as insufficient: a silently-swallowed `PathForbidden`
  from a missing capability grant would look identical to success here,
  and one was in fact present (below).
- **Round 2 (instrumented, targeted).** After the audit below found a real
  capability-scope bug, `src/data/workspace.ts`'s two new functions were
  temporarily instrumented to write their outcome to a debug file under
  `$HOME` (an already-granted, uncontested scope), and `src/main.ts` was
  temporarily given one direct `writeWorkspaceStateText` call — both purely
  to observe the real IPC result without a GUI. A scratch project folder
  under `$HOME` was seeded with its own `.loom/workspace.json`, `session.json`
  was pointed at it, and the app was launched for real. The debug file
  showed `WRITE-OK`; `.loom/workspace.json` and `.loom/.gitignore` were both
  present on disk afterward with real content, confirming `mkdir`, `exists`,
  and `writeTextFile` all resolved against the fixed `fs:scope` grant with no
  `PathForbidden`. This also incidentally exercised the *real*
  `installSessionAutosave` write path end to end for the ordinary
  (non-switch) case. The instrumentation and scratch files were then
  reverted/deleted — none of it is part of the shipped diff.

**Findings from the independent audit, and how they were addressed:**

1. **BLOCKING — `$HOME/**` does not reach `.loom/`.** Tauri's fs scope
   defaults `require_literal_leading_dot` to `true` on Linux/macOS (dotfiles
   are not exposed by a wildcard unless a pattern spells them out literally
   — confirmed by reading `tauri-2.11.5/src/scope/fs.rs` and
   `tauri-plugin-fs-2.5.1`, and reproduced directly against the exact `glob
   0.3.4` crate Tauri itself uses: `$HOME/**` matches
   `$HOME/proj/src/main.ts` but not `$HOME/proj/.loom/workspace.json`).
   `readWorkspaceStateText`/`writeWorkspaceStateText` therefore threw
   `PathForbidden` on every call, silently swallowed by their own
   try/catch, so the whole feature was a silent no-op — exactly the failure
   mode Round 1's boot-only smoke test could not have caught.
   `src-tauri/capabilities/default.json`'s `fs:scope` gained three more
   entries mirroring the literal-dot handling `session-persistence.md`
   already uses for `$CONFIG/loom`: `$HOME/**/.loom` (the directory itself,
   for `mkdir`), `$HOME/**/.loom/*` (`workspace.json`), and
   `$HOME/**/.loom/.gitignore` (the dot-prefixed ignore file needs its own
   entry — `*` doesn't match a leading dot either, confirmed with the same
   `glob` crate test). Verified against the real crate sources rather than
   assumed, and confirmed working end to end by Round 2 above.
2. **BLOCKING — a live *Open Folder…* switch could clobber the newly-opened
   project's own workspace file.** Restoring the new root's saved tree
   expansion inside `EditorShell.openProjectRoot` fires the tree's
   `"expand"` events `installSessionAutosave` already listens on — even
   without the method's own explicit `schedule()` call — so a debounced
   write could fire while `SessionTargets` still held the *previous*
   project's open tabs and pane sizes (deliberately left untouched by a
   live switch, per `## Non-Goals`). `workspaceStateFromSession` would then
   filter those foreign tabs down to `openFiles: []`/`activeFile: null` and
   copy the previous project's `paneSizes` verbatim, and write that into the
   *new* root's `.loom/workspace.json` — silently destroying whatever real
   state that project had already saved. Fixed with a small guard in
   `src/shell/session.ts`'s `writeSnapshot`: the per-project write is now
   skipped whenever any live open file sits outside the current
   `projectRoot` (`openFilesBelongToRoot`, using the same `isUnderRoot` this
   plan already added). This is deliberately not a suppression flag on
   `SessionAutosave` — `session-persistence.md`'s own `restoreSession` doc
   comment rules that out for its own restore path ("there is no
   suppression flag anywhere in this design, and none should be added"),
   and `SessionAutosave`'s exported shape is unchanged here too. The
   app-wide `session.json` write is unaffected by the guard — it has no
   analogous per-project ownership question, so it keeps writing on every
   schedule/flush exactly as `session-persistence.md` designed it. One
   residual, accepted imprecision: once the guard clears (the user closes
   every leftover foreign tab, or opens a file under the new root),
   `paneSizes` may still reflect whatever the split honestly looks like at
   that moment, which can still be the previous project's leftover width —
   this is the same live-switch/pane-size tension `## Architecture
   Decisions` already accepts (split geometry doesn't restore live), not
   new destructive behaviour.
3. **The manual-verify checklist gap itself** — judged by the audit as
   honestly documented but insufficient on its own, since it is the only
   coverage of the mechanism the two findings above were hiding in. Round 2
   above is the direct response: real Tauri IPC calls, under the real fixed
   capability grant, with real file-system evidence, rather than a
   boot-only smoke test. The mouse/keyboard checklist itself remains
   unwalked for the reason given at the top of this section.
