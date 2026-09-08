---
touches-shared: [src/shell/CommandPalette.ts, src/shell/commands.ts, README.md, TODO.md]
---

# Command Palette Disabled Rows — Implementation Plan

## Overview

The menu bar greys out a command that can't run right now: *Save*, *Save As…*, *Close File*,
*Find…* and *Format Document* each carry an `enabled:` flag computed from the shell's own
predicates ([src/shell/EditorShell.ts:508-520](src/shell/EditorShell.ts#L508)). The command
palette's `>` mode makes the same commands **vanish** instead —
[`buildPaletteCommands`](src/shell/commands.ts#L54) wraps them in
`if (actions.canSaveActive())` ([src/shell/commands.ts:62](src/shell/commands.ts#L62)) and
`if (actions.hasActiveFile())` ([src/shell/commands.ts:66](src/shell/commands.ts#L66)), so
searching for `>save` with no file open finds nothing at all.

This plan makes the palette match the menu bar. `PaletteCommand` gains a required `enabled:
boolean`; `buildPaletteCommands` returns all eleven commands every time, each carrying the
same expression the matching menu-bar item uses; and `CommandPalette.renderResults` copies
that flag onto the row it builds. The library's `List` does the rest — a
`SelectableListItem` carrying `enabled: false` renders dim, refuses a click and an
Enter/Space commit, and is skipped by arrow-key navigation, all already implemented in
`AbstractSelectableList`.[^library-ready]

One further change keeps the palette's Enter-activates-the-top-result behaviour intact.
[`setResults`](src/shell/CommandPalette.ts#L169) seeds the highlight on row 0; with disabled
rows in the list it seeds the first *enabled* row instead, so the highlight never rests where
`Enter` would do nothing.

---

## Architecture Decisions

### The enabled flag rides on the item, not on a post-construction setter

Each row's state is set through the `enabled` field of the `SelectableListItem` passed to
`setItemsArray`. The palette does not call the library's `setItemEnabled`.[^item-not-setter]

### Both surfaces keep calling the same `MenuBarActions` predicates

`MenuBarActions` ([src/shell/EditorShell.ts:58](src/shell/EditorShell.ts#L58)) already is the
single source of truth: `hasActiveFile` and `canSaveActive` are one controller method each,
and `EditorShell` hands the very same `actions` object to `buildMenuBar`
([src/shell/EditorShell.ts:213](src/shell/EditorShell.ts#L213)) and to
`buildPaletteCommands` ([src/shell/EditorShell.ts:401](src/shell/EditorShell.ts#L401)). What
was missing is only that the palette *filtered* on those predicates instead of recording
them. No new registry or shared per-command table is introduced.[^no-registry]

Each palette command's `enabled` expression is therefore the expression its menu-bar twin
already uses:

| Palette command | `enabled` | Menu-bar item | Its `enabled` |
|---|---|---|---|
| Save | `actions.canSaveActive()` | File ▸ Save ([:508](src/shell/EditorShell.ts#L508)) | `actions.canSaveActive()` |
| Save As… | `actions.hasActiveFile()` | File ▸ Save As… ([:509](src/shell/EditorShell.ts#L509)) | `actions.hasActiveFile()` |
| Close File | `actions.hasActiveFile()` | File ▸ Close File ([:510](src/shell/EditorShell.ts#L510)) | `actions.hasActiveFile()` |
| Find… | `actions.hasActiveFile()` | Edit ▸ Find… ([:518](src/shell/EditorShell.ts#L518)) | `actions.hasActiveFile()` |
| Format Document | `actions.hasActiveFile()` | Edit ▸ Format Document ([:520](src/shell/EditorShell.ts#L520)) | `actions.hasActiveFile()` |
| New File, Open Folder…, Toggle Explorer, Exit, the two Show/Hide toggles | `true` | the matching items ([:499](src/shell/EditorShell.ts#L499), [:500](src/shell/EditorShell.ts#L500), [:525](src/shell/EditorShell.ts#L525), [:515](src/shell/EditorShell.ts#L515), [:527](src/shell/EditorShell.ts#L527), [:534](src/shell/EditorShell.ts#L534)) | no `enabled` field — always on |

`enabled` is **required**, not optional, so a command added later cannot silently default to
available.

### The seeded highlight lands on the first row that can be activated

`setResults` replaces `setFocusedIndex(0)` with `setFocusedIndex(items.findIndex(item =>
item.enabled !== false))`. `findIndex` returns `-1` when no row qualifies, and
`setFocusedIndex` reads an out-of-range index as "no row", which is the same cleared
highlight an empty result set already produces.[^first-enabled]

| Rows, in ranked order | Highlight seeded on | Why |
|---|---|---|
| `New File`, `Save` (disabled) | row 0, `New File` | row 0 is enabled |
| `Save` (disabled), `Save As…` (disabled), `Show Hidden Files` | row 2, `Show Hidden Files` | the first two are disabled |
| `Save` (disabled), `Save As…` (disabled) | nothing | `findIndex` returns `-1` |
| `src/alpha.ts`, `src/beta.ts` (file mode) | row 0 | file rows carry no `enabled`, so `enabled !== false` holds |

### Activation is refused by the library, not re-checked in `handleCommit`

Nothing is added to [`handleCommit`](src/shell/CommandPalette.ts#L208). The library refuses
the gesture before any `"action"` event fires, so `handleCommit` is never reached for a
disabled row.[^no-double-guard]

---

## Public API

`src/shell/commands.ts` — `PaletteCommand` gains one required field; nothing else changes
shape. `buildPaletteCommands`'s signature is unchanged.

```typescript
export interface PaletteCommand {
    id: string
    title: string
    shortcut?: string
    /** Whether the command can run right now; `false` renders the palette row dim and inert. */
    enabled: boolean
    run: () => void
}

export function buildPaletteCommands(actions: PaletteCommandActions): PaletteCommand[]
```

Each has exactly one importer — `PaletteCommand` in
[src/shell/CommandPalette.ts:12](src/shell/CommandPalette.ts#L12), `buildPaletteCommands` in
[src/shell/EditorShell.ts:13](src/shell/EditorShell.ts#L13) — and neither call site needs a
change.

---

## Internal Structure

`buildPaletteCommands`' new body, replacing everything from
[src/shell/commands.ts:55](src/shell/commands.ts#L55) to the closing brace at line 85. The
display order is exactly today's order when every command is available; the two `if` blocks
are gone.

```typescript
    // Read once so every command below is built against one consistent
    // snapshot of the shell's state.
    const hasActiveFile = actions.hasActiveFile()
    const canSaveActive = actions.canSaveActive()

    return [
        { id: 'new-file',        title: 'New File',        shortcut: NEW_FILE_SHORTCUT,        enabled: true,          run: actions.onNewFile },
        { id: 'open-folder',     title: 'Open Folder…',    shortcut: OPEN_FOLDER_SHORTCUT,     enabled: true,          run: actions.onOpenFolder },
        { id: 'toggle-explorer', title: 'Toggle Explorer', shortcut: TOGGLE_EXPLORER_SHORTCUT, enabled: true,          run: actions.onToggleExplorer },
        { id: 'exit',            title: 'Exit',            shortcut: EXIT_SHORTCUT,            enabled: true,          run: actions.onExit },
        { id: 'save',            title: 'Save',            shortcut: SAVE_SHORTCUT,            enabled: canSaveActive, run: actions.onSave },
        { id: 'save-as',         title: 'Save As…',        shortcut: SAVE_AS_SHORTCUT,         enabled: hasActiveFile, run: actions.onSaveAs },
        { id: 'close-file',      title: 'Close File',      shortcut: CLOSE_FILE_SHORTCUT,      enabled: hasActiveFile, run: actions.onCloseFile },
        { id: 'find',            title: 'Find…',           shortcut: FIND_SHORTCUT,            enabled: hasActiveFile, run: actions.onFind },
        { id: 'format-document', title: 'Format Document', shortcut: FORMAT_SHORTCUT,          enabled: hasActiveFile, run: actions.onFormat },
        {
            id: 'toggle-hidden-files',
            title: actions.isShowingHidden() ? 'Hide Hidden Files' : 'Show Hidden Files',
            enabled: true,
            run: () => actions.onToggleHidden(!actions.isShowingHidden()),
        },
        {
            id: 'toggle-ignored-files',
            title: actions.isShowingIgnored() ? 'Hide Ignored Files' : 'Show Ignored Files',
            enabled: true,
            run: () => actions.onToggleIgnored(!actions.isShowingIgnored()),
        },
    ]
```

`setResults`' new body, replacing
[src/shell/CommandPalette.ts:169-172](src/shell/CommandPalette.ts#L169):

```typescript
    private setResults(items: SelectableListItem[]): void {
        this._resultsList.setItemsArray(items)
        // `findIndex` yields -1 when every row is disabled (or there are no
        // rows); `setFocusedIndex` reads an out-of-range index as "no row",
        // clearing the highlight.
        this._resultsList.setFocusedIndex(items.findIndex(item => item.enabled !== false))
    }
```

---

## Ordered Implementation Steps

1. **Check the library half is already built.** The `enabled` field reaches this repository
   through the library's emitted types, not its source:
   - `ls -l node_modules/@jimka/typescript-ui` — must be a symlink into a
     `typescript-ui` checkout's `packages/lib`. A `npm install` in this worktree replaces it
     with the published registry tarball; re-point it if so.
   - `grep -n 'enabled' node_modules/@jimka/typescript-ui/dist/lib/types/component/list/AbstractSelectableList.d.ts`
     — expect a hit on `enabled?: boolean;` inside `SelectableListItem` **and** on
     `setItemEnabled`. **Stop here if either is missing**: nothing below typechecks, and the
     gap belongs upstream. (Both were present when this plan was written; no library change
     is needed.)

2. **`src/shell/commands.ts` — add the `enabled` field to `PaletteCommand`** immediately
   after `shortcut?: string` ([src/shell/commands.ts:16](src/shell/commands.ts#L16)) and
   before the `run` doc comment, with the doc comment from `## Public API` expanded to say
   that `false` renders the row dim and refuses a click or an Enter commit, the same
   treatment the matching menu-bar item gets.

3. **`src/shell/commands.ts` — replace `buildPaletteCommands`' body** with the block from
   `## Internal Structure`. Both `if` statements go; the `commands` local goes; the function
   becomes two `const` reads and one `return`.
   *Check:* `grep -c 'if (' src/shell/commands.ts` — expect `0`.
   *Check:* `grep -c "id: '" src/shell/commands.ts` — expect `11`.

4. **`src/shell/commands.ts` — update the two stale comments.** The file header (lines 1-3)
   says the list is "filtered rather than greyed out (the library's List has no per-row
   disabled state; see TODO.md)"; replace it with a line saying every command is always
   listed, each carrying the same enabled flag the matching menu-bar item computes.
   `buildPaletteCommands`' JSDoc (lines 47-53) says it leaves "out any that would show
   disabled in the menu bar"; replace that clause and the `@returns` line to describe the new
   contract.
   *Check:* `grep -in 'no per-row disabled state\|leaving out any' src/shell/commands.ts` —
   expect zero matches (both are verbatim fragments of the text being replaced).

5. **`src/shell/CommandPalette.ts` — carry the flag onto the command row.** In
   `renderResults`' command-mode branch
   ([src/shell/CommandPalette.ts:128-131](src/shell/CommandPalette.ts#L128)), add
   `enabled: command.enabled,` after the `label:` line. Leave the `key:` and `label:` lines,
   the `setEmptyText('No matching commands')` call above them, and the whole file-mode branch
   untouched.

6. **`src/shell/CommandPalette.ts` — seed the highlight on the first enabled row.** Replace
   `setResults`' body with the block from `## Internal Structure`, and update its JSDoc
   (lines 160-168) so "highlights the first one" becomes "highlights the first one that can
   be activated", noting that a list whose every row is disabled leaves nothing highlighted.
   *Check:* `grep -n 'setFocusedIndex' src/shell/CommandPalette.ts` — exactly one match,
   inside `setResults`.

7. **`src/shell/CommandPalette.ts` — update the class JSDoc** (lines 31-43). It describes
   `>` mode as "a fixed list of app commands"; add that a command that can't run right now is
   listed greyed out and refuses activation, matching the menu bar. Do not weaken the
   existing "Nothing opens or runs while browsing the list" sentence.

8. **Create `tests/commands.test.ts`** covering every row of `## Expected Behaviour` ›
   *Unit-testable*. Follow [tests/shortcuts.test.ts](tests/shortcuts.test.ts)'s shape: a
   module-level factory that builds a `PaletteCommandActions` with every predicate `false`
   and every callback a no-op, overridable per test with a `Partial`; one `describe`; one
   sentence-shaped `it` per case. Import `buildPaletteCommands` as a value and
   `PaletteCommandActions` / `PaletteCommand` as types. Case 9 needs a `vi.fn()` passed as
   the `onSave` override; every other case reads returned data only.
   *Check:* `npm test` — the new block passes, every existing test untouched.

9. **`README.md` — amend the Command palette bullet** (lines 35-40). The final sentence,
   "Typing `>` switches to a list of app commands — Save, Format Document, Toggle Explorer,
   and the rest of the menu bar — instead", gains a clause saying a command that can't run
   right now (Save with nothing to save, Find… with no file open) is listed greyed out and
   does nothing when activated, just as in the menu bar.

10. **`TODO.md` — delete this item's backlog entry.** Remove the five-line bullet at
    [TODO.md:17-21](TODO.md#L17) ("**Wire up `List` row-level enabled/disabled state for the
    command palette.**"), leaving the surrounding `## High` bullets untouched.
    *Check:* `grep -in 'command palette' TODO.md` — expect zero matches.

11. **Run `## Verification`,** including the manual cases.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src/shell/commands.ts` |
| Modify | `src/shell/CommandPalette.ts` |
| Create | `tests/commands.test.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Unit-testable — `tests/commands.test.ts`

`buildPaletteCommands` is a pure function over a plain object of callbacks and imports only
`./shortcuts`, which touches no DOM at load. It runs in the repository's node-environment
vitest harness as-is.

| # | `hasActiveFile()` / `canSaveActive()` | Assertion |
|---|---|---|
| 1 | `false` / `false` | Returns 11 commands whose `id`s, in order, are `new-file`, `open-folder`, `toggle-explorer`, `exit`, `save`, `save-as`, `close-file`, `find`, `format-document`, `toggle-hidden-files`, `toggle-ignored-files`. |
| 2 | `true` / `true` | Returns the same 11 ids in the same order — the list's length and order never depend on the predicates. |
| 3 | `false` / `false` | `save`, `save-as`, `close-file`, `find`, `format-document` all have `enabled === false`. |
| 4 | `false` / `false` | `new-file`, `open-folder`, `toggle-explorer`, `exit`, `toggle-hidden-files`, `toggle-ignored-files` all have `enabled === true`. |
| 5 | `true` / `false` | `save` has `enabled === false`; `save-as`, `close-file`, `find`, `format-document` all have `enabled === true`. (A clean active file — the state where the File menu greys out *Save* alone.) |
| 6 | `true` / `true` | `save` has `enabled === true`. |
| 7 | `isShowingHidden()` `false` then `true` | `toggle-hidden-files`' `title` is `Show Hidden Files`, then `Hide Hidden Files`. |
| 8 | `isShowingIgnored()` `false` then `true` | `toggle-ignored-files`' `title` is `Show Ignored Files`, then `Hide Ignored Files`. |
| 9 | `false` / `false` | Calling the `save` command's `run` invokes the `onSave` callback — a disabled command still carries a working `run`; refusing it is the list's job, not the builder's. |

Cases 7 and 8 pin behaviour that already exists; they guard the toggles while the array
around them is rewritten.

### Manual verification — the Tauri window (`npm run tauri:dev`)

Loom's harness is node-environment with no DOM and no library components under test, so every
row-rendering and keyboard case is verified live, the split
[vitest.config.ts](vitest.config.ts) records and every prior palette plan followed. Use a
project with several files across two directories.

1. **Unavailable commands are listed, greyed.** With no file open, Ctrl/Cmd+P then `>`: all
   eleven commands appear. *Save*, *Save As…*, *Close File*, *Find…* and *Format Document*
   render dim; the other six render normally. This is the success criterion — those five used
   to be absent.
2. **The menu bar agrees.** In the same state, open the File and Edit menus: exactly the same
   five items are greyed there.
3. **Clicking a dim row does nothing.** Click *Format Document* in case 1: no command runs,
   nothing is selected, and the palette stays open.
4. **Enter on a dim row does nothing.** Type `>save` in case 1 so only *Save* and *Save As…*
   match: both are dim, **nothing is highlighted**, and `Enter` runs nothing and leaves the
   palette open. `Escape` still closes it.
5. **The highlight skips dim rows.** In case 1's full `>` list, arrow down to *Exit* (the
   last enabled row before the dim run), then press `ArrowDown` once more: the highlight
   jumps past all five dim rows to *Show Hidden Files*, never resting on a dim row. `ArrowUp`
   from there walks straight back to *Exit*.
6. **The first enabled row is highlighted on open.** In case 1, *New File* carries the
   highlight as soon as `>` is typed, and `Enter` opens a new untitled tab.
7. **Opening a file re-enables the per-file commands.** Open a file, reopen the palette, type
   `>`: *Save As…*, *Close File*, *Find…* and *Format Document* are no longer dim, and
   *Find…* opens the find bar from the palette.
8. **Save alone stays dim on a clean file.** With a saved, unmodified file active, `>` shows
   *Save* dim while *Save As…*, *Close File*, *Find…* and *Format Document* are normal. Type
   one character into the editor, reopen the palette: *Save* is now normal and `Enter` on it
   saves.
9. **File mode is unchanged.** Ctrl/Cmd+P with no `>`: results are ranked as before, the
   first row is highlighted, `Enter` opens it, and no row renders dim.
10. **The `>` list length no longer tracks app state.** Count the rows in `>` mode with no
    file open and again with a modified file open: eleven both times, in the same order.

---

## Verification

- `npm run typecheck` — clean. A `Property 'enabled' is missing` error on a `PaletteCommand`
  literal means step 3 missed a command; a `SelectableListItem` error on `enabled` means
  step 1's library check was skipped.
- `npm test` — clean, with the new `tests/commands.test.ts` block passing.
- `npm run build` — clean.
- `grep -c "id: '" src/shell/commands.ts` — `11`.
- `grep -c 'if (' src/shell/commands.ts` — `0`.
- `grep -n 'setFocusedIndex' src/shell/CommandPalette.ts` — exactly one match, inside
  `setResults`.
- `grep -n 'setItemEnabled' src/` — zero matches (the flag rides on the item).
- `grep -in 'command palette' TODO.md` — zero matches.
- `git status --short` — the five files in the table above (`tests/commands.test.ts`
  untracked), plus this plan file itself.
- Manual: `npm run tauri:dev`, then cases 1-10. Cases 1-5, 7, 8 and 10 pin the change; cases
  6 and 9 guard what already worked.

---

## Documentation Impact

- **[README.md](README.md)** — step 9 amends the existing *Command palette* bullet. No other
  bullet describes `>` mode.
- **[TODO.md](TODO.md)** — step 10 retires this item's own `## High` entry, matching how
  every prior plan retired its backlog bullet.
- **In-file comments** — `src/shell/commands.ts`'s header and `buildPaletteCommands`' JSDoc
  both assert the old filtering contract and are corrected in step 4;
  `CommandPalette`'s class JSDoc and `setResults`' JSDoc in steps 6 and 7.
- Loom has no `docs/` tree and no generated API reference. The library's own *Disabled rows*
  documentation
  (`/home/jika/typescript/typescript-ui/packages/lib/docs/components/List.md`) already covers
  the `enabled` field and needs nothing.

---

## Potential Challenges

- **A stale library build.** `@jimka/typescript-ui` is consumed as built output, so the
  `enabled` field must be present in `dist/lib/types`. Step 1 checks it before any edit.
- **Reaching for `setItemEnabled` in a loop.** The backlog entry's wording ("nothing in
  `CommandPalette.ts` calls the new API yet") invites it. The item field is the right seam;
  see the decision above and its footnote.
- **Forgetting `enabled` on the row map.** Setting the flag on `PaletteCommand` alone changes
  nothing visible — step 5's one-line addition in `renderResults` is what reaches the list.
  If case 1 shows all eleven rows but none dim, that line is missing.
- **Assuming the file-mode rows need a flag.** They don't: `SelectableListItem.enabled` is
  optional and the list treats an absent flag as enabled. Adding `enabled: true` to file rows
  is noise.
- **A dim first row would break Enter.** Only if step 6 is skipped: `setFocusedIndex(0)` would
  seed the highlight onto a disabled row, and the palette's "Enter activates the top result"
  promise would silently stop holding for `>` queries whose best match is unavailable.
- **Enabled state is a snapshot taken when the palette opens**, not live. That matches the
  menu bar, whose `items:` provider recomputes per open
  ([src/shell/EditorShell.ts:495](src/shell/EditorShell.ts#L495)), and nothing in the app
  changes `hasActiveFile`/`canSaveActive` while the palette is showing.

---

## Critical Files

| File | Why |
|---|---|
| [src/shell/commands.ts](src/shell/commands.ts) | The filtering this plan removes. Read `PaletteCommand` (9-19), `PaletteCommandActions` (29-45), and the two `if` blocks (62-71). |
| [src/shell/CommandPalette.ts](src/shell/CommandPalette.ts) | Read the command-mode branch of `renderResults` (124-134), `setResults` (169-172), `handleKeyDown` (194-205), `handleCommit` (208-222), and the constructor's `setSelectFollowsFocus(false)` / `setFocusOnRowClick(false)` pair (58-59). |
| [src/shell/EditorShell.ts](src/shell/EditorShell.ts), `buildMenuBar` (495-558) | **The precedent.** Every `enabled:` expression this plan copies lives at lines 508-520; `MenuBarActions` (58-87) is the shared predicate surface both callers read. |
| `/home/jika/typescript/typescript-ui/packages/lib/docs/components/List.md`, *Disabled rows* section | The library contract relied on: dim rendering, refused click and Enter/Space, skipped by arrow navigation, key and index preserved. |
| `node_modules/@jimka/typescript-ui/dist/lib/types/component/list/AbstractSelectableList.d.ts` | Where step 1 confirms `SelectableListItem.enabled` actually reached this repository. |
| [tests/shortcuts.test.ts](tests/shortcuts.test.ts) | The shape `tests/commands.test.ts` copies — a module-level factory for the input object, one `describe`, sentence-shaped `it` names. |
| [vitest.config.ts](vitest.config.ts) | States the node-environment / verify-DOM-behaviour-live split this plan's manual cases follow. |

---

## Non-Goals

- **No change to which commands `>` mode offers.** *Open Recent*, *Open Settings*, *Open
  Workspace Settings*, *Command Palette…* and *About* are absent from the palette today and
  stay absent; adding them is a separate decision about what belongs in the palette.
- **No ranking change.** A disabled command is scored and ordered by `filterAndRankFuzzy`
  exactly like an enabled one. Sinking disabled rows to the bottom would reorder results as
  the app's state changes, which the menu bar does not do either.
- **No re-check of `enabled` inside `handleCommit`.** The library refuses the gesture first;
  a second check would be a second place to keep in sync.[^no-double-guard]
- **No live refresh while the palette is open.** The command list is built once per `open()`
  call, the same snapshot the menu bar takes per menu open.
- **No library change.** `AbstractSelectableList` already ships everything needed.
- **No `enabled` flag on file-mode rows.** Every file result is activatable.

---

## Implementation Notes

**Step 1's precondition held, after re-linking.** This worktree's `npm install` ran against a
clean `node_modules/` (each worktree has its own) and resolved the registry version
(`^0.8.0`); replacing `node_modules/@jimka/typescript-ui` with a symlink to
`/home/jika/typescript/typescript-ui/packages/lib` — matching the main tree's own symlink —
restored `enabled?: boolean` and `setItemEnabled` in
`dist/lib/types/component/list/AbstractSelectableList.d.ts`. `node_modules/` is untracked, so
no repository file changed.

**`npm test` has one pre-existing failing suite unrelated to this plan**, matching what
`plans/implemented/temp-tab-italic-styling.md`'s own Implementation Notes recorded for the
same batch. `tests/languages.test.ts` fails with `ReferenceError: document is not defined`,
thrown from `typescript-ui`'s `TextInput.ts` → `StyleTarget.ts` → `DOM.ts` chain during module
import, in the DOM-free `node` test environment (`vitest.config.ts`). Reproduces identically
with this branch's changes reverted (`git stash`), so it is drift in the sibling
`typescript-ui` checkout this tree's `node_modules` symlinks to, not something this branch
introduced or is in scope to fix. All 296 tests that do run (287 pre-existing plus the 9 new
`tests/commands.test.ts` cases) pass.

**Manual verification pass — live, in the sandboxed browser**, using the `npm run dev` +
chrome-devtools-MCP workaround the `loom-visual-qa-in-sandbox` recipe describes (this sandbox
has no display a real `npm run tauri:dev` window could attach to). `vite.config.ts` temporarily
gained `resolve.alias` entries redirecting `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-fs`,
`@tauri-apps/plugin-os`, `@tauri-apps/api/window`, and `@tauri-apps/api/path` to a scratch stub
module backing a small in-memory fake project (`README.md`, `src/alpha.ts`, `src/beta.ts`,
`docs/notes.md`) so file-mode search and "open a file" could be exercised too, not just command
mode — reverted afterward, never committed (`git diff vite.config.ts` is empty on the branch).

Unlike `plans/implemented/temp-tab-italic-styling.md` and
`plans/implemented/command-palette-first-item-focus.md`, none of this plan's ten manual cases
needed a real native dialog, real disk persistence, or an external file watcher, so all ten were
confirmed live rather than deferred to the user's own pass:

**Case 1** — with no file open, all eleven commands appeared in `>` mode in the plan's exact
order; *Save*, *Save As…*, *Close File*, *Find…*, and *Format Document* carried the library's
`.SelectableListRow.disabled` class (confirmed both via the DOM and a screenshot showing them
visibly dimmer than the other six). **Case 2** — the File menu showed *Save*, *Save As…*, and
*Close File* as `aria-disabled="true"`; the Edit menu showed *Find…* and *Format Document* the
same way — the identical five. **Case 3** — clicking the dim *Format Document* row left the
palette open, changed no row's state, and ran nothing. **Case 4** — `>save` matched only *Save*
and *Save As…*, both dim, neither carrying the `focused` class; `Enter` left the query and the
palette untouched; `Escape` then closed it. **Case 5** — arrowing down from *New File* three
times reached *Exit*; a fourth `ArrowDown` jumped the highlight straight to *Show Hidden Files*,
skipping all five dim rows; `ArrowUp` from there returned it to *Exit*. **Case 6** — opening `>`
put the `focused` class on *New File* immediately, and `Enter` opened a new `Untitled-1` tab.
**Case 7** — opening the fake project and double-clicking `src/alpha.ts` made *Save As…*,
*Close File*, *Find…*, and *Format Document* enabled in the palette (only *Save* stayed dim, a
clean file); running *Find…* from the palette opened CodeMirror's find bar over the active
editor. **Case 8** — on that same clean, on-disk `alpha.ts`, *Save* was dim while the other four
were normal; typing one character marked the tab dirty (`alpha.ts •`) and flipped *Save* to
enabled; narrowing to `>save` highlighted it first, and `Enter` wrote the edited text through
the stub filesystem, clearing the dirty marker and updating the reported file size. **Case 9** —
file mode was unaffected throughout: `ts` and `beta` queries ranked and highlighted results with
no row ever carrying `disabled`, and `Enter` on `beta` opened `src/beta.ts` in a new tab. **Case
10** — `>` mode listed the same eleven ids in the same order both with no file open and with a
clean file active, confirmed by re-reading the row list at each point above.

---

## Notes

[^library-ready]: Verified in the sibling checkout at
    `/home/jika/typescript/typescript-ui`. `SelectableListItem.enabled?: boolean` is declared
    at `packages/lib/src/typescript/lib/component/list/AbstractSelectableList.ts:60` and
    documented there as "renders dim, refuses clicks and Enter/Space, and is skipped by
    arrow-key navigation and type-ahead". The enforcement points are `handleRowClick`
    (guarded by `isItemEnabled` at line 1811), `handleRowDblClick` (line 1866),
    `commitFocusedRow` (line 2198 — the Enter/Space path), `nearestEnabledIndex` (line 2067,
    which every arrow/Home/End/Page key routes through), and the type-ahead filter (line
    2228). The dim rendering is the `.SelectableListRow.disabled` style rule, which sets
    `color` only; the row's glyph inherits it through `fill: currentColor`, and neither of
    the palette's renderers (`GlyphListItemRenderer` and the default label renderer) sets an
    explicit foreground colour that would override it. The emitted types the symlinked
    `node_modules/@jimka/typescript-ui` resolves to carry `enabled?: boolean` and
    `setItemEnabled` already, so no library work and no cross-repo ordering is involved —
    unlike `plans/implemented/command-palette-first-item-focus.md`, whose library half had to
    ship first.

[^item-not-setter]: `setItemEnabled(index, enabled)` exists for flipping one row's state
    *after* the item array is set, repainting just that row. The palette never has a row to
    flip: `renderResults` rebuilds the whole item array on every keystroke, so a loop of
    `setItemEnabled` calls after `setItemsArray` would recompute what the array already
    knows, need the enabled state carried alongside the array to index into, and reintroduce
    exactly the kind of second bookkeeping site `setResults` was created to avoid. The
    library resolves `item.enabled` inside `setItemsArray` and applies it as each pooled row
    binds, so the field is the cheaper and more direct seam.

[^no-registry]: A shared `Map<commandId, () => boolean>` consulted by both `buildMenuBar` and
    `buildPaletteCommands` was considered and rejected. The two surfaces do not share command
    identity: the menu bar has items the palette does not (*Open Recent*, *Open Settings*,
    *Open Workspace Settings*, *About*) and builds its rows as `MenuItemConfig` literals with
    no ids at all, so a registry would have to invent ids for menu items purely to key the
    table, and every menu item would gain a lookup where it currently has a one-call
    expression. That is a new pattern with no precedent in this repository, introduced to
    guard five predicate calls. `tests/commands.test.ts` cases 3-6 pin the palette side of
    each pairing instead, at a fraction of the cost.

[^first-enabled]: `List.setFocusedIndex` clamps: its body is
    `this._focusedIndex = idx >= 0 && idx < this._items.length ? idx : -1`, so `-1` is a
    supported "clear the mark" argument and not an error — the palette already relies on that
    today, passing `0` for an empty result set. Seeding row 0 unconditionally was rejected
    because the library's own navigation never lets the focus mark rest on a disabled row:
    `nearestEnabledIndex` skips them for every arrow, Home, End and Page key, and
    `handleNavigationKey` even enters an unfocused list at the nearest enabled row rather than
    at row 0. A seed that lands somewhere the arrow keys refuse to go would be the one place
    in the palette where `Enter` on the highlighted row does nothing.

[^no-double-guard]: `handleCommit` runs off the list's `"action"` event, which fires from
    `notifyUserChange` at the end of `handleRowClick` and `commitFocusedRow` — both of which
    return early on `!isItemEnabled(idx)` before reaching it. There is no path from a
    disabled row to `handleCommit`. A guard there would also have to decide whether to close
    the palette, inventing a behaviour question that the library's silent refusal does not
    raise: the panel simply stays open with nothing highlighted, which manual case 4 pins.
