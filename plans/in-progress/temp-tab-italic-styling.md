---
touches-shared: [src/EditorController.ts, README.md, TODO.md]
---

# Temp Tab Italic Styling — Implementation Plan

## Overview

A temp tab — the one tab a single click in the file tree recycles — marks itself today with a `~`
prefix on its label, built by [`FileEditor.getLabel`](src/editor/FileEditor.ts#L330) from the
`TEMPORARY_LABEL_PREFIX` constant ([src/editor/FileEditor.ts:33](src/editor/FileEditor.ts#L33)).
`@jimka/typescript-ui` now has the VS Code-style styling hook this was standing in for:
`Tab.setTabItalic(content, italic)` and its `TabBar.setEntryItalic` counterpart
([Tab.ts:1359](../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts#L1359),
[TabBar.ts:1587](../typescript-ui/packages/lib/src/typescript/lib/component/container/TabBar.ts#L1587)),
already built into the sibling checkout this tree's `node_modules/@jimka/typescript-ui` symlinks
to.[^library-already-resolved]

This plan swaps the prefix for italics. `FileEditor.getLabel` drops its temporary branch entirely,
and `EditorController` — the sole owner of the tab strip — calls `Tab.setTabItalic` at the three
places that already flip `FileEditor`'s `_temporary` flag:
[`addFileTab`](src/EditorController.ts#L484) (a new temp tab is born italic),
[`pinTab`](src/EditorController.ts#L822) (promotion to permanent turns it upright — covering the
first edit, a tab double-click, a tree double-click, and *Save As*, every one of which already
routes through `pinTab`), and
[`reloadFromDisk`](src/EditorController.ts#L917) (an external-change reload re-applies whatever
italic state the file already had). No new event, no new field, and no change to when a file
becomes or stops being temporary — only how that state is painted.

---

## Architecture Decisions

### Italics fully replace the `~` prefix

`TEMPORARY_LABEL_PREFIX` and its use in `getLabel` are deleted; nothing keeps the tilde around
during a transition. The prefix existed only because the library gave `Tab` no styling hook and
kept `TabBar` private[^full-replacement] — both gone now that `setTabItalic` exists — so there is
no remaining reason to keep it.

### `_temporary` stays the single source of truth; italic is a rendering side effect of it

`FileEditor.isTemporary()`/`setTemporary()` are unchanged — they still gate the "at most one temp
tab" rule in `openFile`/`closeTemporaryTab`. `getLabel()` stops reading `_temporary` at all;
`EditorController` reads it instead, through `file.isTemporary()`, wherever it already calls
`Tab.setTabName` after touching the flag.

| Trigger | `_temporary` before → after | Call added |
|---|---|---|
| `addFileTab(path, text, true)` — a temp open | (new tab) → `true` | `setTabItalic(file, true)` |
| `addFileTab(path, text, false)` — a permanent open or restore | (new tab) → `false` | `setTabItalic(file, false)` |
| `pinTab(file)` runs to completion | `true` → `false` | `setTabItalic(file, false)` |
| `pinTab(file)` early-outs (already pinned) | `false` → `false` | none |
| `reloadFromDisk(file, text)` | `x` → `x` (cleared and restored around the swap) | `setTabItalic(file, file.isTemporary())` |

### The italic call is unconditional in `addFileTab`, not guarded like `repointFile`'s glyph call

`addFileTab` calls `setTabItalic(file, temporary)` on every tab it builds, including the
`temporary: false` calls from `restoreFiles` and `openFile`'s permanent path — it does not skip the
call when `temporary` is `false`.[^unconditional-call] This differs from
[`plans/tab-glyph-save-as.md`](plans/tab-glyph-save-as.md)'s `repointFile`, which guards its
`setTabGlyph` call to skip a same-value rewrite — that guard exists because `Button.setGlyph` tears
down and rebuilds the button's icon on every call, while `Button.setFontStyle` just writes a style
property.

### Save As needs no new call site

`saveAs` already calls `this.pinTab(file)` right after repointing the file
([src/EditorController.ts:615-617](src/EditorController.ts#L615)), which is what un-italicises a
temp tab saved to a new name — the same call that already clears its `~`. That line is unaffected
by whether [`plans/tab-glyph-save-as.md`](plans/tab-glyph-save-as.md)'s `repointFile` helper has
replaced the `file.setPath(target)` line above it: `repointFile` only wraps the path/glyph update,
never `pinTab`, so the two plans touch adjacent but non-overlapping lines in `saveAs` regardless of
which lands first.[^saveas-no-new-callsite]

### No use of `TabBar.setEntryItalic` or `Tab.isTabItalic`

Every tab operation in `EditorController` already addresses the tab by content component through
`this.tabs.getTab()` — `setTabName`, `setTabGlyph`-to-be, `closeTab`, `getActiveContent`. This plan
follows the same seam: `Tab.setTabItalic(file, ...)`, never `TabBar.setEntryItalic`, which exists
for a lazy tab whose content hasn't materialised — Loom never adds a lazy tab. `Tab.isTabItalic` is
never called either: `FileEditor.isTemporary()` is already the flag's source of truth, so nothing
needs to ask the tab strip to read its own styling back.

---

## Internal Structure

`src/editor/FileEditor.ts` — `TEMPORARY_LABEL_PREFIX` (line 33) is deleted. `getLabel` (lines
324-336) drops its temporary branch:

```typescript
/** The tab label: the display name, suffixed with `" •"` while the document is dirty. */
getLabel(): string {
    return this.isDirty() ? `${this._name} •` : this._name
}
```

The class doc comment's temp-tab paragraph (lines 58-61) changes from "tracked here as
`_temporary` and folded into {@link getLabel}" to reading back through `isTemporary` instead, and
its opening paragraph's list of `Tab` operations `EditorController` addresses through this wrapper
(line 50) gains `setTabItalic` beside `setTabName`.

`src/EditorController.ts` — `addFileTab` (lines 484-494):

```typescript
private addFileTab(path: string, text: string, temporary: boolean = false): FileEditor {
    const file = FileEditor({ path, name: baseName(path), text, projectRoot: this._projectRoot })

    file.setTemporary(temporary)
    file.onDirtyChange(() => this.handleDirtyChange(file))
    file.getEditor().on('cursorchange', () => this.handleCursorChange(file))
    this.tabs.addTab(file, file.getLabel(), { closeable: true, glyph: glyphNameForPath(path) })
    this.tabs.getTab().setTabItalic(file, temporary)
    this._openFiles.push(file)

    return file
}
```

`pinTab` (lines 822-836):

```typescript
private pinTab(file: FileEditor): void {
    if (!file.isTemporary()) {
        return
    }

    const path = file.getPath()

    file.setTemporary(false)

    if (path !== null) {
        this.recordRecentFile(path)
    }

    this.tabs.getTab().setTabName(file, file.getLabel())
    this.tabs.getTab().setTabItalic(file, false)
}
```

`reloadFromDisk` (lines 917-925):

```typescript
private reloadFromDisk(file: FileEditor, diskText: string): void {
    const wasTemporary = file.isTemporary()

    file.setTemporary(false)
    file.adoptDiskText(diskText)
    file.setTemporary(wasTemporary)
    this.tabs.getTab().setTabName(file, file.getLabel())
    this.tabs.getTab().setTabItalic(file, file.isTemporary())
    this.statusBar.setMessage(`Reloaded ${file.getLabel()}`, STATUS_MESSAGE_DURATION_MS)
}
```

The trailing `setTabItalic` call runs after `wasTemporary` has been restored, so it always reflects
the file's real, settled state — it is a no-op in the common case (the flag's net value never
changed across the swap) but keeps the tab's italic styling a direct function of `isTemporary()`
rather than assuming nothing in between the clear and the restore could disturb it.

---

## Ordered Implementation Steps

1. **`src/editor/FileEditor.ts`** — delete the `TEMPORARY_LABEL_PREFIX` constant and its doc
   comment ([lines 29-33](src/editor/FileEditor.ts#L29)).

2. **Same file** — replace `getLabel()` and its doc comment
   ([lines 324-336](src/editor/FileEditor.ts#L324)) with the version in `## Internal Structure`.

3. **Same file** — update the class-level doc comment: add `setTabItalic` to the list of `Tab`
   operations `EditorController` addresses through this wrapper
   ([line 50](src/editor/FileEditor.ts#L50)), and rewrite the temp-tab paragraph
   ([lines 58-61](src/editor/FileEditor.ts#L58)) to say the flag is read back through
   `isTemporary()` rather than folded into `getLabel`.

4. Check: `grep -n 'TEMPORARY_LABEL_PREFIX' src/editor/FileEditor.ts` — zero matches. `grep -n "'~'"
   src/editor/FileEditor.ts` — zero matches.

5. **`src/EditorController.ts`** — in `addFileTab`
   ([line 484](src/EditorController.ts#L484)), add
   `this.tabs.getTab().setTabItalic(file, temporary)` immediately after the `this.tabs.addTab(...)`
   call ([line 490](src/EditorController.ts#L490)), and extend the doc comment per `## Internal
   Structure`.

6. **Same file** — in `pinTab` ([line 822](src/EditorController.ts#L822)), add
   `this.tabs.getTab().setTabItalic(file, false)` immediately after the `setTabName` call
   ([line 835](src/EditorController.ts#L835)), and extend the doc comment per `## Internal
   Structure`.

7. **Same file** — in `reloadFromDisk` ([line 917](src/EditorController.ts#L917)), add
   `this.tabs.getTab().setTabItalic(file, file.isTemporary())` immediately after the `setTabName`
   call ([line 923](src/EditorController.ts#L923)), and extend the doc comment per `## Internal
   Structure`.

8. Check: `grep -c 'setTabItalic' src/EditorController.ts` — exactly 3 (the calls in `addFileTab`,
   `pinTab`, and `reloadFromDisk`). `grep -n 'setEntryItalic\|isTabItalic\|clearTabItalic'
   src/EditorController.ts` — zero matches.

9. `npm run typecheck` — clean. A failure naming `setTabItalic` as missing on `Tab` means the
   `node_modules/@jimka/typescript-ui` symlink is not resolving to the sibling checkout; see `##
   Potential Challenges`.

10. **`README.md`** — rewrite the *Tabbed editing* bullet's temp-tab sentence
    ([line 55](README.md#L55)), which today reads "A temp tab shows a `~` before its name and
    becomes permanent on the first edit, on a double-click in the tree, on a double-click of the
    tab itself, or on a *Save As*." Change "shows a `~` before its name and becomes permanent" to
    "renders its label in italics and becomes upright" — leave the rest of the sentence (the list of
    promotion triggers) as it is.

11. **`TODO.md`** — delete the **Wire up `Tab.setTabItalic` for temp tabs.** bullet
    ([lines 22-27](TODO.md#L22)) from `## High`. Leave the neighbouring `Tab.setTabGlyph` and
    `List` row-state bullets alone — they are separate items.

12. `npm run typecheck && npm test && npm run build` — all clean; no test file changes, so the
    suite must be green unchanged.

13. Manual: `npm run tauri:dev`, then walk every case in `## Expected Behaviour` in the app window.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src/editor/FileEditor.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

Every case is **manual verification** in the Tauri window (`npm run tauri:dev`), matching how
`plans/implemented/temp-tabs.md` and `plans/implemented/pin-tab-on-doubleclick.md` verified the
mechanism this plan re-styles — Loom's vitest suite runs in a DOM-free `node` environment with no
component harness (`vitest.config.ts`), and every behaviour here is tab-strip rendering. Open a
project folder with at least three files, none opened earlier in the session.

1. **A single-click temp tab is italic, with no `~`.** Click `a.ts` in the tree: its tab reads
   `a.ts`, rendered in italics, with no tilde anywhere in the label.
2. **Recycling keeps the italic style.** Click `b.md`: the `a.ts` tab is gone, `b.md`'s tab is
   italic in its place.
3. **Typing un-italicises the tab.** With `b.md`'s temp tab active, type one character: the label
   turns upright and gains the dirty dot (`b.md •`) in the same motion the `~` used to disappear in.
4. **A tree double-click un-italicises.** Double-click `c.ts` in the tree: its tab is upright with
   no italics.
5. **A tab double-click un-italicises.** Click `d.ts` (italic temp tab), then double-click that tab
   button: it turns upright, matching `plans/implemented/pin-tab-on-doubleclick.md`'s case 1 with
   italics standing in for the removed `~`.
6. **Save As un-italicises.** With an italic temp tab active, *File > Save As…* to a new name: the
   tab is relabelled and upright, with no italics and no `~`.
7. **A permanent open is never italic.** *File > Open Recent* a file, or open one that is already
   pinned: its tab is upright throughout.
8. **A new file is never italic.** *File > New File*: the untitled tab is upright.
9. **A restored tab is upright.** With a temp tab open, exit and relaunch: the file comes back as an
   upright tab (temp state is not persisted, matching `plans/implemented/temp-tabs.md`'s Non-Goals).
10. **An external reload preserves the temp tab's italic style.** With an italic temp tab showing a
    file, edit that file from outside the app (another editor) without touching the Loom tab: the
    buffer reloads and the tab is still italic afterward, with no visible flicker to upright and
    back.
11. **An external reload leaves a permanent tab upright.** Repeat case 10 on an already-pinned tab:
    it reloads and stays upright.
12. **No tilde survives anywhere.** Across every case above, no tab label ever shows a `~`.

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — clean; no test file changes, so the suite must be green unchanged.
- `npm run build` — clean.
- `grep -n 'TEMPORARY_LABEL_PREFIX' src/editor/FileEditor.ts` — zero matches.
- `grep -c 'setTabItalic' src/EditorController.ts` — exactly 3.
- `grep -n 'setEntryItalic\|isTabItalic\|clearTabItalic' src/` — zero matches.
- `grep -n '~' README.md` — zero matches (the *Tabbed editing* bullet was the only one).
- `grep -n '~' TODO.md` — zero matches (the deleted bullet was the only one).
- `git diff --name-only` — exactly the four files in the table above.
- Manual: `npm run tauri:dev`, then cases 1-12 above.

---

## Documentation Impact

- **README.md** — the *Tabbed editing* bullet's temp-tab sentence changes from describing the `~`
  prefix to describing italics; the rest of that sentence (the promotion triggers) is untouched.
- **TODO.md** — the **Wire up `Tab.setTabItalic` for temp tabs.** entry under `## High` is this
  plan's own backlog entry and is deleted, matching how Loom retires a TODO entry when its feature
  lands (commit `b7beded`, *Retire two resolved High-priority TODO items, reframe three others*,
  which reworded this exact bullet from a missing-capability report into the wiring task this plan
  closes). The neighbouring `Tab.setTabGlyph` and `List` row-state bullets stay — they are separate
  items with their own plans.
- Loom has no `docs/` tree and no generated API reference, so there is nothing else to update.

---

## Potential Challenges

- **`Tab.setTabItalic` returns a boolean**, `true` only when a matching tab was found. Every file
  `addFileTab`/`pinTab`/`reloadFromDisk` call it with is already in `_openFiles` and has a tab, so
  the return value is ignored — the same way every existing `setTabName` call in this file (which
  returns the identical shape) already ignores its own.
- **The reload dance's transient flag flip never reaches the tab.** `reloadFromDisk` clears
  `_temporary`, then restores it, before its own `setTabItalic` call runs — so the intermediate
  `false` value is never painted. This only holds because the whole dance is synchronous JavaScript
  with no `await` in between; do not introduce one without moving the `setTabItalic` call to match.
- **`Tab.setTabItalic`'s styling is view-only** — it is not written to the tab's `LayoutConstraints`,
  so it does not survive a tear-off or a saved layout. This matches
  `plans/implemented/temp-tabs.md`'s own Non-Goal (no persistence of which tab was temporary), so it
  is not a new gap this plan introduces.

---

## Critical Files

- [src/editor/FileEditor.ts](src/editor/FileEditor.ts) — `_temporary`, `isTemporary`,
  `setTemporary`, `getLabel` (all read in `## Internal Structure`), and the class doc comment.
- [src/EditorController.ts](src/EditorController.ts) — `addFileTab` (L484), `pinTab` (L822),
  `reloadFromDisk` (L917), `handleDirtyChange` (L949, the nearest caller of `pinTab` that needs no
  edit of its own), `saveAs` (L591, the other `pinTab` caller), and `handleTabDoubleClick` (L1043,
  the third).
- [../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts:1359-1383](../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts#L1359) —
  `setTabItalic`/`isTabItalic`, keyed by content component, the same seam every other `Tab` call in
  `EditorController` already uses.
- [../typescript-ui/packages/lib/src/typescript/lib/component/container/TabBar.ts:1587-1607](../typescript-ui/packages/lib/src/typescript/lib/component/container/TabBar.ts#L1587) —
  `setEntryItalic`/`isEntryItalic`, confirmed unused by this plan (lazy-tab only).
- [../typescript-ui/packages/lib/src/typescript/TabDemoPanel.ts:338-344](../typescript-ui/packages/lib/src/typescript/TabDemoPanel.ts#L338) —
  the library's own usage precedent: `this.tabPanel.getTab().setTabItalic(content, !...isTabItalic(content))`,
  confirming the call is addressed by content component exactly like `EditorController`'s other
  `Tab` calls.
- [plans/implemented/temp-tabs.md](plans/implemented/temp-tabs.md) — where `_temporary`, `pinTab`,
  and the `~` prefix came from, including the `[^tilde-prefix]` footnote recording that italics were
  the rejected-for-now alternative, blocked on exactly the library gap this plan's library update
  closes.
- [plans/implemented/pin-tab-on-doubleclick.md](plans/implemented/pin-tab-on-doubleclick.md) — the
  fourth `pinTab` caller (a tab-button double-click), unaffected by this plan but exercised by
  Expected Behaviour case 5.
- [plans/tab-glyph-save-as.md](plans/tab-glyph-save-as.md) — the sibling plan touching `saveAs` and
  `EditorController.ts`; read it for the exact call-site layout its `repointFile` helper adds, and
  see this plan's Save As decision for why the two plans don't collide there.

---

## Non-Goals

- **No change to when `_temporary` is set or cleared**, or to the "at most one temp tab" rule in
  `openFile`/`closeTemporaryTab`. This plan only changes how the flag is painted.
- **No use of `Tab.isTabItalic`, `TabBar.setEntryItalic`, or `TabBar.isEntryItalic`.**
  `FileEditor.isTemporary()` stays the flag's only source of truth; the two `TabBar`-level lazy-tab
  methods have no lazy tab in Loom to address.
- **No coordination with `plans/tab-glyph-save-as.md`'s `repointFile` helper.** The two plans touch
  adjacent, non-overlapping lines inside `saveAs`; see the Save As decision above.
- **No new automated tests.** Matches the precedent both `plans/implemented/temp-tabs.md` and
  `plans/implemented/pin-tab-on-doubleclick.md` set: `vitest.config.ts` runs a DOM-free `node`
  environment, so component/tab-strip rendering is verified live, not in the suite.
- **No change to `newFile()` or `restoreFiles()`** beyond what `addFileTab`'s existing `temporary`
  parameter (defaulting to `false`) already provides — neither ever passes `true`.

---

## Notes

[^library-already-resolved]: Unlike `plans/implemented/pin-tab-on-doubleclick.md`, which needed a
    manual symlink fix because its library event was unreleased, `setTabItalic` is already present
    in the checkout this tree resolves: `node_modules/@jimka/typescript-ui` is a symlink to
    `/home/jika/typescript/typescript-ui/packages/lib`, and that checkout's built type declarations
    (`dist/lib/types/layout/Tab.d.ts:105-106`) already list `setTabItalic`/`isTabItalic`. No library
    build or environment step is needed before this plan's typecheck.

[^full-replacement]: `plans/implemented/temp-tabs.md`'s own `[^tilde-prefix]` footnote records why
    the `~` was chosen in the first place: "VS Code italicises a preview tab's title. Loom cannot: a
    tab's label is set through `Tab.setTabName`, which takes a string, and `Tab` holds its `TabBar`
    in a private field, so there is no supported route to the `TabButton` that owns the text." Both
    reasons are gone — `setTabItalic` is a public, supported route — so nothing is left recommending
    the prefix, and `TODO.md`'s own bullet (retitled by commit `b7beded` from a missing-capability
    report to a wiring task) already frames this as the closing move, not a parallel option.

[^unconditional-call]: The alternative — skip the call when `temporary` is `false`, relying on a
    freshly built tab's default upright style (`Text`'s `_defaultTextOptions.fontStyle` is
    `"normal"`, confirmed in `Text.ts:70`) — was considered and rejected. It would make `addFileTab`
    correct only as long as nothing else changes the library's default, and it would make the
    invariant "a tab's italic state always equals `isTemporary()`" true by assumption rather than by
    construction. Calling it unconditionally costs one cheap style write per tab open (`Button
    .setFontStyle` just writes a `Text` style property — no rebuild, unlike `Button.setGlyph`, which
    is why `repointFile`'s `setTabGlyph` call needs its own guard and this one does not) and makes
    the invariant hold regardless of what the library's default happens to be.

[^saveas-no-new-callsite]: At the time of writing, `saveAs` calls `file.setPath(target)` directly
    ([src/EditorController.ts:615](src/EditorController.ts#L615)) — `plans/tab-glyph-save-as.md`'s
    `repointFile` helper, which would replace that one line, has not landed. Whichever plan is
    implemented first, the other's change lands on a line adjacent to but distinct from
    `this.pinTab(file)` (line 617 today), so there is no line-level conflict and no reason to
    sequence the two plans relative to each other.
