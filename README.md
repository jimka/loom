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
  [`src/fileIcons.ts`](src/fileIcons.ts) for the icon map. Hidden (leading-dot)
  and `.gitignore`-ignored entries are filtered out by default; the View
  menu's **Show Hidden Files** and **Show Ignored Files** toggles bring each
  class back independently. The tree follows changes made outside the app —
  another editor, a `git checkout`, a build tool — and editing a
  `.gitignore` re-filters everything below its own directory. A single
  click opens a file in a reusable temp tab; a double click opens it
  permanently. Right-clicking a directory, a file, or empty tree space opens
  a context menu offering New File/New Folder, Rename, Delete, and Copy
  Path.
- **Command palette** — Ctrl/Cmd+P opens a fuzzy file finder over every file
  in the project; arrow keys only move the highlight, and nothing opens or
  runs until you activate a result with Enter or a click. Typing `>` switches
  to a list of app commands — Save, Format Document, Toggle Explorer, and the
  rest of the menu bar — instead.
- **Welcome screen** — shown in place of the tab strip whenever no file is
  open, offering *Open Folder…* and naming the current project once one is.
- **Tabbed editing** — open several files at once, each tab carrying the
  same per-file-type icon the tree shows; a dirty-indicator dot marks
  unsaved changes per tab. A temp tab shows a `~` before its name and
  becomes permanent on the first edit, on a double-click in the tree, or on
  a *Save As*.
- **Breadcrumbs** — a path band above each editor showing where the open
  file sits inside the project folder.
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
  have a formatter (JavaScript/TypeScript, JSON, HTML, SQL, Markdown).
- **Settings** — an app-wide `settings.json` under Loom's config folder,
  and an optional per-project override at `<project>/.loom/settings.json`.
  *File > Open Settings* and *File > Open Workspace Settings* create and
  open each file directly. Covers whether saving reformats the document,
  the tree's default Show Hidden/Show Ignored state, the window title
  template, and the tab strip's width cap — see
  [`src/data/settings.ts`](src/data/settings.ts) for the full set and each
  one's default.

## Architecture

TypeScript + [Vite](https://vitejs.dev/) frontend, built on
`@jimka/typescript-ui`'s layout and editor components (`Tree`, `Tab`/`TabBar`,
`Split`, `MenuBar`, `CodeEditor`, `MarkdownViewer`); [Tauri v2](https://v2.tauri.app/) provides
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
