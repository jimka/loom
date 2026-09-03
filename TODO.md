# Loom — Future Work / Backlog

Deferred features and known limitations, gathered from the initial
implementation plan's `## Non-Goals` and from live-testing feedback since.
The original plan lives in `typescript-ui`'s
[`plans/implemented/code-editor-desktop-app.md`](../typescript-ui/plans/implemented/code-editor-desktop-app.md) —
nothing below has a plan yet.

## Medium

- **Opening dotfiles in a workspace outside `$HOME`/`$CONFIG`.** Fixed for
  the common case by `plugins.fs.requireLiteralLeadingDot: false` in
  `src-tauri/tauri.conf.json` (see commit `ed29f86`): the capability-
  declared `fs:scope` (`$HOME/**`, `$CONFIG/loom/**`) now matches
  dot-prefixed path components, so `.gitignore` etc. open normally in any
  project under the user's home directory. The gap that's left is the
  folder picker's own runtime scope grant (`window.try_fs_scope()` on the
  Tauri side) — it's built once at plugin startup from Tauri's hardcoded
  Unix default and never reads this config value, so a workspace opened
  from entirely outside `$HOME`/`$CONFIG` would still have its dotfiles
  blocked.
- **Split-pane multi-file editing.** `Dock` is the natural upgrade path if
  wanted later — it composes `Split` and `Tab` already, at the cost of
  tear-off windows, a panel registry, and `DockRegion` drop targets that
  phase one deliberately avoided.
- **IntelliSense / LSP** or any language service.
- **In-file or cross-file search.**
- **Git integration**, including a dirty-vs-committed indicator in the tree.
- **Filesystem watching** — the tree does not react to changes made outside
  the app; there is not even a manual refresh today. A refresh must re-run
  the tree's hidden/`.gitignore` filter, not just relist; a changed
  `.gitignore` invalidates the whole subtree below its own directory, not
  just the directory it sits in.
- **Temp tabs.** When browsing files (single-click / tree navigation), reuse
  one transient tab instead of opening a new permanent one; a tab becomes
  permanent once the user edits the file or double-clicks it. (The common
  "preview tab" pattern.)
- **Reselect tab when reselecting a file in the tree.** Re-clicking a tree
  row that's already the sole selection does nothing today — the library's
  `Tree` only emits `"selection"` on a change to the selected-node set, not
  on a same-selection re-click. This is already called out as a known
  limitation in the implementation plan's `## Implementation Notes`, which
  found `"dblclick"` doesn't close the gap either (fires on double-click, not
  the single click this needs). Likely does need a library change: a
  click-level `Tree` event distinct from selection-level, or a deliberately
  scoped exception to reach past `Tree`'s own event surface.
- **Quick-open / fuzzy file finder (Ctrl+P)** — distinct from cross-file
  content search, above: this is file-name navigation, not content search.
- **Format-on-save.** `CodeEditor.format()` is already exposed and wired to
  a manual *Format* menu action; running it automatically before write is
  the natural follow-on.
- **Drag-and-drop to open** a file or folder onto the window.
- **Library `Tab.setTabGlyph` / `TabBar.setEntryGlyph`.** Neither exists
  today — `Tab` has `setTabName` but no glyph counterpart, and the
  `TabButton` that owns the icon is built once from the `glyph` option
  passed to `addTab`. Without it, a *Save As* that changes a file's
  extension cannot re-icon its already-open tab.

## Low

- **An extension / plugin system.**
- **A browser build** — the app calls the Tauri plugins directly with no
  fallback; would need a second filesystem implementation no user runs.
- **Code signing, auto-update, and a multi-platform bundle matrix** —
  `npm run tauri:build` currently produces an unsigned local bundle only.
- **App-level theme switching (light/dark).** Loom never calls into
  `ThemeManager` today, so it's stuck on whatever the library defaults to;
  the library already ships a `DarkTheme` to switch to.
- **Multi-window / "open in new window."** Connects to an older idea from
  this project's history: making `Dock`'s tear-off spawn a real Tauri OS
  window instead of an in-page floating one — relevant now that an app
  which could use it actually exists.
