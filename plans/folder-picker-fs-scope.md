# Mirroring the Folder Picker's Runtime Filesystem Grant — Implementation Plan

## Overview

Tauri decides whether the app may touch a path by checking two separate
filesystem scopes and allowing the path if **either** one permits it:

- The **capability scope** — the `fs:scope` entries declared in
  [`src-tauri/capabilities/default.json:25`](src-tauri/capabilities/default.json#L25)
  (`$HOME/**`, `$CONFIG/loom/**`, and friends). It honours
  `plugins.fs.requireLiteralLeadingDot: false` from
  [`src-tauri/tauri.conf.json:42`](src-tauri/tauri.conf.json#L42), so its `**`
  wildcards match path components that start with a `.`.
- The **runtime scope** — an in-memory allow-list the `fs` plugin builds at
  startup and grows whenever a native gesture hands the app a new path. The
  folder picker in
  [`src/data/workspace.ts:72`](src/data/workspace.ts#L72) grows it, and so do
  the save dialog and native drag-and-drop. Its wildcards **never** match a
  path component that starts with a `.` — call that the *leading-dot rule* —
  because the plugin builds the runtime scope from a hardcoded default and
  ignores the `requireLiteralLeadingDot` setting above.[^hardcoded]

A project under `$HOME` is carried by the capability scope, so `.gitignore`
opens there. A project picked from outside `$HOME`/`$CONFIG` is carried only by
the runtime scope, so every dot-prefixed path inside it is refused — including
the `.loom` folder Loom writes its own per-project state into. This
blocked-dotfile case is the gap
[`plans/implemented/open-outside-home.md`](plans/implemented/open-outside-home.md)
left open and recorded at [`TODO.md:23`](TODO.md#L23).

The fix lives entirely inside
[`src-tauri/src/lib.rs`](src-tauri/src/lib.rs): the app subscribes to the
runtime scope's change events and mirrors every path the runtime scope grants
into the capability scope, which does honour `requireLiteralLeadingDot: false`.
No frontend file changes, no new IPC command, and no dependency change.

---

## Architecture Decisions

### Mirror the runtime scope into a runtime capability

`src-tauri/src/lib.rs` listens on the `fs` plugin's runtime scope
(`FsExt::fs_scope().listen(…)`) and, for each `PathAllowed` event, adds a
capability at runtime (`Manager::add_capability`) whose `fs:scope` allow-list
covers that path. `PathForbidden` is mirrored into the same capability's
deny-list.[^mirror-forbidden] A mirrored allow cannot widen anything the
capability scope already denies: Tauri checks denials first, and a denial
outranks every allow.

There is no in-repo precedent to follow — `src-tauri/src/lib.rs` registers
three plugins and defines nothing else, and
`src-tauri/capabilities/default.json` is the only other place Tauri
permissions appear. The pattern this mirrors is the plugin's own: the `fs`
plugin already treats a native gesture as the trigger for a scope grant, in
its drag-and-drop handler at `tauri-plugin-fs-2.5.2/src/lib.rs:517`. This plan
adds a second grant, in the scope that reads Loom's own config, alongside
every grant those gestures already make.[^why-capability]

### Register the mirror in `setup`, not behind a new IPC command

The listener is installed once from the existing `.setup(…)` closure. Nothing
in `src/` changes, and `src/data/workspace.ts` stays the app's sole
`@tauri-apps/*` entry point.[^setup-seam]

### Escape the granted path, then append `/**`

A granted path is run through `Pattern::escape` before any wildcard is
appended, so a project folder whose name contains `*`, `?`, `[` or `]` is
matched literally. A directory contributes two entries — the escaped path
itself and the escaped path plus `/**` — because `**` never matches the
directory it hangs off.[^escape]

---

## How the two scopes decide each path

For a project picked at `/opt/project`, outside `$HOME`:

| Entry list | Patterns | Dot-prefixed components |
|---|---|---|
| Runtime scope (the picker's own grant) | `/opt/project`, `/opt/project/**` | never matched |
| Capability scope, today | `$HOME/**`, `$CONFIG/loom/**`, … | matched |
| Capability scope, after this plan | the same **plus** `/opt/project`, `/opt/project/**` | matched |

| Path the app asks for | Runtime scope | Capability scope today | Capability scope after | Result |
|---|---|---|---|---|
| `/opt/project` (list the root) | allows | no match | allows | allowed, as today |
| `/opt/project/src/main.ts` | allows | no match | allows | allowed, as today |
| `/opt/project/.gitignore` | **no match** (dot) | no match | **allows** | **fixed** |
| `/opt/project/.github/workflows/ci.yml` | no match (dot) | no match | allows | **fixed** |
| `/opt/project/.loom/workspace.json` | no match (dot) | no match | allows | **fixed** |
| `~/code/project/.gitignore` | n/a | allows | allows | allowed, as today |

---

## Internal Structure

The whole change, as it should read when finished. `src-tauri/src/lib.rs` is
19 lines today; this replaces it.

```rust
use std::path::Path;

use tauri::fs::{Event as FsScopeEvent, Pattern};
use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_fs::FsExt;

/// The `fs` plugin's scope-only permission — the same identifier the static
/// grant in `capabilities/default.json` uses. It carries no commands, so the
/// ACL resolver folds whatever scope entries accompany it into the plugin's
/// app-wide filesystem scope rather than into one command's scope.
const FS_SCOPE_PERMISSION: &str = "fs:scope";

/// Identifier every mirrored grant is added under. One constant is enough:
/// `Manager::add_capability` merges each call's scope entries into the `fs`
/// plugin's app-wide scope and keeps nothing keyed by the capability's own
/// identifier, and this capability declares no commands, so repeated calls
/// accumulate nothing but the scope entries themselves.
const RUNTIME_GRANT_CAPABILITY: &str = "loom-runtime-fs-grant";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .setup(|app| {
            mirror_runtime_fs_scope(app.handle());

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Copies every change the `fs` plugin makes to its in-memory runtime scope
/// into the app's capability scope, which is the only one of the two that
/// honours `plugins.fs.requireLiteralLeadingDot` from `tauri.conf.json`.
/// Without this, a folder picked outside `$HOME`/`$CONFIG` is reachable only
/// through the runtime scope, whose wildcards never match a path component
/// starting with a `.` — so `.gitignore` and the project's own `.loom` folder
/// stay refused there while opening fine under `$HOME`.
///
/// A failed mirror is logged and swallowed: the runtime grant itself already
/// succeeded, so the folder still opens, minus its dotfiles.
///
/// # Arguments
///
/// * `app` - The handle the mirrored capabilities are added through.
fn mirror_runtime_fs_scope<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();

    app.fs_scope().listen(move |event| {
        let (path, allowed) = match event {
            FsScopeEvent::PathAllowed(path) => (path, true),
            FsScopeEvent::PathForbidden(path) => (path, false),
        };

        match mirror_scope_entry(&handle, path, allowed) {
            Ok(()) => log::info!("mirrored the runtime filesystem scope for {}", path.display()),
            Err(error) => log::warn!(
                "could not mirror the runtime filesystem scope for {}: {error}",
                path.display()
            ),
        }
    });
}

/// Adds `path`'s scope entries to the app's capability scope, as an allow or
/// a deny.
///
/// # Arguments
///
/// * `app` - The handle the capability is added through.
/// * `path` - The path the runtime scope just allowed or forbade.
/// * `allowed` - Whether to mirror `path` as an allow rather than a deny.
///
/// # Returns
///
/// Whatever `Manager::add_capability` reports.
fn mirror_scope_entry<R: Runtime>(app: &AppHandle<R>, path: &Path, allowed: bool) -> tauri::Result<()> {
    let entries = scope_entries(path);

    let (allow, deny) = if allowed {
        (entries, Vec::new())
    } else {
        (Vec::new(), entries)
    };

    app.add_capability(
        CapabilityBuilder::new(RUNTIME_GRANT_CAPABILITY)
            .permission_scoped(FS_SCOPE_PERMISSION, allow, deny),
    )
}

/// The `fs:scope` entries covering `path`. Glob metacharacters in `path` are
/// escaped so a folder named `notes [2026]` is matched literally rather than
/// read as a character class. A directory also gets a `/**` entry, because
/// `**` matches what is *under* a directory and never the directory itself.
///
/// # Arguments
///
/// * `path` - The path to build entries for.
///
/// # Returns
///
/// One entry for a file, two for a directory.
fn scope_entries(path: &Path) -> Vec<String> {
    let literal = Pattern::escape(&path.to_string_lossy());

    if path.is_dir() {
        vec![format!("{literal}/**"), literal]
    } else {
        vec![literal]
    }
}
```

---

## Ordered Implementation Steps

1. **`src-tauri/src/lib.rs`** — replace the file's contents with the block in
   `## Internal Structure`, exactly as written. The block keeps the existing
   plugin registrations and the debug-only logger untouched and adds one call
   (`mirror_runtime_fs_scope(app.handle());`) as the first statement of the
   `setup` closure.

2. **Confirm the new imports resolve as expected.** Every symbol used above
   exists in the versions pinned by `src-tauri/Cargo.lock`
   (`tauri` 2.11.5, `tauri-plugin-fs` 2.5.2) — do not substitute alternatives
   if one appears to be missing; re-check the spelling first:

   | Symbol | Where it comes from |
   |---|---|
   | `tauri::fs::Event`, `tauri::fs::Pattern` | `tauri::scope::fs`, re-exported by `pub use scope::*` |
   | `tauri::ipc::CapabilityBuilder` | `tauri`'s `dynamic-acl` feature, on by default |
   | `Manager::add_capability` | same feature; needs `use tauri::Manager` in scope |
   | `FsExt::fs_scope` | `tauri_plugin_fs::FsExt` |

3. **`cargo check --manifest-path src-tauri/Cargo.toml`** — expect no errors
   and no warnings from `lib.rs`. An "unused import" warning here means a
   symbol was imported but the corresponding code was dropped.

4. **Check nothing leaked into the frontend.** `git diff --stat src/
   package.json package-lock.json` — expect empty output. This plan changes
   Rust and `TODO.md` only.

5. **Check the capability file and the plugin config are untouched.**
   `git diff src-tauri/capabilities/ src-tauri/tauri.conf.json src-tauri/Cargo.toml`
   — expect empty output.

6. **`npm run typecheck`** and **`npm test`** — expect the existing suite
   green and unchanged; no TypeScript file was touched.

7. **`TODO.md`** — delete the `Opening dotfiles in a workspace outside
   $HOME/$CONFIG` bullet (lines 23–33). In its place in the *High* section,
   add the bullet recording the behaviour gap this plan deliberately leaves
   (see `## Non-Goals`):

   ```markdown
   - **Restoring a workspace outside `$HOME`/`$CONFIG` on launch.** A project
     root outside those trees is only reachable once a native gesture has
     granted it — the folder picker, a drag-and-drop, or the save dialog.
     Nothing grants it at startup, so a remembered root outside
     `$HOME`/`$CONFIG` is refused before the tree is ever listed and
     `applySession`'s `try`/`catch` (`src/shell/session.ts:81`) leaves the
     tree empty. Fixing it means re-granting a persisted path with no user
     gesture behind it, which needs its own decision about how far that
     grant should reach.
   ```

8. **Run the manual checks** in `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src-tauri/src/lib.rs` |
| Modify | `TODO.md` |

---

## Expected Behaviour

**Every case below needs manual verification under `npm run tauri:dev`.** None
is unit-testable: the change is Rust that only runs inside a live Tauri
process, the behaviour it fixes is a scope decision made by a dependency, and
the app crate has no test harness (`tauri`'s `test` feature is not enabled).

Set up a scratch project **outside `$HOME`** — the prior plan's manual run
used a directory under the session scratchpad — containing `README.md`,
`src/nested/deep.txt`, `.gitignore`, and `.github/workflows/ci.yml`. Open it
with *File → Open Folder…*, and turn on *View → Show Hidden Files* so the
dot-prefixed entries are visible in the tree.

1. **A dotfile in the picked project opens.** Click `.gitignore`. Its contents
   appear in a tab. No `Could not open file` dialog. This is the case that
   fails today.
2. **A file inside a dot-directory opens.** Expand `.github`, then
   `workflows`, and open `ci.yml`. Both the listing and the open succeed.
3. **The project's own `.loom` folder can be written.** Open a file from the
   project and expand a tree directory — both schedule the debounced session
   autosave — then close the window, which flushes it.
   `<root>/.loom/workspace.json` and `<root>/.loom/.gitignore` exist on disk
   afterwards. Today the `mkdir` of `<root>/.loom` is refused and no
   per-project state is written.
4. **Non-dot files are unaffected.** `README.md` and
   `src/nested/deep.txt` still open, and saving still works.
5. **A project under `$HOME` is unaffected.** Open this repository's own
   worktree; the tree lists several levels deep and `.gitignore` opens, as
   before.
6. **A folder dropped from outside `$HOME` behaves like a picked one.** Drag
   the scratch project onto the window from the OS file manager, accept the
   prompt, then open its `.gitignore`. It opens — native drag-and-drop grows
   the same runtime scope the picker does, so the mirror covers it too.
7. **A project folder whose name contains glob characters works.** Rename the
   scratch project to `proj [2026]` and pick it again. Its `.gitignore` still
   opens. Without `scope_entries`' escaping the mirrored pattern's `[2026]`
   would be read as a character class, match nothing under the real folder,
   and leave `.gitignore` refused.
8. **Cancelling the picker still does nothing.** No dialog, no tree change, no
   `mirrored the runtime filesystem scope` line in the log.

---

## Verification

- `cargo check --manifest-path src-tauri/Cargo.toml` — no errors, no warnings
  from `lib.rs`.
- `grep -c 'add_capability(' src-tauri/src/lib.rs` — expect `1`, the single
  call site.
- `git diff --stat src/ package.json src-tauri/capabilities/ src-tauri/tauri.conf.json src-tauri/Cargo.toml`
  — expect empty. Only `src-tauri/src/lib.rs` and `TODO.md` change.
- `npm run typecheck` — no errors.
- `npm test` — the existing suite passes; no new tests.
- `npm run tauri:dev`, then work through cases 1–8 of
  `## Expected Behaviour` via *File → Open Folder…* in the menu bar.
- **Watch the dev console while picking a folder.** Each grant logs
  `mirrored the runtime filesystem scope for <path>` at `info` — one line for
  the picked folder. Its absence means the listener was never installed;
  a `could not mirror …` line names the failure instead.

---

## Potential Challenges

- **The Rust build is cold in a fresh worktree.** `cargo check` will compile
  the whole Tauri dependency tree from scratch. Point `CARGO_TARGET_DIR` at
  the main tree's `src-tauri/target` to reuse its cache, as every prior
  phase's implementation notes record doing.
- **The mirror only covers grants made during the current run.** Nothing is
  persisted, so a project outside `$HOME` must be re-picked (or re-dropped)
  after a restart before its dotfiles open. This re-pick requirement is the
  same limitation the `## Non-Goals` entry on session restore records, not a
  new one.
- **A picked path that goes through a symbolic link is still refused.** The
  mirror registers the path the picker returned, and Tauri resolves every
  later request to its real location before matching — the same mismatch the
  runtime scope already has. Mitigation: none in this plan; pick the real
  path.
- **`add_capability` panics if the ACL cannot resolve the capability.** The
  only inputs that could break resolution are the permission identifier and
  the window patterns, and both are constants here (`"fs:scope"`, none). The
  user-supplied part is a scope *value*, which is parsed later and reported as
  a normal command error. Do not make the identifier dynamic.
- **`path.is_dir()` follows symlinks and touches the disk.** A grant for a
  path that has since disappeared yields one entry instead of two, which
  under-grants rather than over-grants. Acceptable: the picker's grant fires
  immediately after the user chose the folder.

---

## Critical Files

- [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs) — the whole change; 19 lines
  today, registering three plugins and a debug logger.
- [`src-tauri/capabilities/default.json:25`](src-tauri/capabilities/default.json#L25) —
  the static `fs:scope` grant this plan extends at runtime, and the source of
  the `"fs:scope"` identifier the new code reuses. Not edited.
- [`src-tauri/tauri.conf.json:40-44`](src-tauri/tauri.conf.json#L40) —
  `plugins.fs.requireLiteralLeadingDot: false`, the setting that makes the
  capability scope match dotfiles and the reason mirroring into it fixes
  anything. Not edited.
- [`src/data/workspace.ts:63-74`](src/data/workspace.ts#L63) —
  `pickProjectFolder` and its JSDoc, which describes the runtime grant this
  plan mirrors. Read to confirm no frontend change is needed. Not edited.
- [`plans/implemented/open-outside-home.md`](plans/implemented/open-outside-home.md) —
  the shipped plan that established the runtime-grant approach; its
  `## Notes` trace the two-scope check this plan builds on.
- `~/.cargo/registry/src/index.crates.io-*/tauri-plugin-fs-2.5.2/src/commands.rs`,
  around `resolve_path` (line 1480) — the two-scope check itself. Read to see
  why an entry in the capability scope is sufficient on its own.

---

## Non-Goals

- **Restoring a session whose project root sits outside `$HOME`/`$CONFIG`.**
  No native gesture fires at startup, so no runtime grant exists for the
  mirror to copy, and the root is refused before the tree is listed. Granting
  a persisted path with no user gesture behind it is a separate decision;
  step 7 records it in `TODO.md`.
- **Bumping or forking `tauri-plugin-fs`.** 2.5.2 is the newest published
  version and its `v2` branch still builds the runtime scope from the
  hardcoded default, so no upgrade fixes this.[^hardcoded]
- **Widening the static `fs:scope` to `/**`.** Standing access to every file
  on the machine, whether or not the user ever picked it. Already rejected by
  the prior plan and unchanged here.
- **Removing the now-redundant `$HOME/**/.loom*` entries from
  `capabilities/default.json`.** `requireLiteralLeadingDot: false` made them
  unnecessary, but tightening that file is its own change with its own risk.
- **Any frontend or dependency change.** The fix is reachable entirely from
  `src-tauri/src/lib.rs`.

---

## Notes

[^hardcoded]: The leading-dot rule the runtime scope matches with is fixed
    inside the dependency, with no override the app can reach.
    `tauri-plugin-fs` 2.5.2's plugin setup (`src/lib.rs:487-494`) builds it as
    `tauri::fs::Scope::new(app, &FsScope::default())`, and reads
    `requireLiteralLeadingDot` into a *separate* field beside it.
    `FsScope::default()` is `FsScope::AllowedPaths(vec![])`
    (`tauri-utils-2.9.3/src/config.rs:2558`), which is not the
    `FsScope::Scope { require_literal_leading_dot, … }` variant, so
    `Scope::new` falls through to its Unix default of `true`
    (`tauri-2.11.5/src/scope/fs.rs:215-224`) and bakes that into the
    `glob::MatchOptions` it keeps for the life of the scope. `Scope::is_allowed`
    (`src/scope/fs.rs:419`) matches against those baked options, so no later
    call can change the rule. The config value *is* used — but only for the
    capability scope `resolve_path` rebuilds per call
    (`tauri-plugin-fs-2.5.2/src/commands.rs:1533-1556`), which is exactly why
    mirroring into that scope works. `tauri_plugin_fs::init()` takes no
    arguments and the crate exposes no builder, so nothing can be passed at
    registration time. 2.5.2 is the latest version on crates.io (published
    2026-08-31), and the same two lines are present unchanged on the upstream
    `v2` branch, so neither a version bump nor waiting for a release helps.
    A `[patch.crates-io]` fork would work and was rejected: it makes every
    future Tauri upgrade a merge, for a fix the app can make in ten lines of
    its own code.

[^why-capability]: `Manager::add_capability`
    (`tauri-2.11.5/src/lib.rs:813`) is a supported runtime ACL API, gated on
    `tauri`'s `dynamic-acl` feature — which is on, since `src-tauri/Cargo.toml`
    declares `tauri = { version = "2.11.3", features = [] }` and that does not
    disable default features. A capability carrying the `fs:scope` permission
    resolves to a *global* scope entry for the `fs` plugin, because that
    permission declares no commands
    (`tauri-utils-2.9.3/src/acl/resolved.rs:110-112`), and
    `add_capability_inner` extends the stored global scope and clears its cache
    (`tauri-2.11.5/src/ipc/authority.rs:181-189`) so the next fs command sees
    the new entry. The alternative of granting through
    `FsExt::fs_scope().allow_directory(…)` — the plugin's own runtime scope —
    cannot help: its public surface takes paths, not patterns, and the
    leading-dot rule it matches with is already baked in.

[^setup-seam]: Two seams could install the mirror. A Rust command invoked from
    `src/data/workspace.ts` after the picker resolves would also let the app
    grant a root it did not pick — a session-restored one, say. It was
    rejected for this plan: it adds an IPC surface and a second place that
    knows about scopes, and it has to be called from every site that points
    the tree at a root (`openProjectFolder`, `openRecentProject`,
    `applySession`, the drop handler) with a silent dotfile failure whenever
    one is missed. The `setup` listener has no such call sites — it fires for
    the picker, the save dialog and native drag-and-drop alike, because all
    three go through the one runtime scope it watches. The cost is that it
    cannot cover a path no gesture granted, which is the `## Non-Goals` entry
    on session restore. Installing it in `setup` is safe: `Builder::build`
    initialises every plugin before `App::run` invokes the setup closure
    (`tauri-2.11.5/src/app.rs:2440` and `:2531`), so the plugin's scope state
    is already managed when `fs_scope()` asks for it.

[^escape]: The capability scope compiles its entries with `Pattern::new`,
    unescaped (`tauri-2.11.5/src/scope/fs.rs:200-203`), because entries are
    meant to be globs — that is what makes `$HOME/**` work. So a literal path
    spliced in raw is read as a glob too. A project at `/opt/notes [2026]`
    would become the pattern `/opt/notes [2026]`, whose `[2026]` is a
    character class: it would fail to match the real folder while granting
    `/opt/notes 2`, `/opt/notes 0` and `/opt/notes 6`. Escaping first and
    appending `/**` afterwards is what Tauri's own `Scope::allow_directory`
    does, through its `escaped_pattern_with` helper
    (`tauri-2.11.5/src/scope/fs.rs:489`). A forward slash is correct on Windows
    too: entries are re-split into path components before compiling, so
    `C:\x/**` and `C:\x\**` are the same pattern — and the existing capability
    file already writes `$HOME/**`.

[^mirror-forbidden]: Nothing in Loom or in the `fs`/`dialog` plugins calls
    `forbid_file`/`forbid_directory` on the runtime scope today, so the
    `PathForbidden` arm never fires. It is mirrored anyway so the function's
    contract is the simple one — the capability scope tracks the runtime
    scope — rather than "tracks it, except for denials". Handling only the
    allow direction would mean a future denial silently failed to apply on the
    scope that carries dotfile access, which is a security asymmetry for the
    sake of four lines.
