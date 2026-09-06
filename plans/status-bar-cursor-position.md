---
touches-shared:
  - src/EditorController.ts
---

# Status Bar Cursor Position — Implementation Plan

## Overview

[`EditorController`](src/EditorController.ts#L34) owns the app's status bar and puts a single
indicator in it: a `Text` showing the active file's language
([src/EditorController.ts:1024](src/EditorController.ts#L1024)). Nothing reports where the caret is.

This plan adds a second indicator — `Ln 12, Col 5` — immediately to the left of the language text,
fed by the active file's `CodeEditor`. A new pure `src/editor/cursorLabel.ts` holds the label rule
and a new `tests/cursorLabel.test.ts` covers it; [`src/EditorController.ts`](src/EditorController.ts)
creates the `Text`, subscribes each open file's editor, and re-derives the readout from whichever
file is active. `README.md` and `TODO.md` follow.

The `CodeEditor` API the readout reads — `getCursorPosition()` and the `"cursorchange"` event — is
not in the installed library build yet. It is planned and being implemented in
`@jimka/typescript-ui`, in that repository's
[`plans/code-editor-cursor-position.md`](../typescript-ui/plans/code-editor-cursor-position.md).
Loom resolves the library through a symlink into its built `dist/`, so nothing here typechecks until
that change lands and the library is rebuilt; step 1 is the check for it.[^cross-repo-dep]

---

## Architecture Decisions

### The readout is a second status-bar `Text`, added before the language text

`StatusBar.addRight` appends after the bar's flex spacer, in call order
([StatusBar.ts:204](../typescript-ui/packages/lib/src/typescript/lib/component/container/StatusBar.ts#L204)),
so the first widget added is the leftmost of the right-hand group. The constructor therefore calls
`addRight(this._cursorText)` **before** the existing `addRight(this._languageText)`.[^right-not-left]

| Constructor calls | Resulting row, left to right |
|---|---|
| `addRight(_cursorText)`, then `addRight(_languageText)` | `Saved notes.md` … spacer … `Ln 12, Col 5`  `markdown` |
| `addRight(_languageText)`, then `addRight(_cursorText)` | `Saved notes.md` … spacer … `markdown`  `Ln 12, Col 5` |
| `addLeft(_cursorText)` | `Saved notes.md`  `Ln 12, Col 5` … spacer … `markdown` |

### Every open file's editor is subscribed when its tab is created; the handler ignores all but the active file

One `on('cursorchange', …)` per file, registered beside the existing `onDirtyChange` wiring in
[`newFile`](src/EditorController.ts#L340) and [`addFileTab`](src/EditorController.ts#L440).
`handleCursorChange(file)` returns immediately unless `file` is the active one, so a background
editor's caret can never paint over the active file's readout.

Both halves follow existing code in this class: `handleDirtyChange`
([src/EditorController.ts:900](src/EditorController.ts#L900)) is the per-file listener registered
once at tab creation and never removed, and `markExternalChanges`
([src/EditorController.ts:248](src/EditorController.ts#L248)) is the existing per-file event path
that acts only when `file === active`.[^subscribe-all]

### One private method re-derives the readout from the active file

`syncCursorPosition(file)` reads `file.getEditor().getCursorPosition()` live and writes the label.
The `"cursorchange"` handler calls it, and so does `syncActive`
([src/EditorController.ts:1006](src/EditorController.ts#L1006)) — the method every open, close,
restore, save-as and tab switch already routes through. That second caller is what makes a
freshly activated file show its caret straight away: the library's `"cursorchange"` does not fire
for an editor's starting position, so an event-only readout would sit blank until the first caret
move.[^re-derive]

### The caret handler does not call `syncActive`

`syncActive` sets the window title through `setWindowTitle` (a Tauri IPC call) and notifies two
shell listeners. A caret move happens on every keystroke and every arrow key, so the handler calls
`syncCursorPosition` alone.

### The label rule lives in a pure module, `src/editor/cursorLabel.ts`

`cursorLabel` owns both the format and the no-file case, mirroring
[`src/shell/treeSectionLabel.ts`](src/shell/treeSectionLabel.ts) and
[`src/shell/welcomeText.ts`](src/shell/welcomeText.ts): a display-string rule split out of its
component file so vitest's `node` environment can test it.[^pure-module]

| Active file's caret | `cursorLabel` returns |
|---|---|
| `{ line: 1, column: 1 }` | `'Ln 1, Col 1'` |
| `{ line: 12, column: 5 }` | `'Ln 12, Col 5'` |
| none — no file is open (`null`) | `''` |

The empty string for "no file open" is what `_languageText` already shows in that state
([src/EditorController.ts:1015](src/EditorController.ts#L1015)).

### The format is `Ln {line}, Col {column}`

Both numbers are printed as the library reports them, with no arithmetic and no padding.[^label-format]

---

## Public API

Loom publishes no package API, and `EditorController` gains private members only. The one new module
exports a single function:

```typescript
// src/editor/cursorLabel.ts
export function cursorLabel(position: CodeEditorCursorPosition | null): string
```

`CodeEditorCursorPosition` (`{ line: number; column: number }`, both 1-based) is exported from
`@jimka/typescript-ui/component/editor` by the sibling library change.

---

## Internal Structure

### `src/editor/cursorLabel.ts` — the whole file

```typescript
// The status bar's caret-readout rule, split out of EditorController.ts so it
// stays unit testable: vitest.config.ts runs in the `node` environment with
// no DOM, and a module that imports @jimka/typescript-ui's components
// touches `document` at load time.
import type { CodeEditorCursorPosition } from '@jimka/typescript-ui/component/editor'

/**
 * The status bar's caret readout: the caret's 1-based line and column, or the
 * empty string when no file is open — the same blank the language text beside
 * it falls back to.
 *
 * @param position - The active file's caret position, or `null` when no file is open.
 * @returns The text to show in the status bar's cursor readout.
 */
export function cursorLabel(position: CodeEditorCursorPosition | null): string {
    return position === null ? '' : `Ln ${position.line}, Col ${position.column}`
}
```

The `import type` is erased at compile time, so the module still loads under vitest's `node`
environment — the same arrangement [`src/data/settings.ts:5`](src/data/settings.ts#L5) already uses
for `FormatOptions`.

### `src/EditorController.ts` — the edits

Field, declared immediately **before** `_languageText`
([src/EditorController.ts:54](src/EditorController.ts#L54)) so the field order matches the row order:

```typescript
private readonly _cursorText: Text
```

Constructor, replacing [src/EditorController.ts:73-75](src/EditorController.ts#L73):

```typescript
this.statusBar = new StatusBar()
this._cursorText = new Text('')
this._languageText = new Text('')
this.statusBar.addRight(this._cursorText)
this.statusBar.addRight(this._languageText)
```

Subscription, added directly after the existing `onDirtyChange` line in both
[`newFile`](src/EditorController.ts#L340) and [`addFileTab`](src/EditorController.ts#L440):

```typescript
file.onDirtyChange(() => this.handleDirtyChange(file))
file.getEditor().on('cursorchange', () => this.handleCursorChange(file))
```

Handler, placed immediately after `handleDirtyChange`
([src/EditorController.ts:900-907](src/EditorController.ts#L900)):

```typescript
/**
 * Registered as a `"cursorchange"` listener on each open file's editor:
 * repaints the status bar's caret readout. A file that is not the active one
 * is ignored — only the active file's caret is on show.
 */
private handleCursorChange = (file: FileEditor): void => {
    if (file !== this.getActiveFile()) {
        return
    }

    this.syncCursorPosition(file)
}
```

Readout painter, placed immediately after `syncActive`, last in the class:

```typescript
/**
 * Sets the status bar's caret readout from `file`'s editor, read live rather
 * than from a `"cursorchange"` payload — the same call serves an activation,
 * where no event fires at all.
 *
 * @param file - The active file, or `null` when no file is open.
 */
private syncCursorPosition(file: FileEditor | null): void {
    const position = file === null ? null : file.getEditor().getCursorPosition()

    this._cursorText.setText(cursorLabel(position))
}
```

Its call site inside `syncActive`, one line after
`this._activeFileListener?.(file?.getPath() ?? null)`
([src/EditorController.ts:1011](src/EditorController.ts#L1011)) and **before** the `if (!file)`
early return, so one call covers both branches:

```typescript
this._activeFileListener?.(file?.getPath() ?? null)
this.syncCursorPosition(file)
```

---

## Ordered Implementation Steps

1. **Prerequisite — the library API must be built.** Run
   `grep -c 'getCursorPosition' node_modules/@jimka/typescript-ui/dist/lib/types/component/editor/CodeEditor.d.ts`.
   Expect at least one match. On zero, stop: the sibling library change
   ([`../typescript-ui/plans/code-editor-cursor-position.md`](../typescript-ui/plans/code-editor-cursor-position.md))
   has not been implemented and built yet. Once it has been, `npm run build:lib` at that repository's
   root regenerates the `dist/` Loom's symlink resolves through. Nothing below typechecks until this
   grep matches.

2. **Create `src/editor/cursorLabel.ts`** exactly as given in `## Internal Structure`. One
   `import type`, one exported function, no runtime imports.
   *Check:* `grep -c '^import' src/editor/cursorLabel.ts` — expect `1`.

3. **Create `tests/cursorLabel.test.ts`** — one `describe('cursorLabel')` with one `it` per row of
   the table in `## Expected Behaviour` › *Unit-testable*. Follow
   [`tests/treeSectionLabel.test.ts`](tests/treeSectionLabel.test.ts)'s style: one `expect` per
   `it`, a sentence-shaped test name.
   *Check:* `npm test` — the new block passes, every existing test untouched.

4. **`src/EditorController.ts`** — add `import { cursorLabel } from './editor/cursorLabel'` beside
   the existing `./editor/languages` import
   ([src/EditorController.ts:8](src/EditorController.ts#L8)), declare the `_cursorText` field before
   `_languageText` ([src/EditorController.ts:54](src/EditorController.ts#L54)), and replace the
   constructor's three status-bar lines
   ([src/EditorController.ts:73-75](src/EditorController.ts#L73)) with the five from
   `## Internal Structure`. Order matters: `_cursorText` is added first, which is what puts it left
   of the language text.

5. **`src/EditorController.ts`** — add the `syncCursorPosition` method from `## Internal Structure`
   after `syncActive`, then add its call inside `syncActive` after
   `this._activeFileListener?.(…)` ([src/EditorController.ts:1011](src/EditorController.ts#L1011)).
   Update `syncActive`'s doc comment ([src/EditorController.ts:1005](src/EditorController.ts#L1005))
   to name the caret readout alongside the window title and language text.
   *Check:* `npm run typecheck` — clean. At this point the readout already tracks tab switches,
   opens and closes; only live caret moves are missing.

6. **`src/EditorController.ts`** — add the `handleCursorChange` field after `handleDirtyChange`
   ([src/EditorController.ts:907](src/EditorController.ts#L907)), then add the
   `file.getEditor().on('cursorchange', …)` line after the `onDirtyChange` line in both
   [`newFile`](src/EditorController.ts#L340) and [`addFileTab`](src/EditorController.ts#L440).
   *Check:* `grep -c "on('cursorchange'" src/EditorController.ts` — expect `2`. (A bare
   `cursorchange` grep also matches the two doc comments, so match the call itself.)

7. **Run the full check set:** `npm run typecheck`, `npm test`, `npm run build` — all clean.

8. **`README.md` and `TODO.md`** — apply the two edits in `## Documentation Impact`.

9. **`npm run tauri:dev`** — work through every bullet under `## Expected Behaviour` ›
   *Manual verification*.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `src/editor/cursorLabel.ts` |
| Create | `tests/cursorLabel.test.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Unit-testable (`tests/cursorLabel.test.ts`, node environment)

| `cursorLabel` argument | Result |
|---|---|
| `{ line: 1, column: 1 }` | `'Ln 1, Col 1'` |
| `{ line: 12, column: 5 }` | `'Ln 12, Col 5'` |
| `{ line: 340, column: 128 }` | `'Ln 340, Col 128'` |
| `null` | `''` |

### Manual verification (`npm run tauri:dev`)

The wiring is DOM- and event-driven, and vitest runs without a DOM, so everything below is verified
in the running app:

- **No file open** (fresh launch, or after closing the last tab): the right of the status bar is
  blank — no `Ln`, no language.
- **Opening a file** (tree click, Ctrl/Cmd+P, *Open Recent*, drag-and-drop): `Ln 1, Col 1` appears
  immediately, to the left of the language name, without touching the keyboard.
- **A new untitled file** (Ctrl/Cmd+N): same, `Ln 1, Col 1`.
- **Clicking mid-document, arrow keys, Home, End, Ctrl/Cmd+Home**: both numbers track the caret on
  every move.
- **Typing**: a character advances `Col` by one; Enter moves to the next line at `Col 1`.
- **A line starting with a literal tab**: placing the caret just after the tab reports `Col 2`, not
  `Col 5` — the library counts characters, not tab stops.
- **Switching tabs**: the readout jumps to the newly active file's own caret with no keypress;
  switching back restores the first file's position.
- **Session restore**: with several tabs restored on launch, the readout shows the active file's
  position and nothing from the background ones.
- **Format Document**, and a **save** with format-on-save enabled: the readout still matches where
  the caret visibly is; no stale numbers.
- **Saving**: `Saved <name>` appears at the left of the bar for two seconds and the readout is
  untouched.
- **Reload after an outside change** (edit the open file in another editor): the readout matches the
  reloaded document's caret.
- **Widening numbers do not shift the language text**: moving from `Ln 9` to `Ln 10` grows the
  readout leftwards; the language name stays put at the right edge.

The active-file guard in `handleCursorChange` has no manual case: today only the active editor
receives input, and the external-reload path resolves the active file only
([src/EditorController.ts:236-252](src/EditorController.ts#L236)). It is a correctness rule, not a
reproducible symptom — keep it.

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — clean, including the new `tests/cursorLabel.test.ts`.
- `grep -n 'addRight' src/EditorController.ts` — two matches, `_cursorText` on the earlier line.
- `grep -c "on('cursorchange'" src/EditorController.ts` — expect `2` (one per tab-creating method).
- `grep -c 'syncCursorPosition' src/EditorController.ts` — expect `3` (the method, the handler's
  call, `syncActive`'s call).
- `grep -c '^import' src/editor/cursorLabel.ts` — expect `1` (the type-only import; the module must
  stay loadable in the node test environment).
- `npm run build` — passes.
- `npm run tauri:dev` — every bullet under `## Expected Behaviour` › *Manual verification*.

---

## Documentation Impact

`README.md` gains a highlight bullet after **Breadcrumbs**:

> - **Status bar** — the caret's position in the active file (`Ln 12, Col 5`) sits at the right of
>   the bar, left of the file's language; save and reload messages appear at the left.

`TODO.md` gains one `## Low` item, per that file's stated purpose of collecting each plan's
`## Non-Goals`:

> - **Go to Line, and selection metrics in the status bar.** The bar reports the caret's line and
>   column but nothing acts on them: there is no *Go to Line* command, the readout is not clickable,
>   and it reports no selected-character or selected-line count. The library exposes the caret
>   read-only (no `setCursorPosition`), so a jump-to-line would need a new library API first.

No API documentation page exists in this repository — `README.md` and `TODO.md` are the only prose
surfaces.

---

## Potential Challenges

- **The library API must be built, not just written.** Loom's `@jimka/typescript-ui` resolves
  through a symlink into `packages/lib`, whose `exports` map points at `dist/`; a source-only change
  in that repository is invisible here. Step 1's grep is the gate.
- **A file whose tab has never been shown has no mounted view yet** — several restored tabs, only one
  of them laid out — so `getCursorPosition()` answers `{ line: 1, column: 1 }` for it, which is where
  its caret actually is, since a view opens at the document start. Do not add a "not mounted yet"
  branch or a `null` case. A tab that *has* been shown keeps its view and its caret while inactive
  (`Tab` only calls `setVisible(false)` on it), which is why switching back restores its position.
- **`"cursorchange"` fires on every caret move.** Keep `handleCursorChange` on `syncCursorPosition`
  alone; routing it through `syncActive` would issue a `setWindowTitle` IPC call per keystroke.
- **The readout's width changes with the digit count.** The bar's flex spacer absorbs it and the
  language text stays anchored at the right edge, so do not pin a `minSize` on the new `Text`.
- **`Text` is already imported** in `src/EditorController.ts`
  ([line 3](src/EditorController.ts#L3)); the only new import is `cursorLabel`.

---

## Critical Files

- [`src/EditorController.ts`](src/EditorController.ts) — the file being changed. Read the constructor
  ([:68-83](src/EditorController.ts#L68)), the two tab-creating methods `newFile`
  ([:330](src/EditorController.ts#L330)) and `addFileTab` ([:436](src/EditorController.ts#L436)),
  `handleDirtyChange` ([:900](src/EditorController.ts#L900)) — the per-file-listener precedent —
  `markExternalChanges` ([:236](src/EditorController.ts#L236)) — the active-file-guard precedent —
  and `syncActive` ([:1006](src/EditorController.ts#L1006)).
- [`src/editor/FileEditor.ts`](src/editor/FileEditor.ts#L240) — `getEditor()`, the only route from an
  open file to its `CodeEditor`.
- [`src/shell/treeSectionLabel.ts`](src/shell/treeSectionLabel.ts) and
  [`tests/treeSectionLabel.test.ts`](tests/treeSectionLabel.test.ts) — the pure-display-string module
  and test shape `cursorLabel` copies.
- [`src/data/settings.ts`](src/data/settings.ts#L5) — a node-tested module importing a library type
  with `import type`, the arrangement `cursorLabel.ts` reuses.
- [`../typescript-ui/packages/lib/src/typescript/lib/component/container/StatusBar.ts`](../typescript-ui/packages/lib/src/typescript/lib/component/container/StatusBar.ts#L188) —
  `addLeft` and `addRight`, which decide the row order.
- [`../typescript-ui/plans/code-editor-cursor-position.md`](../typescript-ui/plans/code-editor-cursor-position.md) —
  the contract for `getCursorPosition()` and `"cursorchange"`: 1-based fields, the document start
  before mount, no event for the starting position.

---

## Non-Goals

- **No *Go to Line*, and the readout is not clickable.** Reading the caret is this change; moving it
  needs a library API that does not exist (the sibling plan ships no `setCursorPosition`).
- **No selection metrics** — no selected-character count, no selected-line count, no multi-cursor
  count. The library reports the primary caret only.
- **No persisting the caret across restarts.** `session.json` and `.loom/workspace.json` record open
  tabs, not scroll or caret state, and this readout changes neither.
- **No further status-bar indicators** — no encoding, line-ending, indentation or spaces/tabs
  widget. Each is its own feature with its own data source.
- **No library change.** `getCursorPosition()` and `"cursorchange"` are implemented in
  `@jimka/typescript-ui` under its own plan; this plan consumes them unchanged.

---

## Notes

[^cross-repo-dep]: The dependency is not declared as `depends-on` frontmatter because that field
    names plans in *this* repository's `plans/implemented/`, and the plan being depended on lives in
    the `typescript-ui` repository — a value `/implement` could never satisfy or check. Making it
    step 1's grep instead puts the check where the implementer will actually run it, against the
    built artifact Loom really resolves (`node_modules/@jimka/typescript-ui` symlinks to
    `packages/lib`, whose `exports` map resolves `./component/editor` to
    `dist/lib/component/editor.es.js` and `dist/lib/types/component/editor/index.d.ts`).

[^right-not-left]: `addLeft` inserts before the flex spacer
    ([StatusBar.ts:188](../typescript-ui/packages/lib/src/typescript/lib/component/container/StatusBar.ts#L188)),
    which would park the readout at the far left, next to the transient `Saved <name>` /
    `Reloaded <name>` message — visually a different group, and jostled every time a message appears
    and expires. The requirement is the readout beside the language name, which makes it a
    right-group widget added before the language text.

[^subscribe-all]: Subscribing only the active file's editor and swapping the subscription on every
    activation was the alternative. It needs a new `_cursorSource` field, an `off` on the outgoing
    file, and correct handling of the close path — machinery this class has nowhere else — and it
    prevents no leak: `CodeEditor` registers its listener bag through `registerListenerBag`, whose
    `onDestroy(() => bag.clear())` drops every listener when the editor is destroyed, and `Tab`
    disposes a closed tab's content by default (`disposeOnClose !== false`), which destroys the
    `FileEditor` and, recursively, its `CodeEditor`. A subscription therefore lives exactly as long
    as the tab it belongs to, the same lifetime the existing `onDirtyChange` subscription already
    has. Cross-talk is what remains, and the identity guard settles it in one comparison.

[^re-derive]: The handler could take the position from the `"cursorchange"` payload instead of
    calling `getCursorPosition()`. Re-reading keeps one derivation path for both callers: the event
    path and the activation path produce the readout by the same two lines, so they cannot drift.
    It also matches the library's own demo panel, which re-reads its getters on every update rather
    than caching a payload. The cost is one `doc.lineAt` lookup per caret move, which the library
    already performs to emit the event.

[^label-format]: `Ln 12, Col 5` is the format the library's own plan, component documentation and
    demo panel state — its `line`/`column` fields are 1-based specifically "so they render directly
    as Ln 12, Col 5 with no arithmetic at the call site" — and it is what VS Code shows, which is
    the app Loom's tab, temp-tab and status-bar behaviour is modelled on throughout. `12:5` and
    `Line 12, Column 5` were the alternatives: the first is terser but unlabelled, the second is
    wider than the bar's right group wants. Loom exists to dogfood the library, so following the
    library's stated rendering beats inventing a third form.

[^pure-module]: `EditorController.ts` imports `@jimka/typescript-ui` components at module scope,
    which touch `document` on load, so nothing in it can be unit-tested under
    `vitest.config.ts`'s `node` environment. Extracting the label rule is the same move
    `treeSectionLabel.ts` and `welcomeText.ts` already made for their own components, and it is what
    gives this feature an automated red-green cycle at all: everything left in `EditorController`
    is DOM- and event-driven and can only be verified in the running app.
