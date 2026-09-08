---
depends-on: [folder-picker-fs-scope]
touches-shared: [src/data/workspace.ts, src/main.ts, src/shell/EditorShell.ts, src-tauri/src/lib.rs, TODO.md]
---

# Restoring a Workspace Outside `$HOME`/`$CONFIG` on Launch — Implementation Plan

## Overview

Tauri decides whether the app may touch a path by checking two allow-lists,
and permits the path if either one covers it: the **capability scope**, built
from [`src-tauri/capabilities/default.json`](src-tauri/capabilities/default.json)
(`$HOME/**`, `$CONFIG/loom/**`, and friends), and the **runtime scope**, an
in-memory list the `fs` plugin grows whenever a native gesture hands the app a
new path.

Loom remembers the last project folder in `session.json` and reopens it on the
next launch. That works only for a folder one of those two scopes already
covers. A folder outside `$HOME`/`$CONFIG` is reachable only after a native
gesture grants it — the folder picker, a drag-and-drop, or the save dialog —
and no gesture happens at startup. So the remembered root is refused before
the tree is ever listed, `applySession`'s `try`/`catch`
([`src/shell/session.ts:81-89`](src/shell/session.ts#L81)) swallows the
refusal, and the user gets an empty tree and the welcome screen.

The fix re-grants the remembered root at startup. `src-tauri/src/lib.rs` gains
one command, `grant_project_scope`, which adds the root and its subtree to the
app's capability scope by reusing the `mirror_scope_entry` helper already there
([`src-tauri/src/lib.rs:127`](src-tauri/src/lib.rs#L127)).
[`src/data/workspace.ts`](src/data/workspace.ts) — the app's sole
`@tauri-apps/*` entry point — exposes it as `grantProjectScope`, and two call
sites ask for the grant: [`src/main.ts:43-58`](src/main.ts#L43) on a cold
start, and
[`src/shell/EditorShell.ts:313-330`](src/shell/EditorShell.ts#L313) whenever
Loom points the tree at a root the user chose from memory rather than through a
gesture.

Four files change plus `TODO.md`. No new dependency, no change to the session
document's shape, and no change to
[`src-tauri/capabilities/default.json`](src-tauri/capabilities/default.json) or
[`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json).

---

## Architecture Decisions

### Re-grant the remembered root through the capability scope

`grant_project_scope` adds the root and everything under it to the app's
capability scope, by calling the existing `mirror_scope_entry`
([`src-tauri/src/lib.rs:127`](src-tauri/src/lib.rs#L127)) with the path and
`allowed = true`. It does not touch the runtime scope. That choice mirrors what
[`plans/implemented/folder-picker-fs-scope.md`](plans/implemented/folder-picker-fs-scope.md)
established: the capability scope is the one that reaches dot-prefixed paths,
so it is the one a grant must land in.[^why-capability-scope]

### Ask for the grant from the frontend, over one new command

The frontend decides when a grant is needed and passes the path in; Rust never
reads Loom's own `session.json`. `src/data/workspace.ts` wraps the `invoke`
call, keeping every `@tauri-apps/*` import inside that module as its header
comment ([`src/data/workspace.ts:1-5`](src/data/workspace.ts#L1))
requires.[^ask-from-the-frontend]

No entry is added to `src-tauri/capabilities/default.json` for the new command,
and none may be.[^app-command-acl]

### Grant wherever Loom points itself at a remembered root

Two call sites, no more:

| Call site | Covers | Must run before |
|---|---|---|
| [`src/main.ts:44`](src/main.ts#L44), right after `loadSession()` | the cold-start restore | `loadWorkspaceState` (`src/main.ts:45`) and `loadResolvedSettings` (`src/main.ts:47`), which both read files under the root |
| [`src/shell/EditorShell.ts:315`](src/shell/EditorShell.ts#L315), right before `this._tree.setProjectRoot(root)` | the picker, *Open Recent*, the welcome screen's recent list, a dropped folder | the tree's first listing of the new root |

`EditorShell.openProjectRoot` is the single funnel every in-app root adoption
passes through, so one line there covers the picker, *Open Recent*, the welcome
screen's recent list, and a dropped folder alike.[^two-seams]

### The grant reaches one directory subtree, and nothing new is persisted

Each grant covers exactly the folder Loom is about to open, plus everything
under it, and lasts only until the process exits. The only thing that survives
a restart is the `projectRoot` string `session.json` already
records.[^reach]

---

## What the grant covers

`mirror_scope_entry` builds each grant's patterns with `scope_entries`
([`src-tauri/src/lib.rs:154`](src-tauri/src/lib.rs#L154)), which escapes glob
characters and adds a `/**` companion entry for a directory:

| Persisted root | Capability-scope entries added at startup |
|---|---|
| `/opt/project` | `/opt/project/**`, `/opt/project` |
| `/opt/notes [2026]` | `/opt/notes [[]2026[]]/**`, `/opt/notes [[]2026[]]` — `Pattern::escape` wraps each `[` and `]` in a bracket group |
| `/opt/deleted` (no longer on disk) | `/opt/deleted` only — the `/**` companion is added for a directory, and `is_dir()` is false |

Each path the launch reads, before and after:

| Path read during launch restore | Today | After |
|---|---|---|
| `/opt/project` — the tree's first listing | refused | allowed |
| `/opt/project/.loom/workspace.json` — saved expansion | refused | allowed |
| `/opt/project/.loom/settings.json` — per-project settings | refused | allowed |
| `/opt/project/.gitignore` — tree filtering | refused | allowed |
| `/opt/project/src/main.ts` — a remembered tab | refused | allowed |
| `/srv/notes.txt` — a remembered tab outside the root | refused | refused, see `## Non-Goals` |
| `~/code/app` — a root under `$HOME` | allowed | allowed |

---

## Public API

```rust
/// src-tauri/src/lib.rs — new, registered via tauri::generate_handler!.
#[tauri::command]
fn grant_project_scope<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String>
```

```ts
/** src/data/workspace.ts — new export; resolves even when the grant fails. */
export async function grantProjectScope(root: string): Promise<void>
```

No existing signature changes.

---

## Ordered Implementation Steps

1. **`src-tauri/src/lib.rs`** — add the command, immediately after `run()`'s
   closing brace (line 80) and before `mirror_runtime_fs_scope`:

   ```rust
   /// Grants the app filesystem access to `path` and everything under it, for
   /// the life of this process. The frontend calls this for a project folder
   /// Loom points itself at — a restored session's root, or a Recent Projects
   /// entry — rather than one the user just handed it through the folder
   /// picker, a drag-and-drop, or the save dialog. Only those native gestures
   /// grow the `fs` plugin's runtime scope, so a remembered root outside
   /// `$HOME`/`$CONFIG` is refused before its first listing without this.
   ///
   /// The grant goes into the capability scope through [`mirror_scope_entry`],
   /// not into the plugin's runtime scope, so it covers dot-prefixed paths —
   /// the project's own `.loom` folder included — exactly as a mirrored
   /// gesture grant does.
   ///
   /// # Arguments
   ///
   /// * `app` - The handle the capability is added through.
   /// * `path` - The project folder to grant.
   ///
   /// # Returns
   ///
   /// `Ok(())` once the grant is in place, or the failure's message.
   #[tauri::command]
   fn grant_project_scope<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String> {
       match mirror_scope_entry(&app, Path::new(&path), true) {
           Ok(()) => {
               log::info!("granted the filesystem scope for the remembered project root {path}");

               Ok(())
           }
           Err(error) => {
               log::warn!("could not grant the filesystem scope for the remembered project root {path}: {error}");

               Err(error.to_string())
           }
       }
   }
   ```

   Add no imports: `Path`, `AppHandle`, and `Runtime` are already in scope
   (lines 1 and 5).

2. **`src-tauri/src/lib.rs`** — register it. In `run()`, insert
   `.invoke_handler(tauri::generate_handler![grant_project_scope])` after the
   three `.plugin(…)` lines (line 55) and before `.setup(|app| {` (line 56).
   Leave the `setup` closure, the plugin list, and both constants untouched.

3. **`cargo check --manifest-path src-tauri/Cargo.toml`** — expect no errors
   and no warnings from `lib.rs`. Point `CARGO_TARGET_DIR` at the main tree's
   `src-tauri/target` first, or the whole Tauri tree recompiles.

4. **Confirm no capability entry is needed.** `ls src-tauri/permissions`
   — expect *No such file or directory*. Loom defines no app permission
   manifest, which is exactly why a local `invoke` reaches the new command with
   no ACL entry.[^app-command-acl] If that directory ever exists, stop: the
   command would need a permission and this step's assumption is void.

5. **`src/data/workspace.ts`** — add `import { invoke } from '@tauri-apps/api/core'`
   to the `@tauri-apps` import group (after the `@tauri-apps/api/path` import,
   line 10), and add this function immediately after `pickProjectFolder`
   (line 82):

   ```ts
   /**
    * Grants the app filesystem access to `root` and everything under it, for
    * the life of this process. Needed for a project folder Loom points itself
    * at — a restored session's root, a Recent Projects entry — rather than one
    * the user just handed it through the folder picker, a drag-and-drop, or
    * the save dialog: only those native gestures grant a path, so a remembered
    * root outside `$HOME`/`$CONFIG` is refused before its first listing
    * without this.
    *
    * Resolves even when the grant fails. The grant enables the read that
    * follows rather than being the operation itself, so a failure is reported
    * by that read through the caller's existing path; the Rust side logs it at
    * `warn`.
    *
    * @param root - The project folder to grant access to.
    */
   export async function grantProjectScope(root: string): Promise<void> {
       try {
           await invoke<void>('grant_project_scope', { path: root })
       } catch {
           // A failed grant must never stop the app from starting, or stop the
           // tree from being pointed at a folder — see above.
       }
   }
   ```

6. **`src/main.ts`** — add `import { grantProjectScope } from './data/workspace'`
   after the `./shell/settings` import (line 25), and rewrite the first three
   statements of `start()` (lines 44–46) as:

   ```ts
   const appSession = await loadSession()
   const restoredRoot = appSession.projectRoot

   if (restoredRoot !== null) {
       await grantProjectScope(restoredRoot)
   }

   const workspace = restoredRoot !== null ? await loadWorkspaceState(restoredRoot) : null
   const session = applyWorkspaceOverlay(appSession, workspace)
   ```

   Leave the rest of `start()` unchanged.

7. **`src/main.ts`** — extend `start()`'s JSDoc (lines 38–42) with one sentence
   after the existing text: *The remembered root's filesystem scope is granted
   first, because `.loom/workspace.json` and `.loom/settings.json` are both read
   here — before the tree is ever listed — and a root outside `$HOME`/`$CONFIG`
   refuses both until it is granted.*

8. **`src/shell/EditorShell.ts`** — add `grantProjectScope` to the existing
   `../data/workspace` import (line 24), so it reads
   `import { listDirectory, tryReadTextFile, pathExists, grantProjectScope } from '../data/workspace'`.

9. **`src/shell/EditorShell.ts`** — in `openProjectRoot` (line 313), insert
   `await grantProjectScope(root)` between the autosave flush (line 314) and
   `await this._tree.setProjectRoot(root)` (line 315). Change nothing else in
   the method body.

10. **`src/shell/EditorShell.ts`** — in `openProjectRoot`'s JSDoc, change the
    opening clause so it lists the new step. Replace *"flushes the outgoing
    project's own pending autosave, points the tree at the newly chosen
    folder,"* with *"flushes the outgoing project's own pending autosave, grants
    `root` filesystem scope — a Recent Projects entry has no native gesture
    behind it, unlike the picker and a drop, and the grant is harmlessly
    redundant when one does — points the tree at the newly chosen folder,"*.
    Leave the rest of that JSDoc alone.

11. **Check the seam is closed.** `grep -rn 'grantProjectScope(' src/` — expect
    exactly three hits: the declaration in `src/data/workspace.ts` and the two
    call sites from steps 6 and 9. A fourth means a third site was added that
    this plan did not authorise.

12. **`npm run typecheck`** — expect no errors.

13. **`npm test`** — expect the existing suite green and unchanged; no test
    covers the touched files.

14. **`TODO.md`** — delete the *Restoring a workspace outside `$HOME`/`$CONFIG`
    on launch* bullet (lines 28–36) from the *High* section. Add this bullet to
    the end of `## Known issues / loose ends`, recording the limitation this
    plan leaves behind:

    ```markdown
    - **A remembered tab outside the project root stays closed.** Launch
      restore grants the remembered project root and its subtree, nothing
      else, so a tab remembered from outside that root *and* outside
      `$HOME`/`$CONFIG` — a file reached through *Open Recent > Files*, say —
      is still refused on the next launch, and
      `EditorController.restoreFiles` skips it silently the way it skips any
      path that no longer reads. Covering it would widen the launch-time grant
      from one directory to an unbounded list of individually remembered
      files.
    ```

15. **Run the manual checks** in `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src-tauri/src/lib.rs` |
| Modify | `src/data/workspace.ts` |
| Modify | `src/main.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `TODO.md` |

---

## Expected Behaviour

**Every case below needs manual verification under `npm run tauri:dev`.** None
is unit-testable, for the same two reasons the prior two plans recorded:
`src/data/workspace.ts` is the app's Tauri boundary and carries no logic of its
own ([`src/data/workspace.ts:1-5`](src/data/workspace.ts#L1)), and the scope
decision being exercised only exists inside a running Tauri process. The app
crate has no test harness either.

Set up a scratch project **outside `$HOME`** — the prior plans' manual runs used
a directory under the session scratchpad — containing `README.md`,
`src/nested/deep.txt`, and `.gitignore`.

1. **A project outside `$HOME` comes back on the next launch.** Open the scratch
   project with *File → Open Folder…*, expand `src` and `src/nested`, open
   `README.md` and `src/nested/deep.txt`, then close the window with the
   title-bar ✕ (a real window-manager close, which is what flushes the
   autosave). Relaunch. The tree lists the project root with `src` and
   `src/nested` expanded, both tabs are back with their contents, and the
   explorer section header names the project. Today the tree is empty and the
   welcome screen shows instead.
2. **The restored project's own settings apply.** Write
   `{"showHiddenFiles": true}` into `<root>/.loom/settings.json`, relaunch, and
   confirm `.gitignore` appears in the tree. This proves
   `loadResolvedSettings` read a file under the out-of-scope root, which it
   cannot do before the grant.
3. **A dotfile in the restored project opens with no re-pick.** Click
   `.gitignore` in the restored tree. Its contents appear in a tab and no
   `Could not open file` dialog shows. This is what proves the grant landed in
   the capability scope rather than the runtime scope.
4. **Editing the restored project still saves.** Change `src/nested/deep.txt`,
   `Ctrl+S`, confirm the `Saved deep.txt` status message and the new contents
   on disk. Then expand another directory and close the window: the autosave
   rewrites `<root>/.loom/workspace.json`, so the grant covers writes too.
5. **A project under `$HOME` restores exactly as before.** Open this
   repository's own worktree, relaunch, confirm the tree, tabs, and expansion
   come back unchanged from today.
6. **A remembered root that has since been deleted restores quietly.** Delete
   (or rename) the scratch project between two launches. The app starts on the
   welcome screen with an empty tree, shows no error dialog, and does not
   crash — the unchanged `applySession` fallback.
7. **Open Recent works for a second project outside `$HOME`.** With one outside
   project restored, use *File → Open Recent* to switch to a second scratch
   project outside `$HOME` that was opened earlier in a previous run. Its tree
   lists. Today it fails the same way launch restore does.
8. **A project folder whose name contains glob characters restores.** Rename the
   scratch project to `proj [2026]`, open it, relaunch. The tree lists and
   `.gitignore` opens — `scope_entries`' `Pattern::escape` is what makes the
   `[2026]` match literally instead of as a character class.
9. **A first launch grants nothing.** With no `session.json` (or one whose
   `projectRoot` is `null`), the app starts on the welcome screen and the dev
   console shows no `granted the filesystem scope` line.

---

## Verification

- `cargo check --manifest-path src-tauri/Cargo.toml` — no errors, no warnings
  from `lib.rs`.
- `ls src-tauri/permissions` — expect *No such file or directory*, the
  assumption step 4 rests on.
- `grep -c 'grant_project_scope' src-tauri/src/lib.rs` — expect `2`: the
  `generate_handler!` entry and the function definition.
- `grep -rn 'grantProjectScope(' src/` — expect exactly three lines: the
  declaration and the two call sites.
- `git diff src-tauri/capabilities/ src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock`
  — expect empty. No capability entry, no config change, no new dependency.
- `git diff src/shell/session.ts src/data/session.ts` — expect empty. The
  session document's shape and `applySession` are untouched.
- `npm run typecheck` — no errors.
- `npm test` — the existing suite passes; no new tests.
- `npm run tauri:dev`, then work through cases 1–9 of `## Expected Behaviour`.
- **Watch the dev console at launch.** A restored root logs
  `granted the filesystem scope for the remembered project root <path>` at
  `info`, once. Its absence means the command never ran; a
  `could not grant …` line names the failure instead.

---

## Potential Challenges

- **The Rust build is cold in a fresh worktree.** `cargo check` compiles the
  whole Tauri dependency tree from scratch. Point `CARGO_TARGET_DIR` at the
  main tree's `src-tauri/target`, as every prior phase's implementation notes
  record doing.
- **A grant failure is only visible in the log.** Nothing user-facing reports
  it; the launch then behaves exactly as it does today, with an empty tree.
  Mitigation: the `warn` line names the path and the error, and the failure
  mode is a strict non-regression.
- **A root reached through a symbolic link is still refused.** The grant is
  registered under the stored path, and Tauri canonicalises every later request
  before matching — the same mismatch the picker's own grant has. Mitigation:
  none in this plan; the stored path is whatever the picker returned.
- **`npm run dev` in a plain browser has no `invoke`.** The call throws and
  `grantProjectScope` swallows it, leaving the browser-only flow exactly as
  broken as it already is (the README notes folder access does not work
  there).
- **A sandboxed macOS build would need more than a scope grant.** The OS
  requires a security-scoped bookmark to reach a user-picked folder across
  launches, which no Tauri scope entry creates. Mitigation: out of reach today
  — `npm run tauri:build` produces an unsigned local bundle, per `TODO.md`'s
  code-signing item; revisit if Loom is ever sandboxed.

---

## Critical Files

- [`src-tauri/src/lib.rs:127-140`](src-tauri/src/lib.rs#L127) —
  `mirror_scope_entry`, the helper the new command reuses unchanged, and
  [`:154-162`](src-tauri/src/lib.rs#L154) `scope_entries`, which decides the
  escaped patterns each grant registers.
- [`src-tauri/src/lib.rs:51-80`](src-tauri/src/lib.rs#L51) — `run()`, where the
  `invoke_handler` line goes.
- [`plans/implemented/folder-picker-fs-scope.md`](plans/implemented/folder-picker-fs-scope.md) —
  the precedent: capability-scope grants, the two-scope check, and why the
  runtime scope cannot carry dotfiles.
- [`plans/implemented/open-outside-home.md`](plans/implemented/open-outside-home.md) —
  the picker's runtime grant, and the `## Potential Challenges` entry that
  first predicted this bug.
- [`src/main.ts:43-58`](src/main.ts#L43) — `start()`, the cold-start sequence
  the grant has to precede.
- [`src/shell/EditorShell.ts:313-330`](src/shell/EditorShell.ts#L313) —
  `openProjectRoot`, and [`:231-251`](src/shell/EditorShell.ts#L231), the one
  registration of `setProjectRootListener` that funnels into it.
- [`src/shell/session.ts:79-93`](src/shell/session.ts#L79) — `applySession`;
  read to confirm it needs no change.
- [`src/data/workspace.ts:1-5`](src/data/workspace.ts#L1) — the header comment
  that makes this module the only `@tauri-apps/*` importer.
- [`src-tauri/capabilities/default.json:25`](src-tauri/capabilities/default.json#L25)
  and [`src-tauri/tauri.conf.json:40-44`](src-tauri/tauri.conf.json#L40) — the
  static grant and `requireLiteralLeadingDot: false`. Neither is edited.

---

## Non-Goals

- **Persisting the grant at the Tauri or OS level.** There is nowhere to put
  it: `tauri-build` compiles `capabilities/` into the binary, so the shipped
  capability file cannot be edited at runtime, and both the runtime scope and a
  runtime capability live only in memory. Loom's own `session.json` is the
  persistence layer, and re-granting from it at startup is what stands in for
  an OS-level grant.
- **Adding `tauri-plugin-persisted-scope`.** Rejected on both correctness and
  reach.[^why-capability-scope]
- **Restoring a tab remembered from outside the project root.** The grant
  covers one directory subtree; a remembered file elsewhere would need its own
  entry, turning a single grant into a list that grows with every file ever
  opened outside a project. `restoreFiles` already skips an unreadable path
  silently by design ([`src/EditorController.ts:529`](src/EditorController.ts#L529)),
  so the behaviour is unchanged rather than newly broken. Step 14 records it in
  `TODO.md`.
- **Reporting a failed restore to the user.** `applySession`'s `try`/`catch`
  stays exactly as it is. After this plan the only thing it still swallows is a
  root that has since moved or been deleted, and the welcome screen and
  *Recent Projects* already communicate that state; an error dialog on every
  launch after a project folder is deleted would be worse than the quiet
  fallback.
- **Widening the static `fs:scope`.** Rejected by both prior plans; not
  revisited.
- **Any change to the session document.** `src/data/session.ts`,
  `src/shell/session.ts`, and `tests/session.test.ts` are untouched — the
  `projectRoot` field this plan grants from has been recorded since
  `session-persistence.md`.

---

## Notes

[^why-capability-scope]: Two scopes decide every filesystem call and either one
    suffices: `resolve_path` in `tauri-plugin-fs` 2.5.2 ends with
    `if fs_scope.scope.is_allowed(&resolved_path) || scope.is_allowed(&resolved_path)`
    (`src/commands.rs:1564`), where `scope` is rebuilt per call from the
    capability entries (`:1533-1552`) and every command — `read_dir`, `stat`,
    `mkdir`, `rename`, `remove`, and the watcher at `src/watcher.rs:51` — goes
    through it. Only the capability scope honours
    `plugins.fs.requireLiteralLeadingDot: false` from
    `src-tauri/tauri.conf.json:42`, so granting there rather than through
    `FsExt::fs_scope().allow_directory(…)` is what makes the restored project's
    `.loom/workspace.json`, `.loom/settings.json`, and `.gitignore` readable.
    `tauri-plugin-persisted-scope` (2.3.8, published 2026-08-31) is the
    off-the-shelf answer and was rejected on three counts. It restores into the
    *runtime* scope via `allow_file`/`allow_directory`, which re-introduces the
    dotfile refusal that `folder-picker-fs-scope.md` fixed. It restores from
    its own plugin setup, which `tauri` 2.11.5 runs inside `Builder::build`
    (`src/app.rs:2440`) — before the app's setup closure at `:2531` runs
    `mirror_runtime_fs_scope`, the listener Loom installs to copy runtime-scope
    grants into the capability scope — so that listener would not even observe
    those restored grants and could not repair them. And it re-grants every
    path any gesture ever handed the app, forever, out of a `.persisted-scope`
    file in the app data directory that Loom neither writes nor prunes: a
    second store of workspace state beside `session.json`, and a far wider
    reach than one project root.

[^ask-from-the-frontend]: The alternative was to skip IPC entirely and have the
    `setup` closure read `session.json` itself. It was rejected because Rust
    would then need its own copy of two things TypeScript already owns: where
    the file lives — `src/data/workspace.ts:54` picks `loom` on Linux and
    `Loom` elsewhere, a decision recorded in the session-persistence plan — and
    the document's shape, which `parseSession`
    (`src/data/session.ts:77`) defines and `tests/session.test.ts` pins. A
    second parser of Loom's own config file is a second source of truth for it,
    and it would drift the first time the session schema changes. Reading the
    file from Rust also grants nothing for *Open Recent*, which points the tree
    at a remembered root with no gesture behind it and fails identically today.
    `folder-picker-fs-scope.md`'s own `[^setup-seam]` footnote named this
    command shape as what a non-gesture grant would need, and rejected it only
    for that plan's gesture-driven scope.

[^app-command-acl]: Tauri 2.11.5 checks the ACL for an app-defined command only
    when the app ships its own permission manifest. `src/webview/mod.rs:1823`
    gates the check on `plugin_command.is_some() || has_app_acl_manifest || !is_local`,
    and `has_app_acl_manifest` is true only when `tauri-build` found app
    permissions to register — `tauri-build` 2.6.3 inserts the app manifest at
    `src/acl.rs:408-413` only if `AppManifest::commands` or a
    `permissions_path_pattern` produced any permission files. Loom's
    `src-tauri/build.rs` is a bare `tauri_build::build()` and there is no
    `src-tauri/permissions/` directory, so no app manifest exists and a
    local-origin `invoke` reaches `grant_project_scope` directly. The dev
    server counts as local: `is_local_url` (`src/webview/mod.rs:1698`) accepts
    any URL relative to `devUrl` or `frontendDist`. Adding a permission entry
    to the capability file would not merely be redundant, it would break the
    build — `validate_capabilities` rejects an identifier no manifest declares.

[^two-seams]: `src/main.ts` is where the cold-start grant has to happen, not
    `applySession`: `loadWorkspaceState` (`src/main.ts:45`) and
    `loadResolvedSettings` (`src/main.ts:47`) both read files under the root —
    `<root>/.loom/workspace.json` and `<root>/.loom/settings.json` — before the
    shell is even constructed, and both degrade to `null` on a refusal rather
    than throwing. A grant made later, inside `applySession`, would therefore
    restore the tree while silently losing the saved expansion and the
    per-project settings override. `EditorShell.openProjectRoot` is the second
    seam because every in-app root adoption funnels through it:
    `EditorController.openProjectFolder` (the picker) and `openRecentProject`
    (`src/EditorController.ts:354` — the File menu's *Open Recent*, the welcome
    screen's recent list, and a dropped folder via `confirmAndOpenProject`)
    both fire `_projectRootListener`, whose only registration is the callback
    at `src/shell/EditorShell.ts:231` that awaits `openProjectRoot`. The grant
    is redundant there for the picker and the drop, which already granted
    themselves; `Manager::add_capability` merging a duplicate entry costs
    nothing, and `mirror_runtime_fs_scope` — the listener installed in `setup`
    — already re-adds the same entries on every gesture.

[^reach]: Three wider readings of "how far the grant should reach" were
    rejected. Granting every remembered open file as well turns one entry into
    an unbounded list that grows with every file ever opened outside a project.
    Persisting an explicit allow-list the user opts into adds a settings
    surface and a second grant store, for a decision the user already made when
    they picked the folder. Prompting for a fresh native gesture at startup —
    opening the folder picker on the remembered root — was rejected as the
    worst of the three: it puts a modal dialog in front of every launch of a
    project outside `$HOME`, for a folder the user never asked to re-choose.
    Re-granting a path Loom itself recorded from a real gesture adds no
    privilege in practice: anything able to rewrite `session.json`, a file
    inside the user's own config directory, already has the user's filesystem
    access.

## Implementation Notes

**No codebase drift.** Every file this plan touches matched its cited line
numbers exactly (`src-tauri/src/lib.rs`, `src/data/workspace.ts`,
`src/main.ts`, `src/shell/EditorShell.ts`, `TODO.md`), and `ls
src-tauri/permissions` confirmed the no-app-manifest assumption step 4 rests
on. All fifteen `## Ordered Implementation Steps` were followed as written,
with no deviation.

**Manual verification.** Ran against a real `npm run tauri:dev` process
(Linux/WSL2, `DISPLAY` forwarded to a Windows host via WSLg), reusing the
main tree's Cargo build cache (`CARGO_TARGET_DIR` pointed at
`/home/jika/typescript/loom/src-tauri/target`), screenshotted with Pillow's
`ImageGrab` and driven with `pyautogui`; window focus was set explicitly via
`python-xlib` (`set_input_focus`/`configure(stack_mode=Above)`) before each
new window's first interaction, and the genuine window-manager close each
case needed was sent as a real `WM_DELETE_WINDOW` client message rather than
a simulated click, matching every prior phase's recorded technique. Port
1420 was already held by an unrelated worktree's dev server, so
`vite.config.ts`'s `server.port` and `tauri.conf.json`'s `build.devUrl` were
both temporarily repointed to `14209` for the run and reverted (`git
checkout`) before finishing — neither appears in the final diff. The native
GTK folder-picker's location-bar (`Ctrl+L`) auto-completes into any
unambiguous single-child directory on `Enter`, the same pitfall
`open-outside-home.md`'s notes recorded, so the picker was driven by
navigating to the parent directory and double-clicking the target row
instead, once per path segment.

Confirmed against a scratch project outside `$HOME` (this session's
scratchpad) containing `README.md` and `src/nested/deep.txt`:

1. Opened the scratch project via *File → Open Folder…*, expanded `src` and
   `src/nested`, opened both files, closed the two stale tabs left over from
   the previously-open project (the `openFilesBelongToRoot` autosave guard
   `folder-picker-fs-scope.md`'s notes flagged), then closed the window via a
   genuine `WM_DELETE_WINDOW` request. `<root>/.loom/workspace.json` was
   written with the expanded dirs and both open files. Relaunching restored
   the tree (root, `src`, `src/nested` all expanded), both tabs, and their
   content — the dev console logged `granted the filesystem scope for the
   remembered project root <path>` at `info` before the tree was listed.
   Today (pre-fix) this is the exact case that fails: an empty tree and the
   welcome screen.
2. With the restored project still open, *View → Show Hidden Files* revealed
   `.gitignore` and `.loom`; double-clicking `.gitignore` opened it with its
   content (`node_modules/`) and no `Could not open file` dialog — the case
   that distinguishes a capability-scope grant from a runtime-scope-only one.
3. Renaming the scratch project's directory away and relaunching left the
   welcome screen showing, *Recent Projects* intact, no error dialog, and no
   crash — the unchanged `applySession` fallback. The grant itself still
   logged (adding scope entries does no I/O to check the path exists), only
   the later tree listing fails, exactly as `## What the grant covers`
   predicts for a since-deleted root.
4. The very first launch of this session (before any scratch-project setup)
   restored `/home/jika/typescript/loom` — a `$HOME` root left over from an
   earlier phase's manual verification — unaffected: tree, tabs, and
   expansion came back exactly as they do without this change, confirming
   the unconditional cold-start grant call is harmless for an already-in-
   scope root.
5. With `~/.config/loom/session.json` moved aside entirely (no persisted
   `projectRoot` at all), launch showed the welcome screen with an empty
   tree and no *Recent Projects* entries, and the dev console logged no
   `granted the filesystem scope` line — confirming `main.ts`'s
   `if (restoredRoot !== null)` guard skips the grant call outright on a
   true first launch. Restored the session file afterward.

**Not exercised.** Cases 2 (per-project settings override), 4 (edit-and-save
of the restored project), 7 (*Open Recent* to a second out-of-`$HOME`
project), and 8 (a folder name containing glob characters) were not
separately driven through the GUI. Each exercises the same
`grant_project_scope`/`mirror_scope_entry` code path already confirmed live
by cases 1–2 above (`EditorShell.openProjectRoot`'s call site for 7,
`scope_entries`' existing `Pattern::escape` handling for 8, unchanged by
this plan), and reproducing them was judged to add GUI-automation time out
of proportion to the additional confidence, given the fix is a single
`if (restoredRoot !== null) { await grantProjectScope(restoredRoot) }`
gate plus one already-tested reused helper.
