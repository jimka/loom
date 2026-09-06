---
depends-on: [status-bar-cursor-position]
---

# Status Bar Document Offset — Implementation Plan

## Overview

[`cursorLabel`](src/editor/cursorLabel.ts#L15) is the pure function that renders the status bar's
caret readout — today `Ln 12, Col 5` — from the active file's `CodeEditorCursorPosition`. It is
called from one place, [`syncCursorPosition`](src/EditorController.ts#L1054), which reads the
position live from `file.getEditor().getCursorPosition()` on every activation and every
`"cursorchange"` event.

This plan widens the readout to `Ln 12, Col 5 · Pos 245`, adding the caret's raw position in the
whole document. The library's `CodeEditorCursorPosition` interface is gaining a third field,
`offset` — a 0-based index into the document, in
[`../typescript-ui/plans/code-editor-document-offset.md`](../typescript-ui/plans/code-editor-document-offset.md),
a sibling plan not yet implemented. Once it ships, `getCursorPosition()` and `"cursorchange"`
already carry `offset` through to `cursorLabel`'s caller with no change to
[`EditorController.ts`](src/EditorController.ts) — the only file this plan touches is
`src/editor/cursorLabel.ts`, plus its test and two doc files.

As with the plan this one extends, nothing here typechecks until the sibling library change lands
and `npm run build:lib` regenerates the `dist/` Loom's `@jimka/typescript-ui` symlink resolves
through. Step 1 is the check for it.

---

## Architecture Decisions

### `offset` renders as `offset + 1`, to match the already-1-based `Ln`/`Col` next to it

The library's own `offset` field is 0-based — a raw index into the document, not a human-facing
counter — and the library's own demo panel deliberately shows it unmodified. Loom's status bar
renders it as a 1-based ordinal instead, the same way `Ln`/`Col` already are.[^offset-plus-one]

| Raw `offset` (library, 0-based) | Rendered `Pos` (Loom status bar) |
|---|---|
| `0` | `1` |
| `244` | `245` |
| `9999` | `10000` |

### The change is confined to `cursorLabel.ts`; `EditorController.ts` is untouched

`syncCursorPosition` ([src/EditorController.ts:1054](src/EditorController.ts#L1054)) already passes
whatever `file.getEditor().getCursorPosition()` returns straight to `cursorLabel`, and
`cursorLabel`'s parameter type is `CodeEditorCursorPosition | null` — the same interface the
library is widening, imported by name rather than destructured field-by-field. No call site changes
shape.[^no-controller-change]

### The separator is `' · '`

No status-bar or message text in Loom's own source uses `' · '` today,[^separator-search] so this
is a new separator for Loom, not a re-application of one. It is the exact separator the sibling
library's own demo panel plan uses for the identical composite readout — `Ln`/`Col` plus a `Pos`
segment — and Loom already renders `Ln`/`Col` in the library's own stated format
([status-bar-cursor-position.md](plans/implemented/status-bar-cursor-position.md)'s *The format is
`Ln {line}, Col {column}`* decision), so extending that borrowed convention with the library's own
extension of it is more consistent than inventing a Loom-specific one.

| Active file's caret | `cursorLabel` returns |
|---|---|
| `{ line: 1, column: 1, offset: 0 }` | `'Ln 1, Col 1 · Pos 1'` |
| `{ line: 12, column: 5, offset: 244 }` | `'Ln 12, Col 5 · Pos 245'` |
| none — no file is open (`null`) | `''` |

---

## Public API

`cursorLabel`'s signature is unchanged; only the string it returns for a non-null position widens.

```typescript
// src/editor/cursorLabel.ts — signature unchanged
export function cursorLabel(position: CodeEditorCursorPosition | null): string
```

`CodeEditorCursorPosition` gains `offset: number` (0-based) from the sibling library plan; Loom
imports the same type name and reads the new field, with no import statement change.

---

## Internal Structure

### `src/editor/cursorLabel.ts` — the whole file, after this change

```typescript
// The status bar's caret-readout rule, split out of EditorController.ts so it
// stays unit testable: vitest.config.ts runs in the `node` environment with
// no DOM, and a module that imports @jimka/typescript-ui's components
// touches `document` at load time.
import type { CodeEditorCursorPosition } from '@jimka/typescript-ui/component/editor'

/**
 * The status bar's caret readout: the caret's 1-based line and column, its
 * document offset rendered as a 1-based position, or the empty string when
 * no file is open — the same blank the language text beside it falls back
 * to.
 *
 * @param position - The active file's caret position, or `null` when no file is open.
 * @returns The text to show in the status bar's cursor readout.
 */
export function cursorLabel(position: CodeEditorCursorPosition | null): string {
    return position === null ? '' : `Ln ${position.line}, Col ${position.column} · Pos ${position.offset + 1}`
}
```

Only the return line and the doc comment change. The header comment, the `import type`, and the
`null` branch are untouched.

### `tests/cursorLabel.test.ts` — the whole file, after this change

```typescript
import { describe, it, expect } from 'vitest'
import { cursorLabel } from '../src/editor/cursorLabel'

describe('cursorLabel', () => {
    it('formats the document start as Ln 1, Col 1 · Pos 1', () => {
        expect(cursorLabel({ line: 1, column: 1, offset: 0 })).toBe('Ln 1, Col 1 · Pos 1')
    })

    it('formats a mid-document position as Ln 12, Col 5 · Pos 245', () => {
        expect(cursorLabel({ line: 12, column: 5, offset: 244 })).toBe('Ln 12, Col 5 · Pos 245')
    })

    it('formats a far position with no padding as Ln 340, Col 128 · Pos 10000', () => {
        expect(cursorLabel({ line: 340, column: 128, offset: 9999 })).toBe('Ln 340, Col 128 · Pos 10000')
    })

    it('shows nothing when no file is open', () => {
        expect(cursorLabel(null)).toBe('')
    })
})
```

Only the first three tests' names, arguments, and expected strings change — each now names its own
`Pos` value instead of stopping at `Col`. The fourth (`null`) test is byte-for-byte unchanged: the
empty-string case has no `Pos` to add.

---

## Ordered Implementation Steps

1. **Prerequisite — the library API must be built.** Run
   `grep -c 'offset: number;' node_modules/@jimka/typescript-ui/dist/lib/types/component/editor/CodeEditor.d.ts`.
   Expect at least one match, scoped to this one file — a repo-wide grep for `offset: number;` also
   matches an unrelated field in `dist/lib/types/layout/BoxLayout.d.ts`, so do not broaden the
   search. On zero matches in the `CodeEditor.d.ts` file, stop: the sibling library change
   ([`../typescript-ui/plans/code-editor-document-offset.md`](../typescript-ui/plans/code-editor-document-offset.md))
   has not been implemented and built yet. Once it has, `npm run build:lib` at that repository's
   root regenerates the `dist/` Loom's symlink resolves through.

2. **`src/editor/cursorLabel.ts`** — replace the function body and its doc comment with the
   `## Internal Structure` version. No import change.
   *Check:* `grep -c '· Pos' src/editor/cursorLabel.ts` — expect `1`.

3. **`tests/cursorLabel.test.ts`** — replace the file with the `## Internal Structure` version
   exactly. Same one-`expect`-per-`it` shape as
   [`tests/treeSectionLabel.test.ts`](tests/treeSectionLabel.test.ts) already follows.
   *Check:* `npm test` — the updated block passes, every other test untouched.

4. **`README.md`** — apply the Status bar bullet edit in `## Documentation Impact`.

5. **`TODO.md`** — apply the Go to Line bullet edit in `## Documentation Impact`.

6. **Run the full check set:** `npm run typecheck`, `npm test`, `npm run build` — all clean.
   *Check:* `grep -c 'offset' src/EditorController.ts` — expect `0`, confirming this file needed no
   change.

7. **`npm run tauri:dev`** — work through every bullet under `## Expected Behaviour` ›
   *Manual verification*.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src/editor/cursorLabel.ts` |
| Modify | `tests/cursorLabel.test.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

The test values below are illustrative, not derived from a real document — `{ line: 12, column: 5,
offset: 244 }` is internally plausible but not the actual offset of line 12, column 5 in any real
file. `cursorLabel` performs no cross-field validation, so any combination exercises the same
arithmetic.

### Unit-testable (`tests/cursorLabel.test.ts`, node environment)

| `cursorLabel` argument | Result |
|---|---|
| `{ line: 1, column: 1, offset: 0 }` | `'Ln 1, Col 1 · Pos 1'` |
| `{ line: 12, column: 5, offset: 244 }` | `'Ln 12, Col 5 · Pos 245'` |
| `{ line: 340, column: 128, offset: 9999 }` | `'Ln 340, Col 128 · Pos 10000'` |
| `null` | `''` |

### Manual verification (`npm run tauri:dev`)

The wiring is DOM- and event-driven and already covered by the precedent plan's own manual pass;
this list covers only what is new — the `Pos` segment:

- **Opening a file** at the document start shows `Ln 1, Col 1 · Pos 1` — not `Pos 0`.
- **Typing a character at the very start of a document** advances `Pos` from `1` to `2`, in step
  with `Col` advancing from `1` to `2`.
- **A line starting with a literal tab**: placing the caret just after the tab reports the same
  numeric relationship between `Col` and `Pos` as elsewhere — the library counts a tab as one
  character for both, so `Pos` does not expand to a tab stop.
- **Format Document**, when it rewrites text earlier in the document without moving the caret's
  visible line or column: `Pos` still matches where the caret visibly sits, even on the rare case
  where `Ln`/`Col` do not change. This follows from the library's own cursor-tracking, not from any
  Loom-side logic — nothing to build here, only to confirm it displays correctly.
- **Switching tabs and session restore**: `Pos` jumps to the newly active file's own value with no
  keypress, the same as `Ln`/`Col` already do.
- **Widening `Pos` does not shift the language text**: moving from `Pos 99` to `Pos 100` grows the
  readout leftwards; the language name stays anchored at the right edge.

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — clean, including the updated `tests/cursorLabel.test.ts`.
- `grep -c '· Pos' src/editor/cursorLabel.ts` — expect `1`.
- `grep -c 'offset' src/EditorController.ts` — expect `0` (confirms the untouched-controller
  decision held).
- `grep -n "import type { CodeEditorCursorPosition }" src/editor/cursorLabel.ts` — still present,
  unchanged.
- `npm run build` — passes.
- `npm run tauri:dev` — every bullet under `## Expected Behaviour` › *Manual verification*.

---

## Documentation Impact

**`README.md`** — replace the Status bar bullet
([README.md:63-65](README.md#L63)):

> - **Status bar** — the caret's position in the active file, including its raw document offset
>   (`Ln 12, Col 5 · Pos 245`), sits at the right of the bar, left of the file's language; save and
>   reload messages appear at the left.

**`TODO.md`** — the *Go to Line, and selection metrics in the status bar* bullet
([TODO.md:84-89](TODO.md#L84)) says the bar reports only "the caret's line and column"; that is no
longer accurate once this plan ships. Replace its opening clause:

> - **Go to Line, and selection metrics in the status bar.** The bar reports the caret's line,
>   column, and document position but nothing acts on them: there is no *Go to Line* command, the
>   readout is not clickable, and it reports no selected-character or selected-line count. The
>   library exposes the caret read-only (no `setCursorPosition`), so a jump-to-line would need a new
>   library API first.

No API documentation page exists in this repository — `README.md` and `TODO.md` are the only prose
surfaces, same as the precedent plan found.

---

## Potential Challenges

- **Off-by-one is the whole risk surface.** The library's `offset` is 0-based; forgetting the `+ 1`
  renders `Pos 244` where the worked example expects `Pos 245`. The unit test table in
  `## Expected Behaviour` pins the exact arithmetic.
- **`offset: number;` is not unique across the library's bundled type declarations** —
  `dist/lib/types/layout/BoxLayout.d.ts` already has an unrelated field of that name. Step 1's grep
  is scoped to the single `CodeEditor.d.ts` file for this reason; do not widen it to the whole
  `dist/` tree.
- **The library must be built, not just written**, same as the precedent plan: a source-only change
  in `typescript-ui` is invisible to Loom until `npm run build:lib` regenerates `dist/`.

---

## Critical Files

- [`src/editor/cursorLabel.ts`](src/editor/cursorLabel.ts) — the file being changed.
- [`tests/cursorLabel.test.ts`](tests/cursorLabel.test.ts) — the test file being changed.
- [`src/EditorController.ts`](src/EditorController.ts#L1054) — `syncCursorPosition`, confirming the
  call site needs no change: it already forwards the full `CodeEditorCursorPosition` object.
- [`plans/implemented/status-bar-cursor-position.md`](plans/implemented/status-bar-cursor-position.md) —
  the plan this one extends: the precedent for `cursorLabel`'s shape, its test file's style, and the
  `Ln {line}, Col {column}` format this plan's `Pos` segment is appended to.
- [`../typescript-ui/plans/code-editor-document-offset.md`](../typescript-ui/plans/code-editor-document-offset.md) —
  the sibling library contract: read `## Public API` for the exact `offset` field and its 0-based
  semantics, and `## Architecture Decisions` › *`offset` is 0-based* for why the library itself does
  not add 1, and its footnote's explicit statement that a downstream status bar is the one meant to
  do so.
- `README.md` and `TODO.md` — the doc edits in `## Documentation Impact`.

---

## Non-Goals

- **No click-to-jump on the `Pos` segment**, and no new *Go to Position* command. Reading the caret
  is this change; moving it needs a library API that does not exist. Covered by the existing TODO
  entry, updated in `## Documentation Impact` rather than duplicated.
- **No change to how `offset` counts characters.** It counts UTF-16 code units, same as `column` —
  a tab is one, an emoji outside the Basic Multilingual Plane is two. Loom passes the library's
  value straight through, unadjusted except for the display `+ 1`.
- **No library change.** `offset` is implemented in `@jimka/typescript-ui` under its own plan; this
  plan consumes it unchanged.

---

## Notes

[^offset-plus-one]: The library's own demo panel
    ([`CodeEditorPanel.ts`](../typescript-ui/packages/lib/src/typescript/CodeEditorPanel.ts#L111),
    per the sibling plan's `## Internal Structure`) shows `offset` raw, with no `+ 1` — reasoned
    there as every other segment on that line already passing its getter's value straight through
    unmodified, and the demo's job being to show what the API actually returns. That reasoning does
    not carry over to a real status bar: `Ln`/`Col` sit immediately to its left and are already
    1-based, so an unmodified `Pos 0` at the document start reads as an off-by-one bug next to
    `Ln 1, Col 1`, not as a deliberate raw value. The sibling plan's own `offset` design decision
    anticipates exactly this, saying "a downstream status bar wanting 'Pos 245' rather than
    'Pos 244' adds one at render time" — this plan is that downstream status bar, and the worked
    example above (`Ln 12, Col 5 · Pos 245`) uses the `+ 1` form throughout.

[^no-controller-change]: Confirmed by reading the current call site: `syncCursorPosition`
    ([src/EditorController.ts:1054-1058](src/EditorController.ts#L1054)) calls
    `file.getEditor().getCursorPosition()` and passes the result to `cursorLabel` without
    destructuring it first, and `cursorLabel`'s own parameter type names the interface
    (`CodeEditorCursorPosition | null`) rather than an inline `{ line, column }` shape. A structural
    type gaining a field is invisible at every call site that does not destructure — only the one
    place that reads individual fields, inside `cursorLabel` itself, needs to change.

[^separator-search]: `grep -rn '·' src/ README.md TODO.md` inside the worktree returns no matches
    before this change. The only place `' · '` appears in either repository today is the sibling
    library's demo panel line (`Ln ${line}, Col ${column} · Dirty: ...`, soon
    `Ln ${line}, Col ${column} · Pos ${offset} · Dirty: ...`), which is precedent to follow per
    [`pattern-conformance.md`](../../../.claude/skills/_shared/pattern-conformance.md), not a
    Loom-side convention to preserve unchanged.
