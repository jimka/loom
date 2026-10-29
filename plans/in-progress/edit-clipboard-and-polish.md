---
depends-on: [typescript-ui-0-11-adoptions]
touches-shared: [src/shell/commands.ts, src/shell/EditorShell.ts, src/shell/shortcuts.ts, src/EditorController.ts, src/editor/FileEditor.ts, src/main.ts, tests/commands.test.ts, tests/shortcuts.test.ts, README.md, TODO.md]
---

# Edit Clipboard and Polish — Implementation Plan

## Overview

Five small adoptions of `@jimka/typescript-ui` features. Each part lands as its
own code commit, in this order:

1. **Edit › Cut and Edit › Copy**, plus matching command-palette entries, built
   on `CodeEditor.cut()` / `copy()` (library 0.9.0). They act on the active
   file's editor and are greyed out when it has no selection. **Paste is not
   added.** The library's `paste()` cannot read the clipboard inside Loom's
   Tauri window on Linux, so Paste is an open question for the user (see
   `## Open Questions`).
2. **`Theme.text.mutedColor`** (CSS variable `--ts-ui-text-muted-color`, on
   library `master`, unreleased) replaces the hardcoded `rgb(140, 140, 140)` in
   [src/explorer/SearchPanel.ts:32](src/explorer/SearchPanel.ts#L32),
   [src/explorer/PropertiesPanel.ts:20](src/explorer/PropertiesPanel.ts#L20) and
   [src/shell/WelcomeScreen.ts:37](src/shell/WelcomeScreen.ts#L37).
3. **`Card` keyed lazy page** (0.11.0) replaces the hand-rolled
   `ensurePreview` in [src/editor/FileEditor.ts:154](src/editor/FileEditor.ts#L154).
4. **`DialogConfig.role: 'alertdialog'`** (0.11.0) on the five prompts that
   interrupt with a decision.
5. **PageUp / PageDown** in the command palette's query field move the results
   list's highlight by a page, in
   [`CommandPalette.handleKeyDown`](src/shell/CommandPalette.ts#L201).

A docs commit then updates README.md and TODO.md.

---

## Architecture Decisions

### The approach follows the earlier library adoptions

Each part replaces Loom-side code, or a missing feature, with the library API
built for it, as
[plans/implemented/typescript-ui-0-11-adoptions.md](plans/implemented/typescript-ui-0-11-adoptions.md)
did. No new dependency, no new pattern. The specific precedent for each part is
named in its own decision below.

### Build against the linked library checkout

The implementer works in a worktree, runs `npm ci`, then replaces
`node_modules/@jimka/typescript-ui` with a symlink to
`/home/jika/typescript/typescript-ui/packages/lib`. `package.json` keeps
`"@jimka/typescript-ui": "^0.11.0"`; do not change it.[^linked-lib]

### Part 1 — Cut and Copy follow the Find… / Format Document path

Cut and Copy are wired exactly like *Find…*: a menu row and a palette command
call a `MenuBarActions` callback, which calls an `EditorController`
`…InActive()` method, which calls a `FileEditor` method, which calls the
`CodeEditor`. The precedent is *Find…*:
[EditorShell.ts:710](src/shell/EditorShell.ts#L710) →
[`EditorController.findInActive`](src/EditorController.ts#L1087) →
[`FileEditor.openFind`](src/editor/FileEditor.ts#L256).

New members, by layer:

| Layer | New member | Calls |
|---|---|---|
| `FileEditor` | `hasSelection()`, `cutSelection()`, `copySelection()` | `CodeEditor.getSelection()`, `cut()`, `copy()` |
| `EditorController` | `hasActiveSelection()`, `cutInActive()`, `copyInActive()` | the active `FileEditor`'s three members |
| `MenuBarActions` / `PaletteCommandActions` | `hasActiveSelection`, `onCut`, `onCopy` | the three controller methods |

### Part 1 — enablement is read when the menu or the palette opens

Cut and Copy are enabled when `hasActiveSelection()` is true. It is read live,
not tracked from `"selectionchange"`.[^live-enablement] The Edit menu's `items`
is already a provider function, rebuilt on every open, and the palette rebuilds
its command list on every open. `canSaveActive()` is read the same way.

`FileEditor.hasSelection()` is `false` while the Markdown preview is showing,
and `cutSelection()` / `copySelection()` do nothing then. The preview hides the
editor, so its selection is out of sight.[^preview-guard]

| Active file | Its editor's selection | Preview showing | Cut / Copy enabled |
|---|---|---|---|
| none | — | — | no |
| `a.ts` | caret only | — | no |
| `a.ts` | 5 characters | — | yes |
| `notes.md` | 5 characters | yes | no |
| `notes.md` | 5 characters | no | yes |

### Part 1 — the shortcut is a display label only, with no accelerator

The rows show `Ctrl/Cmd+X` and `Ctrl/Cmd+C` through two new display-only
constants, `CUT_SHORTCUT` and `COPY_SHORTCUT`, in
[src/shell/shortcuts.ts](src/shell/shortcuts.ts#L21). Nothing is added to
`acceleratorFor` or `AcceleratorActions`. The keys already work natively in the
editor and in every text field.[^no-accelerator] The library's
`MenuItemConfig.shortcut` is a display hint that binds nothing (see
`docs/recipes/keyboard-shortcuts.md` in the library).

### Part 1 — Cut and Copy act on the active editor, not on the focused field

Like *Find…* and *Format Document*, Edit › Cut and Edit › Copy act on the
active file's editor. With focus in another text field (the Search view's query,
say), Ctrl/Cmd+C still copies from that field natively. Only the menu row
targets the editor.[^active-not-focused]

### Part 1 — Paste is left out, because the library cannot read the clipboard under Tauri on Linux

`CodeEditor.paste()` reads the clipboard through `navigator.clipboard.readText()`.
Inside Loom's Tauri window on Linux, WebKitGTK refuses that read, so `paste()`
resolves `false` and inserts nothing.[^paste-evidence] Writing the clipboard is
allowed, so Cut and Copy work. Making the read work needs either a Tauri window
setting or a library change. Both are outside this plan. Per `CLAUDE.md`, the
choice goes to the user (see `## Open Questions`), and no Loom-side clipboard
code is added.

### Part 2 — the hint colour is the CSS variable, written into `foregroundColor`

Each of the three constants becomes the string
`'var(--ts-ui-text-muted-color)'`, with no fallback value. The precedent is the
status bar's caret link,
[`foregroundColor: 'var(--ts-ui-statusbar-color)'`](src/EditorController.ts#L118),
and the library's own theming tip
(`docs/concepts/theming.md`, "Muted text for secondary labels"). A CSS variable
in an inline style is re-resolved whenever `ThemeManager.setTheme` rewrites the
`:root` variables, so the hint follows a light/dark switch with no Loom code.
The three constants keep their own names and modules.[^muted-fallback]

| Theme | `--ts-ui-text-muted-color` |
|---|---|
| Light (`ModernTheme`) | `rgb(100, 100, 100)` |
| Dark (`DarkTheme`) | `rgb(180, 180, 180)` |

### Part 3 — the preview page is a keyed factory on the deck's `Card`

`FileEditor` adds its editor with `{ key: SOURCE_PAGE_KEY }` and registers the
preview with
`this._body.addComponent(() => this.buildPreview(), { key: PREVIEW_PAGE_KEY })`.
`setPreviewing` selects pages with `this._card.setVisibleKey(…)`. The `Card`
builds the viewer the first time `PREVIEW_PAGE_KEY` is selected, and never
for a tab that never previews. That is what `ensurePreview` did by hand, and why
it was hand-rolled.[^card-equivalent]

`buildPreview()` still stores the viewer in `_preview`, because
`refreshPreview()` needs it for `setMarkdown`. `setPreviewing(true)` calls
`refreshPreview()` **before** `setVisibleKey(PREVIEW_PAGE_KEY)`:

| Visit | `refreshPreview()` | `setVisibleKey(PREVIEW_PAGE_KEY)` | Viewer shows |
|---|---|---|---|
| first | does nothing (`_preview` is `null`) | runs `buildPreview()`, seeded with `getValue()` | current text |
| later | `setMarkdown(getValue())` | shows the built viewer | current text |

The preview factory is registered after `super()`, because the arrow function
uses `this`.

### Part 4 — five prompts become alert dialogs; forms and information stay dialogs

`role: 'alertdialog'` is added to the `Dialog.show` config of every prompt that
interrupts the user with a confirmation, a warning or a choice that must be
answered. Prompts that are forms, or that only inform, keep the default
`'dialog'`.[^role-rule] The library already gives `Dialog.confirm`,
`Dialog.warning` and `Dialog.error` the `alertdialog` role, so those call sites
need no change.

| Prompt | File | Role |
|---|---|---|
| `promptUnsavedChanges` | [src/shell/unsavedPrompt.ts:20](src/shell/unsavedPrompt.ts#L20) | `alertdialog` |
| `promptExternalChange` | [src/shell/externalChangePrompt.ts:22](src/shell/externalChangePrompt.ts#L22) | `alertdialog` |
| `confirmDelete` | [src/explorer/fileTreePrompts.ts:145](src/explorer/fileTreePrompts.ts#L145) | `alertdialog` |
| `confirmReplaceAll` | [src/explorer/searchReplacePrompt.ts:17](src/explorer/searchReplacePrompt.ts#L17) | `alertdialog` |
| `promptRecentDirectoryIntent` | [src/shell/recentProjectPrompt.ts:22](src/shell/recentProjectPrompt.ts#L22) | `alertdialog` |
| `promptName` (New File, New Folder, Rename) | [src/explorer/fileTreePrompts.ts:33](src/explorer/fileTreePrompts.ts#L33) | `dialog` (unchanged: a form) |
| `promptGoToLine` | [src/editor/goToLinePrompt.ts:30](src/editor/goToLinePrompt.ts#L30) | `dialog` (unchanged: a form) |
| `DismissDialog` (About) | [src/shell/DismissDialog.ts:51](src/shell/DismissDialog.ts#L51) | `dialog` (unchanged: information) |
| `confirmOpenSeparateWorkspace`, the exit prompt, every `Dialog.error` | — | already `alertdialog` (library default) |

### Part 5 — the palette forwards PageUp and PageDown, and nothing else new

`handleKeyDown` adds `'PageDown'` and `'PageUp'` to the keys it forwards to
`this._resultsList.handleKey(e)`, beside ArrowUp / ArrowDown. The precedent is
the arrow keys' own forwarding in the same method. `List.handleKey` pages by
the number of whole rows in view, skips disabled rows, and scrolls the focused
row into view (0.11.0). Home and End stay with the query field's caret.[^home-end]

---

## Public API

All Loom-internal. No library API changes.

```ts
// src/shell/shortcuts.ts — display-only labels; no isXChord helper, no accelerator
export const CUT_SHORTCUT = 'Ctrl/Cmd+X'
export const COPY_SHORTCUT = 'Ctrl/Cmd+C'

// src/shell/commands.ts — PaletteCommandActions gains
hasActiveSelection: () => boolean
onCut: () => void
onCopy: () => void

// src/shell/EditorShell.ts — MenuBarActions (not AcceleratorActions) gains the same three

// src/EditorController.ts
hasActiveSelection(): boolean
cutInActive(): void
copyInActive(): void

// src/editor/FileEditor.ts
hasSelection(): boolean
cutSelection(): void
copySelection(): void
```

---

## Implementation

### `FileEditor` (Part 1 and Part 3)

```ts
/** The deck's page keys: the source editor, and the lazily built Markdown preview. */
const SOURCE_PAGE_KEY = 'source'
const PREVIEW_PAGE_KEY = 'preview'

// constructor, replacing `body.addComponent(editor)`:
body.addComponent(editor, { key: SOURCE_PAGE_KEY })

// constructor, after `this._previewToggle = previewToggle`:
this._body.addComponent(() => this.buildPreview(), { key: PREVIEW_PAGE_KEY })

private setPreviewing(previewing: boolean): void {
    this.cancelPreviewRefresh()
    this._previewing = previewing

    if (!previewing) {
        this._card.setVisibleKey(SOURCE_PAGE_KEY)

        return
    }

    this.refreshPreview()
    this._card.setVisibleKey(PREVIEW_PAGE_KEY)
}

private buildPreview(): MarkdownViewer {
    const preview = MarkdownViewer({ markdown: this._editor.getValue() })

    this._preview = preview

    return preview
}

hasSelection(): boolean {
    return !this._previewing && this._editor.getSelection().characterCount > 0
}

cutSelection(): void {
    if (this._previewing) {
        return
    }

    this._editor.cut()
}

// copySelection(): the same shape, calling this._editor.copy()
```

Do not pass `visibleKey` to `new Card()`. The card starts on its first child,
the editor.[^no-initial-key]

### Edit menu (Part 1)

```ts
{ label: 'Edit', glyph: 'code', items: () => [
    { text: 'Cut', glyph: 'scissors', shortcut: CUT_SHORTCUT, enabled: actions.hasActiveSelection(), action: actions.onCut },
    { text: 'Copy', glyph: 'copy', shortcut: COPY_SHORTCUT, enabled: actions.hasActiveSelection(), action: actions.onCopy },
    { separator: true },
    { text: 'Find…', … },   // the existing rows follow, unchanged
```

### Palette commands (Part 1)

In `buildPaletteCommands`, read `const hasActiveSelection = actions.hasActiveSelection()`
once beside `hasActiveFile`, and insert two entries between `close-file` and
`find`:

```ts
{ id: 'cut',  title: 'Cut',  shortcut: CUT_SHORTCUT,  enabled: hasActiveSelection, run: actions.onCut },
{ id: 'copy', title: 'Copy', shortcut: COPY_SHORTCUT, enabled: hasActiveSelection, run: actions.onCopy },
```

---

## Ordered Implementation Steps

### Setup

1. Create the worktree from the branch this plan was drafted on
   (`feature/typescript-ui-0-11-adoptions` or its successor at the tip of the
   chain), run `npm ci`, then
   `rm -rf node_modules/@jimka/typescript-ui && ln -s /home/jika/typescript/typescript-ui/packages/lib node_modules/@jimka/typescript-ui`.
   Checks:
   - `readlink node_modules/@jimka/typescript-ui` → `/home/jika/typescript/typescript-ui/packages/lib`.
   - `grep -l text-muted-color node_modules/@jimka/typescript-ui/dist/lib/*.js | head -1` → one file. If none, run `npm run build:lib` in the library folder first.
   - `npm run typecheck && npm test` pass before any edit.

### Part 1 — Cut and Copy (one code commit)

2. **`src/shell/shortcuts.ts`** — add `CUT_SHORTCUT` and `COPY_SHORTCUT` after
   `FIND_IN_FILES_SHORTCUT` (line 31), under a doc comment saying they are
   display-only: CodeMirror and the webview handle the keys natively, so they
   have no `isXChord` helper and no accelerator, and adding one would run the
   action twice. Add one sentence to the file's header comment (lines 1–16)
   saying the same.
3. **`tests/shortcuts.test.ts`** — add a test: `dispatchAccelerator` returns
   `false` for `Ctrl+X`, `Ctrl+C` and `Ctrl+V`, and for `Cmd+X`, `Cmd+C` and
   `Cmd+V`, and runs none of the actions. Run `npm test`: it passes already
   (it pins current behaviour).
4. **`tests/commands.test.ts`** — write the failing tests first:
   - add `hasActiveSelection: () => false`, `onCut: () => {}`,
     `onCopy: () => {}` to the `actions()` helper;
   - change both order tests to the fifteen ids in `## Expected Behaviour`,
     and rename them "fifteen";
   - add `'cut'` and `'copy'` to the "per-file commands disabled" test's id list;
   - add the Cut/Copy cases from `## Expected Behaviour`.
   Run `npm test`: the new and changed cases fail.
5. **`src/shell/commands.ts`** — add the three members to
   `PaletteCommandActions`, import the two constants, and add the two entries
   (see `## Implementation`). `npm test` passes.
6. **`src/editor/FileEditor.ts`** — add `hasSelection`, `cutSelection` and
   `copySelection` after `openFind` (line 256), each with a doc comment.
7. **`src/EditorController.ts`** — add `hasActiveSelection`, `cutInActive` and
   `copyInActive` after `findInActive` (line 1087), each with a one-line doc
   comment, each delegating to `this.getActiveFile()?.…`
   (`hasActiveSelection` returns `?? false`).
8. **`src/shell/EditorShell.ts`** — add the three members to `MenuBarActions`
   (line 98) with doc comments; wire them in `actions` (line 347) to
   `controller.hasActiveSelection()`, `controller.cutInActive()` and
   `controller.copyInActive()`; import the two constants (line 32); add the two
   rows and a separator at the top of the Edit menu (line 709).
9. **`src/main.ts`** — import `scissors` from
   `@jimka/typescript-ui/glyphs/solid/scissors` and add it to `Glyph.register`
   (line 35). `copy` is registered already.
10. Checks: `npm run typecheck`, `npm test`.
    `grep -rn "navigator.clipboard" src` → only `src/explorer/FileTree.ts:308`.
    `grep -n "CUT_SHORTCUT\|COPY_SHORTCUT" src/shell/shortcuts.ts` → the two
    declarations only, no chord helper.

### Part 2 — muted hint colour (one code commit)

11. **`src/explorer/SearchPanel.ts:32`**, **`src/explorer/PropertiesPanel.ts:20`**,
    **`src/shell/WelcomeScreen.ts:37`** — set each constant to
    `'var(--ts-ui-text-muted-color)'`. Rewrite each doc comment to say it is
    the theme's muted text colour and follows a theme switch. Remove the
    cross-references to "the same muted grey" and the stale
    `WelcomeScreen.ts:34` line reference.
12. Check: `grep -rn "140, 140, 140" src` → zero matches.

### Part 3 — keyed preview page (one code commit)

13. **`src/editor/FileEditor.ts`** — add the two key constants after
    `PREVIEW_LABEL` (line 28). Add the editor with `{ key: SOURCE_PAGE_KEY }`
    (line 93). Register the preview factory after line 111. Replace
    `setPreviewing`'s body and replace `ensurePreview` with `buildPreview`
    (see `## Implementation`). Update `_preview`'s doc: set by `buildPreview`,
    which the `Card` runs the first time the preview key is selected.
14. Checks: `grep -n "ensurePreview\|setVisibleComponentId" src/editor/FileEditor.ts`
    → zero matches. `npm run typecheck`.

### Part 4 — alert dialogs (one code commit)

15. Add `role: 'alertdialog',` after the `message` line of the five
    `Dialog.show` calls marked `alertdialog` in Part 4's table. Leave the
    others untouched. In `promptRecentDirectoryIntent`'s and
    `promptUnsavedChanges`'s doc comments, add one sentence: announced as an
    alert dialog, because it interrupts with a decision.
16. Check: `grep -rn "role: 'alertdialog'" src | wc -l` → `5`.

### Part 5 — palette paging (one code commit)

17. **`src/shell/CommandPalette.ts:202`** — extend `isNavKey` with
    `e.key === 'PageDown' || e.key === 'PageUp'`. Update the method's doc
    comment to list the four forwarded navigation keys, and say Home and End
    stay with the query field's caret.
18. Check: `npm run typecheck`.

### Docs (one docs commit)

19. **`README.md`** — after the *Find & replace* bullet (line 58), add:
    "**Cut and Copy** — *Edit › Cut* and *Edit › Copy*, and the matching
    command-palette entries, act on the active editor's selection and are
    greyed out when nothing is selected. Pasting is Ctrl/Cmd+V."
20. **`TODO.md`** — delete the *Three hint labels stay a hardcoded mid-grey*
    entry (lines 137–150). Add a *Known issues* entry: "**No Edit › Paste, and
    the editor's right-click Paste is refused on Linux.**" Its body says that
    `CodeEditor.paste()` reads `navigator.clipboard.readText()`, that WebKitGTK
    refuses that read unless the webview has clipboard access, which Tauri
    enables only through `enable_clipboard_access()` on a window built in Rust,
    and that Ctrl/Cmd+V works because it is a native paste.
21. Final checks (see `## Verification`).

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src/shell/shortcuts.ts` |
| Modify | `src/shell/commands.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `src/editor/FileEditor.ts` |
| Modify | `src/main.ts` |
| Modify | `src/explorer/SearchPanel.ts` |
| Modify | `src/explorer/PropertiesPanel.ts` |
| Modify | `src/shell/WelcomeScreen.ts` |
| Modify | `src/shell/unsavedPrompt.ts` |
| Modify | `src/shell/externalChangePrompt.ts` |
| Modify | `src/explorer/fileTreePrompts.ts` |
| Modify | `src/explorer/searchReplacePrompt.ts` |
| Modify | `src/shell/recentProjectPrompt.ts` |
| Modify | `src/shell/CommandPalette.ts` |
| Modify | `tests/commands.test.ts` |
| Modify | `tests/shortcuts.test.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Unit-testable

`buildPaletteCommands` (tests/commands.test.ts):

- Every call returns these fifteen ids in this order, whatever the state:
  `new-file, open-folder, toggle-explorer, exit, save, save-as, close-file, cut, copy, find, go-to-line, format-document, toggle-hidden-files, toggle-ignored-files, toggle-dark-theme`
  (plus `find-in-files` last when a project is open, as today).

| `hasActiveFile` | `hasActiveSelection` | `cut` / `copy` `enabled` |
|---|---|---|
| `false` | `false` | `false` |
| `true` | `false` | `false` |
| `true` | `true` | `true` |

- `cut` has title `Cut` and shortcut `Ctrl/Cmd+X`; `copy` has title `Copy` and
  shortcut `Ctrl/Cmd+C`.
- `cut.run()` calls `onCut` once and `copy.run()` calls `onCopy` once, also
  when disabled.

`dispatchAccelerator` (tests/shortcuts.test.ts):

| Key event | Returns | Actions run |
|---|---|---|
| `Ctrl+X`, `Ctrl+C`, `Ctrl+V` | `false` | none |
| `Cmd+X`, `Cmd+C`, `Cmd+V` | `false` | none |

### Manual (UI, clipboard, theme, focus, ARIA)

Part 1:
- With a file open and text selected, *Edit › Cut* removes the selection, the
  tab shows the dirty dot, and a temp tab turns upright. Ctrl/Cmd+Z restores
  the text. Ctrl/Cmd+V in the editor pastes the cut text.
- *Edit › Copy* leaves the document unchanged and focus returns to the editor.
  Ctrl/Cmd+V pastes the copied text.
- Caret only, no file open, or a Markdown file with its preview showing: both
  rows and both palette entries are greyed out and do nothing.
- Ctrl/Cmd+X, C and V in the editor each act once (no double paste, no double
  cut). Ctrl/Cmd+C in the Search view's query field copies from that field.
- The menu rows show `Ctrl/Cmd+X` and `Ctrl/Cmd+C`; the palette shows
  `Cut (Ctrl/Cmd+X)` and `Copy (Ctrl/Cmd+C)`.

Part 2:
- The Welcome screen's hint line and *Recent Projects* heading, the Properties
  panel's empty line, and the Search view's status line have computed colour
  `rgb(100, 100, 100)` under the light theme, and `rgb(180, 180, 180)` right
  after *View › Dark Theme*, without a reload. Switching back restores
  `rgb(100, 100, 100)`.

Part 3:
- On a Markdown file, the preview toggle shows the rendered document. Typing in
  the source and toggling again shows the new text. Toggling back to source
  keeps the caret and scroll position.
- A preview scrolled down, toggled to source and back, keeps its scroll
  position.
- Search-result navigation into a previewing file still drops back to source
  (`revealMatch`), and Save As from `.md` to `.txt` while previewing drops back
  to source.

Part 4:
- While the unsaved-changes, delete, Replace All and recent-folder prompts are
  open, `document.querySelector('[role="alertdialog"]')` finds the dialog.
  While New File, Rename and Go to Line are open, it finds nothing and
  `[role="dialog"]` finds the dialog.

Part 5:
- In the palette with many results, PageDown moves the highlight down by the
  number of rows in view, and the list scrolls to keep it visible. PageUp moves
  it back. The query text and its caret do not change. In `>` mode a page move
  skips greyed-out commands. Home and End still move the caret in the query.

---

## Verification

- `npm run typecheck`, `npm test`, `npm run build`.
- The grep checks in steps 10, 12, 14 and 16.
- **Browser checks** (`npm run dev:browser -- --port 1431 --strictPort`, driven
  through the chrome-devtools tools): set `window.__FAKE_PROJECT_ROOT__` to a
  folder inside the checkout (e.g. the worktree's own path), then click
  *Open Folder…*. Cover Part 1's enablement and Cut's removal, all of Part 2
  (read colours with `getComputedStyle(el).color`), Part 3, Part 4's delete,
  Replace All, unsaved-changes and form prompts (writes do nothing in this mode,
  but the prompts open), and Part 5. Chromium's clipboard permissions differ
  from WebKitGTK's, so a clipboard result here proves nothing about Tauri.
- **Tauri checks** (`npm run tauri:dev`, Linux): Part 1's clipboard round trips
  (Cut / Copy, then Ctrl/Cmd+V), the native Ctrl/Cmd+X/C/V single-fire check,
  the external-change prompt's role (edit an open, dirty file from another
  program), and the recent-folder prompt's role (open a folder, then its parent, then
  pick the first folder from *File › Open Recent*).

---

## Potential Challenges

- **The linked library's `dist/` is stale.** Loom imports the library's built
  `dist/lib`, not its source. Mitigation: step 1's `grep` check, and
  `npm run build:lib` in the library when it fails.
- **`Card` warns "Visible key is specified but no matching component was found."**
  This means a key was selected before its page was added. Mitigation: no
  `visibleKey` option on `new Card()`, and both keys registered in the
  constructor before any selection.
- **`navigator.clipboard.writeText` needs a user gesture in WebKitGTK.** The
  menu runs `action` synchronously inside the row's activation
  (`Menu.ts`, `config.action?.()`), and the palette runs the command from the
  Enter or click handler, so the gesture is present. Mitigation: the Tauri
  check above.

---

## Critical Files

- [src/shell/EditorShell.ts](src/shell/EditorShell.ts) — `MenuBarActions`, `actions`, `buildMenuBar`; the *Find…* row is Part 1's precedent.
- [src/shell/commands.ts](src/shell/commands.ts) and [tests/commands.test.ts](tests/commands.test.ts).
- [src/shell/shortcuts.ts](src/shell/shortcuts.ts) — header comment, constants, `acceleratorFor`.
- [src/EditorController.ts:1087](src/EditorController.ts#L1087) — `findInActive`, the controller-side precedent; [:118](src/EditorController.ts#L118), the CSS-variable colour precedent.
- [src/editor/FileEditor.ts](src/editor/FileEditor.ts) — `setPreviewing`, `ensurePreview`, `openFind`.
- [src/shell/CommandPalette.ts:201](src/shell/CommandPalette.ts#L201) — `handleKeyDown`.
- `/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/component/editor/CodeEditor.ts` — `copy()`, `cut()`, `paste()` (around line 1540) and `getSelection()` (line 1464).
- `/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/layout/Card.ts` and `docs/layouts/Card.md` — keyed lazy pages.
- `/home/jika/typescript/typescript-ui/packages/lib/docs/components/Dialog.md` — *Screen readers*, the role rule.
- `/home/jika/typescript/typescript-ui/packages/lib/docs/concepts/theming.md` — `text.mutedColor`.
- `/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/component/list/AbstractSelectableList.ts` — `handleKey`, `handleNavigationKey`.

---

## Non-Goals

- **Edit › Paste**, and any Loom-side clipboard reader (no
  `@tauri-apps/plugin-clipboard-manager`, no Rust window change). See
  `## Open Questions`.
- **Window accelerators for Ctrl/Cmd+X/C/V.** The keys are native.
- **Opening the find panel through `CodeEditor.openSearch()`, moving tree nodes
  on rename, Dock splits and layout save, editor settings.** Each has its own
  sibling plan (`library-focus-and-search-adoption.md`,
  `tree-move-on-rename.md`, `split-editor-and-layout-save.md`,
  `editor-settings.md`). `FileEditor.openFind`'s stale `setVisible(false)`
  comment belongs to the first of these.
- **Changing the `package.json` library range.**

---

## Open Questions

**How should Paste reach the clipboard under Tauri?** The library's
`CodeEditor.paste()` (and the editor's own right-click *Paste*, which already
shows "Clipboard read blocked by the browser — press Ctrl/Cmd+V to paste." in
Loom today) needs `navigator.clipboard.readText()` to succeed. Options:

1. **Turn on the webview's clipboard access in Loom's Tauri host.** Set
   `"create": false` on the main window in `tauri.conf.json` and build it in
   `src-tauri/src/lib.rs`'s `setup` with
   `WebviewWindowBuilder::from_config(…)?.enable_clipboard_access().build()`.
   Library `paste()` then works unchanged, and so does the right-click *Paste*.
   Page script can then read the clipboard at any time, with no user gesture.
2. **A library seam for the clipboard read**, such as an application-supplied
   reader behind `DOM.source.readClipboardText`, that Loom backs with
   `@tauri-apps/plugin-clipboard-manager`. This is a library change.
3. **No Edit › Paste.** Ctrl/Cmd+V stays the only way to paste.

Once decided, Edit › Paste is one more row and palette entry on the Part 1
path, enabled whenever a file is active and its preview is not showing.

---

## Notes

[^linked-lib]: `Theme.text.mutedColor` is listed in the library's
    `docs/reference/changelog/next.md`, so no published 0.11.x carries it.
    Cut/copy (0.9.0), `Card` keys and `DialogConfig.role` (0.11.0) are all
    published. The linked checkout's version string is `0.11.0`, so the range
    is satisfied. The main tree's `node_modules/@jimka/typescript-ui` is
    already this same symlink.

[^live-enablement]: `"selectionchange"` would have to feed a stored flag
    that the menu provider then reads; reading
    `CodeEditor.getSelection()` at open time gives the same answer without
    the state. `EditorController.syncSelectionMetrics` already reads
    `getSelection()` live for the same reason, and `getSelection()` reads the
    mounted view's state directly. A menu that is open while the selection
    changes is not possible: opening the menu takes the pointer or the
    keyboard away from the editor.

[^preview-guard]: `Card` undisplays the inactive page, but the
    `CodeEditor`'s CodeMirror state, selection included, survives. Without
    the guard, Cut on a previewing tab would delete text the user cannot see.
    `FileEditor.openFind` already returns early while previewing, for the
    same kind of reason.

[^no-accelerator]: CodeMirror handles Ctrl/Cmd+X/C/V inside the editor as
    native cut, copy and paste events, and every `TextField` gets them from
    the webview. A window `keydown` accelerator would run the menu action as
    well as the native one, so every cut or copy would run twice, and an accelerator
    calling `preventDefault()` would break copying from the palette's and the
    Search view's text fields. `Go to Line…` is the existing row with no
    accelerator; it simply has no `shortcut`. These two rows need the label
    because users expect it beside Cut and Copy.

[^active-not-focused]: The library has no "copy from whatever is focused"
    API, and Loom's menu callbacks all address the active file. The menu
    returns focus to the control that had it before running the action
    (`Menu.returnFocusToInvoker`), so an editor that had focus keeps it.

[^paste-evidence]: Checked against the WebKitGTK the machine has
    (`libwebkit2gtk-4.1` 2.50.4) with a small C program: a `WebKitWebView` on
    a secure origin, script run with user activation active
    (`navigator.userActivation.isActive === true`). With the
    `javascript-can-access-clipboard` setting off, `readText()` rejects with
    `NotAllowedError` and `writeText()` resolves. With it on, both resolve.
    Tauri turns that setting on only when `WebviewAttributes.clipboard` is
    true (`wry` 0.55.1, `src/webkitgtk/mod.rs:433`), which defaults to false,
    and Tauri v2's `tauri.conf.json` window config has no field for it: only
    the Rust `enable_clipboard_access()` builder method sets it. Loom's main
    window is created from `tauri.conf.json`, so the read is refused. Ctrl+V
    is unaffected because CodeMirror reads a native `paste` event's
    `clipboardData`, which needs no permission.

[^muted-fallback]: No fallback value, as in the library's own theming tip.
    Against a published 0.11.0, which writes no `--ts-ui-text-muted-color`,
    the inline `color` then falls back to the inherited text colour: full
    strength but readable in both themes. A fixed fallback like
    `rgb(100, 100, 100)` would stay mid-grey on the dark background. One
    shared constant was not introduced: each module already owns its
    constant, and the change is one value in each.

[^card-equivalent]: `plans/implemented/markdown-preview.md` (footnote
    `lazy-preview`) built the viewer on the first toggle so that a tab whose
    preview is never opened never pays for a `MarkdownViewer`. `Card` had no
    lazy pages then. A keyed factory gives the same guarantees: it runs at
    most once, only when its key is first selected, synchronously inside
    `setVisibleKey`, and the built page is added with the registered
    constraints. Re-selection keeps the page's scroll position, as before.
    The unbuilt factory is a map entry on every `FileEditor`, Markdown or not,
    which costs nothing.

[^no-initial-key]: The `Card` resolves its visible page whenever a size is
    asked for. With a `visibleKey` option set, a size query that arrived
    between attaching the card and adding the editor would log a "no matching
    component" warning. With no option, the first child, the editor, is
    shown, which is the page a new tab needs.

[^role-rule]: The library's rule (`docs/components/Dialog.md`, *Screen
    readers*): `'alertdialog'` is for a message that interrupts the user and
    needs an answer: a confirmation, a warning, an error. `confirmDelete` is
    the library docs' own example (a delete confirmation).
    `confirmReplaceAll` is the same kind of confirm. The external-change
    prompt arrives unasked, from the file watcher. The recent-folder prompt is
    a three-way confirm; its sibling `confirmOpenSeparateWorkspace` in the
    same file is already an alert dialog through `Dialog.confirm`. The name
    prompts and Go to Line are forms the user asked for, and About only
    informs.

[^home-end]: The query field is a single-line `TextField` holding focus.
    PageUp and PageDown do nothing useful in it, but Home and End move its
    caret, which a user editing the query needs. VS Code's quick-open has the
    same split.
