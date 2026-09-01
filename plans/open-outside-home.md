# Opening Folders Outside `$HOME` — Implementation Plan

## Overview

Loom can only browse a project folder one level deep when that folder sits
outside `$HOME`. The native folder picker in
[`src/data/workspace.ts:33`](src/data/workspace.ts#L33) already causes Tauri to
grant the app runtime access to whatever folder the user chose — but only to
that folder and its immediate children, because the picker is called without
the `recursive` option. Anything nested deeper is refused.

This plan passes `recursive: true` to the picker, which extends the grant to
the whole subtree. It also surfaces a failed folder listing to the user:
[`src/shell/EditorShell.ts:62`](src/shell/EditorShell.ts#L62) discards the
promise `FileTree.setProjectRoot` returns, so a folder Loom cannot read today
leaves an empty tree and no message.

Three frontend files change: [`src/data/workspace.ts`](src/data/workspace.ts),
[`src/EditorController.ts`](src/EditorController.ts), and
[`src/shell/EditorShell.ts`](src/shell/EditorShell.ts). No Rust changes, and
the capability file
[`src-tauri/capabilities/default.json`](src-tauri/capabilities/default.json)
is left alone.

---

## Architecture Decisions

### Widen the picker's grant, not the static capability scope

`pickProjectFolder` passes `recursive: true` to the dialog plugin's `open`.
Tauri grants filesystem access to the picked folder and everything under it,
at runtime, for that folder only. The `fs:scope` entry in
`src-tauri/capabilities/default.json` is not touched.[^runtime-scope]

The app's convention is that every `@tauri-apps` detail lives in
`src/data/workspace.ts` — its header comment at
[`src/data/workspace.ts:1`](src/data/workspace.ts#L1) states the module is the
app's only importer of those packages. A picker option keeps this change
inside that boundary.[^no-repo-precedent]

### Keep the `$HOME/**` capability grant

The static grant at
[`src-tauri/capabilities/default.json:19`](src-tauri/capabilities/default.json#L19)
stays exactly as it is.[^keep-home]

### Report a failed folder listing from `EditorController`

`EditorController.setProjectRootListener` takes a listener returning
`Promise<void>` instead of `void`, and `openProjectFolder` awaits it inside a
`try`/`catch` that shows `Dialog.error`. This mirrors
[`src/EditorController.ts:102`](src/EditorController.ts#L102), where a failed
file read is caught and reported the same way.[^error-seam]

---

## How the grant decides each path

When the user picks `/opt/project`, Tauri registers two glob patterns. The
`recursive` flag chooses the second pattern:

| `recursive` | Patterns registered |
|---|---|
| `false` (today) | `/opt/project`, `/opt/project/*` |
| `true` (this plan) | `/opt/project`, `/opt/project/**` |

A single `*` never matches across a `/`, so it covers immediate children only.
`**` matches any depth. Neither wildcard matches a path component starting
with `.`.

| Path the app asks for | Today | After |
|---|---|---|
| `/opt/project` (list the root) | allowed | allowed |
| `/opt/project/README.md` (open) | allowed | allowed |
| `/opt/project/src` (expand) | allowed | allowed |
| `/opt/project/src/main.ts` (open) | **refused** | allowed |
| `/opt/project/.gitignore` (open) | refused | refused — see `## Non-Goals` |

---

## Public API

```ts
/** src/data/workspace.ts — signature unchanged; the dialog options change. */
export async function pickProjectFolder(): Promise<string | null>
```

```ts
/** src/EditorController.ts — the listener now returns a promise the caller awaits. */
setProjectRootListener(fn: (root: string) => Promise<void>): void
```

The backing field changes to match:

```ts
private _projectRootListener: ((root: string) => Promise<void>) | null = null
```

---

## Ordered Implementation Steps

1. **`src/data/workspace.ts`** — in `pickProjectFolder` (line 33), change the
   dialog call to:

   ```ts
   return open({ directory: true, multiple: false, recursive: true })
   ```

   Add a sentence to the function's JSDoc recording why: `recursive: true`
   makes Tauri grant filesystem access to the whole subtree under the chosen
   folder rather than its immediate children only, which is what lets a folder
   outside `$HOME` be browsed to any depth.

2. **`src/EditorController.ts`** — change the field at line 36 to
   `private _projectRootListener: ((root: string) => Promise<void>) | null = null`,
   and the parameter type at line 60 to `fn: (root: string) => Promise<void>`.
   Update the `@param` line in `setProjectRootListener`'s JSDoc to say the
   listener resolves once the tree has loaded the folder.

3. **`src/EditorController.ts`** — replace `openProjectFolder` and its JSDoc
   (lines 74–81) so the listener is awaited and a failure is reported:

   ```ts
   /**
    * Shows the native folder picker and points the tree at the chosen folder.
    * A folder the app cannot list shows a `Dialog.error` and leaves the tree
    * as it was.
    */
   async openProjectFolder(): Promise<void> {
     const root = await pickProjectFolder()

     if (root === null) {
       return
     }

     try {
       await this._projectRootListener?.(root)
     } catch (error) {
       await Dialog.error('Could not open folder', messageOf(error))
     }
   }
   ```

   `Dialog.error` and `messageOf` are already imported and defined in this file
   (lines 4 and 14) — add no imports.

4. **`src/shell/EditorShell.ts`** — at line 62, return the promise instead of
   discarding it:

   ```ts
   controller.setProjectRootListener(root => tree.setProjectRoot(root))
   ```

5. **Check the seam is closed.** `grep -rn 'setProjectRootListener' src/` —
   expect exactly three hits: a `{@link}` reference in `EditorController`'s
   class JSDoc, the method declaration in `EditorController`, and the single
   call site in `EditorShell`. Any further call site needs the same
   promise-returning treatment.

6. **`npm run typecheck`** — expect no errors. A `void`-returning listener left
   anywhere fails here.

7. **`npm test`** — expect the existing suite green and unchanged; no test
   covers the touched files.

8. **`TODO.md`** — delete the `Opening folders outside $HOME` bullet (lines
   18–19). In its place in the *High* section, add a bullet recording the
   limitation this change leaves behind:

   ```markdown
   - **Opening dotfiles** — a path component starting with `.` is never matched
     by the `**` wildcard in either the `fs:scope` capability grant or the
     runtime grant the folder picker makes, so `.gitignore`, `.eslintrc.json`
     and anything under `.github/` cannot be opened even though the tree lists
     them. The `plugins.fs.requireLiteralLeadingDot` setting in
     `src-tauri/tauri.conf.json` only relaxes the capability grant, not the
     picker's, so a fix has to cover both.
   ```

9. **Run the manual checks** in `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src/data/workspace.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `TODO.md` |

---

## Expected Behaviour

Every case below needs manual verification under `npm run tauri:dev`. None is
unit-testable: `src/data/workspace.ts` is the app's Tauri boundary and carries
no logic of its own to test — its header comment at
[`src/data/workspace.ts:1`](src/data/workspace.ts#L1) says so — and the grant
being exercised only exists inside a running Tauri process.

1. **A folder outside `$HOME` opens to full depth.** Pick `/opt/<something>`
   (or any readable directory outside the home directory). The tree lists the
   root; expanding two or more levels lists each subdirectory; opening a file
   nested two or more levels down shows its contents in a tab.
2. **A folder inside `$HOME` still opens to full depth.** Unchanged from today.
3. **Cancelling the picker does nothing.** No dialog, no tree change.
4. **An unreadable folder reports itself.** Pick a directory the user cannot
   read — `/root` on Linux when not running as root, or a scratch directory
   set to `chmod 000`. A `Could not open folder` error dialog appears with the
   underlying message, and the tree is left as it was rather than silently
   emptied.
5. **Save still works inside a folder opened from outside `$HOME`.** Edit a
   nested file, `Ctrl+S`, confirm the `Saved <name>` status message and that
   the file on disk changed.
6. **Save As to a path outside the opened folder still works.** With a file
   open, `Ctrl+Shift+S` to a directory unrelated to the project root; the write
   succeeds and the tab retargets to the new path.
7. **A dotfile still refuses to open.** Click `.gitignore` in the tree of an
   opened project. A `Could not open file` dialog appears. This is the
   pre-existing limitation recorded in `TODO.md` by step 8, unchanged by this
   plan.

---

## Verification

- `npm run typecheck` — no errors.
- `npm test` — the existing suite passes; no new tests.
- `grep -n 'recursive: true' src/data/workspace.ts` — expect exactly one hit,
  the picker call.
- `git diff src-tauri/` — expect empty. No Rust or capability change belongs to
  this plan.
- `npm run tauri:dev`, then work through cases 1–7 of `## Expected Behaviour`
  via *File → Open Folder…* in the menu bar.

---

## Potential Challenges

- **A picked path that goes through a symbolic link is still refused.** Tauri
  registers the grant under the path the picker returned, but resolves every
  later request to its real location before matching. Picking `/tmp/x` on macOS
  (where `/tmp` links to `/private/tmp`) therefore grants `/tmp/x/**` and then
  asks whether `/private/tmp/x/src/main.ts` matches that pattern. It does not.
  Mitigation: none in this plan — case 4's error dialog at least makes the
  refusal visible instead of silent. Pick the real path.
- **The grant is in-memory and lost on restart.** Nothing persists it, so a
  folder outside `$HOME` must be re-picked each launch. The loss is invisible
  today because Loom reopens nothing on start, and becomes visible if session
  persistence lands, which will have to re-grant on restore.
- **Loom's own data directory stays blocked.** Tauri's default filesystem
  permissions deny the webview-data folder, and a denial outranks any grant,
  a picker's included. Picking `~/.local/share/com.jimka.loom` therefore still
  fails — correctly.
- **`FileTree` keeps whatever it was showing when a listing fails.**
  `setProjectRoot` only calls `setNodes` after `listDirectory` resolves, so a
  rejection leaves the previous project's nodes on screen behind the error
  dialog. Case 4 pins that as the intended outcome; do not add a "clear the
  tree first" step, which would replace one confusing state with another.

---

## Critical Files

- [`src/data/workspace.ts:27-35`](src/data/workspace.ts#L27) — `pickProjectFolder`,
  the one line that changes behaviour. Its header comment (lines 1–5) states
  the module's role as the sole `@tauri-apps` importer and why it is untested.
- [`src/EditorController.ts:91-116`](src/EditorController.ts#L91) — `openFile`,
  the `try`/`catch` + `Dialog.error` shape that *Report a failed folder listing
  from `EditorController`* copies.
- [`src/EditorController.ts:54-81`](src/EditorController.ts#L54) —
  `setProjectRootListener` and `openProjectFolder`, both edited.
- [`src/shell/EditorShell.ts:62`](src/shell/EditorShell.ts#L62) — the only
  caller of `setProjectRootListener`.
- [`src/explorer/FileTree.ts:53-65`](src/explorer/FileTree.ts#L53) —
  `setProjectRoot` and `loadInto`; read to confirm `setProjectRoot` rejects
  rather than swallowing a listing failure.
- [`src-tauri/capabilities/default.json`](src-tauri/capabilities/default.json) —
  read to confirm the grant this plan deliberately leaves alone.

---

## Non-Goals

- **Widening `fs:scope` to the whole filesystem.** A static grant of `/**`
  would give the webview standing access to every file on the machine whether
  or not the user ever picked it. The picker grant achieves the same reach with
  a user gesture behind it.
- **Making dotfiles openable.** Tauri's runtime grant hard-codes the rule that
  `**` skips components starting with `.`, and the
  `plugins.fs.requireLiteralLeadingDot` setting reaches only the capability
  grant. Fixing one and not the other would make `~/p/.gitignore` open while
  `/opt/p/.gitignore` stays refused, which is worse than the consistent refusal
  today. Recorded as its own backlog item by step 8.
- **Reporting a failed subdirectory expansion.** Only the root listing gets an
  error dialog. A failure inside `FileTree.loadInto` is handled by the library's
  `Tree.loadChildren` contract, which this plan does not investigate or change.
- **Persisting the grant across restarts.** That belongs to the *Session
  persistence across restarts* backlog item, which has no plan yet.
- **Any Rust or capability-file change.** The whole feature is reachable from
  the frontend.

---

## Notes

[^runtime-scope]: Tauri v2 checks two scopes and allows a path if **either**
    one permits it. `resolve_path` in `tauri-plugin-fs` 2.5.1
    (`src/commands.rs:1485`) ends with
    `if fs_scope.scope.is_allowed(&resolved_path) || scope.is_allowed(&resolved_path)`,
    where `fs_scope.scope` is the runtime scope and `scope` is rebuilt per call
    from the capability file's `fs:scope` entries. Because the two are OR'd, a
    runtime grant is sufficient on its own and the static `$HOME/**` grant does
    not gate it. `tauri-plugin-dialog` 2.7.2 already makes that runtime grant:
    its `open` command calls `s.allow_directory(&path, options.recursive)` on
    the picked folder (`src/commands.rs:163` and `:177`), and `recursive`
    deserialises with `#[serde(default)]`, so omitting it from the JS call
    passes `false`. `Scope::allow_directory` in `tauri` 2.11.5
    (`src/scope/fs.rs:351`) then registers the directory itself plus either
    `<dir>/*` or `<dir>/**`. Tauri's own test at `src/scope/fs.rs:572` asserts
    that `allow_directory("/home/tauri", true)` allows
    `/home/tauri/inner/folder/anyfile`. The same plugin uses the same mechanism
    for native drag-and-drop (`tauri-plugin-fs/src/lib.rs:517`), which is the
    upstream precedent for treating a user gesture as the trigger for a grant.

[^no-repo-precedent]: There is no prior art in this repository for filesystem
    scope handling — `src-tauri/capabilities/default.json` is the only place
    Tauri permissions appear, `src-tauri/src/lib.rs` registers plugins with
    default settings and adds no commands, and nothing else calls into a Tauri
    scope. So no in-repo pattern could be followed for the grant itself. The
    pattern that does apply is architectural: `src/data/workspace.ts` is the app's
    single `@tauri-apps` importer, and a dialog option keeps every Tauri-specific
    detail inside it. Two alternative shapes were considered, and both break
    that boundary: a custom Rust
    command calling `FsExt::fs_scope()` would add an IPC surface and a second
    place that knows about scopes, for behaviour the dialog plugin already
    provides; and editing the capability file would push the decision out of the
    code path that makes it.

[^keep-home]: Removing `$HOME/**` looks like a least-privilege win — after this
    change no app flow needs it, since every path the app touches comes from the
    picker or from a listing beneath a picked folder. It was rejected because it
    would regress a case the blanket pattern currently rescues. Tauri fully
    resolves symbolic links before matching a path against the grant
    (`try_resolve_symlink_and_canonicalize`, `tauri` 2.11.5
    `src/scope/fs.rs:471`). A project at `~/projects/app` where `projects` links
    to `~/code/projects` resolves to `~/code/projects/app/...`, which the picker
    grant on `~/projects` does not match but `$HOME/**` does. Tightening the
    static grant is a separate change with its own risk, and it is not needed to
    open folders outside `$HOME`.

[^error-seam]: Three seams could catch the failure: inside
    `FileTree.setProjectRoot`, inside the arrow function in `EditorShell`, or in
    `EditorController.openProjectFolder`. `EditorController` wins because every
    error dialog in the app is already raised there — `messageOf` is defined in
    that file and used by `openFile`, `saveAs`, and `save`. Catching in
    `FileTree` would put user-facing dialogs into a presentation component that
    currently has none; catching in `EditorShell` would put logic into a file
    that is otherwise pure composition. The cost is turning the listener into a
    promise-returning function, which is one type change and one call site.
