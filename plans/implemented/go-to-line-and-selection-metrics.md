---
depends-on: [status-bar-document-offset]
touches-shared:
  - src/EditorController.ts
  - src/shell/EditorShell.ts
  - src/shell/commands.ts
---

# Go to Line, and Selection Metrics in the Status Bar — Implementation Plan

## Overview

The status bar's caret readout (`Ln 12, Col 5 · Pos 245`) is a plain `Text` that nothing acts on:
[`EditorController`](src/EditorController.ts#L68) holds it as `_cursorText` and repaints it from
[`syncCursorPosition`](src/EditorController.ts#L1170), but there is no *Go to Line* command, the
readout is not clickable, and the bar reports nothing about a selection.

This plan delivers *Go to Line* in full. The readout becomes a `Link` — the library's clickable-text
component, and a `Text` subclass, so the fixed-width treatment that
[`WIDEST_CURSOR_POSITION`](src/EditorController.ts#L37) installed to kill a per-keystroke reflow
survives untouched. Clicking it opens a modal line-number prompt built the way
[`promptName`](src/explorer/fileTreePrompts.ts#L20) already builds Loom's other single-input prompts,
and the accepted line is jumped to through [`FileEditor.revealMatch`](src/editor/FileEditor.ts#L263)
— the same seam the project-search results list uses. The command is also reachable from the Edit
menu and the command palette.

The selection half of the feature — a selected-character and selected-line count in the bar —
**cannot be built yet**. `CodeEditor` exposes no way to read a selection's extent: its public surface
offers `getCursorPosition()` and a `"cursorchange"` event carrying `{ line, column, offset }` for the
caret alone, and nothing for the selection's other end. That is a gap in `@jimka/typescript-ui`, not
something to work around in Loom, so this plan specifies the display and the wiring but stops at a
gate. See `## Open Questions`, which a human must settle before step 14.

---

## Architecture Decisions

### The readout becomes a `Link`, the library's clickable text

`_cursorText`'s type changes from `Text` to `Link` (`@jimka/typescript-ui/component/input`, the same
subpath `Text` already comes from), restyled to look exactly as it does today. `Link` is a `Text`
subclass whose hit area is its own box, so every line of the existing fixed-width setup —
`measure()`, `setPreferredSize`, `setAutoMeasure(false)`, `setTextAlign('right')` — keeps working
verbatim.[^link-not-button]

Two option-bag overrides make the readout read as status-bar text rather than as a web link: the
class-level underline goes via the documented `styleRules` escape hatch, and the link colour gives way
to the bar's own foreground token.

```typescript
this._cursorText = new Link('', {
    foregroundColor: 'var(--ts-ui-statusbar-color)',
    styleRules: [{ suffix: '', styles: { textDecoration: 'none' } }],
})
```

`Link` already defaults to `cursor: 'pointer'`, which is the hover affordance; a
`Tooltip.attach(this._cursorText, 'Go to Line')` names the action.

### No global keyboard chord — the palette, the Edit menu, and the readout click are the entry points

`Ctrl/Cmd+G`, the chord VS Code uses, is already bound inside every Loom editor: the library's
`CodeEditor` installs CodeMirror's `searchKeymap` in its base keymap
([CodeEditor.ts:1888](../typescript-ui/packages/lib/src/typescript/lib/component/editor/CodeEditor.ts#L1888)),
and that keymap binds `Mod-g` to *find next*. Loom's accelerators are a single `window` keydown
listener that does not consult `event.defaultPrevented`
([shortcuts.ts:139](src/shell/shortcuts.ts#L139)), so binding `Ctrl/Cmd+G` would fire *find next* and
the Go to Line prompt together on the same keypress. This plan adds no chord and no
`shortcuts.ts` constant.[^no-chord]

### The prompt is a `Dialog` with a `TextField`, mirroring `promptName`

`src/editor/goToLinePrompt.ts` holds `promptGoToLine`, built from the four pieces
[`promptName`](src/explorer/fileTreePrompts.ts#L20) uses: a `TextField`, a `Fit`-laid `Container`, a
`FieldDecorator` for the inline error, and `Dialog.show` whose confirm button's `onClick` returns
`false` to keep the dialog open when the input is rejected.[^not-numberspinner]

The shape is copied rather than shared. Extracting `promptName` into a module both callers import
would make `src/explorer/` depend on `src/shell/`, reversing the only cross-directory import
direction the repository has.[^no-extract]

### The jump goes through `FileEditor.revealMatch`, with `column: 0` and `length: 0`

`revealMatch` takes a `MatchLocation` ([src/data/projectSearch.ts:30](src/data/projectSearch.ts#L30))
whose `column` is **0-based** — [`editorSearch.revealRange`](src/editor/editorSearch.ts#L80) adds one
before handing it to the library, which counts columns from 1. So the start of line *N* is
`{ line: N, column: 0, length: 0 }`.

| `MatchLocation` passed | Caret lands at | Highlight |
|---|---|---|
| `{ line: 1, column: 0, length: 0 }` | line 1, column 1 | none |
| `{ line: 42, column: 0, length: 0 }` | line 42, column 1 | none |
| `{ line: 9999, column: 0, length: 0 }` in a 420-line file | line 420, column 1 | none |

`length: 0` suppresses the accent highlight, and an out-of-range line clamps to the last line — both
come from the library and need no Loom-side handling.[^reveal-reuse]

### Validation is one pure rule: a positive decimal integer

`parseLineNumber` lives in `src/editor/lineNumber.ts` with `countLines`, both pure so vitest's `node`
environment can test them — the same split [`cursorLabel.ts`](src/editor/cursorLabel.ts) already
made. Range is deliberately *not* checked: `CodeEditor.revealRange` clamps against the live document,
and a second clamp in Loom could only disagree with it.

| Raw input | `parseLineNumber` returns |
|---|---|
| `'1'` | `1` |
| `'  42  '` | `42` |
| `'042'` | `42` |
| `''` | `null` |
| `'0'` | `null` |
| `'-3'` | `null` |
| `'12.5'` | `null` |
| `'12abc'` | `null` |
| `'1e3'` | `null` |

### The selection metric is its own status-bar `Text`, not a fourth segment of the caret readout

When the library gap in `## Open Questions` is closed, the count lands in a new `_selectionText`
widget added to the bar **before** `_cursorText`, so it sits to its left. It is a plain `Text`, not a
`Link`.[^separate-widget]

The selection metric's rule lives in `src/editor/selectionLabel.ts` as `selectionLabel`, formatted
after VS Code's `(N selected)` wording, with the line count added only when the selection spans more
than one line:

| Selection | `selectionLabel` returns |
|---|---|
| empty, or no file open | `''` |
| 8 characters on one line | `'8 selected'` |
| 142 characters over 6 lines | `'142 selected, 6 lines'` |

---

## Public API

Loom publishes no package API. `EditorController` gains one public method; the rest is new module
exports.

```typescript
// src/editor/lineNumber.ts
export function parseLineNumber(raw: string): number | null
export function countLines(text: string): number

// src/editor/goToLinePrompt.ts
export function promptGoToLine(lineCount: number): Promise<number | null>

// src/EditorController.ts — new public method
async goToLineInActive(): Promise<void>

// src/shell/commands.ts — PaletteCommandActions gains one field
onGoToLine: () => void
```

Phase two only, blocked on `## Open Questions`:

```typescript
// src/editor/selectionLabel.ts
export function selectionLabel(metrics: { characters: number; lines: number } | null): string
```

---

## Internal Structure

### `src/editor/lineNumber.ts` — the whole file

```typescript
// Pure line-number rules for the Go to Line prompt, kept out of
// goToLinePrompt.ts so vitest's `node` environment can test them: that module
// imports @jimka/typescript-ui components, which touch `document` at load
// time.

/** Matches a bare run of ASCII decimal digits — no sign, no decimal point, no exponent. */
const DIGITS_ONLY = /^[0-9]+$/

/**
 * The line number `raw` names, or `null` when it does not name one. Leading and
 * trailing whitespace is ignored and leading zeros are accepted; anything that
 * is not a run of decimal digits, and zero itself, is rejected. No upper bound
 * is applied — `CodeEditor.revealRange` clamps a too-large line against the
 * live document.
 *
 * @param raw - The prompt field's text.
 * @returns The 1-based line number, or `null` when `raw` does not name one.
 */
export function parseLineNumber(raw: string): number | null {
    const trimmed = raw.trim()

    if (!DIGITS_ONLY.test(trimmed)) {
        return null
    }

    const line = Number(trimmed)

    return line === 0 ? null : line
}

/**
 * How many lines `text` has, counting the way CodeMirror does: one more than
 * the number of newlines, so an empty document has one line and a trailing
 * newline opens a final empty one. A `\r\n` pair counts once, since it carries
 * exactly one `\n`.
 *
 * @param text - The document's full text.
 * @returns The line count, always at least 1.
 */
export function countLines(text: string): number {
    let lines = 1

    for (const character of text) {
        if (character === '\n') {
            lines += 1
        }
    }

    return lines
}
```

### `src/editor/goToLinePrompt.ts` — the whole file

```typescript
// The Go to Line prompt. Same four pieces as `promptName` in
// ../explorer/fileTreePrompts.ts — a TextField in a Fit-laid Container, a
// FieldDecorator for the inline error, and a confirm button whose onClick
// returns false to keep the dialog open on a rejected value.
import { Container } from '@jimka/typescript-ui/core'
import { Fit } from '@jimka/typescript-ui/layout'
import { TextField } from '@jimka/typescript-ui/component/input'
import { Dialog } from '@jimka/typescript-ui/overlay'
import { FieldDecorator } from '@jimka/typescript-ui/validation'
import { parseLineNumber } from './lineNumber'

/**
 * Prompts for a line number to jump to, re-showing an inline error instead of
 * closing when the field does not name one. The field starts empty; the
 * document's line range is shown as the placeholder rather than pre-filled, so
 * the user types the destination straight in.
 *
 * @param lineCount - The document's line count, shown in the placeholder.
 * @returns The line number to jump to, or `null` if the user cancels.
 */
export async function promptGoToLine(lineCount: number): Promise<number | null> {
    const field = TextField({ placeholder: `Line number (1-${lineCount})` })
    const body = Container({ layoutManager: Fit(), components: [field] })
    const decorator = FieldDecorator(field, body)

    field.on('change', () => decorator.clearError())

    let confirmed: number | null = null

    await Dialog.show({
        title: 'Go to Line',
        contentComponent: body,
        initialFocus: field,
        buttons: [
            { text: 'Cancel', result: 'cancel' },
            {
                text: 'Go',
                result: 'confirm',
                primary: true,
                onClick: () => {
                    const line = parseLineNumber(field.getValue())

                    if (line === null) {
                        decorator.showError('Enter a line number.')

                        return false
                    }

                    confirmed = line

                    return true
                },
            },
        ],
    })

    return confirmed
}
```

### `src/EditorController.ts` — the constructor's readout block

Replacing the one line at [src/EditorController.ts:89](src/EditorController.ts#L89). Everything below
it — the long perf comment at [:92-108](src/EditorController.ts#L92) and the measure-once block at
[:109-120](src/EditorController.ts#L109) — stays exactly as it is:

```typescript
this._cursorText = new Link('', {
    foregroundColor: 'var(--ts-ui-statusbar-color)',
    styleRules: [{ suffix: '', styles: { textDecoration: 'none' } }],
})
```

and, immediately after `this.statusBar.addRight(this._languageText)`
([:123](src/EditorController.ts#L123)):

```typescript
Tooltip.attach(this._cursorText, 'Go to Line')
this._cursorText.on('action', () => { void this.goToLineInActive() })
```

### `src/EditorController.ts` — the command

Placed immediately after [`findInActive`](src/EditorController.ts#L795), whose one-line shape it
follows:

```typescript
/**
 * Prompts for a line number and jumps the active file's caret to the start of
 * that line, centred in the viewport. A no-op with no file open — which is
 * also what makes the status bar's caret readout safe to click while the bar
 * is blank.
 */
async goToLineInActive(): Promise<void> {
    const file = this.getActiveFile()

    if (!file) {
        return
    }

    const line = await promptGoToLine(countLines(file.getEditor().getValue()))

    if (line !== null) {
        file.revealMatch({ line, column: 0, length: 0 })
    }
}
```

---

## Ordered Implementation Steps

1. **Prerequisite — the installed library must carry `revealRange`.** Run
   `grep -c 'revealRange' node_modules/@jimka/typescript-ui/dist/lib/types/component/editor/CodeEditor.d.ts`.
   Expect at least one match. On zero, stop and report it: `node_modules/@jimka/typescript-ui` is a
   symlink into a `typescript-ui` checkout whose `dist/` predates `CodeEditor.revealRange`, and
   `npm run build:lib` at that repository's root must regenerate it first. Nothing below typechecks
   until this grep matches.[^library-build-gate]

2. **Create `src/editor/lineNumber.ts`** exactly as given in `## Internal Structure`. No imports.
   *Check:* `grep -c '^import' src/editor/lineNumber.ts` — expect `0`.

3. **Create `tests/lineNumber.test.ts`** — one `describe` per exported function, one `it` per row of
   the two tables in `## Expected Behaviour` › *Unit-testable*. Follow
   [`tests/cursorLabel.test.ts`](tests/cursorLabel.test.ts): one `expect` per `it`, a
   sentence-shaped test name.
   *Check:* `npm test` — the new blocks pass, every existing test untouched.

4. **Create `src/editor/goToLinePrompt.ts`** exactly as given in `## Internal Structure`.
   *Check:* `npm run typecheck` — clean.

5. **`src/EditorController.ts` — the readout's type.** Change the
   `@jimka/typescript-ui/component/input` import ([line 3](src/EditorController.ts#L3)) to bring in
   `Link` alongside `Text` (`Text` is still used for `_languageText`), and add `Tooltip` to the
   existing `@jimka/typescript-ui/overlay` import ([line 4](src/EditorController.ts#L4)). Change the
   `_cursorText` field's declared type from `Text` to `Link`
   ([line 68](src/EditorController.ts#L68)) and replace its construction
   ([line 89](src/EditorController.ts#L89)) with the `new Link(…)` block from `## Internal
   Structure`. Leave [lines 92-120](src/EditorController.ts#L92) — the perf comment, `measure()`,
   `setPreferredSize`, `setAutoMeasure(false)`, `setTextAlign('right')` — exactly as they are.
   *Check:* `npm run typecheck` — clean. `grep -c 'setAutoMeasure(false)' src/EditorController.ts` —
   expect `1`; the fixed-width mitigation must survive the type change.

6. **`src/EditorController.ts` — the command.** Add
   `import { promptGoToLine } from './editor/goToLinePrompt'` and
   `import { countLines } from './editor/lineNumber'` beside the existing `./editor/cursorLabel`
   import ([line 8](src/EditorController.ts#L8)), then add `goToLineInActive` from
   `## Internal Structure` immediately after `findInActive`
   ([:795-797](src/EditorController.ts#L795)).
   *Check:* `npm run typecheck` — clean.

7. **`src/EditorController.ts` — the click wiring.** Add the `Tooltip.attach` and `on('action', …)`
   lines from `## Internal Structure` after
   `this.statusBar.addRight(this._languageText)` ([:123](src/EditorController.ts#L123)).
   *Check:* `grep -c "on('action'" src/EditorController.ts` — expect `1`.

8. **`src/shell/commands.ts`** — add `onGoToLine: () => void` to `PaletteCommandActions` after
   `onFind` ([:47](src/shell/commands.ts#L47)), and the command entry to the array in
   `buildPaletteCommands` immediately after the `find` entry
   ([:81](src/shell/commands.ts#L81)), keeping the column alignment of the surrounding lines:

   ```typescript
   { id: 'go-to-line',      title: 'Go to Line…',     enabled: hasActiveFile, run: actions.onGoToLine },
   ```

   No `shortcut` field — per `## Architecture Decisions`, the command has no chord.

9. **`tests/commands.test.ts`** — add `onGoToLine: () => {},` to the `actions` factory; insert
   `'go-to-line'` after `'find'` in both id-order arrays (and rename both tests from "eleven" to
   "twelve"); add `'go-to-line'` to the `for` loop in *marks the per-file commands disabled…* and to
   the one in *leaves Save disabled but the other file commands enabled…*.
   *Check:* `npm test` — clean.

10. **`src/main.ts`** — add `import { list_ol } from '@jimka/typescript-ui/glyphs/solid/list_ol'`
    beside the other glyph imports, and `list_ol` to the `Glyph.register(...)` call
    ([:32-35](src/main.ts#L32)). Without this the menu item's glyph renders as nothing.
    *Check:* `grep -c 'list_ol' src/main.ts` — expect `2`.

11. **`src/shell/EditorShell.ts`** — add to `MenuBarActions` ([:85](src/shell/EditorShell.ts#L85)),
    after `hasActiveFile`:

    ```typescript
    /** Prompts for a line number and jumps the active file's caret there. */
    onGoToLine: () => void
    ```

    wire it in the `actions` object ([:290](src/shell/EditorShell.ts#L290)) after `onFind`:

    ```typescript
    onGoToLine: () => { void controller.goToLineInActive() },
    ```

    and add the Edit-menu item after *Find in Files…* ([:651](src/shell/EditorShell.ts#L651)), above
    the separator:

    ```typescript
    { text: 'Go to Line…', glyph: 'list-ol', enabled: actions.hasActiveFile(), action: actions.onGoToLine },
    ```

    *Check:* `npm run typecheck` — clean. `MenuBarActions` structurally satisfies
    `PaletteCommandActions`, so `buildPaletteCommands(this._menuBarActions)`
    ([:516](src/shell/EditorShell.ts#L516)) needs no change.

12. **Run the full check set:** `npm run typecheck`, `npm test`, `npm run build` — all clean. Then
    apply the `README.md` and `TODO.md` edits in `## Documentation Impact`, and work through every
    bullet under `## Expected Behaviour` › *Manual verification — Go to Line*. **Everything above is
    shippable on its own.**

13. **Stop.** The selection-metrics half needs a `CodeEditor` capability that does not exist. Do not
    read the selection through `editorSearch.ts`'s `resolveView` seam, through
    `EditorView.findFromDOM`, or through any other route into CodeMirror's state. Take
    `## Open Questions` to the user and wait for an answer before continuing.

14. **Once the library change has landed and been built** — only then — create
    `src/editor/selectionLabel.ts` and `tests/selectionLabel.test.ts` from the table in
    `## Architecture Decisions` › *The selection metric is its own status-bar `Text`*, following
    `cursorLabel.ts`'s shape exactly. Add a `_selectionText: Text` field before `_cursorText`
    ([:68](src/EditorController.ts#L68)); construct it in the constructor, give it the same
    measure-once treatment `_cursorText` gets with `selectionLabel({ characters: 9_999_999, lines:
    99_999 })` as the widest case, and `addRight` it **before** `_cursorText`
    ([:122](src/EditorController.ts#L122)). Add a `syncSelectionMetrics(file)` method beside
    `syncCursorPosition` ([:1170](src/EditorController.ts#L1170)) and call it from both
    `syncActive` and `handleCursorChange` ([:1036](src/EditorController.ts#L1036)), plus from
    whatever new library event the resolved `## Open Questions` answer provides.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `src/editor/lineNumber.ts` |
| Create | `tests/lineNumber.test.ts` |
| Create | `src/editor/goToLinePrompt.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `src/shell/commands.ts` |
| Modify | `tests/commands.test.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `src/main.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |
| Create (step 14 only, after `## Open Questions` is settled) | `src/editor/selectionLabel.ts` |
| Create (step 14 only, after `## Open Questions` is settled) | `tests/selectionLabel.test.ts` |

---

## Expected Behaviour

### Unit-testable (`tests/lineNumber.test.ts`, node environment)

`parseLineNumber`:

| Argument | Result |
|---|---|
| `'1'` | `1` |
| `'42'` | `42` |
| `'  42  '` | `42` |
| `'042'` | `42` |
| `''` | `null` |
| `'   '` | `null` |
| `'0'` | `null` |
| `'-3'` | `null` |
| `'12.5'` | `null` |
| `'12abc'` | `null` |
| `'1e3'` | `null` |

`countLines`:

| Argument | Result |
|---|---|
| `''` | `1` |
| `'a'` | `1` |
| `'a\nb'` | `2` |
| `'a\n'` | `2` |
| `'a\r\nb'` | `2` |
| `'a\n\n\nb'` | `4` |

### Unit-testable (`tests/commands.test.ts`, node environment)

- `go-to-line` appears in the command list, immediately after `find`, in both the
  nothing-available and everything-available orderings.
- Its title is `'Go to Line…'` and it carries no `shortcut`.
- `enabled` is `false` with no active file, `true` with one.
- Its `run` callback invokes `onGoToLine` once, even while disabled — the same contract the existing
  *keeps a working run callback on a disabled command* test pins for `save`.

### Manual verification — Go to Line (`npm run tauri:dev`)

Everything below is DOM- and event-driven, which vitest cannot exercise:

- **No file open:** the right of the bar is blank. Clicking where the readout would be opens nothing.
- **Hovering the readout** with a file open shows a `Go to Line` tooltip after a short delay, and the
  pointer becomes a hand.
- **The readout looks unchanged** from before this plan: same colour as the language text beside it,
  no underline, same position, same right edge.
- **Clicking the readout** opens a *Go to Line* dialog with an empty field already focused, whose
  placeholder names the open document's real line range (`Line number (1-420)` in a 420-line file).
- **Typing `42` and pressing Enter** closes the dialog, puts the caret at line 42 column 1, scrolls
  line 42 to the vertical centre of the viewport, and leaves keyboard focus in the editor so the next
  arrow key moves the caret.
- **Clicking *Go*** does the same as Enter.
- **An empty field, `0`, `-3`, `abc`, or `12.5`** shows `Enter a line number.` inline and leaves the
  dialog open; editing the field clears the error.
- **A line number past the end** (`9999` in a 420-line file) jumps to line 420 rather than erroring.
- **Cancel, Escape, and the dialog's ✕** all close it and move the caret nowhere.
- **No accent highlight** is painted on the destination line — unlike a search result, which flashes.
- **On a Markdown file showing the preview:** the jump drops back to the source view first, then
  lands the caret.
- **Edit > Go to Line…** opens the same dialog, and is greyed out with no file open.
- **Command palette** (`Ctrl/Cmd+P`, then `>go`): a *Go to Line…* row appears with no shortcut hint,
  dim and unactivatable with no file open, and runs the command with one.
- **`Ctrl/Cmd+G` still finds the next match** inside the editor and does *not* open the dialog.
- **The caret readout keeps tracking** after the jump: it shows `Ln 42, Col 1 · Pos …` immediately.
- **Selection dragging still feels smooth** with several tabs open — the fixed-width mitigation
  survived the `Text`→`Link` change.

### Manual verification — selection metrics (step 14 only)

- With no selection, the bar looks exactly as it does after step 12 — no extra text, no visible gap
  where the selection readout will be.
- Selecting 8 characters on one line shows `8 selected` to the left of the caret readout.
- Extending the selection across 6 lines shows `142 selected, 6 lines`.
- Collapsing the selection (a plain click, or an arrow key) clears the text.
- Pressing `Ctrl/Cmd+A` with the caret already at the very end of the document still shows the count
  — the case a `"cursorchange"`-only wiring misses (see `## Open Questions`).
- Switching tabs shows the newly active file's own selection state with no keypress.

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — clean, including `tests/lineNumber.test.ts` and the updated `tests/commands.test.ts`.
- `npm run build` — passes.
- `grep -c 'setAutoMeasure(false)' src/EditorController.ts` — expect `1`.
- `grep -c '^import' src/editor/lineNumber.ts` — expect `0` (the module must stay loadable in the
  node test environment).
- `grep -rn 'GO_TO_LINE\|isGoToLineChord' src/` — expect zero matches (no chord was added).
- `grep -rn 'resolveView\|findFromDOM' src/` — expect matches in `src/editor/editorSearch.ts` only;
  nothing this plan adds may reach into CodeMirror's state.
- `npm run tauri:dev` — every bullet under `## Expected Behaviour` › *Manual verification — Go to
  Line*.

---

## Documentation Impact

**`README.md`** — replace the Status bar bullet ([README.md:82-84](README.md#L82)):

> - **Status bar** — the caret's line, column, and position in the document
>   (`Ln 12, Col 5 · Pos 245`) sit at the right of the bar, left of the file's
>   language; clicking the readout opens *Go to Line*, also on the Edit menu and
>   in the command palette. Save and reload messages appear at the left.

**`TODO.md`** — the `## High` item *Go to Line, and selection metrics in the status bar*
([TODO.md:27-32](TODO.md#L27)) is half-resolved by step 12. Replace it with the selection half alone:

> - **Selection metrics in the status bar.** The bar reports the caret's line, column and document
>   position, and clicking the readout opens *Go to Line* — but it still reports no selected-character
>   or selected-line count. `CodeEditor` exposes the caret only (`getCursorPosition()` and
>   `"cursorchange"` carry `{ line, column, offset }`), with no way to read the selection's other end,
>   so this needs a library API first — see
>   [`plans/go-to-line-and-selection-metrics.md`](plans/go-to-line-and-selection-metrics.md)'s
>   `## Open Questions`.

No API documentation page exists in this repository — `README.md` and `TODO.md` are the only prose
surfaces.

---

## Potential Challenges

- **The `Link`'s hit area is its reserved box, not its text.** `_cursorText` is pinned to the width of
  `Ln 99999, Col 999 · Pos 10000000` and right-aligned, so on a typical `Ln 12, Col 5 · Pos 245` the
  dozen-plus characters' worth of blank bar to its left is clickable too. Accepted: that slack sits
  against the bar's flex spacer, where there is nothing else to click, and narrowing it would mean
  giving up the fixed width and with it the per-keystroke reflow fix. Do not remove
  `setPreferredSize`/`setAutoMeasure(false)` to tighten it.
- **`Link` needs `dispose()` only if it is removed from the page.** This one is built in
  `EditorController`'s constructor and lives for the app's lifetime, so no `dispose` call is needed —
  and none should be added to a teardown path that does not exist.
- **`Text` stays imported** in `src/EditorController.ts`: `_languageText` is still a `Text`. Change
  the import to bring in both, do not replace it.
- **The `list-ol` glyph must be registered** in `src/main.ts` or the Edit-menu item shows a blank
  icon. The registry starts empty and Loom populates it at the composition root.
- **`MenuBarActions` and `PaletteCommandActions` are related only structurally** —
  `src/shell/commands.ts` declares its own narrower interface on purpose. Both need the new
  `onGoToLine` field; adding it to one and not the other fails the typecheck at
  [EditorShell.ts:516](src/shell/EditorShell.ts#L516).
- **CodeMirror's own `gotoLine` panel is already reachable** at `Ctrl+Alt+G` in every Loom editor,
  because the library's `CodeEditor` installs `searchKeymap` wholesale. It renders CodeMirror's
  unthemed DOM panel. This plan neither uses nor removes it; see `## Open Questions`.

---

## Critical Files

- [`src/EditorController.ts`](src/EditorController.ts) — the main file changed. Read the constructor's
  status-bar block ([:88-123](src/EditorController.ts#L88)) including the long perf comment at
  [:92](src/EditorController.ts#L92), the `WIDEST_CURSOR_POSITION` constant
  ([:37](src/EditorController.ts#L37)), `findInActive` ([:795](src/EditorController.ts#L795)) — the
  one-line command precedent `goToLineInActive` follows — `formatActive`
  ([:786](src/EditorController.ts#L786)) — the async-command precedent — `getActiveFile`
  ([:852](src/EditorController.ts#L852)), and `syncCursorPosition`
  ([:1170](src/EditorController.ts#L1170)).
- [`src/explorer/fileTreePrompts.ts`](src/explorer/fileTreePrompts.ts#L20) — `promptName`, the
  single-input-prompt precedent `promptGoToLine` copies: `TextField` + `Fit` `Container` +
  `FieldDecorator` + a confirm `onClick` returning `false` to stay open.
- [`src/editor/FileEditor.ts`](src/editor/FileEditor.ts#L263) — `revealMatch`, the jump seam, and its
  Markdown-preview drop-out.
- [`src/editor/editorSearch.ts`](src/editor/editorSearch.ts#L80) — `revealRange`, which adds one to
  `MatchLocation.column` and hard-codes `scrollAlign: 'center'`. This is where the `column: 0`
  convention comes from.
- [`src/data/projectSearch.ts`](src/data/projectSearch.ts#L30) — `MatchLocation`'s three fields.
- [`src/editor/cursorLabel.ts`](src/editor/cursorLabel.ts) and
  [`tests/cursorLabel.test.ts`](tests/cursorLabel.test.ts) — the pure-module and test shape
  `lineNumber.ts` and `selectionLabel.ts` copy.
- [`src/shell/commands.ts`](src/shell/commands.ts#L67) and
  [`tests/commands.test.ts`](tests/commands.test.ts) — the palette command list and its tests.
- [`src/shell/EditorShell.ts`](src/shell/EditorShell.ts#L290) — the `actions` object and
  `buildMenuBar`'s Edit menu ([:649-654](src/shell/EditorShell.ts#L649)).
- [`src/shell/shortcuts.ts`](src/shell/shortcuts.ts) — read the header comment explaining that the
  existing chords were chosen because CodeMirror's keymap binds none of them. `Ctrl/Cmd+G` breaks
  that rule, which is why no chord is added.
- `node_modules/@jimka/typescript-ui/llms.txt` — the library's capability manifest, which `CLAUDE.md`
  requires reading before any UI decision. It is where `Link` ("clickable text link that activates
  in-app"), `Dialog` ("modal dialog (alert/confirm/prompt/custom)") and `Tooltip` ("hover tooltip")
  come from, rather than from a source grep.
- `node_modules/@jimka/typescript-ui/docs/components/Link.md` and
  `.../docs/components/StatusBar.md` — `Link`'s underline escape hatch, its hit-area rule, and the
  status bar's 21px content band and baseline alignment.

---

## Non-Goals

- **No `Ctrl/Cmd+G` or any other global chord**, and no change to `src/shell/shortcuts.ts` or
  `installAccelerators`. Teaching the accelerator listener to respect `event.defaultPrevented` —
  which is what a working `Ctrl/Cmd+G` would need — affects every chord in the app and is its own
  change.
- **No `line:column` input.** VS Code's Go to Line accepts `12:5`; `parseLineNumber` accepts a bare
  line number only. The column is not what the command is for.
- **No multi-cursor reporting.** Neither the caret readout nor the planned selection readout counts
  selection ranges — the library reports the primary range only, the same boundary
  [`status-bar-cursor-position.md`](plans/implemented/status-bar-cursor-position.md) drew.
- **No reach into CodeMirror's state for the selection.** `editorSearch.ts` reaches the live
  `EditorView` for the find panel because CodeMirror's own panel has no other driver; a selection
  *read* is a plain missing getter on `CodeEditor` and belongs upstream.
- **No further status-bar indicators** — no encoding, line-ending, indentation, or zoom widget.
- **No change to `src/editor/editorSearch.ts`.** Its `revealRange` already does what Go to Line
  needs.

---

## Open Questions

**These need a human answer before step 14. Steps 1-12 do not depend on them.**

### `CodeEditor` has no way to read a selection's extent

The status bar cannot report a selected-character or selected-line count today. `CodeEditor`'s public
surface carries `getCursorPosition()` and a `"cursorchange"` event, both of which describe the
**caret** — `{ line, column, offset }`, derived from `state.selection.main.head` alone
([CodeEditor.ts:1477](../typescript-ui/packages/lib/src/typescript/lib/component/editor/CodeEditor.ts#L1477)).
There is no `getSelection()`, no selection length, and no event for a selection whose caret did not
move.

Two facts make that absence a genuine library gap rather than one Loom can paper over:

- The built type declarations for `CodeEditor` list no selection member at all, so there is nothing
  to compose against.
- `"cursorchange"` is deduplicated on the caret's line, column and offset
  ([CodeEditor.ts:1493](../typescript-ui/packages/lib/src/typescript/lib/component/editor/CodeEditor.ts#L1493)),
  so a selection change that leaves the caret where it is emits **no event**. With the caret already
  at the end of the document, `Ctrl/Cmd+A` selects everything and fires nothing; `Shift+Home` from
  column 1 likewise. A readout wired to `"cursorchange"` alone would sit blank while thousands of
  characters were selected.

What Loom needs, for the active editor's primary selection: the selected character count, the number
of lines it spans, and an event that fires whenever either changes. **The decision is the library's
shape, not Loom's** — whether `"cursorchange"`'s payload widens to carry the selection, or
`CodeEditor` gains a separate `getSelection()` plus a `"selectionchange"` event — and whether that
becomes a sibling `typescript-ui` plan now or later. Step 14's wiring is written to suit either.

### Secondary: CodeMirror's unthemed `gotoLine` panel ships in every `CodeEditor`

The library's `CodeEditor` installs CodeMirror's `searchKeymap` wholesale, which binds `Mod-Alt-g` to
CodeMirror's own `gotoLine` command. That command renders a raw CodeMirror DOM panel styled by
CodeMirror's base theme, not by the library's design tokens — so `Ctrl+Alt+G` in Loom today opens a
prompt that matches nothing else in the app. It is also what makes `Mod-g` unavailable for a Loom
chord. Nothing in this plan depends on the answer, but whether the library should drop or theme those
bindings is worth a decision.

---

## Notes

[^link-not-button]: A `Button` with `flat`/`compact` set is the other way the library makes text
    clickable, and it is what VS Code's own clickable status-bar items look like (flat until hover).
    It was rejected on the perf constraint this readout already carries. `TODO.md`'s *Inactive tabs
    stay in the layout tree* entry records why: `Text.setText`'s default auto-measure forces a
    synchronous `getBoundingClientRect` reflow whose cost scales with every open tab's mounted
    editor, and `"cursorchange"` fires continuously during a selection drag — which is what made
    dragging feel sluggish until `EditorController`'s constructor fixed the readout's width and
    called `setAutoMeasure(false)`. `setAutoMeasure` and `setTextAlign` are `Text` API. A `Button`
    keeps its label in an internal `Text` the caller cannot reach, so `Button.setText` per caret move
    would reintroduce exactly the reflow the constant was added to remove, with no documented way to
    switch it off. `Link` is a `Text` subclass, so the mitigation transfers untouched — and its hit
    area is its own box rather than a padded content row.

[^no-chord]: The collision is unconditional, not a corner case: the library's `CodeEditor` puts
    `...searchKeymap` in the base keymap it builds at mount, so `Mod-g` → *find next* is live in
    every Loom editor from the first keystroke (not only after Loom's own `openFindPanel` appends its
    extension). CodeMirror's `runHandlers` calls `preventDefault()` but not `stopPropagation()`, so
    the keydown still reaches the `window` listener `installAccelerators` registers, and that
    listener dispatches on the chord alone without checking whether anything already handled it —
    both actions would run. Making it check `event.defaultPrevented` is the real fix and is the right
    change to make eventually, but it silently alters every other chord's behaviour inside the editor
    (`Ctrl/Cmd+F` included, which CodeMirror also binds), so it does not belong in this plan. The
    TODO item asks for "command palette and/or a keybinding"; the palette, the Edit menu and the
    clickable readout are three entry points without it.

[^not-numberspinner]: `NumberSpinner` is the library's numeric input and would validate by
    construction. It was rejected twice over: spin arrows are meaningless for jumping to an arbitrary
    line (nobody steps from line 1 to line 340), and it would leave the feature with no unit-testable
    surface at all — `parseLineNumber` is the only part of Go to Line that vitest's `node`
    environment can reach, and the `implement` skill works test-first. CodeMirror's own `gotoLine`
    command was the third option, rejected because it renders an unthemed CodeMirror panel rather
    than the library's components, which is what the house rule in `CLAUDE.md` exists to prevent.

[^no-extract]: `promptName` is module-private in `src/explorer/fileTreePrompts.ts`. Sharing it means
    moving it to a third module, and the only sensible home beside Loom's other prompts is
    `src/shell/` — which would make `src/explorer/` import from `src/shell/`. Every cross-directory
    import in the repository today runs the other way (`src/shell/EditorShell.ts` and
    `src/shell/session.ts` import from `src/explorer/`; nothing in `src/explorer/` imports from
    `src/shell/`), so the extraction would invert that for a saving of about thirty lines. Copying
    the shape also matches what `fileTreePrompts.ts` itself establishes by living next to the
    explorer rather than in `src/shell/`: a prompt sits with the feature it serves.

[^separate-widget]: Folding the count into `cursorLabel`'s string — a fourth `·`-joined segment —
    was the alternative, and it loses twice. The readout is a `Link` whose whole box opens *Go to
    Line*, so `142 selected` would become clickable text that jumps the caret, which is not what it
    describes. And the readout's width is pinned once at startup against a worst case; folding the
    selection in would widen that single reservation by the worst case of *both* facts at once, even
    with no selection, where a separate widget reserves its own worst case and can render the empty
    string. Two widgets also keep one `setText` per fact, so a caret move that leaves the selection
    alone repaints only the caret readout.

[^reveal-reuse]: Reusing `revealMatch` rather than adding a `FileEditor.goToLine` gets three
    behaviours for free that a new method would have to re-implement: the Markdown-preview drop-out
    (the user asked for a position in the *source*, so showing the rendered view would not answer the
    request), the `onFirstLayout` deferral for an editor that has not mounted yet, and
    `scrollAlign: 'center'`, which is right for the same reason it is right for a search result — the
    caller has no idea what is currently on screen. `MatchLocation` is structurally identical to the
    library's own `CodeEditorRevealTarget`, so nothing is being bent to fit.

[^library-build-gate]: Both plans this one builds on opened the same way, for the same reason:
    `node_modules/@jimka/typescript-ui` is a symlink into a local `typescript-ui` checkout whose
    `exports` map resolves to `dist/`, so a source-only change over there is invisible to Loom until
    the library is rebuilt. At the time of writing, the symlink in the main tree points at a
    `typescript-ui` worktree that no longer exists, and the `dist/` in that repository's main
    checkout predates `CodeEditor.revealRange` — the method `editorSearch.ts` already calls. Step 1
    catches both conditions with one grep against the artifact Loom really resolves.

---

## Implementation Notes

- **`## Open Questions` was resolved before this run started, so step 14 shipped in the same run
  as steps 1–12 instead of waiting for a separate one.** By the time implementation began,
  `node_modules/@jimka/typescript-ui` already resolved to a `typescript-ui` checkout carrying
  `CodeEditor.getSelection(): CodeEditorSelection` (`{ characterCount, lineCount }`) and a
  `"selectionchange"` event — exactly the shape this plan's Open Questions section anticipated
  ("Step 14's wiring is written to suit either"). Step 13's "Stop" and the wait for a human answer
  were accordingly skipped: the human answer was already in hand. The secondary, non-blocking
  finding in `## Open Questions` — CodeMirror's unthemed `gotoLine` panel occupying `Mod-Alt-g` —
  was left out of scope here too, as that finding itself specifies.
- **The `## Verification` section's `grep -c 'setAutoMeasure(false)' src/EditorController.ts —
  expect 1` was written for a go-to-line-only run.** With step 14 also shipped, `_selectionText`
  gets the identical measure-once treatment `_cursorText` does, so the count is now correctly `2`,
  not `1`.
- **`## Documentation Impact`'s TODO.md replacement text assumed only the go-to-line half would
  ship this run.** Since both halves shipped, the backlog entry was retired outright instead of
  reworded down to the selection-only remainder the plan specifies — matching this repository's own
  "document X and retire its backlog entry" convention for a fully-resolved item (see e.g.
  `9799e5e`, `b8214aa`) rather than leaving a stub that would need a second edit later.
- **The plan's two halves landed as two code commits and two documentation commits**, not one of
  each, since `## Overview` and `## Ordered Implementation Steps` frame Go to Line and selection
  metrics as separately shippable ("Everything above is shippable on its own" at step 12) rather
  than a single functionality — matching the `commit` skill's one-commit-per-functionality rule.
- **`src/editor/lineNumber.ts`'s `countLines` does not match step 2's "exactly as given" listing.**
  The audit round found that the plan's own loop-based implementation (incrementing on `'\n'` alone)
  undercounts a lone-`\r` line ending relative to CodeMirror's actual default splitter
  (`/\r\n?|\n/`, `@codemirror/state`'s `DefaultSplit`) — a bug this repository had already solved
  once, in `src/data/projectSearch.ts`'s `LINE_SPLIT` constant, which the plan's own `lineNumber.ts`
  listing didn't reuse or mirror. The shipped file adds a local `LINE_SPLIT` constant (mirroring,
  not importing, `projectSearch.ts`'s — importing would add an import where step 2's own check
  expects zero) and reimplements `countLines` as `text.split(LINE_SPLIT).length`, plus a test for
  the lone-`\r` case. The module's public API (`countLines(text: string): number`) is unchanged.
- **`src/EditorController.ts`'s selection-readout construction does not match step 14's inline
  `selectionLabel({ characters: 9_999_999, lines: 99_999 })` literal.** The audit round found this
  undocumented relative to the file's own `WIDEST_CURSOR_POSITION` precedent (a named, doc-commented
  constant for the identical purpose, immediately above it). The shipped code instead adds a
  `WIDEST_SELECTION` constant, documented the same way and derived from
  `WIDEST_CURSOR_POSITION.offset`/`.line` rather than repeating their values as new literals.
