# Loom — Future Work / Backlog

Deferred features and known limitations, gathered from the initial
implementation plan's `## Non-Goals` and from live-testing feedback since.
The original plan lives in `typescript-ui`'s
[`plans/implemented/code-editor-desktop-app.md`](../typescript-ui/plans/implemented/code-editor-desktop-app.md) —
nothing below has a plan yet.

## Medium

- **IntelliSense / LSP** or any language service.
- **Git integration**, including a dirty-vs-committed indicator in the tree.
- **A *Split Editor* command.** Splitting the editor area is a drag gesture
  only — `Dock` exposes no programmatic split, so there is no menu item,
  palette command, or shortcut for it.
- **Re-saving the dock layout on a gutter drag.** `Dock` emits nothing when
  a split ratio changes, so a gutter drag inside the editor area is only
  persisted at the next dock event or on exit.

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
- **Multi-window / "open in new window."** Dragging a tab off the editor
  dock's strip already tears it off into an in-page floating window; what
  remains is making that a real Tauri OS window instead — an older idea
  from this project's history, relevant now that an app which could use it
  actually exists.
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
- **Frequent events wired to layout-forcing reads are still a trap — now
  scaled by what is visible, not by every open tab.** `Tab` used to hide
  inactive content with `visibility: hidden`, so every file ever opened kept
  its live `CodeEditor` participating in layout, and every forced reflow paid
  for all of them. `typescript-ui` now takes inactive tab pages
  (`display: none`, merged 2026-09-14) and settled-collapsed `Split` panes /
  `Border` regions (merged 2026-09-15) out of the render tree, restoring
  their scroll offsets on re-show; measured in the real shell, a gutter drag
  with ten tabs open went from 171 to 92 ms per frame, and one tab is
  unchanged. What remains is the general rule: a forced layout still costs
  in proportion to everything mounted *and visible* — each split group's
  active editor, a populated tree — so any per-keystroke or per-mousemove
  event wired to a layout-forcing read (`getBoundingClientRect`,
  `offsetWidth`, a `Text` measured through the library's off-screen probe,
  `Tree`/table virtualization math) pays that once per event. Two instances
  were found in the status bar, both a `Text` left on its default
  auto-measure, which at the time measured every `setText` through that
  probe and forced a synchronous reflow: the caret readout, re-measured on
  every `cursorchange` during a drag-select, and the language readout,
  re-set on every active-tab switch — `Tab.closeEntry` switches tabs on
  every close, so closing N tabs forced N extra reflows, visible as frame
  times staying elevated for seconds after closing tabs back down to one.
  Both are fixed the same way (measure the widest value once at startup,
  pin the preferred size, `setAutoMeasure(false)`; see
  `WIDEST_CURSOR_POSITION` / `WIDEST_SELECTION` / `WIDEST_LANGUAGE_ID` in
  `EditorController.ts`), and a before/after trace confirmed the clustered
  forced layouts gone. Since `typescript-ui` 0.10 an auto-measured `Text`
  measures a single line on a canvas, with no forced layout, so the pins
  may no longer be needed; they stay until a WebKitGTK Timeline recording
  of `npm run tauri:dev` shows they buy nothing. The probe is still used
  for wrapped text, text with leading, trailing or repeated whitespace, and
  a font the canvas cannot reproduce, so a new readout fed from a frequent
  event should be pinned the same way until then. Split editor groups
  multiply the visible-editor count, so they raise the per-event cost
  rather than lowering it.
- **A remembered tab outside the project root stays closed.** Launch
  restore grants the remembered project root and its subtree, nothing
  else, so a tab remembered from outside that root *and* outside
  `$HOME`/`$CONFIG` — a file reached through *Open Recent > Files*, say —
  is still refused on the next launch, and
  `EditorController.restoreFiles` skips it silently the way it skips any
  path that no longer reads. Covering it would widen the launch-time grant
  from one directory to an unbounded list of individually remembered
  files.
- **The visible editors' own resize work is the remaining gutter-drag cost.**
  Two perf rounds in `typescript-ui` (see its `plans/implemented/`: the
  forced-layout coalescing round across `Split`, `ScrollStrip`/`TabBar`,
  `Tree`, `Panel`, `Accordion`, `DragManager` and `AbstractWindow`; then the
  scroll-shadow edge strips, undisplayed inactive tab pages, collapsed panes
  leaving the render tree, and `ScrollStrip`'s clamp-signature read gate)
  removed the library's own per-frame costs from a gutter drag. Real-shell
  numbers, from the WebKitGTK harness Loom kept in `qa/` until 2026-09-21
  (software-rendered, rAF-paced synthetic drag, ms per frame): explorer
  gutter with one editor ≈70 against ≈52 with no project open; ten tabs
  171 → 92; in a 2×2 editor grid the horizontal gutter went 220 → 107, level
  with the vertical gutter's 112. What is left scales with the number of
  *visible* editors whose box changes — roughly 15–20 ms per frame each — and
  is CodeMirror's own re-measure on resize (its `measure`/`getScrollOffset`
  cycle, plus wrap points under `lineWrap`). Not investigated yet: whether
  Loom or the library could defer that re-measure to the settle frame of a
  drag (the coalescing shape the library now uses for its own resize reads)
  without visible lag, or whether it is already as cheap as it gets. Measure
  any attempt in WebKitGTK, not Chromium — paint and layout costs do not
  transfer between the two — with the library's QA app (`typescript-ui`'s
  `packages/qa`), whose `shell-deep` panel shows four editors and
  `code-document` one. Its numbers are not comparable with the figures
  above, which came from Loom's own shell; a WebKit Timeline recording of
  Loom under `npm run tauri:dev` shows whether a result holds in the app.
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
- **A renamed or moved folder comes back collapsed.** A re-listed folder
  keeps every entry that is still there, matched by path and kind, but a
  rename or move changes the path, so the entry is a new one: collapsed,
  with nothing loaded under it, and — when the rename came from outside
  Loom — unselected. Keeping it open would mean carrying the old node, and
  the path of everything loaded under it, over to the new name. `Tree` has
  no move primitive (`removeNode` then `insertNode` drops the node's state
  in between), and the watcher hands the tree plain paths, not rename
  pairs.

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
