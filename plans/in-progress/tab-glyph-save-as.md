---
touches-shared: [src/EditorController.ts, tests/fileIcons.test.ts, README.md, TODO.md]
---

# Tab Glyph Sync on Save As — Implementation Plan

## Overview

Loom's tabs already carry a per-file-type icon: both `addTab` calls pass one —
[src/EditorController.ts:389](src/EditorController.ts#L389) for an untitled buffer and
[src/EditorController.ts:490](src/EditorController.ts#L490) for a file read from disk — each derived
by [`glyphNameForPath`](src/fileIcons.ts#L121), the same function the tree row renderer
([src/explorer/FileTree.ts:95](src/explorer/FileTree.ts#L95)) and the command palette
([src/shell/CommandPalette.ts:156](src/shell/CommandPalette.ts#L156)) use. What is missing is the
update: an icon is written once, at tab-open time, and never again.

So when a file's path changes under an open tab, the icon goes stale. A *Save As* from `notes.md`
to `notes.txt` leaves the Markdown icon on the tab, and a tree rename does the same. Every other
piece of chrome does follow the move — the tab label, the breadcrumb band, the editor's syntax
language, and the status bar's language readout — because
[`FileEditor.setPath`](src/editor/FileEditor.ts#L221) and the `setTabName` call beside it push them.

This plan adds the icon to that set. It introduces one private helper on `EditorController`,
`repointFile`, that wraps `FileEditor.setPath` and re-icons the tab through the library's
`Tab.setTabGlyph`. Both existing `setPath` call sites —
[`saveAs`](src/EditorController.ts#L615) and
[`relocateOpenFiles`](src/EditorController.ts#L267) — route through it, so the *Save As* fix and
the tree-rename fix land together. Nothing in `src/editor/FileEditor.ts` changes.

---

## Architecture Decisions

### The glyph update rides on a new `repointFile` helper that owns `FileEditor.setPath`

`EditorController` gets a private `repointFile(file, path)` that calls `file.setPath(path)` and
then re-icons the tab. The two existing `file.setPath(...)` calls are replaced by calls to it, so
no code outside the helper repoints an open file.[^one-helper]

The helper mirrors the established shape on the other side of the seam: `FileEditor.setPath`
([src/editor/FileEditor.ts:221](src/editor/FileEditor.ts#L221)) is already the one place that owns
"everything inside the file that must follow a path change" — name, syntax language, breadcrumbs,
Markdown-preview availability. `repointFile` is its counterpart for the chrome the controller owns,
because a `FileEditor` has no reference to the tab strip it sits in.

### The icon is rewritten only when the new path resolves to a different icon

`repointFile` reads the file's icon name before the repoint, reads it again after, and calls
`setTabGlyph` only when the two differ. That comparison is the guard, and it is what keeps a folder
rename — which changes no file's type — from rewriting every open tab's icon.[^guard]

| Path before | Path after | Icon before | Icon after | `setTabGlyph` called? |
|---|---|---|---|---|
| `notes.md` | `notes.txt` | `markdown` | `file-lines` | yes |
| `notes.md` | `draft.md` | `markdown` | `markdown` | no |
| `Untitled-1` | `notes.md` | `file` | `markdown` | yes |
| `Untitled-1` | `notes` | `file` | `file` | no |
| `src/a.ts` | `lib/a.ts` (parent folder renamed) | `js` | `js` | no |
| `README.md` | `README.MD` | `markdown` | `markdown` | no |

### `Tab.setTabGlyph`, not `TabBar.setEntryGlyph`

The re-icon goes through `this.tabs.getTab().setTabGlyph(file, glyph)`, matching how every other tab
operation in `EditorController` is addressed — by content component, through
`TabPanel.getTab()`. `TabBar.setEntryGlyph` and `clearEntryGlyph` are not called at
all.[^library-api]

### The existing `setTabName` calls stay exactly where they are

`repointFile` touches the icon only. The five `this.tabs.getTab().setTabName(...)` calls keep their
current positions and are not folded into the helper.[^label-untouched]

---

## Internal Structure

The new private method on `EditorController`, placed next to the other private tab helpers (after
`pinTab`, [src/EditorController.ts:822](src/EditorController.ts#L822)):

```typescript
/**
 * Repoints `file` at `path` and re-icons its tab when the new path resolves
 * to a different file-type icon than the old one did. Owns the read-before,
 * read-after ordering so no caller has to get it right, and is the only
 * place an open file's path changes.
 *
 * The icon is left alone when it would not change — `Button.setGlyph` has no
 * same-name early-out, so an unconditional call would tear down and rebuild
 * a tab's icon for nothing, once per open tab on a folder rename.
 *
 * @param file - The open file to repoint.
 * @param path - The file's new path.
 */
private repointFile(file: FileEditor, path: string): void {
    const previousGlyph = glyphNameForPath(file.getName())

    file.setPath(path)

    const glyph = glyphNameForPath(file.getName())

    if (glyph !== previousGlyph) {
        this.tabs.getTab().setTabGlyph(file, glyph)
    }
}
```

`file.getName()` is the file's base name once it has a path and its `Untitled-N` display name
before that, and `glyphNameForPath` resolves either — so the untitled-buffer case needs no branch
of its own. No new imports: `glyphNameForPath` is already imported at
[src/EditorController.ts:10](src/EditorController.ts#L10).

---

## Ordered Implementation Steps

1. **Confirm the library API is on disk.** Run
   `grep -n 'setTabGlyph' node_modules/@jimka/typescript-ui/dist/lib/types/layout/Tab.d.ts` — expect
   `setTabGlyph(content: Component, glyph: string): boolean`. It is present today; if it is not, the
   sibling library needs `npm run build:lib` before anything here typechecks.

2. **Add the tests** to `tests/fileIcons.test.ts`, inside the existing `describe('glyphNameForPath')`
   block. Two cases, both pinning the derivation `repointFile` compares against: `.md` and `.txt`
   resolve to different names (`'markdown'` vs `'file-lines'`), and the same base name under two
   different directories resolves to the same name. These pass before the change as well as after —
   they lock the premise the guard rests on, not the guard itself. Run `npm test`.

3. **Add `repointFile`** to `src/EditorController.ts`, exactly as given in `## Internal Structure`,
   directly below `pinTab`.

4. **Route `saveAs` through it.** At [src/EditorController.ts:615](src/EditorController.ts#L615),
   replace `file.setPath(target)` with `this.repointFile(file, target)`. Change nothing else in
   `saveAs` — `markSynced`, `pinTab`, `recordRecentFile`, the `setTabName` call, and the status-bar
   message all keep their current order.

5. **Route `relocateOpenFiles` through it.** At
   [src/EditorController.ts:267](src/EditorController.ts#L267), replace
   `file.setPath(relocatePath(filePath, oldPath, newPath))` with
   `this.repointFile(file, relocatePath(filePath, oldPath, newPath))`. Leave the `setTabName` line
   below it untouched.

6. **Fix the stale hedge in `relocateOpenFiles`'s doc comment.**
   [src/EditorController.ts:256](src/EditorController.ts#L256) currently reads "only the tracked
   path, tab label, and (where the tab strip supports it) icon change". The tab strip now supports
   re-iconing, so drop the parenthetical: "only the tracked path, tab label, and icon change".

7. **Check the invariant.** `grep -n '\.setPath(' src/EditorController.ts` — expect exactly one
   match, the `file.setPath(path)` line inside `repointFile`.

8. **Update `README.md`.** In the *Tabbed editing* highlight (README.md:54–60), which already says
   each tab carries the tree's per-file-type icon, add that the icon follows a *Save As* or a rename
   that changes the file's type.

9. **Update `TODO.md`.** Remove the **Wire up `Tab.setTabGlyph` / `TabBar.setEntryGlyph` for _Save
   As_** bullet from `## High` (TODO.md:11–16) and the **Stale tab icon after a cross-type _Save
   As_** bullet from `## Known issues / loose ends` (TODO.md:100–104). Leave the neighbouring
   `Tab.setTabItalic` and `List` row-state bullets in `## High` alone — they are separate items.

10. **Verify.** `npm run typecheck`, `npm test`, then the manual smoke tests in `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src/EditorController.ts` |
| Modify | `tests/fileIcons.test.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Unit-testable (`tests/fileIcons.test.ts`, node environment, no DOM)

| Call | Result |
|---|---|
| `glyphNameForPath('/p/notes.md')` | `'markdown'` |
| `glyphNameForPath('/p/notes.txt')` | `'file-lines'` |
| `glyphNameForPath('/p/src/a.ts')` vs `glyphNameForPath('/p/lib/a.ts')` | equal — the directory never affects the icon |

The first two already differ, which is why the cross-type *Save As* case must re-icon; the third is
why the folder-rename case must not.

### Manual verification (tab-strip rendering — the vitest suite runs in a DOM-free node environment)

Run `npm run tauri:dev` and open a project folder.

1. **Cross-type *Save As*.** Open `notes.md`. Its tab shows the Markdown icon. *File > Save As…*,
   change the name to `notes.txt`, confirm. The tab's icon becomes the lines-page icon without the
   tab closing or reopening, the label reads `notes.txt`, and the status bar's language readout
   changes with it.
2. **Same-type *Save As*.** Open `notes.md`, *Save As* to `draft.md`. The label changes; the
   Markdown icon stays put and does not flicker.
3. **Untitled first save.** *File > New File* — the tab shows the plain-page default icon. *Save*
   into `hello.py`. The tab takes the Python icon.
4. **Cross-type tree rename.** With `notes.md` open, right-click its tree row, *Rename*, to
   `notes.txt`. The tree row's icon and the open tab's icon both change, and neither the buffer's
   contents nor its dirty state is disturbed.
5. **Folder rename with several tabs open.** Open three or four files under one folder, rename the
   folder in the tree. Every tab keeps its own icon and its label; nothing flickers.
6. **Icons match the tree.** For each file above, the tab's icon is the same glyph the tree row
   shows for that file.
7. **Unaffected paths.** A plain *Save* (Ctrl/Cmd+S), a cancelled *Save As*, a *Save As* refused
   because the target is already open in another tab, an edit that marks a tab dirty, and an
   external-change reload all leave the tab's icon exactly as it was.

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — the whole suite, including the two new `fileIcons` cases.
- `grep -n '\.setPath(' src/EditorController.ts` — exactly one match, inside `repointFile`.
- `grep -rn 'setEntryGlyph\|clearEntryGlyph\|clearTabGlyph' src/` — zero matches.
- `npm run tauri:dev`, then the seven manual cases in `## Expected Behaviour`. The tab strip is the
  screen to watch; `npm run dev` in a browser is not enough, because *Save As* needs the native save
  dialog.

---

## Documentation Impact

- `README.md` — the *Tabbed editing* highlight gains the icon-follows-a-rename behaviour. No new
  file pointer is needed: that bullet already refers to the tree's icons, and the *File tree*
  highlight is where `src/fileIcons.ts` is named.
- `TODO.md` — the `## High` wiring bullet and the `## Known issues / loose ends` stale-icon bullet
  are both removed.

Loom publishes no API docs and has no barrel file, and `repointFile` is private, so there is nothing
else to update.

---

## Potential Challenges

- **Reading the old icon after the repoint.** The whole feature depends on reading
  `glyphNameForPath(file.getName())` *before* `file.setPath(path)` runs; read it after and the two
  names are always equal and the icon never updates. Keeping both reads inside `repointFile`, with
  no caller able to reorder them, is the mitigation — which is why step 4 and step 5 replace the
  `setPath` call itself rather than adding a line after it.
- **`saveAs` writes before it repoints.** `file.setPath(target)` sits after the successful
  `writeFileText`, so a failed write returns early and the tab keeps both its old path and its old
  icon. Swapping in `repointFile` at the same line preserves that; do not move the call earlier.
- **`setTabGlyph` returns a boolean.** It returns `false` for a content component with no tab. Every
  file `repointFile` is called with is in `_openFiles` and has a tab, so the return value is
  ignored — the same way all five existing `setTabName` calls ignore theirs.

---

## Critical Files

- [src/EditorController.ts](src/EditorController.ts) — the only source file changed. Read
  `relocateOpenFiles` (L262), `addFileTab` (L484), `newFile` (L377), `saveAs` (L591), and `pinTab`
  (L822) before editing.
- [src/fileIcons.ts](src/fileIcons.ts) — `glyphNameForPath` (L121) and the two lookup tables it
  reads; `FILE_ICON_GLYPHS` (L107) is what `src/main.ts:31` registers, so every name the function
  returns is safe to hand to `setTabGlyph`.
- [src/editor/FileEditor.ts](src/editor/FileEditor.ts) — `setPath` (L221) and `getName` (L235); the
  precedent `repointFile` mirrors.
- [../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts](../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts) —
  `setTabGlyph` (L1281) and the shared `applyTabGlyph` (L1313), which writes the glyph back to the
  tab's stored `LayoutConstraints` as well as swapping the live button icon.
- [../typescript-ui/packages/lib/src/typescript/lib/component/button/Button.ts](../typescript-ui/packages/lib/src/typescript/lib/component/button/Button.ts) —
  `setGlyph` (L1766), the call at the bottom of the chain, and the reason the update is guarded.
- [tests/fileIcons.test.ts](tests/fileIcons.test.ts) — the existing cases the two new ones sit
  beside.

---

## Non-Goals

- **Any change to `src/editor/FileEditor.ts`.** A `FileEditor` has no reference to the tab strip, so
  the icon cannot be its responsibility.
- **Calling `TabBar.setEntryGlyph` / `clearEntryGlyph`.** They exist for lazy tabs, which Loom does
  not use.[^library-api]
- **Calling `Tab.clearTabGlyph`.** Every Loom tab always has an icon — an unrecognised file type
  resolves to `glyphNameForPath`'s plain-page default rather than to nothing — so there is no case
  that clears one.
- **Changing which icon a file type gets.** The two tables in `src/fileIcons.ts` are untouched.
- **Automated tests for the tab strip itself.** The suite runs in a DOM-free node environment by
  deliberate choice (`vitest.config.ts`); rendering is verified live.[^manual-only]

---

## Notes

[^one-helper]: The alternative was to leave both `file.setPath(...)` calls alone and add a
    `setTabGlyph` line after each. It was rejected for two reasons. First, the guard needs the
    file's icon name read *before* `setPath` overwrites the name, so a bare added line puts an
    ordering trap at each call site: read it one line too late and the comparison is always equal
    and the feature silently does nothing. A helper that performs the repoint itself cannot be
    called in the wrong order. Second, a helper makes the rule greppable —
    `grep -n '\.setPath(' src/EditorController.ts` returning one match is a cheap check that no
    future path change forgets its icon, which is precisely the failure this plan is fixing.

[^guard]: `Tab.setTabGlyph` reaches `TabBar.setEntryGlyph`
    (`.../component/container/TabBar.ts:1524`), which calls `Button.setGlyph`
    (`.../component/button/Button.ts:1766`). `Button.setGlyph` has no same-name early-out: it
    constructs a fresh `ButtonIconGlyph`, rebuilds the button's content row, disposes the outgoing
    glyph, and calls `recomputePreferredSize()` — every time, even for the icon already showing.
    `relocateOpenFiles` loops over every open file under a renamed directory, and a directory rename
    never changes any file's base name, so an unguarded call would rebuild every one of those tabs'
    icons to land on the same glyph. Loom has already been bitten once by unnecessary per-event
    re-measurement in this area (see the `WIDEST_CURSOR_POSITION` comment at
    `src/EditorController.ts:26` and the standing forced-reflow entry in `TODO.md`), so the cheap
    string comparison is worth its two lines.

[^library-api]: Both APIs are confirmed present in the library Loom resolves — the source at
    `../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts:1281` and the built types at
    `node_modules/@jimka/typescript-ui/dist/lib/types/layout/Tab.d.ts:102`, which Loom's
    `@jimka/typescript-ui` symlink resolves through — so no library rebuild is needed. `Tab`'s own
    docs state the split: `setTabGlyph` keys on the content component and writes the glyph back to
    the tab's `LayoutConstraints`, so it survives a tear-off, a re-dock, and layout serialization;
    `TabBar.setEntryGlyph` keys on an owner-minted cell id, is view-only, and exists for a lazy tab
    whose content component does not exist yet. Loom always adds a tab with its content in hand
    (`addTab(file, ...)` at `src/EditorController.ts:389` and `:490`) and already addresses every
    other tab operation by content, so `setTabGlyph` is both the correct and the consistent choice.
    The `TODO.md` item names both methods; wiring the one that fits closes it.

[^label-untouched]: In `saveAs`, `markSynced` (clears the dirty flag) and `pinTab` (clears the
    temporary flag) both run between the repoint and the `setTabName` call, and both change what
    `file.getLabel()` returns — the `" •"` dirty suffix and the `"~"` temp prefix. Moving the label
    write into `repointFile` would therefore render the label from state that has not settled yet.
    The icon has no such dependency: it is a pure function of the path.

[^manual-only]: `vitest.config.ts` sets `environment: 'node'` with the comment that component and
    DOM behaviour is verified live. Adding a DOM environment for one assertion would be a larger
    change than this fix, and the assertion would be about the library's rendering rather than
    Loom's logic. The part of this change that is Loom's own logic — which icon a path resolves to —
    is already pure and already unit-tested.
