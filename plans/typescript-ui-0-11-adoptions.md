---
depends-on: [typescript-ui-0-11-bump]
touches-shared: [src/EditorController.ts, src/data/projectSearch.ts, tests/projectSearch.test.ts, src/shell/shortcuts.ts, tests/shortcuts.test.ts, README.md]
---

# typescript-ui 0.11 Adoptions — Implementation Plan

## Overview

The 0.11 bump moved Loom onto `@jimka/typescript-ui` ^0.11.0 and changed no
behaviour on purpose. This plan adopts three 0.11 APIs, as three parts that
each land as their own code commit:

1. **`CodeEditor.replaceRange(from, to, insert, selection?)`** for
   project-search replace in an open file. Today
   [`EditorController.replaceMatch`](src/EditorController.ts#L940) and
   [`performReplaceInFile`](src/EditorController.ts#L831) rebuild the whole
   text and call `getEditor().setValue(text)`. That moves the caret to the
   start of the document, scrolls away, and can merge with recent typing in
   the undo history. After this part, a replace edits only the changed range,
   in one undo step of its own, and leaves the caret and scroll position where
   they were.
2. **`LayerManager.hasModalLayer()`** as a guard in
   [`installAccelerators`](src/shell/shortcuts.ts#L139). Today every window
   accelerator (Ctrl/Cmd+P, Ctrl/Cmd+W, Ctrl/Cmd+S, …) still runs while a
   modal `Dialog` is open. After this part, every chord does nothing while a
   modal is open.
3. **`DockCloseController`** in place of `TabCloseController` for the dock's
   `"beforeclose"` handler, at
   [src/EditorController.ts:5](src/EditorController.ts#L5) and
   [:1393](src/EditorController.ts#L1393). This is a type-only change plus a
   doc comment.

Two pure helpers are added to
[src/data/projectSearch.ts](src/data/projectSearch.ts) and one to
[src/shell/shortcuts.ts](src/shell/shortcuts.ts), each with vitest coverage.
README's project-search bullet gets one wording change.

---

## Architecture Decisions

### The approach follows the earlier library adoptions

Each part replaces Loom-side code with the library API built for the job, as
[plans/implemented/file-editor-dirty-state-adoption.md](plans/implemented/file-editor-dirty-state-adoption.md)
did for the dirty flag. The modal guard copies SQLAdmin's
[`installAccelerators`](../sqladmin/frontend/src/shell/SqlAdminShell.ts#L171),
which already checks `LayerManager.hasModalLayer()` on every keydown. The
dependency install follows
[plans/implemented/typescript-ui-0-11-bump.md](plans/implemented/typescript-ui-0-11-bump.md):
the worktree gets its own registry install and never links the main tree's
`node_modules`.

### Part 1 — a single replace edits only the match's range

`replaceMatch`'s open-file branch computes a `TextEdit` (a `{ from, to,
insert }` triple of document offsets) with a new `replacementEditAt`, and
applies it with `editor.replaceRange(edit.from, edit.to, edit.insert)`. The
`selection` argument is left out, so the editor maps the existing selection
through the change.[^why-replacerange]

What that mapping does, checked against CodeMirror 6 with the text
`foo\nbar foo baz\nfoo` and the match `foo` at offsets 8–11 replaced with `XY`:

| Selection before | Selection after the replace | Selection after Ctrl/Cmd+Z |
|---|---|---|
| the match itself, 8–11 (a search preview selected it) | the replacement, 8–10 | 8–11 |
| caret at 1, before the match | caret at 1 | caret at 1 |
| caret at 14, after the match on the same line | caret at 13 | caret at 14 |

Ctrl/Cmd+Z undoes only the replace. Typing done just before it stays.

### Offsets are computed from the buffer's own text, by line and column

`replacementEditAt` takes the text it will edit. For an open file that is
always `editor.getValue()`, never the disk text. It finds the match's line by
splitting with the module's existing `splitKeepingLineEndings`, adds the
lengths of every earlier line and line ending, then adds the column.[^offset-source]

| Text the edit is computed against | `at` (line, column) | Query → replacement | Result |
|---|---|---|---|
| `foo\nbar foo\n` | 2, 4 | `foo` → `X` | `{ from: 8, to: 11, insert: 'X' }` |
| `foo\r\nbar foo\r\n` | 2, 4 | `foo` → `X` | `{ from: 9, to: 12, insert: 'X' }` |
| `foo\rbar foo` | 2, 4 | `foo` → `X` | `{ from: 8, to: 11, insert: 'X' }` |
| `foo\nbar foooo` | 2, 4 | regexp `f(o+)` → `<$1>` | `{ from: 8, to: 13, insert: '<oooo>' }` |
| `x fooo` | 1, 2 (stale length 2) | regexp `fo+` → `X` | `{ from: 2, to: 6, insert: 'X' }` |
| `foo\nbar baz\n` | 2, 4 | `foo` → `X` | `null` (nothing matches there any more) |
| `foo\nbar foo\n` | 5, 0 | `foo` → `X` | `null` (no line 5) |

`to` uses the length of the match found now, not `at.length`, as
`replaceOneInText` does today.

### `replaceOneInText` is rebuilt on `replacementEditAt`

The private `replaceOneOnLine` becomes `matchAtColumn`, which returns the
match's current length and its resolved replacement instead of a rewritten
line. `replacementEditAt` and `replaceOneInText` both use it, so the check
that a match is still there exists once.[^one-verifier] `replaceOneInText`
keeps its signature and results. Its five existing tests must pass unchanged.

### Part 1 — Replace All in File is one `replaceRange` over the smallest changed span

`performReplaceInFile`'s open-file branch still builds the new text with
`replaceAllInText`. It then computes the smallest single edit between the old
and new text with a new `editBetween(before, after)`: the common prefix and
common suffix are left alone, and the middle is replaced. One `replaceRange`
applies it.[^replace-all-shape]

| `before` | `after` | `editBetween` |
|---|---|---|
| `a foo b foo c` | `a X b X c` | `{ from: 2, to: 11, insert: 'X b X' }` |
| `abc` | `abc` | `null` |
| `aaa` | `aa` | `{ from: 2, to: 3, insert: '' }` (prefix and suffix never overlap) |
| `foo` | `food` | `{ from: 3, to: 3, insert: 'd' }` |

The whole pass is one undo step. A caret before the first changed character or
after the last one stays where it was. A caret between two replaced matches
moves to the start of the span, because that text is replaced as one block.

`editBetween` returning `null` (every match was replaced with identical text)
makes no edit. The method still returns the match count, as today.

### Part 1 — an editor that has never been shown behaves as it does today

A tab that was restored from the session and never shown has an unmounted
`CodeEditor`: `CodeEditor` builds its view on its first sized layout, and
`Tab` never lays out an inactive page. On an unmounted editor,
`replaceRange` updates the cached text and fires no `"change"`, exactly as
`setValue` does. When the tab is first shown, `CodeEditor.mount()` takes the
replaced text as the clean text, so the tab shows no dirty dot and Ctrl/Cmd+Z
cannot undo it. This plan calls that the *pre-mount gap*.[^premount-gap]

The pre-mount gap exists today with `setValue` and is unchanged by this plan. It comes
from the library (a pre-mount edit is treated as clean at mount), so Loom does
not work around it. It is reported to the user as a library question, per
`CLAUDE.md`.

### Part 2 — every accelerator does nothing while a modal is open

A new pure `dispatchAccelerator(event, actions, modalOpen)` finds the chord's
callback and runs it only when `modalOpen` is `false`. `installAccelerators`
passes `LayerManager.hasModalLayer()` as `modalOpen`. All eleven chords are
suppressed; none is exempt.[^all-chords]

| Key | Modal open? | Callback run | `preventDefault()` |
|---|---|---|---|
| Ctrl/Cmd+P | no | `onOpenCommandPalette` | yes |
| Ctrl/Cmd+P | yes (Go to Line, About, …) | none | yes |
| Ctrl/Cmd+W | yes (unsaved-changes prompt) | none | yes |
| `p` | either | none | no |

A suppressed chord is still swallowed with `preventDefault()`. This is the one
place Loom differs from SQLAdmin, which lets the key through.[^swallow]

### Part 2 — the command palette is not a modal layer

`CommandPalette` extends `PopupPanel`, whose layer mode is `"click-outside"`,
not `"modal"`. `hasModalLayer()` is therefore `false` while the palette is
open, and the accelerators keep working over it as they do today.[^palette]

### Part 3 — the type swap changes no behaviour; the doc comment records the float case

`handleBeforePanelClose` is typed with `DockCloseController`, imported from
`@jimka/typescript-ui/overlay`. `TabCloseController` leaves the
`@jimka/typescript-ui/layout` import. The body is unchanged: all three
controller types have the same `preventDefault()` shape.[^controller-types]

The handler's doc comment gains one fact the old type hid. A floating
window's chrome ✕ fires `"beforeclose"` once for every panel in the window,
all sharing one controller. So vetoing for any dirty panel keeps the whole
window open, its clean panels included, and each dirty panel raises its own
prompt. That behaviour is not changed here (see Non-Goals).

---

## Public API

Loom-internal exports only; nothing in the library changes.

`src/data/projectSearch.ts`:

```typescript
/** One replacement inside a document: the `[from, to)` range of the text it was computed against, and the text that takes its place. */
export interface TextEdit {
    /** 0-based offset where the replaced range starts. */
    from: number
    /** 0-based offset where the replaced range ends (exclusive). */
    to: number
    /** The text that replaces the range. */
    insert: string
}

export function replacementEditAt(
    text: string, at: MatchLocation, compiled: CompiledQuery, replacement: string,
): TextEdit | null

export function editBetween(before: string, after: string): TextEdit | null
```

`src/shell/shortcuts.ts`:

```typescript
export function dispatchAccelerator(event: KeyboardEvent, actions: AcceleratorActions, modalOpen: boolean): boolean
```

`replaceOneInText`, `replaceAllInText` and `installAccelerators` keep their
signatures.

---

## Implementation

### `src/data/projectSearch.ts` — `TextEdit`

Insert after the `SearchMatch` interface (it ends at line 50), with one blank
line before and after: the `TextEdit` block from **Public API**, doc comments
included.

### `src/data/projectSearch.ts` — replaces `replaceOneOnLine` and `replaceOneInText` (lines 428-499)

```typescript
/** The occurrence {@link matchAtColumn} found: its length now, and the text that replaces it. */
interface ColumnMatch {
    length: number
    insert: string
}

/**
 * The occurrence of `compiled` that starts at `column` on `line`, verifying
 * it is still there.
 *
 * @param line - The line to verify on.
 * @param column - The 0-based column the match is expected at.
 * @param compiled - The query to scan for, as a substring or a regular expression.
 * @param replacement - The replacement text (a substring query) or template (a regexp query).
 * @returns The occurrence's current length and its resolved replacement, or
 *   `null` when nothing matches at `column` any more.
 */
function matchAtColumn(line: string, column: number, compiled: CompiledQuery, replacement: string): ColumnMatch | null {
    if (compiled.kind === 'substring') {
        const haystack = compiled.caseSensitive ? line : line.toLowerCase()

        if (!haystack.startsWith(compiled.needle, column)) {
            return null
        }

        return { length: compiled.needle.length, insert: replacement }
    }

    compiled.re.lastIndex = 0

    let match = compiled.re.exec(line)

    while (match !== null) {
        if (match[0].length > 0 && match.index === column) {
            return { length: match[0].length, insert: resolveReplacement(replacement, match) }
        }

        if (match[0].length === 0) {
            compiled.re.lastIndex += 1
        }

        match = compiled.re.exec(line)
    }

    return null
}

/**
 * The edit that replaces the single occurrence `at` names in `text`,
 * verifying it is still there first. `at` normally comes from a `SearchMatch`
 * an earlier `findMatches` run reported against a *different* copy of this
 * file's text. Its line and column address the same character in any copy
 * whose lines are unchanged, whatever line endings each copy uses, so the
 * returned offsets are always offsets into `text` itself.
 *
 * @param text - The text the edit will be applied to — for an open file, the editor's own `getValue()`.
 * @param at - Where the occurrence was last found: a 1-based line and a 0-based column within it.
 * @param compiled - The query to scan for, as a substring or a regular expression.
 * @param replacement - The replacement text (a substring query) or template (a regexp query).
 * @returns The edit, or `null` when `at.line` no longer exists, or nothing
 *   matches at `at.column` on that line any more.
 */
export function replacementEditAt(
    text: string, at: MatchLocation, compiled: CompiledQuery, replacement: string,
): TextEdit | null {
    const parts = splitKeepingLineEndings(text)
    const partIndex = (at.line - 1) * 2

    if (partIndex >= parts.length) {
        return null
    }

    const found = matchAtColumn(parts[partIndex], at.column, compiled, replacement)

    if (found === null) {
        return null
    }

    const lineStart = parts.slice(0, partIndex).reduce((sum, part) => sum + part.length, 0)
    const from = lineStart + at.column

    return { from, to: from + found.length, insert: found.insert }
}

/**
 * Replaces the single occurrence `at` names in `text`, verifying it is still
 * there first — {@link replacementEditAt}'s edit, applied.
 *
 * @param text - The file's current text.
 * @param at - Where the occurrence was last found: a 1-based line and a 0-based column within it.
 * @param compiled - The query to scan for, as a substring or a regular expression.
 * @param replacement - The replacement text (a substring query) or template (a regexp query).
 * @returns The new text, or `null` when `at.line` no longer exists, or
 *   nothing matches at `at.column` on that line any more.
 */
export function replaceOneInText(
    text: string, at: MatchLocation, compiled: CompiledQuery, replacement: string,
): string | null {
    const edit = replacementEditAt(text, at, compiled, replacement)

    if (edit === null) {
        return null
    }

    return text.slice(0, edit.from) + edit.insert + text.slice(edit.to)
}
```

### `src/data/projectSearch.ts` — `editBetween`

Insert directly after `replaceAllInText` (which ends at line 426), with one
blank line before and after:

```typescript
/**
 * The smallest single edit that turns `before` into `after`: everything
 * between their common prefix and their common suffix. The suffix is never
 * allowed to overlap the prefix, so a text that only shrank or only grew
 * still yields a valid range. Compares UTF-16 code units, the same units
 * `CodeEditor` offsets count.
 *
 * @param before - The text the edit applies to.
 * @param after - The text the edit must produce.
 * @returns The edit, or `null` when the two texts are equal.
 */
export function editBetween(before: string, after: string): TextEdit | null {
    if (before === after) {
        return null
    }

    const limit = Math.min(before.length, after.length)
    let prefix = 0

    while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) {
        prefix += 1
    }

    let suffix = 0

    while (
        suffix < limit - prefix
        && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
    ) {
        suffix += 1
    }

    return { from: prefix, to: before.length - suffix, insert: after.slice(prefix, after.length - suffix) }
}
```

### `src/EditorController.ts` — `performReplaceInFile` open-file branch (replaces lines 832-842)

```typescript
        const open = this.findByPath(path)

        if (open) {
            const editor = open.getEditor()
            const current = editor.getValue()
            const { text, count } = replaceAllInText(current, compiled, replacement)
            const edit = editBetween(current, text)

            if (edit !== null) {
                editor.replaceRange(edit.from, edit.to, edit.insert)
            }

            return count
        }
```

In its doc comment (lines 817-830), insert after the first sentence (which ends
"…writes the result back the same way it was read."):

```
     * An open file takes the change as one `CodeEditor.replaceRange` over the
     * smallest span covering every replaced match, so the whole pass is one
     * undo step there and a caret outside that span stays where it was.
```

### `src/EditorController.ts` — `replaceMatch` open-file branch (replaces lines 943-953)

```typescript
        if (open) {
            const editor = open.getEditor()
            const edit = replacementEditAt(editor.getValue(), match, compiled, replacement)

            if (edit === null) {
                return false
            }

            editor.replaceRange(edit.from, edit.to, edit.insert)

            return true
        }
```

In its doc comment (lines 927-939), insert after the first sentence (which ends
"…verifying it is still there first."):

```
     * An open file takes it as one `CodeEditor.replaceRange` over the match's
     * own range: an undo step of its own that leaves the caret and scroll
     * position where they were, and turns a selection covering the match into
     * one covering the replacement.
```

### `src/shell/shortcuts.ts` — new import, two functions, new listener

Add as the file's first line after the header comment (a blank line between):

```typescript
import { LayerManager } from '@jimka/typescript-ui/core'
```

Append to the header comment's last paragraph: `Every chord does nothing while a
modal dialog is open (see dispatchAccelerator), as SqlAdminShell.ts's
installAccelerators does.`

Insert after the `AcceleratorActions` interface (it ends at line 129):

```typescript
/**
 * The callback `event`'s chord dispatches to. Checked in the order listed,
 * the same order the listener used before this table existed.
 *
 * @param event - The keydown event.
 * @param actions - The callbacks each chord dispatches to.
 * @returns The matching callback, or `null` when `event` is not one of the app's chords.
 */
function acceleratorFor(event: KeyboardEvent, actions: AcceleratorActions): (() => void) | null {
    const bindings: ReadonlyArray<readonly [(event: KeyboardEvent) => boolean, () => void]> = [
        [isNewFileChord, actions.onNewFile],
        [isOpenFolderChord, actions.onOpenFolder],
        [isSaveAsChord, actions.onSaveAs],
        [isSaveChord, actions.onSave],
        [isCloseFileChord, actions.onCloseFile],
        [isFormatChord, actions.onFormat],
        [isFindInFilesChord, actions.onFindInFiles],
        [isFindChord, actions.onFind],
        [isToggleExplorerChord, actions.onToggleExplorer],
        [isCommandPaletteChord, actions.onOpenCommandPalette],
        [isExitChord, actions.onExit],
    ]
    const binding = bindings.find(([matches]) => matches(event))

    return binding ? binding[1] : null
}

/**
 * Runs the callback `event`'s chord dispatches to, unless a modal layer is
 * open. Behind a modal the app is inert, so whatever a chord opened or
 * focused there would be out of reach, and Ctrl/Cmd+W or Ctrl/Cmd+Q would
 * stack a second unsaved-changes prompt over the first.
 *
 * @param event - The keydown event.
 * @param actions - The callbacks each chord dispatches to.
 * @param modalOpen - Whether a modal layer is open, as `LayerManager.hasModalLayer()` reports it.
 * @returns Whether `event` is one of the app's chords, whether or not it ran.
 */
export function dispatchAccelerator(event: KeyboardEvent, actions: AcceleratorActions, modalOpen: boolean): boolean {
    const action = acceleratorFor(event, actions)

    if (action === null) {
        return false
    }

    if (!modalOpen) {
        action()
    }

    return true
}
```

`installAccelerators` (lines 131-173) becomes:

```typescript
/**
 * Installs the app's global accelerators as a single `window` keydown
 * listener. `preventDefault()` is called for every chord of the app's,
 * including one a modal suppressed, so a webview's own binding for the same
 * key (print on Ctrl/Cmd+P, find on Ctrl/Cmd+F) never opens over the modal;
 * every other key reaching `window` (Tab traversal, browser shortcuts the
 * app doesn't bind) keeps its default behaviour.
 *
 * @param actions - The callbacks each chord dispatches to.
 */
export function installAccelerators(actions: AcceleratorActions): void {
    window.addEventListener('keydown', (event: KeyboardEvent) => {
        if (dispatchAccelerator(event, actions, LayerManager.hasModalLayer())) {
            event.preventDefault()
        }
    })
}
```

### `src/EditorController.ts` — `handleBeforePanelClose` (replaces the doc comment and the signature line, lines 1387-1393 before Part 1)

```typescript
    /**
     * `"beforeclose"`: a clean file closes immediately. A dirty file vetoes
     * the close and starts the unsaved-changes prompt instead. Fires for
     * every user-initiated destroy — a tab ✕ and a float window's chrome
     * ✕ — while `removePanel` stays the unguarded programmatic path. A
     * float's chrome ✕ fires it once for every panel the window holds, all
     * sharing one controller, so vetoing for any dirty panel keeps the whole
     * window open, its clean panels included, and each dirty panel raises its
     * own prompt.
     */
    private handleBeforePanelClose = (event: DockPanelEvent, controller: DockCloseController): void => {
```

### Tests

`tests/projectSearch.test.ts` — change line 2's import to add
`replacementEditAt, editBetween`, and line 3's to add `TextEdit`. Add to the
existing `describe('replaceOneInText')` block:

```typescript
    it('keeps CRLF line endings around the replaced occurrence', () => {
        const compiled = compileQuery(query('foo'))!
        const result = replaceOneInText('foo\r\nbar foo\r\n', at(2, 4, 3), compiled, 'X')

        expect(result).toBe('foo\r\nbar X\r\n')
    })
```

Then append two blocks at the end of the file. Each `it` builds its query with
`compileQuery(query(...))!`, as the neighbouring blocks do:

```typescript
describe('replacementEditAt', () => {
    function at(line: number, column: number, length: number): MatchLocation {
        return { line, column, length }
    }

    // One `it` per row of the plan's offset table:
    // 'offsets an LF document by its earlier lines'                 → { from: 8, to: 11, insert: 'X' }
    // 'counts both characters of a CRLF line ending'                → { from: 9, to: 12, insert: 'X' }
    // 'counts a lone CR as a line ending'                           → { from: 8, to: 11, insert: 'X' }
    // 'resolves a regexp template against the current match'       → { from: 8, to: 13, insert: '<oooo>' }
    // 'uses the current match length, not the recorded one'        → { from: 2, to: 6, insert: 'X' }
    // 'returns null when nothing matches at the column any more'    → null
    // 'returns null when the target line no longer exists'          → null
})

describe('editBetween', () => {
    // 'replaces only the span between the common prefix and suffix' → ('a foo b foo c', 'a X b X c') → { from: 2, to: 11, insert: 'X b X' }
    // 'returns null for equal texts'                                → ('abc', 'abc') → null
    // 'never lets the suffix overlap the prefix'                    → ('aaa', 'aa') → { from: 2, to: 3, insert: '' }
    // 'reports a pure insertion as an empty range'                  → ('foo', 'food') → { from: 3, to: 3, insert: 'd' }
    // 'round-trips a CRLF replace-all result'                       → see below
})
```

The round-trip case:

```typescript
    it('round-trips a CRLF replace-all result', () => {
        const before = 'a foo\r\nmid\r\nfoo b'
        const { text: after } = replaceAllInText(before, compileQuery(query('foo'))!, 'X')
        const edit: TextEdit | null = editBetween(before, after)

        expect(edit).toEqual({ from: 2, to: 15, insert: 'X\r\nmid\r\nX' })
        expect(before.slice(0, edit!.from) + edit!.insert + before.slice(edit!.to)).toBe(after)
    })
```

`tests/shortcuts.test.ts` — change line 2's import to
`import { isFindChord, isFormatChord, dispatchAccelerator } from '../src/shell/shortcuts'`
and add `import type { AcceleratorActions } from '../src/shell/shortcuts'`.
Append:

```typescript
/** Accelerator callbacks that each record their own name into `calls` when run. */
function recordingActions(): { actions: AcceleratorActions; calls: string[] } {
    const calls: string[] = []
    const record = (name: string): (() => void) => (): void => { calls.push(name) }
    const actions: AcceleratorActions = {
        onNewFile: record('onNewFile'),
        onOpenFolder: record('onOpenFolder'),
        onSave: record('onSave'),
        onSaveAs: record('onSaveAs'),
        onCloseFile: record('onCloseFile'),
        onFormat: record('onFormat'),
        onFind: record('onFind'),
        onFindInFiles: record('onFindInFiles'),
        onToggleExplorer: record('onToggleExplorer'),
        onExit: record('onExit'),
        onOpenCommandPalette: record('onOpenCommandPalette'),
    }

    return { actions, calls }
}

/** One keydown for each of the app's eleven chords. */
const ALL_CHORDS: KeyboardEvent[] = [
    chord({ ctrlKey: true, key: 'n' }),
    chord({ ctrlKey: true, key: 'o' }),
    chord({ ctrlKey: true, key: 's' }),
    chord({ ctrlKey: true, shiftKey: true, key: 's' }),
    chord({ ctrlKey: true, key: 'w' }),
    chord({ altKey: true, shiftKey: true, key: 'f' }),
    chord({ ctrlKey: true, key: 'f' }),
    chord({ ctrlKey: true, shiftKey: true, key: 'f' }),
    chord({ ctrlKey: true, key: 'b' }),
    chord({ ctrlKey: true, key: 'q' }),
    chord({ ctrlKey: true, key: 'p' }),
]

describe('dispatchAccelerator', () => {
    // 'runs the palette for Ctrl+P with no modal open'         → returns true, calls === ['onOpenCommandPalette']
    // 'runs nothing for Ctrl+P while a modal is open'          → returns true, calls === []
    // 'ignores a key that is not a chord, modal or not'        → bare 'p': false with modalOpen false, false with modalOpen true, calls === []
    // 'runs Save As, not Save, for Ctrl+Shift+S'               → calls === ['onSaveAs']
    // 'runs Find in Files, not Find, for Ctrl+Shift+F'         → calls === ['onFindInFiles']
    // 'runs no chord at all while a modal is open'             → every ALL_CHORDS entry returns true; calls === [] afterwards
})
```

---

## Ordered Implementation Steps

All steps run from the worktree root, `.worktrees/typescript-ui-0-11-adoptions`.

### Setup

1. **Install dependencies in the worktree.** Do **not** link the main tree's
   `node_modules`. Run `npm ci`. Checks:
   - `test -L node_modules/@jimka/typescript-ui && echo LINK || echo DIR` → `DIR`.
   - `node -p "require('./node_modules/@jimka/typescript-ui/package.json').version"` → `0.11.0`.
   - `readlink /home/jika/typescript/loom/node_modules/@jimka/typescript-ui` → `/home/jika/typescript/typescript-ui/packages/lib` (main tree untouched).
2. **Baseline.** `npm run typecheck && npm test` → clean, `530 passed`.
3. **Red by-eye baseline.** Build the scratch project and run manual cases
   M1 and M5 from **Verification** against the unmodified code. Both must
   fail: in M1 the status-bar readout no longer matches after the replace; in
   M5 the palette appears over the dialog. Stop the dev server. This proves the
   two checks can fail. Then `rm -rf qa-scratch`.

### Part 1 — `replaceRange` for search replace

4. **[tests/projectSearch.test.ts](tests/projectSearch.test.ts)** — add the
   imports, the CRLF `replaceOneInText` case, and the `replacementEditAt` and
   `editBetween` blocks from **Implementation › Tests**. Check:
   `npx vitest run tests/projectSearch.test.ts` → fails (the two new names are
   not exported yet).
5. **[src/data/projectSearch.ts](src/data/projectSearch.ts)** — three edits,
   bottom of the file first so earlier line numbers stay valid:
   - Replace lines 428-499 (`replaceOneOnLine` and `replaceOneInText`, doc
     comments included) with the block from **Implementation**.
   - Insert `editBetween` after line 426.
   - Insert `TextEdit` after line 50.

   Checks:
   - `grep -n "replaceOneOnLine" src/data/projectSearch.ts` → zero matches.
   - `npx vitest run tests/projectSearch.test.ts` → all pass, including the five
     original `replaceOneInText` cases.
6. **Mutation checks.** Each must make the named tests fail; revert each and
   confirm `git diff --stat src/data/projectSearch.ts` shows only step 5's
   change afterwards:
   - In `replacementEditAt`, change `const from = lineStart + at.column` to
     `const from = at.column` → the LF, CRLF, lone-CR and regexp cases fail.
   - In `editBetween`, change `suffix < limit - prefix` to `suffix < limit` →
     `never lets the suffix overlap the prefix` fails.
7. **[src/EditorController.ts](src/EditorController.ts)** — three edits,
   bottom first (within each method, the body before its doc comment):
   - `replaceMatch`: replace lines 943-953 (`if (open) {` through its closing
     brace) with the open-file branch from **Implementation**, then add its
     doc sentence.
   - `performReplaceInFile`: replace lines 832-842 (`const open = …` through
     the `if (open)` block's closing brace) with the open-file branch from
     **Implementation**, then add its doc sentence.
   - Line 14 becomes
     `import { replaceAllInText, replaceOneInText, replacementEditAt, editBetween, isProbablyBinary } from './data/projectSearch'`.

   Checks:
   - `grep -n "setValue" src/EditorController.ts` → only the doc-comment
     mention in `reloadFromDisk`'s comment (around line 1293); no `setValue(`
     call in `performReplaceInFile` or `replaceMatch`.
   - `npm run typecheck && npm test` → clean.
8. **Commit Part 1** as one code commit (commit skill): `src/data/projectSearch.ts`,
   `tests/projectSearch.test.ts`, `src/EditorController.ts`.

### Part 2 — modal guard for accelerators

9. **[tests/shortcuts.test.ts](tests/shortcuts.test.ts)** — add the imports,
   `recordingActions`, `ALL_CHORDS` and the `dispatchAccelerator` block from
   **Implementation › Tests**. Check: `npx vitest run tests/shortcuts.test.ts`
   → fails (`dispatchAccelerator` is not exported yet).
10. **[src/shell/shortcuts.ts](src/shell/shortcuts.ts)** — add the import and
    the header sentence, insert `acceleratorFor` and `dispatchAccelerator`
    after line 129, and replace `installAccelerators` (lines 131-173) with the
    version in **Implementation**. Checks:
    - `grep -n "actions.on" src/shell/shortcuts.ts` → eleven matches, all
      inside `acceleratorFor`'s table.
    - `npx vitest run tests/shortcuts.test.ts` → all pass.
11. **Mutation check.** In `dispatchAccelerator`, change `if (!modalOpen)` to
    `if (true)` → `runs nothing for Ctrl+P while a modal is open` and
    `runs no chord at all while a modal is open` fail. Revert.
12. `npm run typecheck && npm test` → clean. **Commit Part 2** as one code
    commit: `src/shell/shortcuts.ts`, `tests/shortcuts.test.ts`.

### Part 3 — `DockCloseController`

13. **[src/EditorController.ts](src/EditorController.ts)** — three edits:
    - Line 4 becomes `import type { DockPanelEvent, DockCloseController } from '@jimka/typescript-ui/overlay'`.
    - Line 5 becomes `import type { LayoutState } from '@jimka/typescript-ui/layout'`.
    - Replace `handleBeforePanelClose`'s doc comment and signature line with
      the block in **Implementation**; the body is unchanged. Part 1 moved
      them down from lines 1387-1393, so find them with
      `grep -n "handleBeforePanelClose = " src/EditorController.ts`.

    Checks:
    - `grep -rn "TabCloseController" src tests` → zero matches.
    - `npm run typecheck && npm test` → clean.
14. **Commit Part 3** as one code commit: `src/EditorController.ts`.

### Documentation and final checks

15. **[README.md](README.md)** — in the **Project search** bullet, lines 82-83,
    change *"editing an open file's own buffer (undo it there, and save when
    ready)"* to *"editing an open file's own buffer as a single undo step (undo
    it there, and save when ready)"*. Commit as the docs commit for Part 1.
16. **Full check.** `npm run typecheck && npm test && npm run build` → all
    clean; `npm test` reports `549 passed`. `git status --short` is empty.
17. Run every manual case in **Verification**.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src/data/projectSearch.ts` |
| Modify | `tests/projectSearch.test.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `src/shell/shortcuts.ts` |
| Modify | `tests/shortcuts.test.ts` |
| Modify | `README.md` |

---

## Expected Behaviour

**Unit-testable** (19 new cases; the suite goes from 530 to 549):

1. `replacementEditAt` returns exactly the results in the offset table in
   **Architecture Decisions** (7 cases, in `tests/projectSearch.test.ts`).
2. `replaceOneInText('foo\r\nbar foo\r\n', at(2, 4, 3), foo, 'X')` →
   `'foo\r\nbar X\r\n'`; the five existing `replaceOneInText` cases pass
   unchanged.
3. `editBetween` returns exactly the results in the `editBetween` table, and
   `round-trips a CRLF replace-all result` holds (5 cases).
4. `dispatchAccelerator` (6 cases, in `tests/shortcuts.test.ts`):
   - Ctrl+P, `modalOpen` `false` → returns `true`, runs `onOpenCommandPalette` only.
   - Ctrl+P, `modalOpen` `true` → returns `true`, runs nothing.
   - Bare `p` → returns `false` and runs nothing, for both `modalOpen` values.
   - Ctrl+Shift+S → runs `onSaveAs` only.
   - Ctrl+Shift+F → runs `onFindInFiles` only.
   - Every one of the eleven chords with `modalOpen` `true` → returns `true`; nothing runs.

**Manual** (browser shell; the test harness has no DOM, no live editor and no
layers). The cases are numbered M1–M10 and described in **Verification**:

5. M1 — a single replace keeps the caret and scroll, and one Ctrl/Cmd+Z undoes
   only the replace.
6. M2 — a replace in a CRLF file lands on the right characters.
7. M3 — Replace All in File keeps a caret below the last match, and one
   Ctrl/Cmd+Z undoes all of it.
8. M4 — a replace in a background tab that was shown earlier dirties that tab.
9. M5, M6, M7 — no chord runs while Go to Line, About, or the unsaved-changes
   prompt is open.
10. M8 — chords still run while the command palette is open.
11. M9, M10 — closing a dirty tab, tiled or floated, still prompts.

---

## Verification

- `npm run typecheck`, `npm test` (549 passed), `npm run build` — all clean.
- The greps and mutation checks in steps 1, 5-7, 10, 11 and 13.
- **By eye, browser shell.** From the worktree:
  1. Build a scratch project:
     ```bash
     mkdir qa-scratch
     for i in $(seq 1 80); do echo "line $i foo"; done > qa-scratch/notes.txt
     printf 'alpha foo\r\nbeta foo\r\ngamma foo\r\n' > qa-scratch/crlf.txt
     { printf 'foo one\nfoo two\nfoo three\n'; for i in $(seq 4 80); do echo "plain $i"; done; } > qa-scratch/top.txt
     printf 'one foo\ntwo foo\n' > qa-scratch/back.txt
     ```
  2. `npm run dev:browser` (add `-- --port 1431 --strictPort` if port 1420 is
     busy) and open the page with the chrome-devtools tools. Set
     `window.__FAKE_PROJECT_ROOT__` to the absolute path of `qa-scratch` with
     `evaluate_script`, then click *Open Folder…*.
  3. Two readings are used throughout. **Readout**: the status bar's
     `Ln …, Col … · Pos …` text. **Scroll**: from `evaluate_script`,
     `[...document.querySelectorAll('.cm-scroller')].find(e => e.offsetParent !== null).scrollTop`.
     To give the visible editor focus without moving its caret, run
     `[...document.querySelectorAll('.cm-content')].find(e => e.offsetParent !== null).focus()`.
  4. Run the cases:
     - **M1.** Double-click `notes.txt` in the tree. Scroll the editor until
       lines 30-50 are on screen. Click at the end of line 40 and type `z`.
       In the Search view, search `foo` and type `BAR` in the Replace field.
       Right-click the line-35 match leaf. With the menu open, take the
       readout and scroll. Click **Replace**. Line 35 reads `line 35 BAR`;
       the tab shows its dirty dot; readout and scroll are unchanged (if the
       right-click had selected the match, `BAR` is now selected and the
       readout's line is still 35). Focus the editor as in item 3 and press
       Ctrl+Z: line 35 reads `line 35 foo`, line 40 still ends in `z`, and
       readout and scroll are unchanged again. A second Ctrl+Z removes the `z`.
     - **M2.** Open `crlf.txt`, search `foo`, right-click the line-2 leaf,
       **Replace**. The editor reads `alpha foo` / `beta BAR` / `gamma foo`.
     - **M3.** Open `top.txt`, click on line 50, take the readout and scroll.
       Search `foo`, right-click the `top.txt` file branch, **Replace All in
       File**. Lines 1-3 read `BAR one`, `BAR two`, `BAR three`; readout and
       scroll are unchanged. Focus the editor, press Ctrl+Z once: all three
       lines read `foo …` again.
     - **M4.** Double-click `back.txt`, then double-click `notes.txt`, in the
       same group, so `back.txt` becomes a background tab that has been shown
       once. Search `foo`, right-click the `back.txt` line-2 leaf, **Replace**.
       `back.txt`'s tab shows its dirty dot; switching to it shows
       `two BAR`.
     - **M5.** Open *Go to Line* (click the status-bar readout). With its field
       focused, press Ctrl+P: no palette appears. Press Escape, then Ctrl+P:
       the palette opens. Escape.
     - **M6.** Open the About dialog (far right of the menu bar). Press Ctrl+P,
       then Ctrl+Shift+F: no palette appears and the sidebar stays on its
       current view. Close the dialog.
     - **M7.** Type a character into `notes.txt`, then click its tab's ✕: the
       unsaved-changes prompt opens. Press Ctrl+W: no second prompt appears
       (take a screenshot). Click *Cancel*.
     - **M8.** Press Ctrl+P to open the palette, then Ctrl+B: the explorer
       pane collapses. Ctrl+B again to restore it; Escape.
     - **M9.** With `notes.txt` dirty, click its tab's ✕, then *Cancel*: the tab
       stays open with its dirty dot.
     - **M10.** Drag the dirty `notes.txt` tab off the strip to tear it into a
       floating window. Click the window's chrome ✕: the prompt opens. Choose
       *Don't Save*: the window closes.
  5. Stop the server, `rm -rf qa-scratch`, and confirm `git status --short` is
     empty.

Saves are no-ops in the browser shell, so no case saves.

---

## Documentation Impact

- **README.md** — the one-phrase change in step 15. README never described
  what shortcuts do under a dialog, so Part 2 needs no README change; Part 3
  changes no behaviour.
- **TODO.md** — no change.
- No public API changes. Loom has no `docs/` tree.

---

## Potential Challenges

- **`replaceRange` scrolls the caret into view.** The library dispatches
  with `scrollIntoView: true`, so if the caret was off screen, the editor
  scrolls back to it. M1 and M3 put the caret on screen first, which is the
  normal case after a search preview.[^scroll-into-view]
- **`npm ci` needs the network.** If the registry is unreachable, stop and
  report it; do not fall back to linking the main tree's `node_modules`.
- **The shortcuts test now loads the library's core barrel.** `shortcuts.ts`
  imports `LayerManager`. `tests/languages.test.ts` already loads the
  library under vitest's node environment, so this is expected to work. If
  the suite fails to load, stop and report it rather than mocking the import.
- **M4 depends on the dock keeping `back.txt` mounted.** `back.txt` was shown
  before `notes.txt` covered it, so its editor is mounted. If its tab shows no
  dirty dot, record it in the implementation notes; that would be the
  pre-mount gap from **Architecture Decisions**, not a regression.

---

## Critical Files

- [src/EditorController.ts](src/EditorController.ts) — `performReplaceInFile`
  (:831), `replaceMatch` (:940), `handleBeforePanelClose` (:1393),
  `reloadFromDisk` (:1304, the other `setValue` caller, left alone).
- [src/data/projectSearch.ts](src/data/projectSearch.ts) — `LINE_SPLIT`
  (:22), `splitKeepingLineEndings` (:282), `replaceAllInText` (:412),
  `replaceOneOnLine` (:438), `replaceOneInText` (:480).
- [src/shell/shortcuts.ts](src/shell/shortcuts.ts) and
  [src/shell/EditorShell.ts:433](src/shell/EditorShell.ts#L433) — the one
  `installAccelerators` call.
- [src/shell/CommandPalette.ts:46](src/shell/CommandPalette.ts#L46) — extends
  `PopupPanel`, so it is not a modal layer.
- [src/explorer/SearchPanel.ts:465-513](src/explorer/SearchPanel.ts#L465) —
  the context-menu replace actions, which re-run the search afterwards.
- **Precedents:**
  - `../sqladmin/frontend/src/shell/SqlAdminShell.ts:171-209` —
    `installAccelerators` with the `LayerManager.hasModalLayer()` guard.
  - [plans/implemented/file-editor-dirty-state-adoption.md](plans/implemented/file-editor-dirty-state-adoption.md)
    — adopting a library API in place of Loom's own code.
  - [plans/implemented/project-wide-replace.md](plans/implemented/project-wide-replace.md)
    — where `replaceMatch` and `performReplaceInFile` came from, and its
    `setvalue-undo` footnote.
  - [plans/implemented/typescript-ui-0-11-bump.md](plans/implemented/typescript-ui-0-11-bump.md)
    — the worktree install rule.
- Library, at `../typescript-ui/packages/lib/src/typescript/lib/`:
  - `component/editor/CodeEditor.ts:885-969` — `getValue` (LF-normalised),
    `setValue`, `replaceRange`.
  - `component/editor/CodeEditor.ts:844` and `:2462-2474` — mounting on first
    layout, and the clean text taken at mount.
  - `core/LayerManager.ts:626` — `hasModalLayer`; `overlay/Dialog.ts:1690`
    and `core/AnimatedDropdown.ts:439` — the `"modal"` and `"click-outside"`
    dismiss modes.
  - `overlay/Dock.ts:168` (`DockCloseController`), `:1724` and `:1744` — the
    tab and float `"beforeclose"` forwarding.
- `../typescript-ui/packages/lib/docs/reference/changelog/0.11.0.md:302-314`
  (inert behind a modal), `:641` (`replaceRange`), `:855-860`
  (`DockCloseController`); `docs/concepts/layering.md:254-270`.

---

## Non-Goals

- **`editorSearch.ts` and *Find…* focus.** Waits on a public
  `CodeEditor.openSearch()` upstream.
- **`Dock.focusPanel` and torn-off windows.** Being fixed upstream.
- **`resizeMode`, editor settings, Cut/Copy/Paste and other 0.11 adoptions.**
- **The pre-mount replace gap.** A replace into a never-shown tab stays clean
  and cannot be undone, as today. It needs a library decision, which goes to
  the user.
- **A float holding several dirty panels.** Its chrome ✕ raises one prompt
  per dirty panel and keeps the window open. That behaviour comes from 0.10,
  not from the type change, and stays as it is; the doc comment records it.
- **Keeping a caret that sits between two matches during Replace All in
  File.** It would need a multi-range replace in the library; `replaceRange`
  takes one range.
- **Closed-file replace.** The disk paths of `performReplaceInFile` and
  `replaceMatch` are unchanged.
- **Standing down for non-modal layers** (menus, the palette) with
  `LayerManager.hasActiveInputLayer()`. Loom's chords run over them today and
  keep doing so.

---

## Notes

[^why-replacerange]: `setValue` dispatches a full-document replace. CodeMirror
    maps every caret inside a replaced range to that range's edge, so the
    caret lands at offset 0, and the viewport follows. `setValue` also has no
    `isolateHistory`, so a replace made within CodeMirror's 500 ms grouping
    delay of the user's typing can merge into one undo step with it.
    `replaceRange` dispatches the change with `isolateHistory.of("full")`,
    which gives it an undo step of its own. Omitting `selection` is what
    keeps the caret: an explicit selection would move it on purpose. The
    selection table was checked by running `@codemirror/state` 6 and
    `@codemirror/commands` from the bump worktree's install: a selection equal
    to the match maps to the replacement, carets outside it shift with the
    text, and `undo` restores the selection from before the change.
    `project-wide-replace.md` listed caret and scroll preservation as a
    non-goal because `setValue` could not offer it; `replaceRange` now can.

[^offset-source]: `CodeEditor.getValue()` returns LF-only text: CodeMirror
    splits a document on `\r\n`, `\r` and `\n` and joins with `\n`, and the
    library normalises the pre-mount cached value the same way. The search
    itself reads disk text, which may use CRLF, so an offset computed from
    disk text would land one character late per earlier CRLF line. A line and
    column do not have that problem: `findMatches` splits lines with
    `LINE_SPLIT`, which is CodeMirror's own default splitter, so line N is the
    same line in both copies and a column never counts a line ending.
    Computing the offset from the editor's own text, at the moment of the
    replace, is therefore correct for both kinds of file. The library has no
    public line-and-column-to-offset method (`revealRange` converts
    internally but only selects), so Loom does the conversion.

[^one-verifier]: Keeping `replaceOneOnLine` as it is and adding a second
    function that also verifies the match would leave two copies of the
    substring and regexp checks to drift apart. The disk path still needs a
    rewritten string, so `replaceOneInText` stays, built on the same edit.

[^replace-all-shape]: Three shapes were considered. One `replaceRange` per
    match gives one undo step per match, so undoing a Replace All in File
    over 40 matches would take 40 Ctrl/Cmd+Z presses; every editor users know
    (VS Code, CodeMirror's own *replace all*) undoes it in one. Keeping
    `setValue` keeps the one undo step but loses the caret and scroll every
    time. One `replaceRange` over the smallest changed span keeps the single
    undo step and keeps the caret whenever it is outside the span, which is
    never worse than `setValue`. Matches can only change text between the
    first match's start and the last match's end, so the common-prefix and
    common-suffix scan finds that span (or a smaller one) without
    `replaceAllInText` having to report offsets. A span edge can fall between
    the two halves of a surrogate pair when the old and new text share a high
    surrogate; the resulting document is still exactly `after`.

[^premount-gap]: `CodeEditor`'s constructor registers
    `this.onFirstLayout(() => this.mount())` (`CodeEditor.ts:844`), and
    `Tab.doLayout` lays out only the selected page and calls
    `setDisplayed(false)` on the rest (`Tab.ts:2116-2127`), so a restored tab
    the user has not clicked has no `EditorView`. `replaceRange` without a view
    sets `_options.value` and returns (`CodeEditor.ts:954-956`).
    `mount()` then builds the state from that value and sets `_cleanValue`
    from it (`CodeEditor.ts:2462-2472`, *"The editor is always clean at
    mount"*). The result: no dirty dot, no unsaved-changes prompt on close
    (so the replace is silently dropped if the tab is closed), and no undo
    entry. `setValue` behaves the same way today, which is right for a host
    loading a document but not for an edit. The library could keep a
    pre-mount `replaceRange` dirty, for example by not re-taking the clean
    text at mount when the cached value has moved away from it. Loom cannot
    fix this without forcing the tab to show or keeping its own dirty flag,
    both of which `CLAUDE.md` rules out as workarounds. This was found by
    reading the source; the browser shell cannot reproduce it, because a
    never-shown tab needs session restore, and the shell does not write the
    session.

[^all-chords]: Every chord acts on the app behind the modal. While a modal is
    open the library makes everything else `inert`
    (`changelog/0.11.0.md:302-314`), so a palette, a sidebar view or a find
    panel opened from a chord would sit unreachable, or open behind the
    dialog. Ctrl/Cmd+S, Save As and Format would save or reformat the buffer
    a prompt may be asking about. Ctrl/Cmd+W and Ctrl/Cmd+Q would
    stack a second unsaved-changes prompt over the first. No Loom dialog
    hosts an editor or uses any of these chords itself. The library's own key
    handling needs no help: an inert element cannot take focus, so no
    component behind the modal receives keys, and only listeners on
    `window` or `document` like Loom's still fire. `FocusTraversal` and
    `FocusHistory` stand down on `hasModalLayer()` for the same reason
    (`docs/concepts/layering.md:254-270`). SQLAdmin made the same call for
    every one of its chords.

[^swallow]: SQLAdmin returns before matching, so the key keeps its browser
    default. Its chords are Alt+letter, which browsers mostly leave unbound.
    Loom's are Ctrl/Cmd+P, F, S, W and Q, which webviews and browsers bind to
    print, find, save-page and close. Loom already swallows them when no
    modal is open; letting them through under a modal would let, say,
    WebView2's print dialog (Windows) or the browser's find bar (the dev
    browser shell) open over the modal. Inside a Loom dialog, these chords
    have no default to lose: the dialogs' text fields use none of them.

[^palette]: `CommandPalette` extends `PopupPanel`, which extends
    `AnimatedDropdown`, whose `getDismissMode()` returns `"click-outside"`
    (`core/AnimatedDropdown.ts:439`). Only `Dialog` and a modal `Drawer`
    report `"modal"`, and every Loom prompt is a `Dialog` (`Dialog.show`,
    `Dialog.error`, `Dialog.confirm`, or `DismissDialog`, which extends
    `Dialog`). With the palette open, Ctrl/Cmd+P re-opens it with an empty
    query and the other chords act as usual, both as today. The palette
    cannot be opened over a modal, because Ctrl/Cmd+P is suppressed and the
    menu bar behind the modal is inert.

[^controller-types]: `TabCloseController` (`layout/Tab.ts:75`),
    `WindowCloseController` (`overlay/AbstractWindow.ts:130`) and
    `DockCloseController` (`overlay/Dock.ts:168`) each declare only
    `preventDefault(): void`. Dock forwards the controller `Tab` or the
    window handed it, unchanged (`Dock.ts:1724-1748`). The changelog entry
    (`changelog/0.11.0.md:855-860`) says a listener annotated with either old
    type still compiles; the migration notes have no entry for it. The swap
    is about naming the type `Dock` actually passes.

[^scroll-into-view]: `replaceRange` passes `scrollIntoView: true`
    (`CodeEditor.ts:964`), which scrolls the main selection to the nearest
    visible position and does nothing when it is already on screen. Passing
    `selection` would not avoid it. After a search preview the caret sits on
    the previewed match, which `revealRange` scrolled to the centre, so the
    common case does not scroll.
