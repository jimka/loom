---
touches-shared: [package.json, package-lock.json, src/editor/languages.ts, tests/languages.test.ts, src/EditorController.ts, src/shell/aboutDialog.ts, src/shell/WelcomeScreen.ts, src/explorer/FileTree.ts, src/explorer/SearchPanel.ts, README.md, TODO.md]
---

# typescript-ui 0.11 Bump — Implementation Plan

## Overview

Loom declares `"@jimka/typescript-ui": "^0.8.0"` in
[package.json:24](package.json#L24). On a 0.x version that range means
`>=0.8.0 <0.9.0`. [package-lock.json:218-221](package-lock.json#L218) pins
the 0.8.0 registry tarball. In the main tree, though,
`node_modules/@jimka/typescript-ui` is a symlink to the local library
checkout at `/home/jika/typescript/typescript-ui/packages/lib`, which is at
0.11.0. Loom already compiles and tests clean against that link
(`tsc --noEmit` passes, 529 vitest tests pass). 0.11.0 is published on npm
from the same commit (`gitHead` `180751e9`).

This plan moves the declared range and the lockfile to `^0.11.0`, then cleans
up what 0.9–0.11 made wrong in Loom:

- **A real bug.** Since 0.9.0 the library registers `css` (with a Prettier
  formatter) and `python` itself. Loom's
  [src/editor/languages.ts:74-92](src/editor/languages.ts#L74) registers both
  again with a grammar only. The registry is a plain `Map.set`, so Loom's
  copy wins and CSS loses its formatter: format-on-save skips `.css` files and
  *Format Document* only re-indents them. Loom's two blocks are deleted, and
  the two CodeMirror grammar packages they imported leave `package.json`.
- **Stale comments and docs** about `Image` sizing, inactive-tab hiding, the
  `"selectionchange"` event, `Text` measurement, the in-file find panel, and
  the file tree's context menu. Each one below was checked against the
  library source at 0.11.0.

The only runtime changes are the CSS formatter coming back and the About
dialog losing two wrapper constructs. Everything else is comments, docs,
tests and dependency metadata.

---

## Architecture Decisions

### Install the registry 0.11.0 inside the worktree; leave the main tree's link alone

The implementer runs `npm install @jimka/typescript-ui@^0.11.0` inside the
worktree. The worktree has no `node_modules`, so this builds a fresh, real one
from the registry. The worktree's `typecheck`, `test`, `build` and by-eye
checks then all run against the published package, not the link. The main
tree's `node_modules` and its symlink are never touched.[^registry-in-worktree]

**Do not** link the main tree's `node_modules` into the worktree, as
[plans/implemented/retire-qa-harness.md:597-598](plans/implemented/retire-qa-harness.md#L597)
did. An `npm install` through that link would replace the main tree's library
symlink with the registry copy.

The precedent for the dependency step itself is
[plans/implemented/tree-filtering.md:218](plans/implemented/tree-filtering.md#L218):
one `npm install <pkg>@<range>` call, with `package.json` and
`package-lock.json` both in the files table.

### Loom stops registering `css` and `python`

Both `registerLanguage` blocks in `src/editor/languages.ts` are deleted. The
module keeps its extension map, `languageForPath`, `isMarkdownPath` and
`hasFormatter`. It no longer imports `registerLanguage`, and its header
comment says every id it maps to is a library built-in.[^library-owns-languages]

This follows
[plans/implemented/file-editor-dirty-state-adoption.md](plans/implemented/file-editor-dirty-state-adoption.md):
once the library does the job, Loom deletes its own copy instead of keeping
it alongside.

| Language id | Registered by, today | Registered by, after | `hasFormatter` today | `hasFormatter` after |
|---|---|---|---|---|
| `css` | Loom (overwrites the library's) | library | `false` | `true` |
| `python` | Loom (overwrites the library's) | library | `false` | `false` |
| `javascript`, `json`, `html`, `sql`, `markdown` | library | library | `true` | `true` |

### Drop `@codemirror/lang-css` and `@codemirror/lang-python`; keep the other three CodeMirror packages

Nothing else in `src/`, `tests/`, `browser-shell/` or the Vite configs imports
`@codemirror/lang-css` or `@codemirror/lang-python`. They are removed with
`npm uninstall`. `@codemirror/search`, `@codemirror/state` and
`@codemirror/view` stay, because
[src/editor/editorSearch.ts:15-17](src/editor/editorSearch.ts#L15) imports
them.[^keep-codemirror-deps]

### `Image` keeps its size lock; only the About dialog's bug wrappers go

Since 0.9.0, `Image.getPreferredSize()` returns an explicit `preferredSize`
and never reads the DOM. That fixes the bug Loom's comments describe. The
three-way lock (`preferredSize` + `minSize` + `maxSize`) stays in both files,
because `minSize` still stops a short editor pane from squashing the square
mark. Only its comments change.[^size-lock]

The About dialog drops the two constructs that existed only for the old bug:
the `mark.getElement(true)` forced render and the `Fit`-managed `markSlot`
wrapper. `mark` goes straight between the row's two flex spacers.[^about-wrapper]

### The status-bar width pins stay; their comment and the TODO entry are reworded

The measure-once, `setPreferredSize`, `setAutoMeasure(false)` treatment of the
three status-bar readouts (`WIDEST_CURSOR_POSITION`, `WIDEST_SELECTION`,
`WIDEST_LANGUAGE_ID` in
[src/EditorController.ts:42-59](src/EditorController.ts#L42)) is not changed.
Two things in the prose around it are out of date:

- the constructor comment says inactive tabs are hidden with
  `visibility: hidden`;
- the comment and TODO.md both say an auto-measured `Text.setText` forces a
  synchronous reflow through an off-screen probe.

Both are reworded to say what the library does now, and that the pins stay
until a WebKitGTK Timeline recording shows they buy nothing.[^pin-stays]

### `"selectionchange"`: doc comment only

Since 0.11.0 `"selectionchange"` fires whenever the primary selection's
`from`, `to`, character count or line count changes, so it fires on every
caret move. `handleSelectionChange`'s doc comment says so, and says that the
resulting second `syncSelectionMetrics` call per caret move costs nothing,
because `Text.setText` returns early on an unchanged string. Neither
handler's code changes.[^selection-comment]

### README's find & replace bullet describes the library's search panel

The visible in-file find UI is the library's floating search card, pinned to
the editor's upper-right corner. CodeMirror's own search bar is hidden by the
library's editor theme in every case. README's *"CodeMirror's own
find/replace bar"* is therefore wrong however Loom's `openFindPanel` ends up
being wired, and the bullet is rewritten. Its *by word* toggle becomes
*whole word*, the library card's name for it.[^find-panel]

### Document the two tree keyboard gestures 0.11 adds

In 0.11.0, `Enter` on a `Tree`'s current row fires `"dblclick"`. Shift+F10 and
the ContextMenu key fire `"contextmenu"` for the current row. Loom's file tree
and search-results tree already handle both events, so both gestures work in
Loom with no code change. README gains them, and the two Loom doc comments
that say `"contextmenu"` means a right-click are corrected.[^tree-keys]

### Tests: one assertion flips, two names change, one guard is added

In [tests/languages.test.ts](tests/languages.test.ts):

- the `css` `hasFormatter` case flips to `true`;
- the `python` case keeps `false` with a new reason in its name;
- the two `languageForPath` cases named "app-registered" lose that word;
- one new case checks that every language id the extension map resolves to is
  registered in the library.

The flipped `css` case is written first and fails until step 5 deletes Loom's
override, which gives a real red-green cycle.[^guard-test]

---

## Implementation

### `src/editor/languages.ts` — new header and imports (replaces lines 1-7)

```typescript
// Extension → language id map. Every id it resolves to is one of the
// library's own built-in languages (javascript, json, html, sql, markdown,
// css, python), which the `@jimka/typescript-ui/component/editor` barrel
// registers as an import side effect, so this module registers nothing itself.
import { getLanguage } from '@jimka/typescript-ui/component/editor'
import { extensionOf } from '../data/paths'
```

### `src/editor/languages.ts` — `hasFormatter` doc (replaces lines 60-69, the comment only)

```typescript
/**
 * Whether a language has a registered formatter — the question format-on-save
 * asks before reformatting a document. `false` for a language the library
 * registers with a grammar only (`python`), for an id no one registered, and
 * for a buffer with no language at all.
 *
 * @param languageId - A `CodeEditor` language id, or `null` when the editor has none.
 * @returns `true` when `CodeEditor.format()` would run a real formatter rather
 *   than its whole-document re-indent fallback.
 */
```

### `tests/languages.test.ts` — the new guard case

Add `import { getLanguage } from '@jimka/typescript-ui/component/editor'` as
the file's second import line, and this block at the end of the file:

```typescript
describe('language registration', () => {
    it('resolves every mapped extension to a language the library registers', () => {
        for (const path of ['/p/f.js', '/p/f.json', '/p/f.html', '/p/f.sql', '/p/f.md', '/p/f.css', '/p/f.py']) {
            const id = languageForPath(path)

            expect(id).not.toBeNull()
            expect(getLanguage(id!)).toBeDefined()
        }
    })
})
```

### `src/shell/WelcomeScreen.ts` — `MARK_SIZE` doc (replaces lines 19-24)

```typescript
/**
 * The mark's locked display size, passed as all three of `preferredSize`,
 * `minSize` and `maxSize`. `preferredSize` is the 80×80 the layout asks for;
 * the min/max pair keeps a layout from moving off it. `VBox` shrinks the
 * children of a column too short for them toward their minimum height while
 * leaving their width alone, so without `minSize` a short editor pane would
 * squash the square mark into a wide strip; `maxSize` likewise stops a
 * stretching layout from growing it.
 */
```

### `src/shell/aboutDialog.ts` — `MARK_SIZE` doc (replaces lines 30-36)

```typescript
/**
 * The mark's locked display size, passed as `preferredSize`, `minSize` and
 * `maxSize` alike — the same lock `WelcomeScreen.ts`'s identical constant
 * applies, for the reason its comment gives.
 */
```

### `src/shell/aboutDialog.ts` — `openAboutDialog` body, top half

Lines 72-115 become the block below. The `markRow` comment is the current one
(lines 101-111) with both `markSlot` mentions changed to `mark`. Lines 117-127
(`body` and the `DismissDialog` call) are unchanged.

```typescript
    const mark = Image(APP_FAVICON, { preferredSize: MARK_SIZE, minSize: MARK_SIZE, maxSize: MARK_SIZE })

    // Two equal-weight flex spacers, rather than the outer VBox's own
    // `itemAlign: 'center'`: that alignment is shared by every child in the
    // VBox, and the Markdown block below needs the opposite — full width, not
    // centred at its own natural size. Flanking `mark` with spacers that
    // absorb the row's leftover space evenly keeps it centred, while the row
    // itself stays free to stretch to the dialog's full width under the outer
    // VBox's `stretch` alignment (a single centred child would report the
    // *row's* own max size as 80×80 too, capping it at 80px before `stretch`
    // ever gets to grow it — flex spacers report an unbounded max of their
    // own, so the row's aggregate stays unbounded no matter how narrow
    // `mark` is).
    const markRow = Container({
        layoutManager: new HBox(),
        components: [Spacer.flex(), mark, Spacer.flex()],
    })
```

Line 9's import drops `Fit`, which has no other use in the file:
`import { HBox, VBox } from '@jimka/typescript-ui/layout'`.

### `src/EditorController.ts` — constructor comment (replaces the first paragraph, lines 121-135)

```typescript
        // `cursorchange` fires once per caret position, not once per click —
        // dragging out a selection fires it continuously. Left on Text's
        // default auto-measure, every one of those `setText` calls schedules
        // a re-layout of the status bar and re-measures the readout to grow or
        // shrink it by a few pixels. Before typescript-ui 0.10 that
        // measurement read an off-screen probe element with
        // `getBoundingClientRect` — a forced full-document layout whose cost
        // scaled with every editor on screen — which made selection drag feel
        // sluggish once a few files were open. 0.10 measures a single line on
        // a canvas instead, with no forced layout; this measure-once treatment
        // stays until a WebKitGTK recording shows it buys nothing (see
        // TODO.md's *Frequent events wired to layout-forcing reads*).
        // Measuring once against a generous worst case and fixing the width
        // means later `setText` calls only touch the DOM text node.
```

The second paragraph (*Right-aligned so…*, lines 137-140) stays as it is.

### `src/EditorController.ts` — `handleSelectionChange` doc (replaces lines 1363-1375)

```typescript
    /**
     * Registered as a `"selectionchange"` listener on each open file's editor:
     * repaints the status bar's selection readout. Since typescript-ui 0.11
     * the event fires whenever the primary selection's `from`, `to`,
     * character count or line count changes — every caret move included — so
     * a plain caret move reaches {@link syncSelectionMetrics} twice, from here
     * and from {@link handleCursorChange}. The second call costs nothing:
     * `Text.setText` returns early on an unchanged string. This listener is
     * still needed alongside {@link handleCursorChange}, because a selection
     * can change without the caret moving: `Ctrl/Cmd+A` with the caret
     * already at the document's end leaves the head in place and moves only
     * `from`, which fires `"selectionchange"` alone, so a caret-only wiring
     * would leave the readout blank. A file that is not the active one is
     * ignored, mirroring {@link handleCursorChange}.
     */
```

### `TODO.md` — the *Frequent events* entry (replaces lines 78-96, from "What remains is the general rule" to the entry's end)

```markdown
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
  measures at the next layout pass instead, and measures a single line on a
  canvas with no forced layout, so the pins may no longer be needed; they
  stay until a WebKitGTK Timeline recording of `npm run tauri:dev` shows
  they buy nothing. The probe is still used for wrapped text, text with
  leading, trailing or repeated whitespace, and a font the canvas cannot
  reproduce, so a new readout fed from a frequent event should be pinned
  the same way until then. Split editor groups multiply the visible-editor
  count, so they raise the per-event cost rather than lowering it.
```

The first line above repeats line 78's `unchanged.`; lines 69-77 stay as they are.

### `README.md` — find & replace bullet (replaces lines 57-62)

```markdown
- **Find & replace** — Ctrl/Cmd+F opens the editor's search panel, a
  floating card pinned to the active editor's upper-right corner; every
  match in the document highlights as you type, Enter and Shift+Enter walk
  to the next and previous match, and the *match case*, *whole word*, and
  *regular expression* toggles refine the query. Replace one match at a
  time or all of them at once with *replace* and *replace all*; Escape
  closes the panel.
```

---

## Ordered Implementation Steps

All steps run from the worktree root, `.worktrees/typescript-ui-0-11-bump`.

1. **Install the bump.** The worktree has no `node_modules`; do **not** link
   the main tree's in. Run `npm install @jimka/typescript-ui@^0.11.0`.
   Checks:
   - `grep -n '"@jimka/typescript-ui"' package.json` → `"^0.11.0"`.
   - `node -p "const p = require('./package-lock.json').packages['node_modules/@jimka/typescript-ui']; p.version + ' ' + p.resolved"`
     → `0.11.0 https://registry.npmjs.org/@jimka/typescript-ui/-/typescript-ui-0.11.0.tgz`.
   - `test -L node_modules/@jimka/typescript-ui && echo LINK || echo DIR` → `DIR`.
   - `find node_modules -path '*/@codemirror/search/package.json' | wc -l` → `1`.
   - `readlink /home/jika/typescript/loom/node_modules/@jimka/typescript-ui`
     → `/home/jika/typescript/typescript-ui/packages/lib` (main tree untouched).

2. **Baseline.** `npm run typecheck && npm test` → clean, `529 passed`. This is
   the first run against the published package rather than the link.

3. **[tests/languages.test.ts](tests/languages.test.ts)** — make these edits:
   - Line 17: rename the case to
     `'resolves an uppercase extension case-insensitively to css'`.
   - Line 56: rename the case to `'resolves .py to python'`.
   - Lines 116-118: replace with
     `it('resolves css to true', () => { expect(hasFormatter('css')).toBe(true) })`,
     formatted as the neighbouring cases are (body on its own line).
   - Lines 120-122: rename the case to
     `'resolves python to false, registered by the library with a grammar only'`;
     the assertion stays `toBe(false)`.
   - Add the `getLanguage` import and the `language registration` block from
     **Implementation**.

   Check: `npx vitest run tests/languages.test.ts` → exactly one failure,
   `hasFormatter > resolves css to true`.

4. Mutation check for the new guard case: in `src/editor/languages.ts`,
   change line 30 `py: 'python',` to `py: 'pythonx',` temporarily. Run
   `npx vitest run tests/languages.test.ts`; the `language registration` case
   must fail, along with `resolves .py to python`. Revert line 30 and confirm
   with `git diff src/editor/languages.ts` that it is empty.

5. **[src/editor/languages.ts](src/editor/languages.ts)** — make three edits,
   bottom of the file first so the earlier line numbers stay valid:
   - Delete both `registerLanguage({...})` blocks and the blank line before
     them ([:73-92](src/editor/languages.ts#L73)).
   - Replace the `hasFormatter` doc comment
     ([:60-69](src/editor/languages.ts#L60)) with the one in
     **Implementation**; the function body is unchanged.
   - Replace lines 1-7 (the header comment and both imports) with the
     header-and-imports block in **Implementation**.

   Checks:
   - `grep -n "registerLanguage\|lang-css\|lang-python" src/editor/languages.ts` → zero matches.
   - `npx vitest run tests/languages.test.ts` → all pass.

6. **Drop the grammar packages.** Run
   `npm uninstall @codemirror/lang-css @codemirror/lang-python`. Checks:
   - `grep -rn "lang-css\|lang-python" src tests browser-shell package.json vite.config.ts vitest.config.ts` → zero matches.
   - `node -p "Object.keys(require('./package-lock.json').packages[''].dependencies).join(' ')"`
     → no `@codemirror/lang-css` or `@codemirror/lang-python`. Both may still
     appear as `node_modules/...` entries elsewhere in the lockfile, because
     the library depends on them; that is expected.
   - `npm run typecheck && npm test` → clean.

7. **[src/shell/aboutDialog.ts](src/shell/aboutDialog.ts)** — replace the
   `MARK_SIZE` doc ([:30-36](src/shell/aboutDialog.ts#L30)) and lines 72-115
   with the versions in **Implementation**. That deletes the
   `mark.getElement(true)` call and its comment (lines 74-82), and the
   `markSlot` declaration and its comment (lines 84-99). Change line 9's
   import to drop `Fit`. Checks:
   - `grep -n "getElement(true)\|markSlot\|Fit" src/shell/aboutDialog.ts` → zero matches.
   - `grep -n "ignores the .preferredSize" src/shell/*.ts` → zero matches.

8. **[src/shell/WelcomeScreen.ts](src/shell/WelcomeScreen.ts)** — replace the
   `MARK_SIZE` doc ([:19-24](src/shell/WelcomeScreen.ts#L19)) with the version
   in **Implementation**. Line 25 and line 69 are unchanged.

9. **[src/EditorController.ts](src/EditorController.ts)** — replace the
   constructor comment's first paragraph
   ([:121-135](src/EditorController.ts#L121)) and `handleSelectionChange`'s
   doc comment ([:1363-1375](src/EditorController.ts#L1363)) with the versions
   in **Implementation**. Change no code in this file. Checks:
   - `grep -n "visibility: hidden" src/EditorController.ts` → zero matches.
   - `git diff -U0 src/EditorController.ts | grep '^[-+][^-+]' | grep -v '^\s*[-+]\s*//\|^\s*[-+]\s*\*\|^\s*[-+]\s*/\*\*'`
     → no output (only comment lines changed).

10. **[src/explorer/FileTree.ts](src/explorer/FileTree.ts)** — replace the
    one-line doc at [:134](src/explorer/FileTree.ts#L134) with:
    ``/** `Tree`'s own `"contextmenu"` event: fires for a right-click on a row, and for Shift+F10 or the ContextMenu key on the current row, with that row's node already resolved. */``

    **[src/explorer/SearchPanel.ts](src/explorer/SearchPanel.ts)** — replace
    lines 459-460 of `handleContextMenu`'s doc with:
    ```
         * @param node - The right-clicked node, or the current node for
         *   Shift+F10 or the ContextMenu key.
         * @param event - The originating mouse event, or the tree's synthetic
         *   one under the current row for a key-raised menu; its
         *   `clientX`/`clientY` anchor the menu either way.
    ```

11. **[README.md](README.md)** — four edits:
    - Lines 38-42: change *"A single click opens a file in a reusable temp
      tab; a double click opens it permanently. Right-clicking a directory, a
      file, or empty tree space opens a context menu offering…"* to *"A single
      click opens a file in a reusable temp tab; a double click, or Enter on
      the selected row, opens it permanently. Right-clicking a directory, a
      file, or empty tree space — or pressing Shift+F10 or the ContextMenu
      key on the selected row — opens a context menu offering…"*. Keep the
      rest of the sentence (*New File/New Folder, Rename, Delete, and Copy
      Path.*) as it is.
    - Lines 57-62: replace the *Find & replace* bullet with the version in
      **Implementation**.
    - Line 74: change *"and a double click opens it permanently"* to *"and a
      double click, or Enter, opens it permanently"*.
    - Line 143: change *"(JavaScript/TypeScript, JSON, HTML, SQL, Markdown)"*
      to *"(JavaScript/TypeScript, JSON, HTML, SQL, Markdown, CSS)"*.

    Check: `grep -n "CodeMirror's own" README.md` → zero matches.

12. **[TODO.md](TODO.md)** — replace lines 78-96 with the block in
    **Implementation**. Check: `grep -n "calculateSize" TODO.md` → zero
    matches; `grep -n "WIDEST_SELECTION" TODO.md` → one match.

13. **Full check.** `npm run typecheck && npm test && npm run build` → all
    clean; `npm test` reports `530 passed`. `git status --short` lists only
    the files in the table below.

14. Run the manual cases in **Verification**.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `package.json` |
| Modify | `package-lock.json` |
| Modify | `src/editor/languages.ts` |
| Modify | `tests/languages.test.ts` |
| Modify | `src/shell/aboutDialog.ts` |
| Modify | `src/shell/WelcomeScreen.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `src/explorer/FileTree.ts` |
| Modify | `src/explorer/SearchPanel.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

**Unit-testable** (in `tests/languages.test.ts`):

1. `hasFormatter('css')` → `true`.
2. `hasFormatter('python')` → `false`.
3. `hasFormatter` for `javascript`, `json`, `html`, `sql`, `markdown` → `true`;
   for `'nonsense'` and `null` → `false` (unchanged).
4. For each of `/p/f.js`, `/p/f.json`, `/p/f.html`, `/p/f.sql`, `/p/f.md`,
   `/p/f.css`, `/p/f.py`: `languageForPath` returns a non-null id and
   `getLanguage(id)` is defined.
5. Every other existing case passes unchanged; the suite totals 530.

**Manual** (browser shell, see **Verification**; the test harness cannot
exercise formatting through a live editor, layout, or keyboard focus):

6. **CSS formats with Prettier.** A `.css` file holding `a{color:red}`, after
   *Edit > Format Document* (Alt+Shift+F), reads `a {` / `  color: red;` /
   `}`. Before this change the text stays on one line.
7. **CSS formats on save.** Type a space at the end of that file's last line,
   then press Ctrl+S: the document is reformatted as in case 6 and the status
   bar shows `Saved style.css`, with no `(not formatted)` suffix.
8. **Python is highlighted and is not formatted on save.** A `.py` file shows
   syntax colours (`def` and `return` coloured differently from the function
   name). Ctrl+S after a one-character edit leaves the text exactly as typed.
9. **Welcome mark is 80×80.** With no file open, the Loom mark's `<img>`
   measures 80×80.
10. **Welcome mark keeps its shape in a short pane.** With the page viewport
    resized to 800×240, the mark still measures 80×80.
11. **About mark is 80×80 and centred.** In the About dialog the mark measures
    80×80. Its horizontal centre is within 1px of the horizontal centre of the
    dialog's Markdown block, and there is no empty band above or below it.
12. **The find panel is the library's card.** With the caret in a file,
    Ctrl+F shows a floating card in the editor's upper-right corner, with a
    find field and a replace field. No full-width bar appears above the
    document.
13. **Enter pins a file-tree row.** Arrow to a file row in the tree: it
    previews in the italic temp tab. Press Enter: the tab's label turns
    upright (permanent).
14. **Shift+F10 opens the row's menu.** With a file row selected and the tree
    focused, Shift+F10 opens the Rename / Delete / Copy Path menu, positioned
    at that row.

---

## Verification

- `npm run typecheck`, `npm test` (530 passed), `npm run build` — all clean,
  run in the worktree against the registry copy.
- The greps in steps 1, 5, 6, 7, 9, 11 and 12.
- `readlink /home/jika/typescript/loom/node_modules/@jimka/typescript-ui` →
  `/home/jika/typescript/typescript-ui/packages/lib`.
- **By eye, browser shell.** From the worktree:
  1. Create a scratch project:
     `mkdir qa-scratch && printf 'a{color:red}\n' > qa-scratch/style.css && printf 'def f():\n    return 1\n' > qa-scratch/script.py`.
  2. `npm run dev:browser` (add `-- --port 1431 --strictPort` if port 1420 is
     busy) and open the page with the chrome-devtools tools.
  3. Cases 9 and 10 first, before opening a folder: measure with
     `evaluate_script` on
     `[...document.querySelectorAll('img')].filter(i => i.src.startsWith('data:image/svg+xml')).map(i => { const r = i.getBoundingClientRect(); return [r.width, r.height] })`,
     then `resize_page` to 800×240 and measure again. Restore the size.
  4. Case 11: open the About dialog (far right of the menu bar), measure the
     same `<img>`, and compare its centre with
     `document.querySelector('.Markdown').getBoundingClientRect()`. Take a
     screenshot.
  5. Set `window.__FAKE_PROJECT_ROOT__` to the absolute path of `qa-scratch`
     with `evaluate_script`, click *Open Folder…*, then run cases 6, 7, 8,
     12, 13 and 14.
  6. Stop the server, `rm -rf qa-scratch`, and confirm `git status --short`
     shows no `qa-scratch`.
- Optional, on the user's machine: case 7 under `npm run tauri:dev` with a
  real `.css` file, to see format-on-save write to disk.

---

## Documentation Impact

- **README.md** — the four edits in step 11: tree gestures, find & replace,
  search-result gestures, and the formatter list.
- **TODO.md** — the *Frequent events wired to layout-forcing reads* entry is
  reworded, not retired. The workaround it describes stays (see the pin
  decision).
- No public API changes. Loom has no `docs/` tree.

---

## Potential Challenges

- **Keeping the main tree's link.** The main tree's
  `node_modules/@jimka/typescript-ui` symlink was made by hand. After this
  branch merges, the main tree's lockfile names the registry tarball, so any
  later `npm install` or `npm ci` there replaces the symlink with the registry
  copy. To restore it, run:
  `cd /home/jika/typescript/loom/node_modules/@jimka && rm -rf typescript-ui && ln -sf /home/jika/typescript/typescript-ui/packages/lib typescript-ui`.
  That is the same command that created it. This plan never runs `npm` in the
  main tree.[^link-history]
- **The menu's *Edit > Find…* path differs between the two trees.** In the
  worktree's registry install, npm keeps one copy of `@codemirror/search`, so
  Loom's `openFindPanel` should also open the library's card (without
  focusing its field). In the linked main tree there are two copies, and that
  path opens a stock CodeMirror panel that the library's theme hides, so
  nothing may appear. That is the known `editorSearch.ts` issue listed under
  Non-Goals. Case 12 therefore uses Ctrl+F with the caret in the editor,
  where the library's own key binding opens the card in both trees.
- **First CSS format in the dev server may reload the page.** The library is
  excluded from Vite's dependency pre-bundling, so the first dynamic import of
  `prettier/plugins/postcss` may trigger a dependency re-optimization and a
  full reload. If case 6 reloads the page, reopen the folder and file and
  repeat; the second run formats.
- **`npm install` needs the network.** Steps 1 and 6 download from
  registry.npmjs.org. If the registry is unreachable, stop and report it; do
  not fall back to the main tree's `node_modules`.
- **The lockfile diff is large.** Library 0.11.0 adds dependencies over 0.8.0
  (`lexical`, `d3-*`, `prettier`, more `@codemirror/*`). Only the root
  package's `dependencies` and the `@jimka/typescript-ui` entry need reading
  in review; the optional peer `elkjs` is not installed and needs nothing.

---

## Critical Files

- [src/editor/languages.ts](src/editor/languages.ts) and
  [tests/languages.test.ts](tests/languages.test.ts) — the bug and its tests.
- [src/EditorController.ts:1005-1031](src/EditorController.ts#L1005) —
  `formatBeforeSave`, the `hasFormatter` gate that makes format-on-save skip
  CSS today.
- [src/shell/aboutDialog.ts](src/shell/aboutDialog.ts),
  [src/shell/WelcomeScreen.ts](src/shell/WelcomeScreen.ts) — the `Image`
  lock and the About wrappers.
- [src/editor/editorSearch.ts](src/editor/editorSearch.ts) — read only, to
  see why `@codemirror/search`/`state`/`view` stay in `package.json`.
- [plans/implemented/file-editor-dirty-state-adoption.md](plans/implemented/file-editor-dirty-state-adoption.md)
  — **the precedent**: delete Loom's copy once the library does the job.
- [plans/implemented/tree-filtering.md:218](plans/implemented/tree-filtering.md#L218)
  — the precedent for a one-command dependency change.
- [plans/implemented/about-dialog-and-welcome-glyph.md:39-47](plans/implemented/about-dialog-and-welcome-glyph.md#L39)
  and its `[^mark-size]` footnote — why the lock was added.
- Library, at `../typescript-ui/packages/lib/src/typescript/lib/`:
  - `component/editor/languages.ts:683-705` — the library's `css` and
    `python` registrations.
  - `component/editor/LanguageRegistry.ts:123` — `registerLanguage`, a plain
    `Map.set`.
  - `component/display/Image.ts:23-29`, `:714`, `:787`, `:931` — the
    `preferredSize` contract, the load handler that respects it,
    `getPreferredSize`, `getMinSize`.
  - `layout/VBox.ts:653` — `resolveChildHeight`, the shrink toward minimum
    height.
  - `component/input/Text.ts:884-911` — `setText`'s early return and its
    deferred measurement.
  - `component/editor/CodeEditor.ts:1912` — `onSelectionChange`'s four-field
    comparison.
  - `component/editor/theme.ts:225-235` — the rule hiding CodeMirror's own
    search panel.
  - `component/tree/Tree.ts:2333` — `_handleContextMenu`, the keyboard path.
- `../typescript-ui/packages/lib/docs/reference/changelog/0.9.0.md:66-160`,
  `0.10.0.md:279-292`, `0.11.0.md:480-494`, and `migration/0.11.0.md:139-461`
  — the changelog and migration entries behind each change.

---

## Non-Goals

- **Rewriting `src/editor/editorSearch.ts`.** That waits on a public
  `CodeEditor.openSearch()` in the library. The two physical copies of
  `@codemirror/search` under the link, and Vite's `dedupe` list not naming it,
  belong to that rewrite too.
- **`Dock.focusPanel` focus with torn-off windows** — waits on the library.
- **Adopting new library features**: `replaceRange`, `hasModalLayer`,
  `DockCloseController`, `resizeMode`, the `lint` option (which would now pick
  up the library's CSS and Python lint sources), and the rest.
- **Removing the status-bar width pins**, or `handleCursorChange`'s
  `syncSelectionMetrics` call that 0.11 made redundant.[^selection-comment]
- **Changing how the main tree links the library**, or documenting the link in
  README.
- **Library changes.** Nothing under `../typescript-ui/` is edited.

---

## Notes

[^registry-in-worktree]: Installing in the worktree is what proves the
    published 0.11.0 works for Loom. Until now every typecheck and test ran
    against the symlinked checkout, whose `package.json` `files` list is not
    applied (`dist/lib`, `llms.txt` and two notice files ship). The registry
    `gitHead` matches the checkout's HEAD (`180751e9`), so the results should
    match. The other option was to run the install in the main tree and
    restore the link afterwards. It was rejected because it rewrites the
    user's working setup for a branch that may not merge yet. The worktree
    sits inside the main tree (`.worktrees/`), so without a `node_modules` of
    its own, Node's parent-directory lookup would reach the main tree's,
    link included. The fresh install in step 1 shadows it.

[^library-owns-languages]: Loom added `css` and `python` at
    commit `e2788cb`, when the library shipped five languages. 0.9.0's
    changelog (*"plus the CSS and Python languages"*) moved both into the
    library's `component/editor/languages.ts:683-705`. The `css` entry
    carries `loadFormatter` (Prettier's `postcss` plugin) and `loadLintSource`;
    the `python` entry carries `loadLintSource` only, with the comment
    *"No formatter: format() falls back to CodeMirror's own re-indent."*
    `registerLanguage` is `_registry.set(def.id, def)`
    (`LanguageRegistry.ts:123`). The barrel imports `languages.js` before
    Loom's module body runs, so Loom's later `set` replaced the library's
    entry with a grammar-only one. `hasFormatter` reads
    `getLanguage(id)?.loadFormatter`, so it answered `false` for CSS, and
    `formatBeforeSave` skipped CSS files. The lint sources Loom also dropped
    are inert, because Loom never sets `lint: true` on its editors. Keeping
    Loom's blocks and adding `loadFormatter` to them was not considered: it
    would copy the library's definition into Loom for no benefit.

[^keep-codemirror-deps]: `editorSearch.ts` imports `EditorView` and `keymap`
    from `@codemirror/view`, `StateEffect` from `@codemirror/state`, and
    `search`, `searchKeymap` and `openSearchPanel` from `@codemirror/search`.
    Relying on the library's copies through npm hoisting would be an
    undeclared dependency. Those imports go away with the `editorSearch.ts`
    rewrite, which is out of scope. `lang-css` and `lang-python` are still
    installed after `npm uninstall`, as dependencies of the library, which is
    the right owner for them.

[^size-lock]: The lock was added by
    `plans/implemented/about-dialog-and-welcome-glyph.md`, because 0.8's
    `Image.getPreferredSize()` returned the natural 240×240 size and ignored
    `preferredSize`. 0.9.0 changed that: `getPreferredSize()` returns the
    explicit constraint, and `handleLoad` publishes the natural size only
    when there is no explicit one (`Image.ts:714`). So `preferredSize` alone
    now yields an 80×80 preferred size. `minSize` still matters for a
    different reason. `VBox` shrinks an overflowing column's non-weighted
    children toward their minimum height (`VBox.ts:653`, `resolveChildHeight`),
    and `Image.getMinSize()` defaults to `{0, 0}` since 0.9.0. The
    `WelcomeScreen` column uses `itemAlign: 'center'`, which keeps the
    preferred 80px width. A short editor pane would therefore draw the mark
    80px wide and less than 80px tall, and `<img>`'s default
    `object-fit: fill` would squash the artwork. `maxSize` is only a guard
    today: neither layout grows the mark past its preferred size. It also
    writes a CSS `max-*` on the element, as the original footnote notes, and
    it costs nothing to keep. Deleting `minSize` and `maxSize` was rejected
    for the squash case. Changing `Image` to keep its aspect ratio instead
    (`preserveAspectRatio`) would be a feature adoption.

[^about-wrapper]: Both constructs were workarounds for 0.8's live-DOM read.
    `mark.getElement(true)` existed because `Dialog` measures its content
    synchronously before attaching it, and 0.8's `getPreferredSize` threw on
    an unrendered `<img>`. Since 0.9.0, `getPreferredSize` reads the stored
    constraint, and the changelog states the old live-DOM read is gone. The
    `Fit`-managed `markSlot` hid the raw 240 from `Dialog`'s height
    measurement and from the flex row's leftover-width split. With the mark
    reporting 80×80 itself, the slot adds a container and changes nothing.
    The `markRow` comment's reasoning, that a lone centred child would cap
    the row's max size at 80×80, still holds, because `mark` carries
    `maxSize` 80×80 just as `markSlot` reported it. Case 11 checks the
    result.

[^pin-stays]: `Text.setText` (`Text.ts:884`) now returns early on an equal
    string. Otherwise it marks the measurement dirty and, under auto-measure,
    calls `(parent ?? this).scheduleLayout()`. Measurement happens later, in
    `calculateSize`, through `measureTextMetrics`. 0.10.0's changelog says a
    single line in a canvas-reproducible font is measured on a canvas, with
    the probe kept for wrap widths, unusual whitespace and fonts the canvas
    cannot reproduce. So the TODO's *`Text.setText` → `calculateSize` →
    synchronous reflow* no longer describes the code. Whether the pins still
    save anything measurable in WebKitGTK (a status-bar layout pass per
    event, plus a probe fallback if the status-bar font fails canvas
    calibration) is an engine question. Chromium-based checks of Loom have
    missed paint-bound costs that WebKitGTK recordings showed, so only a
    real recording should retire them. The `visibility: hidden` wording
    dates from before 2026-09-14, when `Tab` started taking inactive pages
    out of the render tree with `display: none`. TODO.md already records
    that history correctly.

[^selection-comment]: The current comment's description of the dedupe
    (*"on the selection's normalized span (`main.from`/`main.to`)"*) matches
    0.11's `onSelectionChange` (`CodeEditor.ts:1912`), which compares all
    four fields. What it leaves out is the consequence: a collapsed
    selection's `from`/`to` move with the caret, so the event now fires on
    every caret move. `handleCursorChange` also calls `syncSelectionMetrics`,
    so each caret move runs it twice with the same state, and the second
    `setText` gets the same string and returns early. Removing
    `handleCursorChange`'s call would make the selection readout depend on
    0.11's firing rule for a saving of one string comparison per caret move,
    so it stays as is.

[^find-panel]: The library's editor theme (`theme.ts:225-235`) sets
    `.cm-panel.cm-search { display: none }` and hides a `.cm-panels`
    container whose only child is that panel. The theme is scoped to the
    editor, so the rule hides any CodeMirror search panel inside a library
    `CodeEditor`, including one opened from Loom's own `@codemirror/search`
    copy. What the user sees is the library's `CodeEditorSearchPanel`
    (0.9.0 changelog: *"a framework-built floating card, pinned to the
    editor's upper-right corner"*). Its controls are a find field, *Match
    upper and lower case exactly*, *Match whole words only*, *Read the search
    text as a regular expression*, previous/next (Shift+Enter/Enter),
    *Select every match*, close (Escape), a replace field, *Replace the
    current match* and *Replace every match*. The project-search bullet's
    *"The two toggles match the in-file find panel's own"* stays true: the
    card has *match case* and *regular expression*.

[^tree-keys]: `migration/0.11.0.md:139-158` (keyboard `"contextmenu"` with a
    synthetic event) and `:448-461` (`Enter` fires `"dblclick"`). Loom reads
    neither event's `target`. `FileTree.handleNodeContextMenu` and
    `SearchPanel.handleContextMenu` use the node and `clientX`/`clientY`,
    which the migration note says are set in both cases. Loom has no
    `keydown` handler for `Enter` on either tree; `SearchPanel`'s only
    `Enter` handler is on its query field. So nothing opens twice. The key-raised
    real event is `preventDefault`ed by `Tree._handleContextMenu` when there
    is a current row (`Tree.ts:2333`), so `FileTree`'s background listener,
    which checks `defaultPrevented` in a microtask, does not open the root
    menu as well. These are user-visible changes this bump brings to Loom,
    so README describes them. FileTree's one-line doc was false
    (*"fires only when a row is right-clicked"*), and SearchPanel's `@param`
    lines describe the same event, so both are corrected.

[^guard-test]: The guard case covers the one new assumption this plan
    makes: every id in Loom's extension map is registered by someone else.
    It cannot fail against 0.11.0 as written, which is why step 4 proves it
    by breaking the map on purpose. Loom's tests already import the library
    barrel through `src/editor/languages.ts`, and 0.10.0 made that import
    safe in vitest's `node` environment, so the extra `getLanguage` import
    needs no setup. The CSS flip is the real red-green: it fails in step 3
    and passes only after step 5.

[^link-history]: The user's shell history shows the link was made with
    `rm -rf typescript-ui && ln -sf /home/jika/typescript/typescript-ui/packages/lib typescript-ui`
    from inside `node_modules/@jimka`. `npm link` was not used: the global
    `@jimka/typescript-ui` link under nvm still points at the
    pre-monorepo repo root, and the main tree's symlink target is absolute,
    where npm would have written a relative one.