- **Merge the menu bar into the window's title bar** (VS Code/Discord-style,
  Windows/Linux only). Today the native OS title bar and Loom's own
  `MenuBar` (built in `EditorShell.ts`, NORTH of the content) render as two
  separate rows, since `src-tauri/tauri.conf.json` doesn't set
  `decorations`. Merging them means going decorationless
  (`"decorations": false`) and hand-building the header: a
  `data-tauri-drag-region` wrapper around the menu row for window
  dragging/double-click-to-maximize, plus custom minimize/maximize/close
  buttons via `@tauri-apps/api/window`. macOS is a separate case — the OS
  convention keeps File/Edit/View in the global top-of-screen menu bar, not
  the window itself, so a true merge doesn't apply there; at most a
  `titleBarStyle: "overlay"` treatment to extend content under the traffic
  lights.

## Known issues / loose ends

- **WebKitGTK rendering quirks (Linux only).** General visual glitches
  reported during live testing, plus a specific confirmed case: the `Split`
  gutter's resize cursor (`ew-resize`/`ns-resize`) never updates on hover or
  drag, even though the drag itself works — traced to the library's cursor
  mechanism (plain CSS `cursor`, no custom images, standard APIs throughout),
  ruling out a code-level cause. WebKitGTK has a known history of not
  repainting the cursor promptly (or at all) on script-driven style changes.
  No fix planned; recorded so it isn't mistaken for a regression later.
- **Stale tab icon after a cross-type *Save As*.** Saving `notes.md` as
  `notes.txt` leaves its already-open tab showing the Markdown icon until
  the tab is closed and reopened — the library has no way to re-icon a
  `Tab` in place (see the `Tab.setTabGlyph` item above). The status bar's
  language updates correctly; the tree, per the Filesystem watching item
  above, shows no row for `notes.txt` at all until its directory is loaded
  again — the project is reopened, or, if the directory was never expanded
  in this session, expanded for the first time. Collapsing and
  re-expanding an already-loaded directory does not reload it, so the tab
  icon is stale for longer than the tree row even exists.

## Notes

- **Native menus, dialogs, and other OS chrome are available via Tauri**, not
  just the library's own components. VSCode itself is a native/custom hybrid
  on Electron: a real native menu bar on macOS, native open/save dialogs and
  clipboard access, but a custom HTML-rendered menu bar and context menus on
  Windows/Linux for consistent theming. Tauri's equivalents, if ever wanted:
  - `tauri::menu` (core, `@tauri-apps/api/menu`) — a real native menu bar and
    native popup context menus; the direct swap-in for the library's `Menu`
    component, at the cost of losing its theming and needing IPC plumbing per
    menu action.
  - `plugin-window-state` — persists/restores window size and position
    automatically; only covers geometry, not the rest of session state.
  - `plugin-clipboard-manager`, `plugin-notification`, `plugin-global-shortcut`,
    `plugin-os`, `plugin-shell` (open-with-default-app / run commands).
  - `plugin-updater` — relevant to the code signing/auto-update item, above.
  - Native OS drag-and-drop (`onDragDropEvent`) — relevant to the
    drag-and-drop-to-open item, above.
  - No official plugin exists for native OS file-type icons — the tree and
    tabs draw their per-file-type icons from Font Awesome instead (see
    [`src/fileIcons.ts`](src/fileIcons.ts)); matching the OS's own icon set
    would need a custom Rust crate.
- **Frontend hot reload today is a full page reload, not a state-preserving
  one** — the library has no HMR accept boundary (it isn't React, so there's
  no fast-refresh mechanism), so any source edit during `tauri:dev` drops the
  open tree/tabs, same as a full restart. Session persistence now fixes this
  as a side effect: a Vite-triggered reload is a page reload within the same
  webview, not a process restart, so the tree, tabs, and split — persisted to
  disk — come back exactly like a real restart brings them back. It still
  doesn't cover unsaved buffer contents, which are not persisted.
