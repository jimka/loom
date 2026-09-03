# Loom — Future Work / Backlog

Deferred features and known limitations, gathered from the initial
implementation plan's `## Non-Goals` and from live-testing feedback since.
The original plan lives in `typescript-ui`'s
[`plans/implemented/code-editor-desktop-app.md`](../typescript-ui/plans/implemented/code-editor-desktop-app.md) —
nothing below has a plan yet.

## High

- **Library `Tab.setTabGlyph` / `TabBar.setEntryGlyph`.** Neither exists
  today — `Tab` has `setTabName` but no glyph counterpart, and the
  `TabButton` that owns the icon is built once from the `glyph` option
  passed to `addTab`. Without it, a _Save As_ that changes a file's
  extension cannot re-icon its already-open tab.
- **Library `List` row-level enabled/disabled state.** `AbstractSelectableList`
  has no per-row disabled flag, only the whole list's `enabled`/`readOnly`, so
  the command palette filters out a disabled command instead of greying it
  out the way the menu bar does.
- **Library per-tab label styling.** `Tab.setTabName` sets a tab's text but
  nothing styles it, and `Tab` keeps its `TabBar` private, so Loom marks a
  temp tab with a `~` prefix instead of the italics VS Code uses.
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
- **Double-clicking a temp tab should pin it.** Today the only way to
  promote the strip's one temp tab to permanent is double-clicking the file
  in the tree, editing its content, or _Save As_ — double-clicking the tab
  itself in the strip does nothing special. VS Code's preview tabs pin the
  same way; `EditorController.pinTab` already exists, it just isn't wired to
  a tab-strip double-click yet.
- **Refresh an open file when it changes on disk.** `FileTree`'s filesystem
  watcher (`FileTree.refreshSubtree`) only updates the tree — it never
  touches an already-open `FileEditor`'s buffer. Two related gaps: a file
  edited externally while it's the _active_ tab should reload live, and
  switching to a tab whose file changed while unfocused should reload at
  that point too. Needs a real design decision for the conflict case first —
  an externally-changed file with unsaved local edits can't just silently
  overwrite either side.
- **Configurable formatting style.** `formatOnSave`/_Format Document_ only
  toggle _whether_ `CodeEditor.format()` runs — there's no control over
  _how_ it formats (indent width, quote style, line length, and so on).
  Needs research into what each per-language formatter `CodeEditor` wraps
  (JS/TS, JSON, HTML, SQL, Markdown) actually accepts as options, then
  surfacing whatever's available through the settings file.
- **Right clicking on empty space in FileTree** should show a context menu
  with options for creating a new file or folder, at the root of the
  workspace.
- **When typing in the command palette** I can't directly press enter to
  activate the first item. However, when I press down, the second item is
  selected. If I then press up again, I can then select the first row.
  This seems like a bug in the List component, or is it a behaviour in Loom?
- **Saving a file that I'm currently editing**, reloads the entire file and
  moves the scrollbar to the top, loosing the current work state.
- **In-file or cross-file search.**

## Medium

- **Split-pane multi-file editing.** `Dock` is the natural upgrade path if
  wanted later — it composes `Split` and `Tab` already, at the cost of
  tear-off windows, a panel registry, and `DockRegion` drop targets that
  phase one deliberately avoided.
- **IntelliSense / LSP** or any language service.
- **Git integration**, including a dirty-vs-committed indicator in the tree.

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
- **Stale tab icon after a cross-type _Save As_.** Saving `notes.md` as
  `notes.txt` leaves its already-open tab showing the Markdown icon until
  the tab is closed and reopened — the library has no way to re-icon a
  `Tab` in place (see the `Tab.setTabGlyph` item above). The status bar's
  language updates correctly.

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
