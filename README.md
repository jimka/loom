# Loom

A local desktop code editor, built on [`@jimka/typescript-ui`](https://github.com/jimka/typescript-ui)
and packaged as a native app with [Tauri](https://tauri.app/). Open a project
folder, browse it in a file tree, and edit multiple files in tabs with syntax
highlighting — no IntelliSense/LSP yet, CodeMirror-level highlighting and
formatting only.

## Status

An early, actively-evolving dogfood project for the underlying component
library — not published or packaged for distribution. Deferred features and
known limitations are tracked in [`TODO.md`](TODO.md).

## Highlights

- **File tree** — open a project folder, browse it, lazily loading each
  directory as it's expanded; each row shows a per-file-type icon — see
  [`src/fileIcons.ts`](src/fileIcons.ts) for the icon map. The tree's own
  collapsible sidebar section is titled with the open project's name (just
  *Files* before one is open). Hidden (leading-dot)
  and `.gitignore`-ignored entries are filtered out by default; the View
  menu's **Show Hidden Files** and **Show Ignored Files** toggles bring each
  class back independently. The tree follows changes made outside the app —
  another editor, a `git checkout`, a build tool — and editing a
  `.gitignore` re-filters everything below its own directory. A single
  click opens a file in a reusable temp tab; a double click opens it
  permanently. Right-clicking a directory, a file, or empty tree space opens
  a context menu offering New File/New Folder, Rename, Delete, and Copy
  Path.
- **Properties** — a second, collapsible section under the file tree,
  showing the selected file or folder's name, path, type, size, and
  last-modified time. Selecting a row with a click or the arrow keys updates
  it; with nothing selected it says so.
- **Command palette** — Ctrl/Cmd+P opens a fuzzy file finder over every file
  in the project; the first match is highlighted as soon as you type, so
  Enter opens it directly; arrow keys only move the highlight, and nothing
  opens or runs until you activate a result with Enter or a click. Typing `>`
  switches to a list of app commands — Save, Format Document, Toggle
  Explorer, and the rest of the menu bar — instead, with a command that can't
  run right now (Save with nothing to save, Find… with no file open) listed
  greyed out and doing nothing when activated, just as in the menu bar.
- **Find & replace** — Ctrl/Cmd+F opens CodeMirror's own find/replace bar
  over the active file's editor; every match in the document highlights as
  you type, Enter and Shift+Enter walk to the next and previous match, and
  the *match case*, *regexp*, and *by word* toggles refine the query.
  Replace one match at a time or all of them at once with *replace* and
  *replace all*.
- **Project search** — Ctrl/Cmd+Shift+F opens a **Search** section in the
  explorer sidebar; Enter runs a case-insensitive substring search over
  every file the command palette lists, results stream in as
  `path:line · matched line`, and clicking one opens the file with the
  match selected. A file too large to open, or that looks binary (a NUL
  byte in its first 8000 characters, git's own rule), is skipped.
- **Welcome screen** — shown in place of the tab strip whenever no file is
  open, under the Loom mark, offering *Open Folder…* and naming the current
  project once one is.
- **About** — a *Close*-only dialog on the far right of the menu bar, showing
  the Loom mark above the app's author and links to Loom's own repository and
  to the UI library it is built on.
- **Tabbed editing** — open several files at once, each tab carrying the
  same per-file-type icon the tree shows; a dirty-indicator dot marks
  unsaved changes per tab, staying visible even when a long file name is
  truncated. A temp tab renders its label in italics and
  becomes upright on the first edit, on a double-click in the tree, on a
  double-click of the tab itself, or on a *Save As*. The icon follows a
  *Save As* or a rename that changes the file's type, without the tab
  closing or reopening. Open tabs follow changes made outside the app too:
  a buffer with no unsaved changes reloads, and one with unsaved changes
  asks whether to reload from disk or keep them.
- **Breadcrumbs** — a path band above each editor showing where the open
  file sits inside the project folder.
- **Status bar** — the caret's line, column, and position in the document
  (`Ln 12, Col 5 · Pos 245`) sit at the right of the bar, left of the file's
  language; save and reload messages appear at the left.
- **Markdown preview** — a toggle on the breadcrumb band of any Markdown
  file swaps the editor for a rendered view of it, with a heading outline
  and width/zoom controls, that refreshes as the document changes.
- **Session restore** — the last project folder, expanded tree directories,
  open tabs, and the explorer width all come back on the next launch. Once a
  project has been saved to once, its own tree expansion, open tabs, and
  split geometry travel with the project folder itself (in
  `.loom/workspace.json`) rather than only living in the app-wide file.
- **Recent Projects & Files** — reopen a recently-used project folder or
  file from the File menu's *Open Recent* submenu, or a recent project from
  the welcome screen.
- **Drag-and-drop to open** — dropping a file from the OS onto the window
  opens it in a tab, and dropping a single folder opens it as the project,
  raising the same prompts a Recent Projects entry does when a workspace is
  already open.
- **New files** — *File > New File* (Ctrl/Cmd+N) opens an empty, untitled
  tab; *Save* prompts for a location the first time it's saved.
- **Save / Save As**, with an unsaved-changes prompt on closing a modified
  file or exiting with modified files open.
- **Syntax highlighting** for JavaScript/TypeScript (and their JSX/module
  variants), JSON, HTML, SQL, Markdown, CSS, and Python — see
  [`src/editor/languages.ts`](src/editor/languages.ts) for the extension map.
- **Format Document**, and a **Toggle Explorer** command to hide/show the
  file tree. Saving reformats the document first, for the languages that
  have a formatter (JavaScript/TypeScript, JSON, HTML, SQL, Markdown), in
  whatever style the settings file's `formatting` block asks for.
- **Settings** — an app-wide `settings.json` under Loom's config folder,
  and an optional per-project override at `<project>/.loom/settings.json`.
  *File > Open Settings* and *File > Open Workspace Settings* create and
  open each file directly. Covers whether saving reformats the document and
  in what style (indent width, line width, quote style, and the rest — per
  language, only where that language's formatter honours the field), the
  tree's default Show Hidden/Show Ignored state, the window title template,
  and the tab strip's width cap — see
  [`src/data/settings.ts`](src/data/settings.ts) for the full set and each
  one's default.

## Architecture

TypeScript + [Vite](https://vitejs.dev/) frontend, built on
`@jimka/typescript-ui`'s layout and editor components (`Tree`, `Tab`/`TabBar`,
`Split`, `Accordion`, `MenuBar`, `CodeEditor`, `MarkdownViewer`); [Tauri v2](https://v2.tauri.app/) provides
the native shell and the filesystem/dialog access the frontend calls through
`src/data/workspace.ts`, the app's sole `@tauri-apps/*` entry point.

## Development

```bash
npm install
npm run tauri:dev
```

`tauri:dev` is the real dev flow — it launches the native window backed by
Tauri's filesystem and dialog plugins. `npm run dev` alone only serves the
web frontend via Vite (useful for quick UI iteration), without those native
plugins, so folder/file access won't work in a browser tab.

- `npm run typecheck` — strict TypeScript check, no emit.
- `npm test` — run the vitest suite.
- `npm run build` — frontend production build.
- `npm run tauri:build` — bundled native app.

## Licensing

Loom is licensed under the PolyForm Noncommercial License 1.0.0, matching
`@jimka/typescript-ui`, the library it's built to exercise.
