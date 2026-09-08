---
depends-on: [temp-tab-italic-styling, tab-glyph-save-as, tab-modified-glyph]
touches-shared: [src/EditorController.ts, src/editor/FileEditor.ts, README.md]
---

# Tab Modified Indicator — Implementation Plan

## Overview

[`FileEditor.getLabel`](src/editor/FileEditor.ts#L339) marks an unsaved file by appending a
trailing bullet to the tab's text label — `` isDirty() ? `${this._name} •` : this._name `` — so the
bullet is part of the same string as the file name. Loom's tabs now have a max
width ([`EditorController.ts:85`](src/EditorController.ts#L85), `tabMaxWidthPx` in
[`src/data/settings.ts`](src/data/settings.ts)), and a long file name ellipsises — taking the
trailing `" •"` with it, since it is part of the same truncated text run. The modified indicator
then silently disappears on exactly the tabs where it matters most.

The fix moves the indicator out of the label string into fixed tab chrome that never truncates.
VS Code's own approach — the close (✕) button swaps to a dot when a file is dirty, and back to ✕ on
hover — turns out not to be reachable with what `@jimka/typescript-ui` exposes today (see
`## Architecture Decisions`). Instead, this plan renders the dot as a small persistent glyph inside
the tab button's own content row, trailing the label, mirroring how the library's `SplitButton`
already keeps a fixed trailing chevron beside a truncating title.

The dot needs a new library capability — `Tab.setTabModified` / `TabBar.setEntryModified` /
`TabButton.setModified` — that does not exist in `@jimka/typescript-ui` yet. Per this repo's
established pattern for exactly this situation (a Loom feature blocked on a small library
addition), that capability gets its own plan in the sibling `typescript-ui` repo rather than being
implemented inline here; `## Addendum: typescript-ui Library Prerequisite` gives its full contract.
This plan's own scope is the Loom side: consuming that new API, and deleting the now-dead trailing
bullet.

This plan depends on two already-implemented sibling plans that established the same "per-entry
`Tab`/`TabBar` styling hook, wired to `EditorController`'s existing dirty/lifecycle call sites"
shape this plan follows:
[`plans/implemented/temp-tab-italic-styling.md`](plans/implemented/temp-tab-italic-styling.md)
(added `setTabItalic`/`setEntryItalic` and wired them into `addFileTab`, `pinTab`, and
`reloadFromDisk`) and
[`plans/implemented/tab-glyph-save-as.md`](plans/implemented/tab-glyph-save-as.md) (added the
`repointFile` helper and wired `setTabGlyph` into it).

---

## Architecture Decisions

### The close-button hover-swap is a genuine library gap, not a small addition

VS Code's mechanism needs a way to swap *which* glyph a button shows, driven purely by `:hover`,
with no per-hover JS work. `@jimka/typescript-ui` has no such mechanism today: every `:hover`
style-tier rule in the library only ever repaints colors, borders, and shadows, never a glyph's
identity, and the one API that does change a glyph (`Button.setGlyph`) is expensive enough that a
sibling plan already had to guard it against redundant calls.[^close-swap-rejected] Closing that gap
would mean either new CSS-only content-swap plumbing with no precedent in this library, or a JS
hover handler paying that cost on every pointer movement across the strip — the exact class of
frequent, layout-forcing per-event cost `TODO.md` already flags as a standing trap in this app. This
plan does not touch the close button.

### The dot lives in the tab's content row, mirroring `SplitButton`'s trailing chevron

`SplitButton` already keeps a fixed-size `Glyph` — its dropdown chevron — as a real child of the
button's content row (`_content`, an `HBox`), trailing a truncating label; only the label shrinks
under `HBox` layout, so a second such fixed child is never clipped, the same way the tab's own
leading file-type glyph already survives truncation today.[^why-content-row] The modified dot
follows the identical shape: a `circle` glyph, colored with the tab strip's existing
`--ts-ui-tab-indicator-color` accent (the same token the active-tab underline already uses), sized
to `glyphXs` (8px at the default scale, matching the close ✕'s own size). `TabBar` already reserves
the close button's gutter as an inset on the tab button itself
([TabBar.ts:2050-2077](../typescript-ui/packages/lib/src/typescript/lib/component/container/TabBar.ts#L2050)),
so the dot needs no new layout math there. `circle` is a solid filled disc already registered in the
library's glyph set
([glyphs/solid/circle.ts](../typescript-ui/packages/lib/src/typescript/lib/glyphs/solid/circle.ts)) —
no new CSS variable, no new glyph registration file needed.

Truncation behaviour, worked:

| File name | Tab state | `tabMaxWidthPx` | Label shown | Dot shown? |
|---|---|---|---|---|
| `a.ts` | dirty | 200 (default) | `a.ts` | yes, right after the label |
| `a.ts` | clean | 200 (default) | `a.ts` | no |
| `very-long-component-name-that-keeps-going.tsx` | dirty | 200 (default) | `very-long-component-nam…` | yes — today's `" •"` suffix would be swallowed by the ellipsis here |
| `very-long-component-name-that-keeps-going.tsx` | dirty | 60 (narrowed in Settings) | `very-lo…` | yes — still visible even with almost no label text left |

### A new library capability, specified here, built in its own `typescript-ui` plan

This repo has an established pattern for exactly this situation — a Loom feature needing a small
`Tab`/`TabBar`/`TabButton` addition that doesn't exist yet: the addition gets its own plan in the
sibling `typescript-ui` repo's `plans/`, and the Loom plan takes a `depends-on` on it rather than
inlining the library edit.
[`plans/implemented/pin-tab-on-doubleclick.md`](plans/implemented/pin-tab-on-doubleclick.md)
depended on `../typescript-ui/plans/tab-doubleclick-event.md` this same way, down to the
`depends-on` frontmatter entry and the "treat it as an instruction to a human" footnote. This plan
follows that shape for a new plan named `tab-modified-glyph`, whose full required contract —
`Tab.setTabModified`/`isTabModified`, `TabBar.setEntryModified`/`isEntryModified`,
`TabButton.setModified`/`isModified`, and the content-row glyph mechanics — is specified in
`## Addendum: typescript-ui Library Prerequisite` below, so authoring or implementing that plan
needs no further design work.[^cross-repo-dependency] `## Ordered Implementation Steps` starts with
the mechanical check for whether it has landed.

### One new call site: `handleDirtyChange`

Unlike `setTabItalic`, which needed three call sites because `_temporary` changes independently at
`addFileTab`, `pinTab`, and `reloadFromDisk`, every way a file's dirty state can change — typing,
undo, `save`, `saveAs`, `reloadFromDisk` — funnels through the same `Component` `"dirtychange"`
event, which `addFileTab`/`newFile` already wire to `handleDirtyChange`.[^single-callsite] So that is
the single place `setTabModified` needs to be called; no call is added to `pinTab`, `saveAs`, or
`reloadFromDisk`, and none at tab-creation time, since a freshly opened or restored file is never
dirty at that instant.

### `getLabel()` is deleted, not just trimmed

After this change, `getLabel()`'s only remaining logic — the dirty-suffix ternary — is gone, and
its temp-tab prefix branch was already removed by `temp-tab-italic-styling.md`. What is left is
`return this._name`, an exact duplicate of the existing [`getName()`](src/editor/FileEditor.ts#L231).
Keeping a second, identically-behaved method around is the same class of dead code that plan was
careful to delete (`TEMPORARY_LABEL_PREFIX` and its only use), so `getLabel()` is deleted outright
and its nine call sites in `src/EditorController.ts` switch to `getName()`.

---

## Public API

```typescript
// src/editor/FileEditor.ts — deleted, no replacement (callers use the existing getName()):
getLabel(): string
```

The library additions this plan depends on — `Tab.setTabModified`/`isTabModified`,
`TabBar.setEntryModified`/`isEntryModified`, `TabButton.setModified`/`isModified` — are specified in
full in `## Addendum: typescript-ui Library Prerequisite`; they are not part of this plan's own
`src/` changes.

---

## Internal Structure

`src/editor/FileEditor.ts` — `getLabel` and its doc comment (currently
[lines 338-341](src/editor/FileEditor.ts#L338)) are deleted entirely, leaving `getName()` as the
one accessor for the tab's display text.

`src/EditorController.ts` — `handleDirtyChange`
([lines 1002-1014](src/EditorController.ts#L1002)):

```typescript
/**
 * Registered as a `Component` dirty-state listener on each open file: pins
 * the file's tab on its first edit, then relabels the tab, paints its
 * modified indicator, and resyncs the title/status bar.
 */
private handleDirtyChange = (file: FileEditor): void => {
    if (file.isDirty()) {
        this.pinTab(file)
    }

    this.tabs.getTab().setTabName(file, file.getName())
    this.tabs.getTab().setTabModified(file, file.isDirty())
    this.syncActive()
}
```

---

## Ordered Implementation Steps

1. **Confirm the library prerequisite has landed.** Run
   `grep -n 'setTabModified' node_modules/@jimka/typescript-ui/dist/lib/types/layout/Tab.d.ts` —
   expect `setTabModified(content: Component, modified: boolean): boolean;`. If it is missing, the
   `tab-modified-glyph` plan (`## Addendum` below) has not been implemented and merged into the
   `typescript-ui` checkout this tree's `node_modules/@jimka/typescript-ui` resolves to — stop here;
   see `## Potential Challenges`.

2. **`src/editor/FileEditor.ts`** — delete `getLabel()` and its doc comment
   ([lines 338-341](src/editor/FileEditor.ts#L338)).

3. **Same file** — update the class doc comment's list of `Tab` operations `EditorController`
   addresses through this wrapper ([line 45](src/editor/FileEditor.ts#L45)): add `setTabModified`
   after `setTabItalic`, so it reads `` `setTabName`, `setTabItalic`, `setTabModified`, `closeTab`,
   `getActiveContent` ``.

4. **Same file** — `setTemporary`'s doc comment
   ([line 330](src/editor/FileEditor.ts#L330)) reads "Changing the flag changes {@link getLabel}, so
   the owner relabels the tab afterwards." Change `{@link getLabel}` to `{@link getName}` — the
   underlying behavior (the owner re-calls `setTabName` after this flag changes) is unchanged, only
   the accessor's name is.

5. Check: `grep -n 'getLabel' src/editor/FileEditor.ts` — zero matches.

6. **`src/EditorController.ts`** — replace every `file.getLabel()` call with `file.getName()`, at
   [line 269](src/EditorController.ts#L269) (`relocateOpenFiles`),
   [line 390](src/EditorController.ts#L390) (`newFile`),
   [line 509](src/EditorController.ts#L509) (`addFileTab`),
   [line 648](src/EditorController.ts#L648) (`saveAs`),
   [line 748](src/EditorController.ts#L748) (`savedMessage`, two occurrences on one line),
   [line 865](src/EditorController.ts#L865) (`pinTab`),
   [lines 980,982](src/EditorController.ts#L980) (`reloadFromDisk`), and
   [line 1012](src/EditorController.ts#L1012) (`handleDirtyChange`, addressed together with step 7).
   Leave every other part of these lines unchanged.

7. **Same file** — in `handleDirtyChange` ([line 1007](src/EditorController.ts#L1007)), replace the
   body with the version in `## Internal Structure`: the `setTabName` call now reads `file.getName()`
   (from step 6) and gains a new `this.tabs.getTab().setTabModified(file, file.isDirty())` line
   immediately after it, before `syncActive()`. Extend the doc comment as shown there.

8. **`savedMessage`**'s doc comment ([line 743](src/EditorController.ts#L743)) reads "its label
   supplies the name" — change "label" to "name".

9. Check: `grep -n 'getLabel' src/EditorController.ts` — zero matches.
   `grep -c 'getName()' src/EditorController.ts` — at least the nine occurrences from step 6, plus
   any pre-existing ones.
   `grep -c 'setTabModified' src/EditorController.ts` — exactly 1 (the `handleDirtyChange` call).

10. `npm run typecheck` — clean. A failure naming `setTabModified`/`setTabName` as missing on `Tab`,
    or `getLabel` as missing on `FileEditor`, means either step 1's prerequisite hasn't landed or a
    call site was missed in step 6.

11. **`README.md`** — extend the *Tabbed editing* bullet's dirty-indicator sentence
    ([around line 62](README.md#L62)), which today reads "a dirty-indicator dot marks unsaved
    changes per tab." Add that the dot stays visible regardless of the tab's width or how long the
    file name is — e.g. "a dirty-indicator dot marks unsaved changes per tab, staying visible even
    when a long file name is truncated." Leave the rest of the bullet untouched.

12. `npm test && npm run build` — both clean; no test file changes, so the suite must be green
    unchanged.

13. Manual: `npm run tauri:dev`, then walk every case in `## Expected Behaviour` in the app window.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src/editor/FileEditor.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `README.md` |

---

## Expected Behaviour

Every case is **manual verification** in the Tauri window (`npm run tauri:dev`), matching how both
sibling plans verified tab-strip rendering — Loom's vitest suite runs in a DOM-free `node`
environment with no component harness. Open a project folder with at least one short-named and one
long-named file.

1. **Typing shows the dot.** Open a clean file, type one character: a small filled dot appears right
   after the label, in the strip's accent color. The label text itself does not shift or reflow
   beyond making room for the dot.
2. **Saving clears the dot.** With the dot showing, save (Ctrl/Cmd+S): the dot disappears
   immediately.
3. **Undo back to the saved state clears the dot.** Type a character (dot appears), then undo it
   (Ctrl/Cmd+Z) back to the file's last-saved text: the dot disappears, without saving.
4. **A long file name at the default tab width still shows the dot.** Open or create a file whose
   name is long enough to ellipsis at the default 200px cap, edit it: the label truncates, and the
   dot is visible immediately after the truncated text — this is the case today's `" •"` suffix
   fails.
5. **The dot survives a narrow tab-width cap.** In Settings, lower `tabMaxWidthPx` to something like
   60, so the label truncates to only a few characters. Edit a long-named file: the dot is still
   fully visible, not clipped or squeezed out.
6. **A temp tab shows italics and the dot together.** Single-click a file in the tree (temp tab,
   italic label), then edit it: the tab is italic (from `temp-tab-italic-styling`) and shows the dot,
   simultaneously, with no visual clash.
7. **A cross-type Save As clears the dot and updates the icon together.** Edit `notes.md` (dot
   shows), *Save As* to `notes.txt`: the dot clears, the tab's icon updates to the plain-text glyph
   (from `tab-glyph-save-as`), and the label reads `notes.txt` — all in the same repaint.
8. **An external reload that discards local changes clears the dot; keeping them leaves it.** With a
   dirty file, edit it outside the app and let Loom detect the conflict: choosing *Reload* clears the
   dot (the buffer becomes clean); choosing *Keep* leaves the dot showing (the buffer is still
   dirty).
9. **Several dirty tabs each show their own dot independently.** Edit three different open files:
   each tab shows its own dot; saving one clears only that tab's dot.
10. **Closing a dirty tab is unaffected.** The tab's ✕ close button is unchanged throughout every
    case above — clicking it on a dirty tab still raises the unsaved-changes prompt exactly as
    before, since this plan never touches the close button.

---

## Verification

- `npm run typecheck` — clean (after step 1's prerequisite check passes).
- `npm test` — clean; no test file changes, so the suite must be green unchanged.
- `npm run build` — clean.
- `grep -rn 'getLabel' src/` — zero matches.
- `grep -c 'setTabModified' src/EditorController.ts` — exactly 1.
- `git diff --name-only` — exactly the three files in the table above.
- Manual: `npm run tauri:dev`, then cases 1-10 above.

---

## Documentation Impact

- **README.md** — the *Tabbed editing* bullet's dirty-indicator sentence gains a clause about
  surviving truncation; the rest of the bullet is untouched.
- No `TODO.md` change: no existing bullet describes this bug, so there is nothing to retire.
- The library-side documentation for `Tab.setTabModified`/`TabBar.setEntryModified`/
  `TabButton.setModified` belongs to the `tab-modified-glyph` plan (`## Addendum` below) and is not
  restated here, matching how `plans/implemented/pin-tab-on-doubleclick.md` treated
  `"tabdblclick"`.
- Loom has no `docs/` tree and no generated API reference beyond this.

---

## Potential Challenges

- **A fresh worktree's `node_modules/@jimka/typescript-ui` resolves to the published package, not
  the sibling checkout.** Both sibling plans' Implementation Notes hit this: `npm install` pulls the
  registry version, which will not carry `setTabModified` until it is published. Restore the symlink
  the main tree uses: `ln -s /home/jika/typescript/typescript-ui/packages/lib
  node_modules/@jimka/typescript-ui`. The `tab-modified-glyph` library plan's branch must also be
  merged into that checkout first — this is step 1's mechanical check.
- **`setTabModified`/`setTabName`/`setTabGlyph`/`setTabItalic` all return a boolean**, `true` only
  when a matching tab was found. Every file `handleDirtyChange` is called with is already in
  `_openFiles` and has a tab, so the return value is ignored, matching every existing `setTabName`
  call in this file.
- **The dot's glyph is a real content-row child, not an overlay** — unlike the close button and the
  busy indicator, it is added via `addComponent`, so `TabButton`'s destructor must **not** explicitly
  dispose it: `Container`'s own child-disposal recursion already reaches it, and disposing twice
  would double-dispose. The Addendum's `## Internal Structure` calls this out explicitly.

---

## Critical Files

- [src/editor/FileEditor.ts](src/editor/FileEditor.ts) — `getLabel` (deleted, L338-341), `getName`
  (L231-233, the surviving accessor), the class doc comment (L42-58), and `setTemporary`'s doc
  comment (L328-336).
- [src/EditorController.ts](src/EditorController.ts) — `handleDirtyChange` (L1002-1014, the one new
  call site), and the nine other `getLabel()` call sites listed in `## Ordered Implementation Steps`
  step 6.
- [plans/implemented/temp-tab-italic-styling.md](plans/implemented/temp-tab-italic-styling.md) — the
  precedent for adding a per-entry `Tab`/`TabBar` styling hook and wiring it into
  `EditorController`'s existing lifecycle call sites; also where `getLabel`'s temp-tab prefix branch
  was removed, the direct predecessor to this plan's removal of its dirty-suffix branch.
- [plans/implemented/tab-glyph-save-as.md](plans/implemented/tab-glyph-save-as.md) — the precedent
  for a guarded `Button.setGlyph` call and for citing the exact cost that rules out a hover-driven
  glyph swap in `## Architecture Decisions` above.
- [plans/implemented/pin-tab-on-doubleclick.md](plans/implemented/pin-tab-on-doubleclick.md) — the
  precedent for a Loom plan depending on a not-yet-written `typescript-ui` plan, including the exact
  `depends-on` frontmatter shape and footnote treatment this plan reuses.
- [../typescript-ui/packages/lib/src/typescript/lib/component/button/SplitButton.ts](../typescript-ui/packages/lib/src/typescript/lib/component/button/SplitButton.ts) —
  `_chevron` and `_afterRebuildContentRow` (L97,141-156,223-227), the precedent the `tab-modified-glyph`
  plan's content-row glyph must mirror.
- [../typescript-ui/packages/lib/src/typescript/lib/component/button/TabButton.ts](../typescript-ui/packages/lib/src/typescript/lib/component/button/TabButton.ts) —
  `_busyIndicator`/`setBusy` (L76-93,386-420, the closest lazy-build-and-toggle precedent) and
  `buildCloseButton` (L319-352, the `ThemeManager.getResolvedScale()` sizing precedent).
- [../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts](../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts) —
  `setTabItalic`/`isTabItalic` (L1359-1383) and `setTabBusy`/`isTabBusy` (L1397-1420), the two shapes
  `setTabModified`/`isTabModified` must mirror.
- [../typescript-ui/packages/lib/src/typescript/lib/component/container/TabBar.ts](../typescript-ui/packages/lib/src/typescript/lib/component/container/TabBar.ts) —
  `setEntryItalic`/`isEntryItalic` (L1587-1607), `setEntryBusy`/`isEntryBusy` (L1641-1656), and
  `computeTabButtonInsets` (L2050-2077, why no new layout math is needed).

---

## Non-Goals

- **No close-button hover-swap.** Investigated and rejected — see `## Architecture Decisions`. The
  close button is completely unchanged by this plan.
- **No new CSS-only hover-content-swap mechanism added to the library.** The gap is real but out of
  scope; the content-row glyph sidesteps it entirely rather than closing it.
- **No use of `isTabModified`/`isEntryModified`/`TabButton.isModified`.** `FileEditor.isDirty()` (via
  `Component`'s own dirty tracking) stays the single source of truth; the getters exist for API
  symmetry with `isTabItalic`/`isTabBusy`, matching how `temp-tab-italic-styling.md` left
  `isTabItalic` unused by Loom.
- **No calls to `setTabModified` outside `handleDirtyChange`.** See the "One new call site" decision
  above.
- **No new automated tests.** Matches every sibling tab-chrome plan's precedent:
  `vitest.config.ts` runs a DOM-free `node` environment, so tab-strip rendering is verified live.
- **No change to how a dirty file blocks closing or exiting**, or to the unsaved-changes prompt
  itself — only how the modified state is painted on the tab at rest.

---

## Notes

[^close-swap-rejected]: Reaching the per-entry close button at all turns out to be the easy half:
    `TabBar`'s entry record already carries a `closeButton` field
    ([TabBar.ts:202](../typescript-ui/packages/lib/src/typescript/lib/component/container/TabBar.ts#L202)),
    exposed via `TabButton.getCloseButton()`
    ([TabButton.ts:361](../typescript-ui/packages/lib/src/typescript/lib/component/button/TabButton.ts#L361)),
    so a `setEntryCloseGlyph`-style accessor mirroring `setEntryGlyph` would be small and precedented
    on its own. The blocker is the swap itself. The library's state-tier mechanism
    (`ownStyleStates`, `writeStateStyle`) only ever extracts a `StyleBag` — colors, borders, shadows,
    sizes — from a `:hover`/`.pressed`/`.selected` rule; the full interface
    ([ClassStyleRules.ts:44-93](../typescript-ui/packages/lib/src/typescript/lib/core/ClassStyleRules.ts#L44))
    has no field for which SVG a glyph renders, and this was checked across every `:hover` entry in
    the library (`Button.ts`, `TabButton.ts`, `TabCloseButton.ts`, `ToggleButton.ts`,
    `MenuBarButton.ts`, `PickerButton.ts`, and others) — none swaps content, only paint. `Button.setGlyph`
    is the only way to change which glyph a button shows, and it is expensive by design: it constructs
    a fresh icon, rebuilds the content row, and calls `recomputePreferredSize()` on every call, not
    just changes — confirmed by [`plans/implemented/tab-glyph-save-as.md`](plans/implemented/tab-glyph-save-as.md)'s
    own `[^guard]` footnote, which is why that plan's `repointFile` guards its `setTabGlyph` call at
    all. Driving that from `mouseenter`/`mouseleave` would fire a full icon rebuild on every tab the
    pointer crosses while moving across a busy strip — exactly the class of frequent, per-mousemove-
    adjacent, layout-forcing cost `TODO.md`'s own "Inactive tabs stay in the layout tree" entry already
    flags as a standing trap in this app. Building a CSS-only alternative (e.g. overlaying two static
    glyphs and toggling visibility via a new descendant-combinator rule reaching from a hovering parent
    into a child) would be new library plumbing well beyond "a small addition following the exact shape
    of `setTabGlyph`/`setTabItalic`," and would fight the library's own `StyleBag`-only state-tier
    design. The content-row dot avoids the whole class of problem.

[^why-content-row]: `SplitButton`'s chevron is added once in the constructor and re-appended by an
    `_afterRebuildContentRow()` override after every content-row rebuild
    ([SplitButton.ts:141-156,223-227](../typescript-ui/packages/lib/src/typescript/lib/component/button/SplitButton.ts#L141)).
    Only the label (`_text`, a `Text` with `truncate: true`) shrinks and ellipsises when the row is
    too narrow — every other child keeps its full preferred size
    ([Button.ts:1661-1665](../typescript-ui/packages/lib/src/typescript/lib/component/button/Button.ts#L1661),
    [Text.ts:33-44](../typescript-ui/packages/lib/src/typescript/lib/component/input/Text.ts#L33)).
    An absolute overlay (like the close button or the busy wash) was also considered and rejected in
    favor of this. An overlay's position would have to be computed relative to the *leading glyph's*
    geometry (not the button's own width, which is what the close button's overlay math already uses)
    to sit next to it without colliding, which needs new per-layout positioning code in `TabBar` with
    no existing precedent to mirror. A content-row child needs none of that — it just takes its place
    in the existing `HBox` after the label, and its width is automatically excluded from what the
    label is allowed to shrink into.

[^cross-repo-dependency]: The `depends-on: [..., tab-modified-glyph]` entry names a plan in the
    sibling `typescript-ui` repository, not in Loom's own `plans/`. Loom's `/implement` cannot check
    that off a local `plans/implemented/` listing, so treat it as an instruction to a human: the
    `tab-modified-glyph` plan must be written (from the contract in `## Addendum` below), implemented,
    and merged into the checkout this tree's `node_modules/@jimka/typescript-ui` resolves to, before
    this plan's own step 1 — step 1's grep is the deliberate, cheap detector for this; step 10's full
    typecheck would also fail on it if step 1 were somehow skipped.

[^single-callsite]: `Component`'s dirty flag fires `"dirtychange"` only when `isDirty()` actually
    changes
    ([Component.ts:2390-2402](../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L2390)),
    and `addFileTab`/`newFile` wire that event to `handleDirtyChange` via `file.onDirtyChange(...)`
    ([EditorController.ts:388,507](src/EditorController.ts#L388)). This was checked against every path
    that can end a file's dirty state: typing and undo change it directly; `save`/`saveAs` call
    `file.markSynced(text)`, which calls `CodeEditor.markClean()`; `reloadFromDisk` calls
    `file.adoptDiskText(diskText)`, which also ends in `markSynced`. All of them reach the same
    dirty-flag setter, so none bypasses `handleDirtyChange`.

---

## Addendum: typescript-ui Library Prerequisite (`tab-modified-glyph`)

This is the full contract the `tab-modified-glyph` plan in `typescript-ui/plans/` must deliver —
written here so authoring or implementing that plan needs no further design work. It does not modify
any Loom file; it lives entirely in `/home/jika/typescript/typescript-ui`.

**`layout/Tab.ts`** — new methods, placed after `isTabBusy` (currently ending at
[line 1420](../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts#L1420)), mirroring
`setTabItalic`/`isTabItalic`'s exact shape (view-only, not written to `LayoutConstraints`):

```typescript
setTabModified(content: Component, modified: boolean): boolean {
    const entry = this._contents.find(e => e.component === content);

    if (!entry) {
        return false;
    }

    this._bar.setEntryModified(entry.id, modified);
    this.getContainer()?.scheduleLayout();

    return true;
}

isTabModified(content: Component): boolean {
    const entry = this._contents.find(e => e.component === content);

    return entry ? this._bar.isEntryModified(entry.id) : false;
}
```

**`component/container/TabBar.ts`** — new methods, placed after `isEntryBusy` (currently ending at
[line 1656](../typescript-ui/packages/lib/src/typescript/lib/component/container/TabBar.ts#L1656)),
mirroring `setEntryBusy`/`isEntryBusy`'s exact shape:

```typescript
setEntryModified(id: string, modified: boolean): this {
    this.entryById(id)?.button.setModified(modified);

    return this;
}

isEntryModified(id: string): boolean {
    return this.entryById(id)?.button.isModified() ?? false;
}
```

**`component/button/TabButton.ts`** — the content-row glyph itself:

- Add `import { Glyph } from "~/component/display/Glyph.js";` and
  `import { circle } from "~/glyphs/solid/circle.js";` to the existing import block
  ([lines 1-13](../typescript-ui/packages/lib/src/typescript/lib/component/button/TabButton.ts#L1)), and
  register it near the top, matching how `TabCloseButton.ts` registers `xmark` and `SplitButton.ts`
  registers `caret_down`:

  ```typescript
  Glyph.register(circle);

  /** Registry name of the trailing "unsaved changes" dot — a plain filled disc. */
  const MODIFIED_GLYPH = "circle";
  ```

- Two new fields, beside `_busy`/`_busyIndicator`
  ([lines 212-217](../typescript-ui/packages/lib/src/typescript/lib/component/button/TabButton.ts#L212)):

  ```typescript
  // Whether this tab is marked modified (unsaved changes). Runtime state, not
  // configuration, so it carries no options-bag field — matching `_busy`.
  private _modified: boolean = false;

  // The trailing "unsaved changes" dot, built lazily on the first
  // setModified(true) and reused thereafter, matching `_busyIndicator`. Added
  // to and removed from `_content` directly (not merely shown/hidden) so a
  // clean tab's label keeps the full row width instead of always reserving
  // blank space for a dot it isn't showing.
  private _modifiedGlyph: Glyph | null = null;
  ```

- `setModified`/`isModified`, placed after `isBusy`
  ([line 429](../typescript-ui/packages/lib/src/typescript/lib/component/button/TabButton.ts#L429)):

  ```typescript
  /**
   * Shows or hides the trailing "unsaved changes" dot in the tab's content
   * row, after the label. Unlike the busy overlay, this is a real row child,
   * not an absolute overlay: only the label truncates when the tab narrows
   * (`Text`'s own ellipsis), so the dot — like the leading glyph — always
   * keeps its full size and is never clipped away.
   *
   * @param modified - True to show the dot, false to hide it.
   *
   * @returns This button, for method chaining.
   */
  setModified(modified: boolean): this {
      if (this._modified === modified) {
          return this;
      }

      this._modified = modified;

      if (!this._modifiedGlyph) {
          if (!modified) {
              return this;
          }

          this._modifiedGlyph = new Glyph(MODIFIED_GLYPH);

          const dotSize = ThemeManager.getResolvedScale().glyphXs;

          this._modifiedGlyph.setPreferredSize({ width: dotSize, height: dotSize });
          this._modifiedGlyph.setForegroundColor("var(--ts-ui-tab-indicator-color, #1a73e8)");
      }

      if (modified) {
          this._content.addComponent(this._modifiedGlyph);
      } else {
          this._content.removeComponent(this._modifiedGlyph);
      }

      return this;
  }

  /**
   * Reports whether the trailing "unsaved changes" dot is currently shown.
   *
   * @returns True when this tab is marked modified.
   */
  isModified(): boolean {
      return this._modified;
  }
  ```

  The color reuses `--ts-ui-tab-indicator-color` directly — the same token the active-tab underline
  already uses ([TabBar.ts:242](../typescript-ui/packages/lib/src/typescript/lib/component/container/TabBar.ts#L242))
  — with no new CSS variable.

- Override `_afterRebuildContentRow`, mirroring `SplitButton`'s override exactly
  (added once, near the other protected overrides):

  ```typescript
  /**
   * Re-appends the modified dot after a content-row rebuild, mirroring
   * `SplitButton`'s own override for its trailing chevron — `_rebuildContentRow`
   * empties `_content` wholesale on any label/glyph/writing-mode change (e.g. a
   * cross-type Save As calling `setGlyph`), which would otherwise silently
   * drop the dot until the next explicit `setModified` call.
   */
  protected override _afterRebuildContentRow(): void {
      if (this._modified && this._modifiedGlyph) {
          this._content.addComponent(this._modifiedGlyph);
      }
  }
  ```

- **Do not** add `_modifiedGlyph` to the existing `destructor` override
  ([lines 279-284](../typescript-ui/packages/lib/src/typescript/lib/component/button/TabButton.ts#L279)).
  `_closeButton`/`_busyIndicator` need explicit disposal there because they are raw-appended onto the
  DOM element outside the component tree; `_modifiedGlyph` is added via `_content.addComponent(...)`,
  so it is a real registered child and `Container`'s own child-disposal recursion already reaches it
  through `super.destructor()` — confirmed by `SplitButton`'s own destructor, which disposes its
  unregistered `_menu` but not its registered `_chevron`
  ([SplitButton.ts:165-169](../typescript-ui/packages/lib/src/typescript/lib/component/button/SplitButton.ts#L165)).
  `removeComponent`/`removeAllComponents` are themselves detach-only and never dispose
  ([Component.ts:6704-6719,6730-6738](../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L6704)),
  which is what makes toggling `_modifiedGlyph` in and out of `_content` and reusing the same instance
  safe.

This plan needs no new `StyleRule`/class-rule registration (unlike `TabBusyIndicator`): `Glyph`'s
existing rendering already covers a fixed-size, fixed-color SVG glyph with no further styling.
