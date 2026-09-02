# File Type Icons — Implementation Plan

## Overview

The file tree draws one of two icons today — `folder` for a directory,
`file-code` for everything else
([src/explorer/FileTree.ts:37](src/explorer/FileTree.ts#L37)) — and the tab
strip draws none at all
([src/EditorController.ts:112](src/EditorController.ts#L112)). This plan gives
both a per-file-type icon: a TypeScript file gets the JavaScript mark, a PNG
gets an image icon, an unrecognised file keeps a plain page.

The work adds one module, `src/fileIcons.ts`, holding two lookup tables
(exact base name, then extension) plus the list of icon definitions the app
must register. Three existing source files change: `FileTree` swaps its icon
resolver, `EditorController` passes a `glyph` when it opens a tab, and
`main.ts` registers the new icons alongside the ones it already registers
([src/main.ts:19](src/main.ts#L19)).

No new dependency is added. The icons are Font Awesome Free glyphs that
`@jimka/typescript-ui` already ships and Loom already draws from.

---

## Architecture Decisions

### Icons come from the library's bundled Font Awesome set

Every icon is a `NamedGlyphDef` imported from
`@jimka/typescript-ui/glyphs/solid/<name>` or
`@jimka/typescript-ui/glyphs/brands/<name>`, one module per icon, and drawn
through the library's `Glyph` component.[^icon-source] This is the same
source [src/main.ts:4](src/main.ts#L4) already draws the menu-bar and tree
icons from.

### The icon table is its own map, not derived from `languageForPath`

`src/fileIcons.ts` gets its own extension-keyed table rather than mapping
[src/editor/languages.ts:35](src/editor/languages.ts#L35)'s language ids to
icons.[^own-map] The new module mirrors `languages.ts` structurally — a
`Record<string, …>` keyed by `extensionOf(path)`, a module-scope constant per
lookup table, one exported lookup function — and reuses the same
`extensionOf` helper from [src/data/paths.ts:24](src/data/paths.ts#L24).

### An exact base-name table is checked before the extension table

Files whose type lives in the whole name rather than the suffix — `.gitignore`,
`Dockerfile`, `package.json` — need a first lookup on the lowercased base
name.[^base-name] The extension table is consulted only when the base-name
table misses.

| Path | Base name (lowercased) | Extension | Icon | Why |
|---|---|---|---|---|
| `/p/src/main.ts` | `main.ts` | `ts` | `js` | no base-name row; extension row `ts` |
| `/p/package.json` | `package.json` | `json` | `node-js` | base-name row beats extension row `json` → `file-code` |
| `/p/.gitignore` | `.gitignore` | `""` | `git-alt` | base-name row; `extensionOf` yields `""` for a dotfile |
| `/p/Dockerfile` | `dockerfile` | `""` | `docker` | base-name row, matched after lowercasing |
| `/p/notes.bin` | `notes.bin` | `bin` | `file` | neither table has a row → default |

### The module exports the icon definitions rather than registering them

`src/fileIcons.ts` exports `FILE_ICON_GLYPHS`, built from its own two tables,
and `main.ts` spreads that array into its existing `Glyph.register` call.
Registration stays at the composition root, and the list cannot fall behind
the tables it is derived from.[^register-at-root]

### Neither the tree nor the tab strip needs a library change

`TabPanel.addTab(component, label, { closeable, glyph })` already accepts a
registry glyph name and renders it leading the tab label
([../typescript-ui/packages/lib/src/typescript/lib/component/container/TabPanel.ts:139](../typescript-ui/packages/lib/src/typescript/lib/component/container/TabPanel.ts#L139)).
No library change is needed for the tab strip, and none for the tree either —
`IconLabelTreeNodeRenderer` already takes a per-row icon-name resolver
([../typescript-ui/packages/lib/src/typescript/lib/component/tree/renderer/IconLabel.ts:36](../typescript-ui/packages/lib/src/typescript/lib/component/tree/renderer/IconLabel.ts#L36)).

### A tab's icon is fixed when the tab opens

`Tab` can rename a tab after the fact but cannot re-icon one, so a *Save As*
that changes a file's extension leaves the tab showing the icon of the
original type until the file is closed and reopened.[^save-as-stale] The tree
is unaffected: it re-resolves the icon on every row render. This plan accepts
the stale tab icon and records it in `TODO.md`.

---

## Public API

`src/fileIcons.ts` exports two symbols:

```ts
/**
 * Resolves the Glyph registry name for a file, from its base name first and
 * its extension second. A file matching neither table gets the plain-page
 * default, so this never returns an unregistered name.
 *
 * @param path - The file path.
 * @returns A glyph registry name that is always present in `FILE_ICON_GLYPHS`.
 */
export function glyphNameForPath(path: string): string
```

```ts
/**
 * Every glyph definition the two tables can return, deduplicated. `main.ts`
 * registers these. `glyphNameForPath` never returns a name outside this list,
 * because `new Glyph(name)` throws on an unregistered name.
 */
export const FILE_ICON_GLYPHS: readonly NamedGlyphDef[]
```

`NamedGlyphDef` is imported **as a type only**:

```ts
import type { NamedGlyphDef } from '@jimka/typescript-ui/component/display'
```

A value import from that barrel would break the project's Node-environment
unit tests.[^type-only]

---

## Internal Structure

`src/fileIcons.ts` holds four constants and one function. Sketch — the full
table rows are given in `## Expected Behaviour`:

```ts
const BASE_NAME_TO_GLYPH: Record<string, NamedGlyphDef> = { … }
const EXTENSION_TO_GLYPH: Record<string, NamedGlyphDef> = { … }

/** Shown for any file neither table recognises. */
const DEFAULT_GLYPH: NamedGlyphDef = file

export const FILE_ICON_GLYPHS: readonly NamedGlyphDef[] = Array.from(new Set<NamedGlyphDef>([
  ...Object.values(BASE_NAME_TO_GLYPH),
  ...Object.values(EXTENSION_TO_GLYPH),
  DEFAULT_GLYPH,
]))

export function glyphNameForPath(path: string): string {
  const byName = BASE_NAME_TO_GLYPH[baseName(path).toLowerCase()]

  if (byName) {
    return byName.name
  }

  return (EXTENSION_TO_GLYPH[extensionOf(path)] ?? DEFAULT_GLYPH).name
}
```

Both tables are typed `Record<string, NamedGlyphDef>` and indexed without an
`undefined` in the type, matching how
[src/editor/languages.ts:9](src/editor/languages.ts#L9) declares and indexes
`EXTENSION_TO_LANGUAGE`. The project does not enable
`noUncheckedIndexedAccess`, so the `if (byName)` guard and the `??` fallback
are the runtime checks.

Import each icon as its own module, so a bundler drops the several thousand
unused ones:

```ts
import { js } from '@jimka/typescript-ui/glyphs/brands/js'
import { file } from '@jimka/typescript-ui/glyphs/solid/file'
```

---

## Ordered Implementation Steps

1. **Add `tests/fileIcons.test.ts`** covering every case in
   `## Expected Behaviour`. Import `glyphNameForPath` and `FILE_ICON_GLYPHS`
   from `../src/fileIcons`. Mirror the shape of
   [tests/languages.test.ts](tests/languages.test.ts) — one `describe`, one
   `it` per case, plain `expect(...).toBe(...)`. The suite fails to resolve
   the module at this point; that is the expected red state.

2. **Add `src/fileIcons.ts`** with the two tables, `DEFAULT_GLYPH`,
   `FILE_ICON_GLYPHS`, and `glyphNameForPath`, exactly as sketched in
   `## Internal Structure` and populated from the tables in
   `## Expected Behaviour`. Open the file with a `//` header comment saying
   what the module is, following
   [src/editor/languages.ts:1](src/editor/languages.ts#L1) and
   [src/data/paths.ts:1](src/data/paths.ts#L1). Import `baseName` and
   `extensionOf` from `./data/paths`. Do **not** call `Glyph.register` here.
   Run `npm test` — the new suite must now pass.

3. **Point the tree at the new resolver.** In
   [src/explorer/FileTree.ts:37](src/explorer/FileTree.ts#L37), replace the
   resolver body so a directory still yields `'folder'` and a file yields
   `glyphNameForPath(data.path)`:

   ```ts
   this.setRendererFactory(() => new IconLabelTreeNodeRenderer(
     node => {
       const data = node.data as FileTreeNodeData

       return data.isDir ? 'folder' : glyphNameForPath(data.path)
     },
   ))
   ```

   Add `import { glyphNameForPath } from '../fileIcons'`.

4. **Give new tabs an icon.** In
   [src/EditorController.ts:112](src/EditorController.ts#L112), change the
   `addTab` call to
   `this.tabs.addTab(file, file.getLabel(), { closeable: true, glyph: glyphNameForPath(path) })`.
   Add `import { glyphNameForPath } from './fileIcons'`. Leave
   [src/EditorController.ts:171](src/EditorController.ts#L171)'s `setTabName`
   alone — there is no glyph counterpart to call.

5. **Register the new icons.** In [src/main.ts:19](src/main.ts#L19), spread
   the new list into the existing call:
   `Glyph.register(folder, floppy_disk, times, pen_to_square, eye, bars, code, right_from_bracket, ...FILE_ICON_GLYPHS)`.
   Delete the now-unused `file_code` import at
   [src/main.ts:5](src/main.ts#L5) — `fileIcons.ts` owns that icon now. Add
   `import { FILE_ICON_GLYPHS } from './fileIcons'`. Update the comment above
   the call so it still describes what is being registered.

6. **Checkpoint:** `grep -rn "file_code\|'file-code'" src/ tests/` — expect
   matches only inside `src/fileIcons.ts` and `tests/fileIcons.test.ts`.

7. **Update `README.md`.** In *Highlights*, say the *File tree* and *Tabbed
   editing* bullets now carry a per-file-type icon, and point at
   `src/fileIcons.ts` for the map — the same way the *Syntax highlighting*
   bullet points at `src/editor/languages.ts`.

8. **Update `TODO.md`.** Remove the **File type icons** bullet from `## High`.
   Add to `## Medium`: a library item for a `Tab.setTabGlyph` /
   `TabBar.setEntryGlyph` pair, noting that without it a *Save As* across file
   types cannot re-icon its tab. Add to `## Known issues / loose ends`: the
   stale tab icon after such a *Save As*, and that the tree and status bar do
   update.

9. **Verify** per `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `src/fileIcons.ts` |
| Create | `tests/fileIcons.test.ts` |
| Modify | `src/explorer/FileTree.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `src/main.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### The two tables

`BASE_NAME_TO_GLYPH` — keys are lowercased base names:

| Key | Icon module | Registry name |
|---|---|---|
| `.gitignore`, `.gitattributes`, `.gitmodules` | `brands/git_alt` | `git-alt` |
| `dockerfile` | `brands/docker` | `docker` |
| `package.json`, `package-lock.json` | `brands/node_js` | `node-js` |
| `cargo.toml`, `cargo.lock` | `brands/rust` | `rust` |
| `makefile`, `.env` | `solid/gear` | `gear` |

`EXTENSION_TO_GLYPH` — keys are lowercased extensions, as `extensionOf`
returns them:

| Keys | Icon module | Registry name |
|---|---|---|
| `js`, `jsx`, `mjs`, `cjs`, `ts`, `tsx`, `mts`, `cts` | `brands/js` | `js` |
| `py` | `brands/python` | `python` |
| `html`, `htm` | `brands/html5` | `html5` |
| `css` | `brands/css3_alt` | `css3-alt` |
| `scss`, `sass` | `brands/sass` | `sass` |
| `md`, `markdown` | `brands/markdown` | `markdown` |
| `rs` | `brands/rust` | `rust` |
| `sql`, `db`, `sqlite` | `solid/database` | `database` |
| `sh`, `bash`, `zsh`, `ps1`, `bat`, `cmd` | `solid/terminal` | `terminal` |
| `json`, `xml` | `solid/file_code` | `file-code` |
| `toml`, `yaml`, `yml`, `ini`, `cfg`, `conf` | `solid/gear` | `gear` |
| `txt`, `log` | `solid/file_lines` | `file-lines` |
| `csv`, `tsv` | `solid/file_csv` | `file-csv` |
| `png`, `jpg`, `jpeg`, `gif`, `svg`, `webp`, `ico`, `bmp` | `solid/file_image` | `file-image` |
| `pdf` | `solid/file_pdf` | `file-pdf` |
| `zip`, `tar`, `gz`, `tgz`, `xz`, `7z`, `rar` | `solid/file_zipper` | `file-zipper` |

`DEFAULT_GLYPH` is `solid/file`, registry name `file`. There are 20 distinct
icons in total.

### `glyphNameForPath` — unit-testable

| Input | Result | Case |
|---|---|---|
| `/p/src/main.ts` | `'js'` | extension hit |
| `/p/src/app.tsx` | `'js'` | every JavaScript-family extension shares one icon |
| `/p/style.CSS` | `'css3-alt'` | uppercase extension, lowercased by `extensionOf` |
| `/p/README.md` | `'markdown'` | extension hit |
| `/p/package.json` | `'node-js'` | base-name row beats the `json` extension row |
| `/p/other.json` | `'file-code'` | extension row, no base-name row |
| `/p/.gitignore` | `'git-alt'` | dotfile — `extensionOf` returns `''`, base name matches |
| `/p/Dockerfile` | `'docker'` | extensionless name, matched after lowercasing |
| `/p/DOCKERFILE` | `'docker'` | base-name match is case-insensitive |
| `/p/src-tauri/Cargo.toml` | `'rust'` | base-name row beats the `toml` extension row |
| `/p/other.toml` | `'gear'` | extension row, no base-name row |
| `/p/notes.bin` | `'file'` | unknown extension → default |
| `/p/Makefile` | `'gear'` | extensionless name in the base-name table |
| `C:\p\src\main.ts` | `'js'` | backslash path — `baseName` splits on both separators |

### `FILE_ICON_GLYPHS` — unit-testable

- Contains no duplicates: `new Set(FILE_ICON_GLYPHS.map(g => g.name)).size ===
  FILE_ICON_GLYPHS.length`.
- Covers every result `glyphNameForPath` can produce: for each path in the
  table above, `FILE_ICON_GLYPHS.some(g => g.name === glyphNameForPath(path))`
  is `true`. This is the test that stops a table row from referencing an icon
  the app never registers, which would throw at render time.

### Rendering — manual verification only

The test harness runs in Node with no DOM
([vitest.config.ts](vitest.config.ts)), so none of the following is
automatable:

- Opening Loom's own folder shows the JavaScript mark on `vite.config.ts` and
  every file under `src/`, the Node mark on `package.json`, the Git mark on
  `.gitignore`, the Markdown mark on `README.md`, the Rust mark on
  `src-tauri/Cargo.toml`, and the code-page icon on `tsconfig.json`.
- Directories still show `folder`, expanded or collapsed.
- Opening a file adds a tab whose label is preceded by the same icon the tree
  row shows.
- Icons stay put while scrolling a long directory — the row renderer pools and
  rebinds rows, so an icon must follow its row rather than its slot.
- A *Save As* from `notes.md` to `notes.txt` leaves the tab icon on the
  Markdown mark (the accepted limitation) while the tree row for the new file
  shows the text-lines icon and the status bar clears the language.

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — the 28 existing tests still pass, plus the new
  `tests/fileIcons.test.ts` cases.
- `grep -rn "file_code" src/main.ts` — expect zero matches.
- `grep -rn "'file-code'" src/explorer/FileTree.ts` — expect zero matches.
- `npm run build` — the frontend bundle builds.
- `npm run tauri:dev`, then *File → Open Folder…* on the Loom repo itself, and
  walk the manual checks listed under `## Expected Behaviour`.

---

## Documentation Impact

- `README.md` — the *File tree* and *Tabbed editing* highlights gain the
  per-file-type icon behaviour and a pointer to `src/fileIcons.ts`, mirroring
  the *Syntax highlighting* bullet's pointer to `src/editor/languages.ts`.
- `TODO.md` — the `## High` entry is removed; a library `Tab.setTabGlyph`
  entry is added to `## Medium`; the stale-tab-icon case is added to
  `## Known issues / loose ends`.

Loom publishes no API docs and has no barrel file, so there is nothing else to
update.

---

## Potential Challenges

- **An unregistered name throws.** `new Glyph(name)` raises
  `Unknown glyph: <name>`
  ([../typescript-ui/packages/lib/src/typescript/lib/component/display/Glyph.ts:263](../typescript-ui/packages/lib/src/typescript/lib/component/display/Glyph.ts#L263)),
  and the tree builds one per row. Deriving `FILE_ICON_GLYPHS` from the tables
  rather than hand-listing it removes the failure mode; the coverage test in
  `## Expected Behaviour` guards it.
- **Importing the wrong barrel breaks the tests.** Keep `NamedGlyphDef` a
  type-only import and never import `Glyph` itself into `src/fileIcons.ts`.
- **Icon churn while scrolling.** `IconLabelTreeNodeRenderer` disposes and
  rebuilds its `Glyph` whenever the resolved name changes
  ([../typescript-ui/packages/lib/src/typescript/lib/component/tree/renderer/IconLabel.ts:99](../typescript-ui/packages/lib/src/typescript/lib/component/tree/renderer/IconLabel.ts#L99)),
  so a mixed-type directory rebuilds more icons than today's two-name tree
  does. No mitigation is in scope; watch for scroll stutter during the manual
  pass and report it against the library if it appears.
- **Brand marks at 16px.** Icons render monochrome at the theme's `glyphLg`
  step. Check during the manual pass that `js`, `python`, `rust`, and
  `node-js` stay distinguishable; swap a row to a `solid/file_code` icon if
  one does not.

---

## Critical Files

- [src/editor/languages.ts](src/editor/languages.ts) — the structural
  precedent `src/fileIcons.ts` follows: an extension-keyed `Record` fed by
  `extensionOf`, and one exported lookup function over it. Its module-scope
  `registerLanguage` call is the one part `src/fileIcons.ts` does *not* copy,
  for the reason given in `## Architecture Decisions`.
- [src/data/paths.ts](src/data/paths.ts) — `baseName` and `extensionOf`, and
  exactly what they return for dotfiles and extensionless names.
- [src/main.ts](src/main.ts) — the composition root and its single
  `Glyph.register` call.
- [src/explorer/FileTree.ts](src/explorer/FileTree.ts) — the icon resolver
  being replaced, and the `FileTreeNodeData` shape it reads.
- [src/EditorController.ts](src/EditorController.ts) — the `addTab` call and
  the *Save As* path.
- [tests/languages.test.ts](tests/languages.test.ts) — the test file to mirror.
- [../typescript-ui/packages/lib/src/typescript/lib/component/tree/renderer/IconLabel.ts](../typescript-ui/packages/lib/src/typescript/lib/component/tree/renderer/IconLabel.ts) —
  `IconLabelGlyphResolver` and how the icon is rebuilt per row.
- [../typescript-ui/packages/lib/src/typescript/lib/component/container/TabPanel.ts](../typescript-ui/packages/lib/src/typescript/lib/component/container/TabPanel.ts) —
  `addTab`'s `glyph` option.
- [../typescript-ui/packages/lib/src/typescript/lib/glyphs/README.md](../typescript-ui/packages/lib/src/typescript/lib/glyphs/README.md) —
  the icon-module naming rules (`-` becomes `_` in the identifier, the
  hyphenated upstream name survives as `def.name`).

---

## Non-Goals

- **Native OS file-type icons.** No official Tauri plugin exists for them, per
  `TODO.md`'s `## Notes`; a custom Rust crate is out of proportion to the
  feature.
- **Coloured icons.** `IconLabelTreeNodeRenderer` exposes no colour hook, so
  every icon inherits the row's foreground. Per-type colour would need a
  library change.
- **A `folder-open` icon for expanded directories.** The row resolver does
  receive an `expanded` flag, but changing the folder icon is a separate
  cosmetic choice, not file-type information.
- **A user-configurable or switchable icon theme.** The tables are code.
- **Re-iconing a tab after *Save As*.** It needs a library `Tab.setTabGlyph`
  that does not exist; step 8 records that gap in `TODO.md`.
- **Breadcrumbs above the editor.** A separate `TODO.md` item.

---

## Implementation Notes

**Codebase drift beyond line numbers.** The plan was drafted before the
untitled-files and recent-projects plans landed, and both added file-display
call sites the plan never saw:

- `EditorController`'s single `addTab` call at the cited line had split into
  two: `newFile()` (untitled-files.md) opens a path-less buffer, and a new
  private `addFileTab(path, text)` helper — shared by `openFile` and
  `restoreFiles` — opens a path-based one. The plan's step 4 snippet, written
  against the single-call-site code, no longer matched either location.
  Resolution: `addFileTab` got `glyph: glyphNameForPath(path)`, exactly the
  plan's intent, since it always has a real path. `newFile()` got
  `glyph: glyphNameForPath(file.getName())` — not mentioned by the plan at
  all — so an untitled tab also carries an icon instead of none; since an
  untitled buffer's name (`Untitled-N`) has no extension and matches neither
  table, this resolves to the same default `file` icon every untitled tab
  showed implicitly before (no icon rendered), just now rendered explicitly
  and consistently with every other tab.
- `EditorShell`'s Open Recent submenu (recent-projects.md) renders each
  recent file with a hardcoded `glyph: 'file-code'`, a call site the plan
  never mentions because it postdates the plan's drafting. Leaving it
  hardcoded would have shipped a feature that visibly contradicts its own
  README description ("per-file-type icon" everywhere a file is named) the
  moment a user opened the File menu. Resolution: swapped the hardcoded
  literal for `glyphNameForPath(path)`, the same call already used at every
  other file-display site — no new pattern, just the existing one applied to
  a call site the plan's author couldn't have known about.

These two additions extend the same manual-verify gap the plan already
accepted for the rest of the feature (`### Rendering — manual verification
only` — no DOM in the vitest harness): on `npm run tauri:dev`, the File
menu's *Open Recent* submenu should show each recent file's own per-type
icon rather than the uniform code-page icon it showed before, and *File >
New File* should open an untitled tab carrying the plain-page `file` icon
(pinned automatable behaviour: `glyphNameForPath('Untitled-1')` resolves to
`'file'`, added to `tests/fileIcons.test.ts`) rather than no icon at all.

**A plan claim about `FileTree` doesn't hold.** Both the *Save As* row in
`## Expected Behaviour`'s manual-verify list and step 8's `TODO.md`
instructions describe the tree row for a *Save As*'d file as updating on
its own ("the tree row for the new file shows the text-lines icon"). It
doesn't: `FileTree` only loads a directory's children from
`setProjectRoot`/`loadInto` on expansion (`src/explorer/FileTree.ts`), and
`EditorController.saveAs` never touches the tree — this is the same
no-filesystem-watching gap `TODO.md`'s own `## Medium` section already
documents elsewhere. This was a pre-existing plan inaccuracy, not new
codebase drift. `TODO.md`'s *Stale tab icon* bullet (step 8) is corrected
to say the tree shows no row for the new file until it is next re-listed,
rather than claiming it updates correctly.

**`glyphNameForPath`'s lookups are guarded, not unguarded like the
precedent.** `## Internal Structure` and `## Architecture Decisions` both
call for mirroring `languages.ts`'s unguarded `if (byName)` / `??` checks —
plain `Record` indexing with no ownership check. Implemented that way at
first, but a plain `obj[key]` lookup on a file literally named `constructor`
or `__proto__` resolves through `Object.prototype` rather than missing, so
`glyphNameForPath` would return `'Object'` or `undefined` — a name
`FILE_ICON_GLYPHS` never registers. In `languages.ts` the same shape only
degrades to a wrong-typed value flowing into a status-bar label
(`languageForPath` returns `string | null`, and a stray `Object` string is
merely a cosmetic wrong label). Here it is strictly worse: `new Glyph(name)`
throws `Unknown glyph: …` inside the tree row renderer
(`IconLabelTreeNodeRenderer.update`) and inside `TabBar.createBarEntry`, so
a file with either name would crash rendering rather than just mislabel it.
Both lookups in `glyphNameForPath` were changed to `Object.hasOwn(table,
key)` guards before indexing, keeping the tables themselves exactly as
sketched (plain `Record<string, NamedGlyphDef>` literals) and diverging only
in how they're read. `tests/fileIcons.test.ts` pins `constructor`,
`x.constructor`, and `__proto__` all resolving to the default `file` icon
rather than throwing.

---

## Notes

[^icon-source]: `@jimka/typescript-ui` bundles Font Awesome Free 7.2.0 as
    ~2,860 generated single-icon modules — 2,000 solid, 273 regular, 587
    brands — each exporting one `NamedGlyphDef`, so a per-icon import tree-shakes
    down to only what is used. That makes it the cheapest possible source: no
    new dependency, no new asset pipeline, no licence or attribution work
    (the library already carries the CC-BY-4.0 notice), and the icons match
    the ones already on the menu bar. A separate icon set — Seti, Material
    Icon Theme, a hand-picked SVG folder — would each mean a new dependency
    or a new build step plus its own attribution, to sit beside a Font Awesome
    set that is already in the bundle. Brand marks (`js`, `python`, `rust`,
    `markdown`, …) give real per-language differentiation; the `file-*` solid
    icons cover the asset and data types that have no brand.

[^own-map]: `languageForPath` answers "which CodeMirror grammar", and it knows
    seven languages. Icons must cover far more: `.rs`, `.png`, `.zip`,
    `.toml`, `.gitignore` and the rest all deserve an icon and none of them
    has a grammar. Deriving icons from language ids would leave almost every
    row in a real project on the default page icon, which is roughly where the
    tree is today. The one case where reusing the language id would have cost
    nothing is `.ts` versus `.js`: Font Awesome Free ships no TypeScript mark,
    so both families get the `js` icon either way.

[^base-name]: `extensionOf` returns `""` for a dotfile such as `.gitignore`
    and for an extensionless name such as `Dockerfile`
    ([src/data/paths.ts:24](src/data/paths.ts#L24)), so an extension-only
    lookup can never reach them. Checking the base name first also lets
    `package.json` and `Cargo.toml` show the ecosystem they belong to instead
    of the generic icon their suffix would give them, which is what makes the
    precedence order load-bearing rather than incidental.

[^register-at-root]: The alternative — `src/fileIcons.ts` calling
    `Glyph.register` itself at module scope, the way
    [src/editor/languages.ts:39](src/editor/languages.ts#L39) calls
    `registerLanguage` — is what the library's own components do
    (`TreeRow.ts`, `Table.ts`, `ComboBox.ts` each register their glyphs on
    import). It is rejected here only because it forces a value import of
    `@jimka/typescript-ui/component/display`, which the unit tests cannot
    load. See the type-only note below.

[^type-only]: Importing `@jimka/typescript-ui/component/display` as a value
    under Vitest's `node` environment fails with `document is not defined` —
    the barrel pulls in `Canvas`, `Markdown`, and `StyleRule`, which touch the
    DOM at module scope. The per-icon glyph modules and
    `@jimka/typescript-ui/component/editor` both load cleanly under plain
    Node, which is why `tests/languages.test.ts` works today. `import type`
    is erased before the module ever runs, so `src/fileIcons.ts` stays
    node-loadable and testable. The alternative was switching
    [vitest.config.ts](vitest.config.ts) to `jsdom`, which adds a
    devDependency and contradicts that file's own stated position that these
    tests need no DOM.

[^save-as-stale]: `Tab` exposes `setTabName`
    ([../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts:1228](../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts#L1228))
    and `TabBar` the `setEntryName` behind it
    ([../typescript-ui/packages/lib/src/typescript/lib/component/container/TabBar.ts:1460](../typescript-ui/packages/lib/src/typescript/lib/component/container/TabBar.ts#L1460)),
    but neither has a glyph counterpart. The `TabButton` that owns the icon is
    built once in `TabBar.createBarEntry` from `constraints.glyph`
    ([../typescript-ui/packages/lib/src/typescript/lib/component/container/TabBar.ts:1575](../typescript-ui/packages/lib/src/typescript/lib/component/container/TabBar.ts#L1575)),
    `Tab`'s `_bar` field and `TabBar`'s own entry records are both private, so
    there is no supported route from Loom to that button.
    Closing and re-adding the tab would work but costs the tab's position in
    the strip and disposes the editor with its undo history. The clean fix is
    a library `Tab.setTabGlyph`, which belongs in a `typescript-ui` plan —
    the same split `TODO.md` already uses for the `component-dirty-state`
    item.
