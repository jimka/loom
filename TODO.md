# Loom — Future Work / Backlog

Deferred features and known limitations, gathered from the initial
implementation plan's `## Non-Goals` and from live-testing feedback since.
The original plan lives in `typescript-ui`'s
[`plans/implemented/code-editor-desktop-app.md`](../typescript-ui/plans/implemented/code-editor-desktop-app.md) —
nothing below has a plan yet.

## High
- **Split-pane multi-file editing.** `Dock` is the natural upgrade path if
  wanted later — it composes `Split` and `Tab` already, at the cost of
  tear-off windows, a panel registry, and `DockRegion` drop targets that
  phase one deliberately avoided.
## Medium

- **IntelliSense / LSP** or any language service.
- **Git integration**, including a dirty-vs-committed indicator in the tree.

## Low

- **Interruptible project-search matching.** A pathological regular
  expression (nested quantifiers over a very long line) blocks the main
  thread until that line's match attempt finishes, because JavaScript
  cannot interrupt a running `RegExp.exec`; the walk's per-file `await`
  keeps the panel responsive between files, and the `maxFiles`/`maxMatches`
  ceilings bound the run, but the only real fix is matching off the main
  thread in a worker.
- **An extension / plugin system.**
- **A browser build** — the app calls the Tauri plugins directly with no
  fallback; would need a second filesystem implementation no user runs.
- **Code signing, auto-update, and a multi-platform bundle matrix** —
  `npm run tauri:build` currently produces an unsigned local bundle only.
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
- **External links depend on the webview.** The About dialog's *Source* and
  *UI library* links render as `target="_blank"` anchors — the library's
  Markdown default. Loom wires no opener/shell plugin (see the plugin list
  under `## Notes`), so whether a click reaches the system browser is up to
  the platform's webview. Each link's text is the URL itself, so the
  address stays readable either way.
- **Inactive tabs stay in the layout tree — a standing forced-reflow trap.**
  `Tab`'s layout manager hides every non-active tab's content with
  `setVisible(false)`, which is `visibility: hidden`, not `display: none` —
  so every file ever opened in a session keeps its live `CodeEditor` (gutter,
  decorations, and all) participating in layout, even years into an editing
  session with dozens of tabs open. This already caused one real bug: the
  status bar's caret readout re-measured itself on every `cursorchange`
  (`Text.setText`'s default auto-measure forces a synchronous
  `getBoundingClientRect` reflow), and `cursorchange` fires continuously
  during drag-select — cheap on the library's own demo panels (one or two
  editors ever mounted), but scaling with every open tab in real Loom usage,
  which made selection dragging feel sluggish. Fixed for that one call site
  by fixing the readout's width and disabling auto-measure (see
  `EditorController.ts`'s `WIDEST_CURSOR_POSITION`), but the underlying trap
  is still there: any future feature that wires a frequent, per-keystroke or
  per-mousemove event to a layout-forcing read (`getBoundingClientRect`,
  `offsetWidth`, a `Text`/`Component` auto-measure, `Tree`/table
  virtualization math) will pay a cost proportional to every open tab, not
  just the active one. The real fix would be giving `Tab` a `display: none`
  (or unmount) path for inactive content instead of `visibility: hidden`.
- **A remembered tab outside the project root stays closed.** Launch
  restore grants the remembered project root and its subtree, nothing
  else, so a tab remembered from outside that root *and* outside
  `$HOME`/`$CONFIG` — a file reached through *Open Recent > Files*, say —
  is still refused on the next launch, and
  `EditorController.restoreFiles` skips it silently the way it skips any
  path that no longer reads. Covering it would widen the launch-time grant
  from one directory to an unbounded list of individually remembered
  files.
- **Three hint labels stay a hardcoded mid-grey under both themes.**
  `SearchPanel.ts`, `PropertiesPanel.ts`, and `WelcomeScreen.ts` each paint a
  de-emphasised hint text `rgb(140, 140, 140)`, and the `Theme` interface has
  no muted/secondary-text token to replace it with — the nearest candidates
  (`button.description.foreground`, the various `disabledColor`s) are
  semantically wrong for a hint. Left alone, but not because it is
  accessible: mid-grey falls short of WCAG 2.1's 4.5:1 body-text contrast
  threshold in five of the six label/background/theme combinations — as low
  as 3.08:1 for `SearchPanel.ts`'s status text against the light theme's
  toolbar background — and clears it only for `PropertiesPanel.ts`'s hint
  against the plain dark-theme background (4.96:1). This is a known,
  pre-existing readability gap, not a deliberate tradeoff; fixing it
  properly needs a `text.muted` token in the library first, not a
  Loom-side color pick.

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
