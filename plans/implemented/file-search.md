---
touches-shared: [src/EditorController.ts, src/editor/FileEditor.ts, src/shell/shortcuts.ts, src/shell/EditorShell.ts, src/shell/commands.ts, package.json, README.md, TODO.md]
---

# In-File Find & Replace — Implementation Plan

## Overview

Ctrl/Cmd+F opens a find/replace bar over the active file's editor: type a query, every match in the document highlights, Enter and Shift+Enter walk forward and back, and a replace field replaces one match or all of them. Case-sensitive, regular-expression, and whole-word toggles sit on the same bar.

The bar itself is CodeMirror's own search panel, from `@codemirror/search`. The library's [`CodeEditor`](../../typescript-ui/packages/lib/src/typescript/lib/component/editor/CodeEditor.ts#L751) does not wire that extension and keeps its `EditorView` private, so a new Loom module — `src/editor/editorSearch.ts` — resolves the live view through the component's DOM id and appends the extension to it on first use.

The rest is wiring along paths that already exist: a new chord in [`src/shell/shortcuts.ts:37`](src/shell/shortcuts.ts#L37), a `findInActive()` on [`src/EditorController.ts:653`](src/EditorController.ts#L653)'s pattern, an Edit-menu item in [`src/shell/EditorShell.ts:403`](src/shell/EditorShell.ts#L403), and a palette entry in [`src/shell/commands.ts:53`](src/shell/commands.ts#L53).

Cross-file (project-wide) search is **not** in this plan. [`TODO.md:63`](TODO.md#L63)'s backlog entry is rewritten to cover only that remaining half.

---

## Architecture Decisions

### Ship in-file find/replace; leave cross-file search on the backlog

The backlog item is unscoped ("In-file or cross-file search."), so this plan takes the in-file half only.[^scope] The palette's file-listing machinery makes *gathering candidate paths* for a project-wide search cheap, but the parts that actually make such a search work — reading every file's content, matching, streaming and cancelling results, a results panel, and jump-to-line — are all still missing, and jump-to-line needs the very editor seam this plan builds.[^crossfile-cost]

### Use CodeMirror's own search panel, not a Loom-built bar

`@codemirror/search`'s `search()` extension ships the find field, the replace field, next/previous/select-all and replace/replace-all buttons, the three matching toggles, and match highlighting. Loom appends that extension and opens the panel; it builds no chrome of its own.[^cm-panel]

### Reach the live `EditorView` through the component's DOM id

`CodeEditor` exposes no `EditorView` and no seam for adding extensions, so `src/editor/editorSearch.ts` calls `document.getElementById(editor.getId())` and hands the result to CodeMirror's `EditorView.findFromDOM`. `getId()` is public `Component` API and `findFromDOM` is public CodeMirror API; the extension then goes in through `StateEffect.appendConfig`, CodeMirror's documented way to extend a running editor.[^view-access]

This is a new pattern for Loom — every other file in `src/` goes through the library's DOM seam.[^new-pattern] Loom already imports `@codemirror/*` packages directly and feeds their extensions to the library's editor: [`src/editor/languages.ts:74`](src/editor/languages.ts#L74) registers `css` and `python` grammars that way, and [`vite.config.ts`](vite.config.ts) already dedupes `@codemirror/state`, `@codemirror/view`, and `@codemirror/language` so those extensions share the library's own instances.

### Install the extension lazily, on the first Find

`openFindPanel` resolves the view and appends the extension at the moment the user first asks to search a given editor, not at editor construction.[^lazy]

### Ctrl/Cmd+F, through the existing `isCtrlChord` helper

`isFindChord` is `isCtrlChord(event, 'f')` and gets its own branch in `installAccelerators`, exactly like the nine chords already there. Ctrl/Cmd+F is unclaimed today, and the one existing `f` binding is Format's Alt+Shift+F, which requires `altKey` and so cannot collide.[^chord]

### Find is a no-op while the Markdown preview is showing

`FileEditor.openFind()` returns early when `_previewing` is set.[^preview]

---

## Public API

New module `src/editor/editorSearch.ts`:

```typescript
/** Opens CodeMirror's find/replace panel over `editor`, installing the
 *  search extension on first use. A no-op before the editor has mounted. */
export function openFindPanel(editor: CodeEditor): void
```

`src/editor/FileEditor.ts` — new public method on `FileEditor`:

```typescript
openFind(): void
```

`src/EditorController.ts` — new public method on `EditorController`:

```typescript
findInActive(): void
```

`src/shell/shortcuts.ts` — new export, new predicate, new `AcceleratorActions` field:

```typescript
export const FIND_SHORTCUT = 'Ctrl/Cmd+F'

export function isFindChord(event: KeyboardEvent): boolean

export interface AcceleratorActions {
    // ...existing fields unchanged...
    /** Ctrl/Cmd+F — opens the find/replace bar over the active editor. */
    onFind: () => void
}
```

`src/shell/commands.ts` — new field on `PaletteCommandActions`:

```typescript
export interface PaletteCommandActions {
    // ...existing fields unchanged...
    onFind: () => void
}
```

---

## Internal Structure

`src/editor/editorSearch.ts` in full — the only non-obvious code in this plan:

```typescript
import { EditorView, keymap } from '@codemirror/view'
import { StateEffect } from '@codemirror/state'
import { search, searchKeymap, openSearchPanel } from '@codemirror/search'
import type { CodeEditor } from '@jimka/typescript-ui/component/editor'

/** Views whose configuration already carries the search extension. Keyed on
 *  the view rather than on the `CodeEditor`, so a rebuilt view gets a fresh
 *  install; a `WeakSet` keeps no view alive past its editor. */
const installed = new WeakSet<EditorView>()

/**
 * The live CodeMirror view behind `editor`, or `null` before the editor has
 * mounted (`CodeEditor` mounts on its first sized layout).
 *
 * @param editor - The editor whose view to resolve.
 * @returns The live view, or `null` when none exists yet.
 */
function resolveView(editor: CodeEditor): EditorView | null {
    const host = document.getElementById(editor.getId())

    return host !== null ? EditorView.findFromDOM(host) : null
}

export function openFindPanel(editor: CodeEditor): void {
    const view = resolveView(editor)

    if (view === null) {
        return
    }

    if (!installed.has(view)) {
        view.dispatch({
            effects: StateEffect.appendConfig.of([search({ top: true }), keymap.of(searchKeymap)]),
        })
        installed.add(view)
    }

    openSearchPanel(view)
}
```

Two details the code depends on:

- `search({ top: true })` puts the panel above the document instead of below it, which is where VS Code's find widget sits. The `top` option defaults to `false`, so it must be passed explicitly — `openSearchPanel` alone would bootstrap the extension at its defaults.
- `keymap.of(searchKeymap)` is what gives the panel Escape-to-close and F3 / Ctrl+G find-next, because the panel dispatches its own keydowns through the `"search-panel"` keymap scope that `searchKeymap` registers for.

---

## Ordered Implementation Steps

1. **`package.json`** — add `"@codemirror/search": "^6.7.1"`, `"@codemirror/state": "^6.7.1"`, and `"@codemirror/view": "^6.43.9"` to `dependencies`, keeping the block alphabetical (they sort before `@jimka/typescript-ui`). Run `npm install`. Do **not** touch `vite.config.ts` — its `resolve.dedupe` list already names `@codemirror/state` and `@codemirror/view`, which is all that is needed for the appended extension to share the library's instances.[^no-vite-change]

2. **Create `tests/shortcuts.test.ts`** — cover the chord cases in `## Expected Behaviour`'s unit table. Follow `tests/dropIntent.test.ts`'s plain `describe`/`it`/`expect` style. The suite needs `KeyboardEvent`-shaped inputs and runs in the node environment, so build them with one local helper:

   ```typescript
   const chord = (over: Partial<KeyboardEvent>): KeyboardEvent =>
       ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: '', ...over }) as KeyboardEvent
   ```

   Run `npm test` — the new suite fails, because `shortcuts.ts` exports no `isFindChord` yet. That is the red step.

3. **`src/shell/shortcuts.ts`** — add, in the places matching the existing layout:
   - `export const FIND_SHORTCUT = 'Ctrl/Cmd+F'` after `COMMAND_PALETTE_SHORTCUT` (line 26).
   - `isFindChord`, `isCtrlChord(event, 'f')`, placed after `isFormatChord` (line 70).
   - `onFind: () => void` on `AcceleratorActions` after `onFormat` (line 106), with the doc comment `/** Ctrl/Cmd+F — opens the find/replace bar over the active editor. */`.
   - `} else if (isFindChord(event)) { actions.onFind() }` in `installAccelerators`, immediately after the `isFormatChord` branch (line 137).

   Run `npm test` — green. `npm run typecheck` now **fails** on `EditorShell.ts`'s `actions` object literal, which does not yet supply the newly-required `onFind`; step 7 fixes it. Do not add a temporary stub.

4. **Create `src/editor/editorSearch.ts`** with the module from `## Internal Structure`, adding a file-header comment stating why the view is resolved through the DOM (the library wires no search extension and keeps its `EditorView` private) and TSDoc on `openFindPanel`. The snippet already carries the comments on `installed` and `resolveView`.

5. **`src/editor/FileEditor.ts`** — import `openFindPanel` from `./editorSearch`, and add a public `openFind()` next to the other public accessors (after `getEditor()`, line 234):

   ```typescript
   openFind(): void {
       if (this._previewing) {
           return
       }

       openFindPanel(this._editor)
   }
   ```

   Document the early return: `Card` hides the editor with `setVisible(false)` while the preview page shows, so the panel and its focused find field would open invisibly.

6. **`src/EditorController.ts`** — add `findInActive()` immediately after `formatActive()` (line 653), mirroring its shape:

   ```typescript
   /** Opens the find/replace bar over the active file's editor. */
   findInActive(): void {
       this.getActiveFile()?.openFind()
   }
   ```

7. **`src/shell/EditorShell.ts`** — three edits:
   - Add `FIND_SHORTCUT` to the `./shortcuts` import list (line 24).
   - Add `onFind: () => controller.findInActive(),` to the `actions` object literal, after `onFormat` (line 125).
   - In `buildMenuBar`'s Edit menu (line 403), put Find first and separate it from formatting:

     ```typescript
     { label: 'Edit', glyph: 'code', items: () => [
         { text: 'Find…', glyph: 'magnifying-glass', shortcut: FIND_SHORTCUT, enabled: actions.hasActiveFile(), action: actions.onFind },
         { separator: true },
         { text: 'Format Document', glyph: 'pen-to-square', shortcut: FORMAT_SHORTCUT, enabled: actions.hasActiveFile(), action: actions.onFormat },
     ] },
     ```

     `magnifying-glass` is already registered in [`src/main.ts:32`](src/main.ts#L32) for the View menu's palette item, so no new glyph registration is needed.

   Run `npm run typecheck` — green again.

8. **`src/shell/commands.ts`** — add `onFind: () => void` to `PaletteCommandActions` (after `onFormat`, line 39), import `FIND_SHORTCUT` from `./shortcuts`, and push the command inside the existing `hasActiveFile()` block (line 65), before the `format-document` entry so the palette order matches the Edit menu:

   ```typescript
   commands.push({ id: 'find', title: 'Find…', shortcut: FIND_SHORTCUT, run: actions.onFind })
   ```

9. **`README.md`** — insert a **Find & replace** bullet in `## Highlights` immediately after the **Command palette** bullet, describing Ctrl/Cmd+F, the match highlighting, next/previous, the case/regex/whole-word toggles, and replace/replace-all.

10. **`TODO.md`** — replace line 63's `- **In-file or cross-file search.**` in place, keeping it in the `## High` section at the same position, with a bullet covering only the cross-file half: that in-file find/replace now ships (Ctrl/Cmd+F, CodeMirror's own panel), and that project-wide search still needs content matching over every file, streaming/cancellable results, a results panel, and jump-to-match — see `## Non-Goals` for the list.

11. **Checkpoints** — `grep -rn 'onFind' src/` expects exactly three files (`shortcuts.ts`, `EditorShell.ts`, `commands.ts`); `grep -rn 'openFindPanel' src/` expects exactly two (`editorSearch.ts`, `FileEditor.ts`); `grep -rn 'In-file or cross-file' TODO.md README.md src/` expects zero matches.

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Create | `src/editor/editorSearch.ts` |
| Create | `tests/shortcuts.test.ts` |
| Modify | `package.json` |
| Modify | `src/shell/shortcuts.ts` |
| Modify | `src/editor/FileEditor.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `src/shell/commands.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Unit-testable — `tests/shortcuts.test.ts`

| Input | `isFindChord` | `isFormatChord` |
| --- | --- | --- |
| `{ ctrlKey: true, key: 'f' }` | `true` | `false` |
| `{ metaKey: true, key: 'f' }` | `true` | `false` |
| `{ ctrlKey: true, key: 'F' }` | `true` | `false` |
| `{ ctrlKey: true, shiftKey: true, key: 'f' }` | `false` | `false` |
| `{ altKey: true, shiftKey: true, key: 'f' }` | `false` | `true` |
| `{ ctrlKey: true, altKey: true, key: 'f' }` | `false` | `false` |
| `{ key: 'f' }` | `false` | `false` |
| `{ ctrlKey: true, key: 'p' }` | `false` | `false` |

The `key: 'F'` row pins the case-folding `isCtrlChord` already does. The `altKey + shiftKey` row is the collision check: Ctrl/Cmd+F and Format's Alt+Shift+F must each reject the other's chord.

### Manual verification — the live app (`npm run tauri:dev`)

`CodeEditor` mounts nothing under the test harness (the library documents it as live-only, and Loom's vitest config runs in the node environment with no DOM), so everything below is verified by hand.

| Action | Expected |
| --- | --- |
| Ctrl/Cmd+F with a file open | The find panel appears above the document, under the breadcrumb band; the find field has focus |
| Ctrl/Cmd+F with a short (under 100 characters) selection | The find field is pre-filled with the selected text |
| Type a query | Every match in the document highlights; the selection does not move |
| Enter / Shift+Enter in the find field | Jumps to the next / previous match and scrolls it into view |
| *match case*, *regexp*, *by word* checkboxes | Re-run the query; highlighting updates |
| Type in the replace field, click *replace* once | Selects the next match without changing the document (CodeMirror's `replaceNext` only replaces a match that is already selected) |
| Click *replace* again | Replaces the selected match and selects the next one; the tab shows its dirty dot; Ctrl/Cmd+Z undoes it |
| Click *replace all* | Replaces every match in one undo step |
| Escape with focus in the panel | Closes the panel |
| Escape with focus in the document | Panel stays open (the library's `defaultKeymap` claims Escape for `simplifySelection`) |
| The panel's `×` button | Closes the panel |
| Ctrl/Cmd+F while the panel is already open | Re-focuses and re-selects the find field; no second panel |
| Ctrl/Cmd+F with no file open | Nothing happens, no error in the console |
| Ctrl/Cmd+F on a Markdown file whose preview is showing | Nothing happens |
| Switch to another tab and search there | Each tab keeps its own query and panel state |
| *Edit > Find…* | Same as Ctrl/Cmd+F |
| *Edit > Find…* with no file open | Greyed out |
| `> Find…` in the command palette | Opens the panel, with the find field focused after the palette closes |

---

## Verification

- `npm run typecheck` — clean (expected to fail only between steps 3 and 7).
- `npm test` — the new `tests/shortcuts.test.ts` suite passes alongside the twelve existing suites.
- `npm run build` — clean, confirming the three new dependencies resolve in the production bundle.
- `grep -rn 'onFind' src/` — three files; `grep -rn 'openFindPanel' src/` — two files.
- `npm run tauri:dev`, then walk the manual table above. Open a large source file (`src/EditorController.ts` itself works) so there are matches off-screen to scroll to.
- Confirm no second CodeMirror instance loaded: with the panel open, typing in the find field must highlight matches. Highlighting is driven by a state field that the appended extension installs, so if `@codemirror/state` had resolved to a second copy the panel would render but highlight nothing.

---

## Documentation Impact

- `README.md` — `## Highlights` gains a **Find & replace** bullet (step 9). No `## Architecture` change: the app still reaches the native shell only through `src/data/workspace.ts`, and the three new dependencies are frontend-only.
- `TODO.md` — line 63's backlog entry is rewritten to the cross-file half (step 10).
- No library documentation changes. Nothing in `@jimka/typescript-ui` is modified.

---

## Potential Challenges

- **CodeMirror's own `Mod-f` binding fires too.** `searchKeymap` binds `Mod-f` to `openSearchPanel`, so with the caret in the document both that binding and Loom's window accelerator run. Harmless: the second call finds the panel already open and just re-focuses and re-selects the find field. Do not filter the binding out of `searchKeymap` — Loom's own accelerator is what makes Ctrl/Cmd+F work when focus is in the file tree or the menu bar instead.
- **The view may not exist yet.** `CodeEditor` mounts on its first sized layout, so `resolveView` can return `null` — for a file restored into a background tab, or in the same frame a tab is created. `openFindPanel` returns silently in that case, which is why it must not throw or assert.
- **Loom's other accelerators still fire while typing in the find field.** The panel's inputs live inside the editor's DOM, so Ctrl+S and friends reach the `window` listener from there. That is already true of the document itself — see the header comment in `src/shell/shortcuts.ts` — and needs no new handling.
- **Panel styling is inherited, not authored.** `.cm-panels`, `.cm-textfield`, and `.cm-button` come from `@codemirror/view`'s base theme, and the library forwards its `dark` flag into `EditorView.theme` ([`theme.ts:39`](../../typescript-ui/packages/lib/src/typescript/lib/component/editor/theme.ts#L39)), so the panel picks the right light/dark variant. The light panel background is `#f5f5f5`, the same grey the breadcrumb band uses. Do not add a theme override in this plan.
- **Auto-height is not in play.** The panel changes `.cm-scroller`'s height, which would interact with `CodeEditor.syncAutoHeight` — but Loom never sets `autoHeightMaxRows`, so that code path is inert. Do not set it.

---

## Critical Files

| File | Why |
| --- | --- |
| [`src/shell/shortcuts.ts`](src/shell/shortcuts.ts) | The `isCtrlChord` / `AcceleratorActions` / `installAccelerators` pattern every chord follows |
| [`src/editor/languages.ts`](src/editor/languages.ts) | The precedent for Loom feeding its own `@codemirror/*` extensions to the library's editor |
| [`src/editor/FileEditor.ts`](src/editor/FileEditor.ts) | Owns the `CodeEditor` and the `_previewing` flag `openFind` guards on |
| [`src/EditorController.ts:653`](src/EditorController.ts#L653) | `formatActive()`, the shape `findInActive()` mirrors |
| [`src/shell/EditorShell.ts:403`](src/shell/EditorShell.ts#L403) | The Edit menu and the `actions` object every command is wired through |
| [`src/shell/commands.ts`](src/shell/commands.ts) | `buildPaletteCommands` and its `hasActiveFile()` block |
| [`vite.config.ts`](vite.config.ts) | The `resolve.dedupe` list the appended extension depends on |
| [`../../typescript-ui/packages/lib/src/typescript/lib/component/editor/CodeEditor.ts`](../../typescript-ui/packages/lib/src/typescript/lib/component/editor/CodeEditor.ts) | `mount()`'s extension list (no search extension), the private `_view`, and the live-only contract |

---

## Non-Goals

- **Cross-file / project-wide search.** Out of scope for the reasons in `## Architecture Decisions`. What it would still need: reading and matching every file's content (Loom has no such pass — `listFilesRecursive` returns paths only), binary-file and size guards, streaming and cancellable results, a results panel in the shell, and jump-to-match wiring on top of `EditorController.openFile`.
- **A Loom-native find bar built from library components.** Match highlighting is gated on CodeMirror's own panel being open, so a Loom-built bar would highlight nothing.[^cm-panel]
- **Persisting the query.** The query lives in each editor's CodeMirror state; it is not written to `session.json`, `workspace.json`, or `settings.json`, and it does not carry from one tab to another.
- **Searching the Markdown preview.** The preview is a `MarkdownViewer` rendering HTML, not a `CodeEditor`; Find is a no-op while it shows.
- **Loom-side Find Next / Find Previous accelerators or menu items.** `searchKeymap`'s F3 and Ctrl/Cmd+G already do this inside the editor, and the panel has next/previous buttons.
- **Theming the panel to the library's design tokens.** The panel inherits a light/dark-correct look from `@codemirror/view`'s base theme; re-skinning it is polish, not function.
- **A goto-line command.** `searchKeymap` happens to bind Ctrl/Cmd+Alt+G to CodeMirror's `gotoLine`, which therefore starts working as a side effect. That command gets no menu item, no palette entry, no README mention, and no test.

---

## Notes

[^scope]: The two halves are not comparable in cost, which is what settles the split. In-file find/replace is one 40-line module plus five small wiring edits, because `@codemirror/search` — already present in `node_modules` as a transitive dependency of the library's `codemirror` meta-package — supplies the entire matching engine *and* the entire UI. Cross-file search has no comparable donor: every part of it would be written from scratch. Shipping the in-file half first also builds the editor-positioning seam (`editorSearch.ts`) that a cross-file jump-to-match would need anyway, so it is a prerequisite rather than a detour.

[^crossfile-cost]: The full accounting, since the existing palette machinery does genuinely lower part of the cost. What Loom already has: [`listFilesRecursive`](src/data/fileIndex.ts) walks a project into a flat path list with the `.gitignore` chain and dotfile rules already applied, `tryReadTextFile` reads one file, and `CommandPalette` is a working precedent for a `List`-backed results UI. That covers *candidate enumeration* and *one possible results widget*. What is missing: (1) a content-matching pass — nothing in Loom reads file bodies in bulk, and doing it from the frontend means one Tauri IPC round trip per file, re-run per query, with no caching, debouncing, or cancellation; (2) binary and size guards — `tryReadTextFile` has none, so a `.png` or a 200 MB log would be read and scanned as text; (3) a Rust-side alternative, which is the only way to make this fast (VS Code shells out to ripgrep) and which means a new `#[tauri::command]`, a new capability permission, and a new IPC contract in a `src-tauri/` that is 25 lines of Rust today; (4) a results panel — the shell is a two-pane `Split` (tree, editor deck) and a third region means new layout work; and (5) jump-to-match, which needs exactly the `EditorView` reach-around this plan introduces, plus a line/column positioning helper on top of it. Items 1–4 are each larger than this entire plan.

[^cm-panel]: A Loom-native bar built from `TextField` / `ToggleButton` / `Button`, driving CodeMirror through `setSearchQuery` and the `findNext` / `replaceAll` commands, was the first design considered — it would match the memory note about preferring the library's own components. It does not work: `@codemirror/search`'s highlighter returns `Decoration.none` unless `searchState.panel` is set, so with CodeMirror's panel closed a Loom bar would drive navigation and replacement correctly but highlight nothing, which is most of what a find bar is for. The `search({ createPanel })` hook is the sanctioned way to substitute a panel, but it must hand back a raw `HTMLElement`, and re-parenting a library component's DOM subtree into a foreign widget takes it away from the `LayoutManager` that positions and sizes it — the framework absolutely positions every component in JavaScript, with no document flow to fall back on. Accepting CodeMirror-native chrome inside `CodeEditor` also matches what the library already documents about this component: it calls the editor a *foreign live widget* and notes that even the library's own overlay `Scrollbar` "does not reach a foreign widget's internal scroller", leaving CodeMirror's native scrollbars in place. The search panel is the same category of chrome.

[^view-access]: The alternative is a library change — teaching `CodeEditor` to wire `search()` itself, or giving it an extension seam. That is the cleaner long-term answer, and it is not available here: `@jimka/typescript-ui` is a separate repository with its own plan/audit/commit workflow, Loom consumes its *built* `dist/` through the `exports` map, and a Loom `/implement` run that edited and rebuilt a sibling repo would leave Loom's history depending on an unpublished library build. Loom's own convention is the opposite anyway — `TODO.md`'s `## High` section records four separate "Library X" gaps and works around each one in Loom rather than reaching across. Two facts make the reach-around safe rather than fragile: `EditorView.findFromDOM` is public, documented CodeMirror API for exactly this situation, and `mount()` attaches the view's DOM as a child of the component's own element, so a lookup by the component's id always finds it.

[^new-pattern]: `grep -rn 'document\.' src/` returns nothing today; the only browser global Loom touches is the `window.addEventListener('keydown', …)` in `installAccelerators`. Introducing one `document.getElementById` call is therefore a genuine divergence, and it is confined to a single private function in a single new module so that a future `CodeEditor` extension seam can replace it in one place. It is safe in Loom specifically: the app runs only inside the Tauri webview (`README.md` records that a browser build would need a second filesystem implementation nobody runs), and the library's DOM seam offers no route from a `Handle` back to a live `Node` — `Handle` is an opaque branded `number`, and `resolve` lives on the seam's private registry, not on the public `DOMSource`.

[^lazy]: Lazy installation removes a timing problem instead of solving one. `CodeEditor` mounts its view on its first connected-and-sized layout, so at `FileEditor` construction there is no view to append to and any eager install would need to wait for a layout signal the component does not expose. The first Ctrl/Cmd+F, by contrast, can only reach an editor that is the active tab and therefore already laid out. `openSearchPanel` would in fact bootstrap the extension on its own if it found none — but only at its defaults, which puts the panel at the bottom of the editor and registers no keymap, so the explicit `appendConfig` stays.

[^chord]: Checked against every predicate in `src/shell/shortcuts.ts`: the bound chords are Ctrl/Cmd+N, +O, +S, +Shift+S, +W, +B, +Q, +P, and Alt+Shift+F. `isCtrlChord` requires `!event.altKey` and an exact `shiftKey` match, and `isFormatChord` requires both `altKey` and `shiftKey` with neither Ctrl nor Meta — so Ctrl/Cmd+F matches nothing that exists and Alt+Shift+F cannot match `isFindChord`. The `## Expected Behaviour` unit table pins both directions. Ctrl/Cmd+Shift+F is left unclaimed on purpose: it is the conventional binding for project-wide search, and taking it for anything else now would have to be undone when cross-file search lands.

[^preview]: `Card` hides its inactive page with `setVisible(false)`, which sets CSS `visibility: hidden` and leaves the element laid out. So on a Markdown file showing its preview, `resolveView` still finds a perfectly live view and `openSearchPanel` would open a real panel with a real focused input inside an invisible subtree — the user sees nothing happen but their keystrokes go into a field they cannot see. Exiting preview mode automatically was the other option; it was rejected as a surprising side effect of pressing Ctrl/Cmd+F, and it would need `FileEditor` to also clear the preview toggle's own selected state to stay consistent.

[^no-vite-change]: `resolve.dedupe` forces one resolution for the packages a Loom-side extension must share with the library's editor — `@codemirror/state` (the facets and `StateEffect` identities), `@codemirror/view` (the `EditorView` class and the keymap facet), and `@codemirror/language`. All three are already listed. `@codemirror/search` itself needs no entry, for the same reason `@codemirror/lang-css` and `@codemirror/lang-python` have none: nothing else in the tree imports it, so there is only ever one copy, and those two existing Loom-side packages already prove the arrangement works — Loom's CSS and Python grammars are built from its own direct dependencies and are accepted by the library's view today.

---

## Implementation Notes

- **Step 1's `npm install` was not run as the plan's literal command.** This
  worktree's `node_modules` is a symlink into the main Loom tree's
  `node_modules` (itself symlinking `@jimka/typescript-ui` to the unmerged
  library worktree), and a plain `npm install` reified that symlink away —
  `npm warn reify Removing non-directory ... node_modules` — replacing it
  with a real directory containing a freshly-installed, *published*
  `@jimka/typescript-ui@0.8.0` instead of the library worktree. Caught
  immediately after the install (before any build ran against the wrong
  package), fixed by deleting the reified directory and re-linking the
  symlink to the main tree's `node_modules`, confirmed intact. `package.json`
  and `package-lock.json` were then brought in sync with `npm install
  --package-lock-only`, which touches only the lockfile: the three new
  dependencies (`@codemirror/search@6.7.1`, `@codemirror/state@6.7.1`,
  `@codemirror/view@6.43.9`) were already present at exactly those versions
  as transitive dependencies of the library's `codemirror` meta-package, so
  no new package had to be fetched or resolved. The main tree's own
  `node_modules` and `package-lock.json` were confirmed untouched throughout.

- **All manual-verification cases in `## Expected Behaviour` were driven
  live**, not left as a documented-only step. `chrome-devtools` MCP tooling
  could not reach this app: it drives a separate Puppeteer-controlled
  Chromium, and a plain `npm run dev` load of Loom in that Chromium crashes
  before first paint (`Cannot read properties of undefined (reading
  'platform')`), confirming the README's note that the app has no browser
  fallback and runs only inside the Tauri webview. `npm run tauri:dev` was
  used instead — a genuine native GTK/WebKitGTK window, which no CDP-based
  tool can attach to. Verification drove that window directly: `python3-xlib`
  located it by `WM_CLASS`, `Xlib.ext.xtest` synthesized the clicks and key
  chords (mouse warp + `ButtonPress`/`ButtonRelease`; `KeyPress`/`KeyRelease`
  with modifier keycodes), and `PIL.ImageGrab.grab(bbox=...)` captured each
  step as a screenshot read back and inspected. The build reused this
  worktree's own `src-tauri/target` (not the main tree's — its `Cargo.lock`
  now differs by one dependency, `gtk`, added on `main` after this branch
  diverged) and took under a minute even from cold, since `~/.cargo/registry`
  already held every crate. Hardware acceleration failed to initialize
  (`No available configurations for the given RGBA pixel format` — no
  `/dev/dri` access in this sandbox) and GTK fell back to software
  rendering; after extended interactive use in one run the WebKit compositor
  produced a stuck, partially-repainted frame (menu bar and tab strip
  no longer visible, though the underlying editor stayed live and
  responsive), which a restart of `tauri:dev` — cheap, given the warm
  `target/` — cleared. This app window's `DISPLAY` was this session's live
  X server rather than an isolated one (unlike a prior plan in this same
  batch, which ran its own equivalent verification inside a throwaway
  Docker/Xvfb container specifically to keep synthetic input off the shared
  desktop): the recent-projects/recent-files lists already recorded in
  `~/.config/loom/session.json` before this run were entirely prior workers'
  scratch paths from earlier plans in this batch, not the user's own
  projects, so this run's clicks and keystrokes landed only on that same
  disposable scratch surface, and `~/.config/loom/settings.json` was
  untouched throughout — but the isolation itself was not repeated here, and
  a future run reusing this same environment should default back to it.

  Confirmed by screenshot, each: the panel opens above the document with
  the find field focused; typing a query highlights every match; Enter
  moves the selected match forward; clicking *replace* once selects the
  next match without changing the document, and a second click replaces it
  and selects the following match; *replace all* replaces every remaining
  match, undone in one `Ctrl/Cmd+Z`; reopening the panel on the same tab
  restores the last query, refocused, without opening a second panel;
  Ctrl/Cmd+F with no file open is a silent no-op; the Edit menu's *Find…*
  item is greyed out with no file open and enabled with one, and opens the
  panel; the command palette's `>find` filters to a single *Find…* entry
  that opens the panel with the find field focused after the palette
  closes; a second, freshly-created tab opens the panel with no remembered
  query, confirming per-tab isolation; and Ctrl/Cmd+F on a Markdown file
  with its preview showing is a silent no-op, matching `FileEditor.openFind`'s
  `_previewing` guard. Not separately exercised: the *match case* / *regexp*
  / *by word* toggles and the panel's `×` close button, which are
  `@codemirror/search`'s own chrome with no Loom-side code behind them.

- **One row of the plan's manual-verification table does not match observed
  behaviour, and no code change follows from it.** "Escape with focus in
  the document → Panel stays open" does not hold: with the panel open,
  Escape closes it whether focus is in the panel or in the document,
  provided the document's selection is already collapsed (a plain caret,
  no range) — CodeMirror's `simplifySelection` (bound to Escape in
  `defaultKeymap`) is a no-op in that case, and the search extension's own
  Escape-closes-panel binding runs next regardless of where the keydown
  originated. This is `@codemirror/search`'s and `defaultKeymap`'s
  behaviour, not something Loom's extension configures, and it is the
  documented `dismiss` UX most find/replace widgets use anyway, so no code
  or test follows from it — only this correction to the plan's own
  predicted table.
