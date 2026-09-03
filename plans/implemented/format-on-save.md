---
touches-shared: [src/EditorController.ts, src/editor/languages.ts, tests/languages.test.ts, README.md, TODO.md]
---

# Format on Save — Implementation Plan

## Overview

Loom reformats a document only when the user asks: *Edit > Format Document*
(Alt+Shift+F) calls
[`EditorController.formatActive`](src/EditorController.ts#L510), which awaits
the library's `CodeEditor.format()`. Saving writes whatever the buffer holds —
[`save`](src/EditorController.ts#L446) and
[`saveAs`](src/EditorController.ts#L407) each pass
`file.getEditor().getValue()` straight to `writeFileText`.

This plan runs the formatter automatically, in the moment between "the target
is settled" and "the bytes go to disk", on both save paths. Two guards sit in
front of it: a single module constant, `FORMAT_ON_SAVE`, which turns the
feature off in one edit, and a check that the document's language actually has
a registered formatter. A formatter that throws — normal while the source is
mid-edit and syntactically invalid — does not stop the save.

The changes are confined to `src/EditorController.ts` (the constant and two
new private methods, called from the two existing save methods) and
`src/editor/languages.ts` (one new pure predicate, `hasFormatter`, covered by
new cases in `tests/languages.test.ts`). No change to `@jimka/typescript-ui`,
and no change to the manual *Format Document* action.

---

## Architecture Decisions

### The toggle is one module constant, `FORMAT_ON_SAVE`, in `src/EditorController.ts`

`const FORMAT_ON_SAVE = true` is declared at module scope in
[src/EditorController.ts](src/EditorController.ts), beside the existing
`SAVE_MESSAGE_DURATION_MS` ([:24](src/EditorController.ts#L24)), and is read
in exactly one place: the new private method `formatBeforeSave`. That is the
whole switch — flipping it to `false` restores today's byte-for-byte save
behaviour with no other edit.[^toggle-home]

**This is the location a later settings migration must come to.** TODO.md's
*Transition hard-coded settings to a settings file* entry
([TODO.md:43-48](TODO.md#L43)) lists format-on-save among the values to move;
step 13 below points that entry at the constant by name, so the migration plan
can find it with `grep -n FORMAT_ON_SAVE src/EditorController.ts` and does not
have to re-derive anything from this plan.

### A save skips any language with no registered formatter

`formatBeforeSave` runs `CodeEditor.format()` only when the editor's current
language has a `loadFormatter`. Today that means JavaScript/TypeScript, JSON,
HTML, SQL and Markdown are reformatted on save, while CSS, Python, and every
unrecognised extension are written exactly as the buffer holds them.

Without this guard a save would reach `format()`'s other branch, which
re-indents the whole document through CodeMirror's indentation service
([CodeEditor.ts:579](node_modules/@jimka/typescript-ui/src/typescript/lib/component/editor/CodeEditor.ts#L579)).
That branch stays reachable from the manual *Format Document* action, where
the user asked for it.[^skip-reindent]

### `hasFormatter` is a pure predicate in `src/editor/languages.ts`

The formatter check is a language question, so it lives with Loom's other
language questions — beside
[`isMarkdownPath`](src/editor/languages.ts#L56), in the module that already
imports the library's language registry
([:6](src/editor/languages.ts#L6)). `hasFormatter` is a pure function of a
language id, so the existing `tests/languages.test.ts` covers it with ordinary
cases — unlike the component wiring that calls it.

`hasFormatter` takes a language id, not a path as its two neighbours do,
because its caller reads the editor's live language rather than re-deriving
one from the file path.[^id-not-path]

### A formatter that throws does not stop the save

`formatBeforeSave` catches the rejection, leaves the document untouched, and
reports back to its caller. The save then proceeds with the unformatted text,
and the status bar reads `Saved app.ts (not formatted)` instead of
`Saved app.ts`.[^throw-degrades]

### Formatting runs after the Save As target is confirmed, and before the write

In `saveAs`, `formatBeforeSave` is called after the duplicate-target check and
immediately before `writeFileText`. Cancelling the save dialog therefore
formats nothing. `saveAs`'s existing `setPath` → `markClean` order, after the
write, is not touched.[^saveas-ordering]

### The manual *Format Document* action is not touched

`formatActive` ([:510](src/EditorController.ts#L510)) keeps calling
`file.getEditor().format()` directly, with no `FORMAT_ON_SAVE` check, no
`hasFormatter` check, and no `try`/`catch`. Its menu item, its Alt+Shift+F
chord, and its re-indent behaviour on CSS and Python all stay exactly as they
are.

### Which saves reformat

| Save | Editor language when `formatBeforeSave` runs | Result |
|---|---|---|
| Ctrl+S on `app.ts` | `javascript` | Prettier reformats it, then the formatted text is written |
| Ctrl+S on `app.ts` holding `const x = (` | `javascript` | Prettier throws; the unformatted text is written, status `Saved app.ts (not formatted)` |
| Ctrl+S on `main.py` | `python` | no formatter — written unchanged, and **not** re-indented |
| Ctrl+S on `notes.txt` | `null` | no formatter — written unchanged |
| Save As `app.ts` → `copy.ts` | `javascript` | Prettier reformats it, then the formatted text is written |
| First save of `Untitled-1` → `notes.ts` | `null`, because `setPath` runs after the write | written unchanged; every later save of `notes.ts` is formatted |

---

## Public API

### `src/editor/languages.ts`

```typescript
/**
 * Whether a language has a registered formatter — the question format-on-save
 * asks before reformatting a document.
 *
 * @param languageId - A `CodeEditor` language id, or `null` when the editor has none.
 * @returns `true` when `CodeEditor.format()` would run a real formatter rather
 *   than its whole-document re-indent fallback.
 */
export function hasFormatter(languageId: string | null): boolean
```

The module's existing import gains one name:

```typescript
import { registerLanguage, getLanguage } from '@jimka/typescript-ui/component/editor'
```

### `src/EditorController.ts`

Both new methods are **private**, and the `FORMAT_ON_SAVE` constant is
module-private (declared in full under **Internal Structure**); no public
signature changes.

```typescript
class EditorController {
    /** Reformats `file`'s document in place, immediately before its bytes are written. */
    private async formatBeforeSave(file: FileEditor): Promise<boolean>

    /** The status-bar text for a completed save. */
    private savedMessage(file: FileEditor, formatFailed: boolean): string

    // Unchanged signatures: save(file), saveAs(file), formatActive().
}
```

---

## Internal Structure

`src/editor/languages.ts` — placed after `isMarkdownPath`
([:56-58](src/editor/languages.ts#L56)) and before the two `registerLanguage`
calls at the foot of the file:

```typescript
/**
 * Whether a language has a registered formatter — the question format-on-save
 * asks before reformatting a document. `false` for a language registered with
 * a grammar only (`css` and `python`, below), for an id no one registered, and
 * for a buffer with no language at all.
 *
 * @param languageId - A `CodeEditor` language id, or `null` when the editor has none.
 * @returns `true` when `CodeEditor.format()` would run a real formatter rather
 *   than its whole-document re-indent fallback.
 */
export function hasFormatter(languageId: string | null): boolean {
    return languageId !== null && getLanguage(languageId)?.loadFormatter !== undefined
}
```

`src/EditorController.ts` — the constant, at module scope directly below
`SAVE_MESSAGE_DURATION_MS` ([:24](src/EditorController.ts#L24)):

```typescript
/** Whether a save reformats the document before writing it.
 *
 *  The single switch for format-on-save: `formatBeforeSave` is the only reader,
 *  so setting this to `false` restores a byte-for-byte save with no other edit.
 *  Hardcoded rather than read from disk because Loom has no settings system
 *  yet — TODO.md's *Transition hard-coded settings to a settings file* entry
 *  names this constant as one of the values that migration picks up. */
const FORMAT_ON_SAVE = true
```

`src/EditorController.ts` — the two private methods, placed together directly
below `saveDialogDefault` ([:479-487](src/EditorController.ts#L479)):

```typescript
/**
 * Reformats `file`'s document in place, immediately before its bytes are
 * written. A no-op while `FORMAT_ON_SAVE` is off, and for a language with no
 * registered formatter — that second guard is what keeps a save away from
 * `CodeEditor.format()`'s whole-document re-indent fallback, which is
 * reserved for the manual *Format Document* action.
 *
 * @param file - The file about to be written.
 * @returns `true` when a formatter ran and threw, leaving the document
 *   unformatted; `false` when formatting succeeded or was skipped.
 */
private async formatBeforeSave(file: FileEditor): Promise<boolean> {
    if (!FORMAT_ON_SAVE || !hasFormatter(file.getEditor().getLanguage())) {
        return false
    }

    try {
        await file.getEditor().format()
    } catch {
        // A formatter throws on syntactically invalid source, which is the
        // normal state of a file mid-edit. The save is what the user asked
        // for, so it goes ahead with the text as it stands.
        return true
    }

    return false
}

/**
 * The status-bar text for a completed save.
 *
 * @param file - The file that was written; its label supplies the name.
 * @param formatFailed - Whether format-on-save ran a formatter that threw.
 * @returns The message to show for `SAVE_MESSAGE_DURATION_MS`.
 */
private savedMessage(file: FileEditor, formatFailed: boolean): string {
    return formatFailed ? `Saved ${file.getLabel()} (not formatted)` : `Saved ${file.getLabel()}`
}
```

---

## Ordered Implementation Steps

Steps 1-3 are the test-first cycle for the one unit-testable piece. Steps 4-9
wire it into the save paths; nothing between them breaks the typecheck.

1. **[tests/languages.test.ts](tests/languages.test.ts)** — add
   `hasFormatter` to the import on
   [:2](tests/languages.test.ts#L2), then add a
   `describe('hasFormatter', ...)` block after the existing `isMarkdownPath`
   block with the nine cases from **Expected Behaviour**. Run `npm test` —
   the new cases fail, since `hasFormatter` does not exist yet.

2. **[src/editor/languages.ts](src/editor/languages.ts)** — add `getLanguage`
   to the existing library import on [:6](src/editor/languages.ts#L6), then
   add the `hasFormatter` function from **Internal Structure** after
   `isMarkdownPath` ([:58](src/editor/languages.ts#L58)) and before the first
   `registerLanguage` call ([:60](src/editor/languages.ts#L60)).

3. Check: `npm test` — green, including the nine new cases.

4. **[src/EditorController.ts](src/EditorController.ts)** — add `hasFormatter`
   to the existing `./editor/languages` import on
   [:7](src/EditorController.ts#L7), which today imports `languageForPath`
   only.

5. **Same file** — add the `FORMAT_ON_SAVE` constant and its doc comment from
   **Internal Structure**, directly below `SAVE_MESSAGE_DURATION_MS`
   ([:24](src/EditorController.ts#L24)) and above the `EditorController` class
   JSDoc.

6. **Same file** — add the `formatBeforeSave` and `savedMessage` methods from
   **Internal Structure**, in that order, directly after `saveDialogDefault`
   ([:487](src/EditorController.ts#L487)) and before `closeActive`.

7. **Same file, `saveAs` ([:407-437](src/EditorController.ts#L407))** — insert
   `const formatFailed = await this.formatBeforeSave(file)`, followed by a
   blank line, between the duplicate-target `if` block
   ([:414-418](src/EditorController.ts#L414)) and the `try` that writes
   ([:420](src/EditorController.ts#L420)). Then replace the message line
   ([:432](src/EditorController.ts#L432)) with:

   ```typescript
   this.statusBar.setMessage(this.savedMessage(file, formatFailed), SAVE_MESSAGE_DURATION_MS)
   ```

   Leave `file.setPath(target)` and `file.markClean()`
   ([:428-429](src/EditorController.ts#L428)) in their present order and
   position, after the write.

8. **Same file, `save` ([:446-465](src/EditorController.ts#L446))** — insert
   `const formatFailed = await this.formatBeforeSave(file)`, followed by a
   blank line, between the `path === null` block
   ([:449-451](src/EditorController.ts#L449)) and the `try` that writes
   ([:453](src/EditorController.ts#L453)). Then replace the message line
   ([:462](src/EditorController.ts#L462)) with the same
   `this.savedMessage(file, formatFailed)` call as step 7.

9. **Same file** — extend the two save methods' doc comments to record the new
   step: `save`'s ([:439-445](src/EditorController.ts#L439)) and `saveAs`'s
   ([:398-406](src/EditorController.ts#L398)) each gain a sentence saying the
   document is reformatted first when `FORMAT_ON_SAVE` is on and the language
   has a formatter. Leave `formatActive`
   ([:509-516](src/EditorController.ts#L509)) completely unchanged.

10. Checks:
    - `npm run typecheck` — clean.
    - `grep -n 'FORMAT_ON_SAVE' src/EditorController.ts` — exactly two
      matches: the declaration and the guard in `formatBeforeSave`.
    - `grep -rn 'FORMAT_ON_SAVE' src/ --include=*.ts` — the same two matches
      and no others, confirming the toggle is not scattered.
    - `grep -rn '\.format()' src/` — exactly two matches, in `formatActive`
      and `formatBeforeSave`.
    - `grep -n 'statusBar.setMessage' src/EditorController.ts` — exactly two
      matches, both passing `this.savedMessage(file, formatFailed)`.

11. Run `npm run typecheck && npm test && npm run build` — all clean.

12. **[README.md](README.md)** — replace the *Format Document* bullet
    ([:48-49](README.md#L48)) with the text in **Documentation Impact**.

13. **[TODO.md](TODO.md)** — delete the **Format-on-save** bullet from
    `## High` ([:23-25](TODO.md#L23)); `## High` keeps its other entries, so
    the heading stays. Then replace the bare `* Format-on-save` sub-item of
    the *Transition hard-coded settings* entry
    ([:46](TODO.md#L46)) with the pointer text in **Documentation Impact**.

14. Run the manual cases in **Verification**.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src/editor/languages.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `tests/languages.test.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Unit-testable — `tests/languages.test.ts`

`hasFormatter` reads the live language registry, which is populated by
importing `src/editor/languages.ts` (the library's barrel registers its five
built-ins as an import side effect; this module registers `css` and `python`).
Nine cases:

| Input | Expected | Why |
|---|---|---|
| `'javascript'` | `true` | Prettier `babel-ts` |
| `'json'` | `true` | Prettier `json` |
| `'html'` | `true` | Prettier `html` |
| `'sql'` | `true` | `sql-formatter` |
| `'markdown'` | `true` | Prettier `markdown` |
| `'css'` | `false` | registered by Loom with a grammar only |
| `'python'` | `false` | registered by Loom with a grammar only |
| `'nonsense'` | `false` | no such registration |
| `null` | `false` | the editor has no language |

### Manual verification — `npm run tauri:dev`

Component behaviour is verified live in this project, not in the test suite
([vitest.config.ts](vitest.config.ts)). Cases 1-6 and 11 exercise the new
behaviour; cases 7-10 and 12 confirm nothing else moved.

1. **A formatted language is reformatted on save.** Open a `.ts` file, break
   its formatting (collapse a block onto one line), press Ctrl+S. The buffer
   snaps to Prettier's output, the tab's dirty dot clears, the status bar
   shows `Saved <name>`, and the file on disk holds the formatted text.
2. **Save As reformats too.** With the same file, *File > Save As…* to a new
   `.ts` name: the written file holds the formatted text and the tab takes the
   new name.
3. **A syntax error still saves.** Type `const x = (` into a `.ts` file and
   press Ctrl+S. The document is left exactly as typed, the file on disk gets
   that text, and the status bar shows `Saved <name> (not formatted)`.
4. **A language with no formatter is written untouched.** Open a `.py` file
   with deliberately odd but valid indentation, edit one line, press Ctrl+S:
   the indentation is unchanged on screen and on disk. Repeat with a `.css`
   file.
5. **An unrecognised extension is written untouched.** Same test with a
   `.txt` file.
6. **An untitled buffer's first save is not formatted, its second is.**
   *File > New File*, paste badly formatted TypeScript, Ctrl+S, choose
   `scratch.ts`: the file is written as pasted. Edit it again and press
   Ctrl+S: now it is reformatted.
7. **The manual action is unchanged on a formatted language.** *Edit > Format
   Document* (or Alt+Shift+F) on a clean `.ts` file still reformats it and
   marks the tab dirty.
8. **The manual action still re-indents an unformatted language.** *Edit >
   Format Document* on a `.py` file with odd indentation still re-indents it —
   the behaviour case 4 keeps out of the save path.
9. **Cancelling Save As changes nothing.** *File > Save As…* on a badly
   formatted `.ts` file, then cancel the dialog: the buffer is untouched and
   still dirty.
10. **Closing a dirty tab via *Save* formats it.** Click a dirty `.ts` tab's
    ✕ and choose *Save* in the unsaved-changes prompt: the file is written
    formatted, and the tab closes.
11. **The toggle turns it off.** Set `FORMAT_ON_SAVE = false`, restart, and
    repeat case 1: the file is written exactly as typed, with the status bar
    showing plain `Saved <name>`. Restore it to `true`.
12. **Markdown preview keeps up.** With a `.md` file open and its preview
    toggled on, press Ctrl+S: the source is reformatted by Prettier's Markdown
    rules and the preview re-renders about a quarter-second later.

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — green, with the nine new `hasFormatter` cases.
- `npm run build` — clean.
- `grep -rn 'FORMAT_ON_SAVE' src/ --include=*.ts` — exactly two matches, both
  in `src/EditorController.ts`.
- `grep -rn '\.format()' src/` — exactly two matches (`formatActive`,
  `formatBeforeSave`).
- `git diff src/editor/FileEditor.ts src/shell/ src/data/` — empty; this plan
  touches neither the editor component nor the shell nor the filesystem layer.
- Manual: `npm run tauri:dev`, then cases 1-12 above in the app window. Case 3
  (a formatter throwing) and case 6 (an untitled buffer's first save) are the
  two the reasoning here flagged as least obvious — run them deliberately.

---

## Documentation Impact

No exported symbol changes outside `src/`, and Loom has no `docs/` tree, so
the impact is the two Markdown files at the repo root.

- **[README.md:48-49](README.md#L48)** — the *Format Document* bullet becomes:

  ```markdown
  - **Format Document**, and a **Toggle Explorer** command to hide/show the
    file tree. Saving reformats the document first, for the languages that
    have a formatter (JavaScript/TypeScript, JSON, HTML, SQL, Markdown).
  ```

- **[TODO.md:23-25](TODO.md#L23)** — the `## High` *Format-on-save* bullet is
  deleted, matching how Loom retires a backlog entry when its feature lands
  (commit `3e7329a`, *Document the breadcrumb band and retire its TODO
  entry*).

- **[TODO.md:46](TODO.md#L46)** — the *Transition hard-coded settings* entry's
  `* Format-on-save` sub-item becomes:

  ```markdown
  * Format-on-save — the `FORMAT_ON_SAVE` constant at the top of
    [`src/EditorController.ts`](src/EditorController.ts)
  ```

---

## Potential Challenges

- **Prettier runs on its own defaults, not the project's.** The library builds
  its Prettier formatters with a parser id and plugins only
  ([formatters/prettier.ts:33](node_modules/@jimka/typescript-ui/src/typescript/lib/component/editor/formatters/prettier.ts#L33)),
  so no `.prettierrc` is read. Saving a file written in another style — Loom's
  own 4-space, semicolon-free TypeScript, for one — rewrites it to Prettier's
  defaults. Mitigation: this is exactly what the `FORMAT_ON_SAVE` toggle is
  for, and README's new sentence tells the user the feature exists.
- **A failed write leaves the document formatted.** `formatBeforeSave` runs
  before `writeFileText`, and nothing undoes the reformat if the write then
  fails. Mitigation: the file stays dirty and the `Dialog.error` still
  appears, so no work is lost — the buffer simply holds formatted text at the
  next attempt.
- **Typing during the formatter's first run can be lost.** `format()` reads
  the document after its dynamic `import()` of Prettier resolves, then
  replaces the whole document when the formatter returns; a keystroke landing
  inside that second window is overwritten. Mitigation: none — this is the
  library's own behaviour, identical under the manual *Format Document*
  action, and it is the same class of save-time overwrite
  `file-editor-dirty-state-adoption.md` already records as out of scope.
- **Two dirty-state notifications per save.** The format dispatch marks the
  editor dirty and `markClean()` clears it moments later, so the tab relabels
  twice. Mitigation: none needed — both relabels are the existing relay doing
  its job, and the dirty label between them is not painted long enough to see.

---

## Critical Files

- [src/EditorController.ts](src/EditorController.ts) — every site this plan
  touches: `SAVE_MESSAGE_DURATION_MS` ([:24](src/EditorController.ts#L24)),
  `saveAs` ([:407](src/EditorController.ts#L407)), `save`
  ([:446](src/EditorController.ts#L446)), `saveDialogDefault`
  ([:479](src/EditorController.ts#L479)) — **the precedent for a small private
  helper computing one decision for the save flow** — and `formatActive`
  ([:510](src/EditorController.ts#L510)), which must not change.
- [src/editor/languages.ts:56-58](src/editor/languages.ts#L56) —
  `isMarkdownPath`, **the precedent `hasFormatter` mirrors**: a one-line
  language predicate exported from this module and unit-tested as a pure
  function.
- [tests/languages.test.ts](tests/languages.test.ts) — the file the new cases
  join, and the proof that importing `src/editor/languages.ts` under the node
  test environment populates the library's registry.
- [node_modules/@jimka/typescript-ui/src/typescript/lib/component/editor/CodeEditor.ts:532-583](node_modules/@jimka/typescript-ui/src/typescript/lib/component/editor/CodeEditor.ts#L532)
  — `format()` and its `reindentFallback()` branch. Read both: which branch
  runs depends on the language's `loadFormatter`, and the formatter branch
  replaces the document only after the formatter resolves, so a throw leaves
  the document exactly as it was.
- [node_modules/@jimka/typescript-ui/src/typescript/lib/component/editor/CodeEditor.ts:397-399](node_modules/@jimka/typescript-ui/src/typescript/lib/component/editor/CodeEditor.ts#L397)
  — `getLanguage()`, the synchronous id read `formatBeforeSave` passes to
  `hasFormatter`.
- [node_modules/@jimka/typescript-ui/src/typescript/lib/component/editor/LanguageRegistry.ts:28-61](node_modules/@jimka/typescript-ui/src/typescript/lib/component/editor/LanguageRegistry.ts#L28)
  — `LanguageDefinition.loadFormatter` (optional) and `getLanguage`, both
  re-exported from the `component/editor` barrel Loom already imports.
- [src/editor/FileEditor.ts:203-224](src/editor/FileEditor.ts#L203) —
  `setPath` and `getEditor`, showing that the wrapped editor's language is set
  from the path at construction and re-set on every `setPath`, and never
  anywhere else.
- [plans/implemented/file-editor-dirty-state-adoption.md](plans/implemented/file-editor-dirty-state-adoption.md)
  — the dirty-state contract this plan must not disturb: `markClean()` accepts
  whatever the document holds when the write resolves, and `saveAs`'s
  `setPath` → `markClean` order is load-bearing.
- [plans/implemented/untitled-files.md](plans/implemented/untitled-files.md) —
  why `save` delegates to `saveAs` on a null path, and why a path-less buffer
  has no language until its first save completes.
- [vitest.config.ts](vitest.config.ts) — records that component behaviour is
  verified live rather than in the suite, which is why only `hasFormatter` is
  unit-tested here.

---

## Non-Goals

- **No settings file.** The toggle stays a hardcoded constant. Building the
  global/per-session settings system is TODO.md's own separate entry, and this
  plan's job toward it is to leave one named, greppable constant to migrate.
- **No user-facing control.** No menu item, no checkbox, no per-file or
  per-language opt-out. Changing the behaviour means editing the constant and
  restarting.
- **No project formatter config.** `.prettierrc`, `.editorconfig` and friends
  are not read; the library's formatters take no options and this plan adds
  none.
- **No formatters for CSS or Python.** Registering one is a change to
  `src/editor/languages.ts`'s registrations, unrelated to when formatting
  runs.
- **No format on the first save of an untitled buffer.** Formatting it would
  mean moving `setPath` ahead of the write so the editor knows its language,
  which changes what a *failed* write leaves behind. The second save formats
  it, which is enough.
- **No change to the manual *Format Document* action**, including its
  unhandled rejection when a formatter throws — `EditorShell` calls it as
  `void controller.formatActive()` ([:96](src/shell/EditorShell.ts#L96)) today
  and still will.
- **No library changes.** `@jimka/typescript-ui` is used exactly as shipped.
- **No new test harness.** The vitest suite stays node-only over pure helpers.

---

## Notes

[^toggle-home]: Two homes were considered. A new `src/settings.ts` module was
    rejected: it would be a settings system with one entry and no loader,
    pre-empting the design of the real one and giving the migration plan a
    file to delete rather than a constant to move. Module scope in
    `src/EditorController.ts` is where every other Loom tunable lives —
    `SAVE_MESSAGE_DURATION_MS` and `TAB_MAX_WIDTH` in this same file,
    `PREVIEW_REFRESH_DEBOUNCE_MS` in `src/editor/FileEditor.ts`,
    `SESSION_SAVE_DEBOUNCE_MS` in `src/shell/session.ts` — each a documented
    `const` in the module that reads it. `EditorController` is the right
    module because it owns the save commands; its own class JSDoc calls it the
    owner of "every editor command (open/save/close/format)". The constant is
    deliberately not exported: nothing outside the file reads it, and an
    export would invite the scattered conditionals this shape exists to
    prevent.

[^skip-reindent]: `format()` dispatches on the language's `loadFormatter`. With
    one, it replaces the document with the formatter's output; without one, it
    calls `reindentFallback()`, which runs `indentRange(state, 0, doc.length)`
    over the whole document. For a language whose grammar defines
    `indentNodeProp` — both `@codemirror/lang-css` and
    `@codemirror/lang-python` do — that rewrites the leading whitespace of
    every line CodeMirror has an opinion about. Python's indentation carries
    meaning, so a silent whole-file re-indent on every Ctrl+S is a genuine
    risk of changing what the program does, and the user never asked for it.
    For a document with no language at all the fallback happens to be inert:
    `getIndentation` consults the syntax tree, an empty tree yields `null`,
    and `indentRange` skips every line whose indentation is `null`
    (`@codemirror/language/dist/index.js:869-885`). Gating on `hasFormatter`
    covers both cases with one check rather than relying on that inertness.

[^id-not-path]: `languageForPath` and `isMarkdownPath` both take a path, and
    `hasFormatter` could have too — the editor's language is always
    `languageForPath` of its own path, set in `FileEditor`'s constructor and
    re-set by `setPath`, with no other caller of `setLanguage` anywhere in
    Loom. Taking the id instead removes the need to depend on that
    correspondence holding: `formatBeforeSave` asks the editor what language it
    is about to format under, and `format()` then reads the same field. In
    `saveAs` the difference is visible — the editor's language belongs to the
    old path, since `setPath(target)` runs after the write — and asking the
    editor is what makes the guard agree with what actually happens.

[^throw-degrades]: Three responses to a throwing formatter were weighed.
    Aborting the save was rejected outright: a formatter throws precisely when
    the source is syntactically invalid, which is the normal state of a file
    being edited, and refusing to save then loses the user's work for a reason
    they did not ask about. A `Dialog.error` was rejected as intolerable
    noise — it would interrupt Ctrl+S every time a file is saved mid-thought.
    Complete silence was rejected because format-on-save would then appear to
    have simply stopped working with no way to tell why. Folding the fact into
    the status message that the save already shows costs one boolean and one
    small helper, and it cannot be missed or overwritten: the alternative of
    posting a separate `setMessage` before the write would be replaced by the
    `Saved …` message microseconds later. The `(not formatted)` suffix is not
    shown for a language with no formatter — that is the expected, silent case
    for every `.py`, `.css` and `.txt` file, and annotating it would make the
    message noisy on most saves.

[^saveas-ordering]: Three orderings were possible in `saveAs`, and only one
    survives. Formatting before `pickSaveTarget` would reformat the document
    even when the user cancels the dialog, which turns a cancelled save into
    an unrequested edit. Formatting after `writeFileText` would write the
    unformatted bytes and leave the buffer disagreeing with the file. Between
    the two is the only place that reformats exactly what is about to be
    written. Keeping `setPath` after the write matters for a different reason:
    `file-editor-dirty-state-adoption.md` pinned the `setPath` → `markClean`
    order because the listener `markClean` may fire reads `getLabel()`, and
    moving `setPath` ahead of the write would additionally rename the tab and
    repoint the breadcrumbs even when the write then fails. The cost of
    leaving it alone is the untitled-first-save row in the decisions table:
    the editor has no language yet, so nothing is formatted that once.

---

## Implementation Notes

- **`node_modules/@jimka/typescript-ui` needed re-pointing at the sibling
  checkout.** A plain `npm install` in this fresh worktree pulled the published
  `0.8.0` package from the registry, which lags the local
  `../typescript-ui/packages/lib` checkout the main tree symlinks to (`isDirty`,
  `markClean`, `onDirtyChange`, `setTabName` and `TabCloseController` are all
  missing from the published version, failing typecheck on lines this plan
  never touches). Fixed with
  `ln -s /home/jika/typescript/typescript-ui/packages/lib node_modules/@jimka/typescript-ui`
  after install, mirroring the main tree's own symlink — the same recurring
  dev-environment gap `welcome-screen.md` and `recent-projects.md` already
  record.
- **The plan's own step-10/Verification grep counts undercount by design.**
  `grep -rn 'FORMAT_ON_SAVE' src/` and `grep -rn '\.format()' src/` return more
  than the "exactly two" the plan predicts, because the doc comments this
  plan's own Internal Structure specifies (`formatBeforeSave`'s JSDoc, and
  `hasFormatter`'s) mention both identifiers in prose. The underlying
  invariant — one constant with one guard site, and two real `.format()` call
  sites (`formatActive`, `formatBeforeSave`) — holds; only the literal grep
  match count is off, which is a pre-existing imprecision in the plan's
  wording rather than a defect in the implementation.
- **Manual verification (the plan's `## Expected Behaviour` cases 1, 3, 4, 6)
  was executed live, against an isolated display, not the user's desktop.**
  `npm run tauri:dev` was launched with `DISPLAY` unset from the ambient
  session at first, which briefly rendered the real window on the user's live
  X server (`172.22.32.1:0`) before this was noticed; it was killed
  immediately, with no synthetic input ever sent to it and no trace left
  behind (confirmed by querying that display's window tree afterward). All
  further runs isolated the app: an `Xvfb` inside a throwaway Docker container
  (`debian:bookworm-slim`, the user's own Docker daemon, no `sudo` needed),
  TCP-listening and port-mapped to `127.0.0.1:6098`; `npm run tauri:dev` was
  then relaunched with `DISPLAY=127.0.0.1:98`, `GDK_BACKEND=x11` (forcing X11
  over the ambient Wayland session), and fresh `XDG_CONFIG_HOME`/
  `XDG_DATA_HOME` scratch directories, so neither the display nor the app's
  own session/recent-projects config (`~/.config/loom/session.json`, shared
  with the user's real usage) was touched again — confirmed by the file's
  unchanged mtime across the whole rest of the session. All file operations
  were pointed at a scratch project folder under `$HOME`
  (`~/loom-format-on-save-verify`, required by the fs plugin's `$HOME/**`
  scope — a folder under `/tmp` was tried first and is outside it), driven
  with `python-xlib`'s XTEST extension (no `xdotool` in this sandbox) for
  clicks/keys and raw `X.ZPixmap`/`get_image` for screenshots.

  Four cases were driven and confirmed by screenshot plus the written file's
  actual bytes: case 1 (a messy `.ts` file reformats to Prettier's output on
  Ctrl+S, status bar reads `Saved messy.ts`, disk matches); case 3 (`const x
  = (` still saves exactly as typed, status bar reads `Saved broken.ts (not
  formatted)` — the plan's own flagged least-obvious case); case 4 (a `.py`
  file's odd 8-space indentation and a one-line `.css` rule both survive a
  save unchanged, with a plain `Saved <name>` and no suffix); and case 6 (a
  New File buffer's first save, via Save As to `scratch.ts`, writes the
  pasted text unformatted since the editor has no language yet, while its
  second save — now that the language is known — reformats it) — the plan's
  other flagged least-obvious case. Cases 2, 5, 7-12 were not driven live:
  2 and 10 exercise the same `formatBeforeSave` call already proven correct
  from a different entry point; 5 is the same no-formatter path already
  confirmed by cases 4's two languages; 7-8 touch `formatActive`, which this
  plan does not change; 9 and 11-12 were judged lower-value against the setup
  cost of a further build/relaunch cycle. The container, scratch project
  folder, and `XDG_*` scratch directories were removed afterward; nothing
  from this verification persists outside this note.
