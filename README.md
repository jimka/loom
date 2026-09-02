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
  directory as it's expanded.
- **Welcome screen** — shown in place of the tab strip whenever no file is
  open, offering *Open Folder…* and naming the current project once one is.
- **Tabbed editing** — open several files at once; a dirty-indicator dot
  marks unsaved changes per tab.
- **Session restore** — the last project folder, expanded tree directories,
  open tabs, and the explorer width all come back on the next launch. Once a
  project has been saved to once, its own tree expansion, open tabs, and
  split geometry travel with the project folder itself (in
  `.loom/workspace.json`) rather than only living in the app-wide file.
- **Save / Save As**, with an unsaved-changes prompt on closing a modified
  file or exiting with modified files open.
- **Syntax highlighting** for JavaScript/TypeScript (and their JSX/module
  variants), JSON, HTML, SQL, Markdown, CSS, and Python — see
  [`src/editor/languages.ts`](src/editor/languages.ts) for the extension map.
- **Format Document**, and a **Toggle Explorer** command to hide/show the
  file tree.

## Architecture

TypeScript + [Vite](https://vitejs.dev/) frontend, built on
`@jimka/typescript-ui`'s layout and editor components (`Tree`, `Tab`/`TabBar`,
`Split`, `MenuBar`, `CodeEditor`); [Tauri v2](https://v2.tauri.app/) provides
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
