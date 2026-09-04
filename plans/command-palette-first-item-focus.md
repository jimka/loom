---
touches-shared: [src/shell/CommandPalette.ts, README.md, TODO.md]
---

# Command Palette First-Item Focus — Implementation Plan

## Overview

Typing in the command palette leaves no result highlighted, so `Enter` does nothing and the
first `ArrowDown` jumps to the *second* row. Both follow from one fact: every keystroke
rebuilds the results through
[`CommandPalette.renderResults`](src/shell/CommandPalette.ts#L114), and the library's
`List.setItemsArray` resets the list's keyboard-focus position to "no row" each time it is
called. `Enter` is then forwarded into a list with nothing focused, which commits nothing,
and the first arrow key steps *past* the first row instead of onto it.

The fix in this repository is to highlight the first row after each rebuild. A private
`setResults` helper replaces the three `setItemsArray` call sites inside `renderResults`,
setting the rows and then seeding the highlight in one place. Highlighting stays
side-effect free: nothing opens or runs until `Enter` or a click, exactly as
today.[^no-side-effects]

Seeding needs `List.setFocusedIndex`, a new public method in the sibling `@jimka/typescript-ui`
repository. That library plan — `plans/command-palette-first-item-focus.md` in
`/home/jika/typescript/typescript-ui` — also fixes the arrow-key off-by-one, and **must be
implemented and built before this plan starts**.[^cross-repo] Step 1 below is the check that
it has been.

---

## Architecture Decisions

### One helper owns "replace the rows, then highlight the first"

`renderResults` sets the item array in three branches — command mode, the empty file query,
and file matches. All three route through a new private `setResults(items)` so the seeding
cannot be forgotten at one of them.[^helper]

### The highlight is a focus mark, not a selection

`setResults` calls `setFocusedIndex(0)`, which paints the same dashed focus mark the arrow
keys move. It must not call `setSelectedIndex(0, false)`: that would also make `Enter` work,
but it paints the library's filled selection wash instead, and leaves that wash stranded on
the first row as the user arrows away.[^focus-not-selection]

### The arrow-key off-by-one is fixed in the library, not worked around here

Once the first row is highlighted, `ArrowDown` correctly moves to the second, so this
repository needs no arrow handling of its own.
[`handleKeyDown`](src/shell/CommandPalette.ts#L177) keeps
forwarding `ArrowUp`/`ArrowDown`/`Enter` into `this._resultsList.handleKey(e)` unchanged.

---

## Internal Structure

The new private method on `CommandPalette`, placed after `renderResults` and before
[`displayLabel`](src/shell/CommandPalette.ts#L166):

```typescript
/**
 * Replaces the results list's rows and highlights the first one, so Enter
 * activates the top result without an arrow keypress first. Highlighting
 * moves the list's focus mark only — the selection is untouched and no file
 * opens or command runs until an explicit activation (see {@link handleCommit}).
 * An empty `items` leaves nothing highlighted.
 *
 * @param items - The rows to show, in ranked order.
 */
private setResults(items: SelectableListItem[]): void {
    this._resultsList.setItemsArray(items)
    this._resultsList.setFocusedIndex(0)
}
```

`SelectableListItem` is already exported as a type from `@jimka/typescript-ui/component/list`
(`{ key: string, label: string, glyph?: string, tooltip?: string }`), so both the
command-mode rows (`{key, label}`) and the file rows (`{key, label, glyph}`) satisfy it
without a cast.

---

## Ordered Implementation Steps

1. **Check the library half is in place.** The new method reaches this repository through the
   library's build output, not its source:
   - `ls -l node_modules/@jimka/typescript-ui` — must be a symlink to
     `/home/jika/typescript/typescript-ui/packages/lib`. A fresh `npm install` in this
     worktree replaces it with the published registry copy, which does **not** carry the new
     method; re-point it if so (the same step `plans/implemented/command-palette.md`'s
     Implementation Notes records for every prior phase).
   - The library repo's own plan must be implemented, then `npm run build:lib` run from
     `/home/jika/typescript/typescript-ui/packages/lib` to regenerate `dist/lib`.
   - `grep -rn 'setFocusedIndex' node_modules/@jimka/typescript-ui/dist/lib/types/` — expect
     at least one match. **Stop here if it is empty**: nothing below will typecheck, and the
     fix belongs upstream.

2. **Add the type import** at the top of `src/shell/CommandPalette.ts`, beside the existing
   `import type { Rect } from '@jimka/typescript-ui/core'` (line 2):
   `import type { SelectableListItem } from '@jimka/typescript-ui/component/list'`.

3. **Add the `setResults` method** to `CommandPalette` using the body from
   `## Internal Structure`, placed between `renderResults` and `displayLabel`.

4. **Route all three branches of `renderResults` through it.** Replace each
   `this._resultsList.setItemsArray(…)` with `this.setResults(…)`, keeping every
   `setEmptyText` call, the `filterAndRankFuzzy` calls, the `.map` callbacks, the early
   `return`s, and the existing absolute-path-versus-label comment exactly as they are:
   - the command-mode branch (line 125)
   - the empty-file-query branch (line 135), which passes `[]`
   - the file-match branch (line 150)

   Then `grep -n 'setItemsArray' src/shell/CommandPalette.ts` — expect exactly **one** match,
   inside `setResults`.

5. **Update `renderResults`' own JSDoc** (lines 107–113): it says the method "Never opens a
   file or runs a command itself". Keep that sentence and add that it highlights the first
   result so `Enter` activates it.

6. **Update the class JSDoc** (lines 30–41). The sentence "Nothing opens or runs while
   browsing the list — arrow keys only move the highlight — until a result is activated
   (Enter or click)" stays true and must not be weakened; extend it to say the first result
   is highlighted as soon as results appear, so `Enter` activates it directly.

7. **Update the README.** In `README.md`'s **Command palette** bullet (lines 30–34), the
   clause "arrow keys only move the highlight, and nothing opens or runs until you activate
   a result with Enter or a click" becomes something like: "the first match is highlighted as
   soon as you type, so Enter opens it directly; arrow keys only move the highlight, and
   nothing opens or runs until you activate a result with Enter or a click."

8. **Delete the backlog entry.** Remove the four-line bullet at `TODO.md:57-60` ("**When
   typing in the command palette** …"), leaving the surrounding `## High` bullets untouched.
   Then `grep -n 'command palette' TODO.md` — the only remaining match should be the
   unrelated row-disabled bullet at line 18.

9. **Run the verification set** in `## Verification`, including the manual cases.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src/shell/CommandPalette.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

Loom's vitest suite is node-environment and covers the pure data helpers only —
`vitest.config.ts` records that "component/DOM behaviour is verified live, not here", the
same precedent `plans/implemented/command-palette.md` followed. Every case below is
therefore **manual verification** in the Tauri window (`npm run tauri:dev`), against a
project with at least six files across two directories. No new automated test is added.

1. **Typing highlights the top result.** Ctrl/Cmd+P, then type a few characters of a file's
   name. Results appear ranked and the **first** row carries the highlight immediately — no
   arrow keypress needed. No file opens and no tab appears.
2. **Enter opens the highlighted first result.** From case 1, press `Enter` without touching
   an arrow key: the top file opens and the palette closes. This is the reported defect; it
   used to do nothing.
3. **The highlight follows every keystroke.** Keep typing so the result set changes: the
   highlight stays on whatever the new first row is, never on a stale position, and the list
   scrolls back to the top when it had been scrolled down.
4. **The first ArrowDown moves to the second row.** From case 1, press `ArrowDown` once: the
   highlight moves from the first row to the second (it used to jump straight to the second
   from nothing highlighted at all). `ArrowUp` returns it to the first row.
5. **Arrowing still has no side effect.** Arrow through several results: nothing opens, no
   tab appears, and the tab strip is unchanged until `Enter` or a click.
6. **An empty query highlights nothing.** Ctrl/Cmd+P and type nothing: the "Type to search
   files" hint shows, no row is highlighted, and `Enter` does nothing.
7. **A no-match query highlights nothing.** Type a query matching no file: "No matching
   files" shows, nothing is highlighted, and `Enter` does nothing.
8. **Command mode behaves identically.** Type `>`: the command list appears with its first
   command highlighted, and `Enter` runs that command and closes the palette. Typing after
   `>` re-filters and the highlight follows the new first command.
9. **Deleting the `>` re-highlights the first file result** (or nothing, when the remaining
   text matches no file).
10. **Clicking a row still activates that row**, not the highlighted one.
11. **Escape still closes the palette with nothing opened**, from any of the states above.

---

## Verification

- `npm run typecheck` — clean. This is what proves step 1's precondition held; a
  `Property 'setFocusedIndex' does not exist` error means the library build is stale.
- `npm test` — clean, unchanged (no test file is touched).
- `npm run build` — clean.
- `grep -n 'setItemsArray' src/shell/CommandPalette.ts` — exactly one match, inside
  `setResults`.
- `grep -n 'setFocusedIndex' src/shell/CommandPalette.ts` — exactly one match, inside
  `setResults`.
- `grep -n 'setSelectedIndex' src/shell/CommandPalette.ts` — zero matches.
- `git diff --name-only` — exactly the three files in the table above.
- Manual: `npm run tauri:dev`, then cases 1–11 above. Cases 1, 2, 4, and 8 are the ones that
  pin the fix; the rest guard against regressing what already worked.

---

## Documentation Impact

- **[README.md](README.md)** — step 7 amends the existing *Command palette* bullet. No other
  bullet describes palette keyboard behaviour.
- **[TODO.md](TODO.md)** — step 8 deletes this defect's own backlog entry, matching how
  `plans/implemented/command-palette.md` and `plans/implemented/settings-file.md` each
  retired theirs.
- Loom has no `docs/` tree and no generated API reference, so nothing else needs
  regenerating. The library-side documentation of `setFocusedIndex` belongs to the library
  plan.

---

## Potential Challenges

- **A stale library build is the likely failure.** `@jimka/typescript-ui` is consumed as
  built output (`dist/lib`), not source, so editing the library alone changes nothing here.
  Step 1 checks both the symlink and the emitted types before any edit.
- **`npm install` in this worktree silently un-does the symlink**, replacing the sibling
  checkout with the published 0.8.0 tarball. If typecheck fails on `setFocusedIndex` after
  step 1 passed, re-check `ls -l node_modules/@jimka/typescript-ui`.
- **Do not "fix" the arrow keys here.** With the first row highlighted, an `ArrowDown` that
  lands on the third row means the library half was not built — not that `handleKeyDown`
  needs a workaround.
- **`handleCommit`'s `key === ''` guard stays.** It is now unreachable through `Enter` on a
  populated list, but a zero-row list still needs it, and the library's `handleKey` returns
  `false` for every key on an empty list so no activation fires at all.

---

## Critical Files

| File | Why |
|---|---|
| [`src/shell/CommandPalette.ts`](src/shell/CommandPalette.ts) | The only source file changed. Read `renderResults` (114), `handleKeyDown` (177), `handleCommit` (191), and the constructor's `setSelectFollowsFocus(false)` / `setFocusOnRowClick(false)` pair (56–57) before editing. |
| `plans/implemented/command-palette.md`, `## Implementation Notes` (final section) | Records why the highlight must stay side-effect free: the original highlight-preview design was deleted after live use because a file opening from typing or arrowing alone was rejected. Read it before touching anything near the list's selection. |
| `/home/jika/typescript/typescript-ui/plans/command-palette-first-item-focus.md` | The library half — defines `setFocusedIndex`'s exact contract (clamps out of range to "no row", fires no event, leaves the selection alone) and the arrow-key fix this plan relies on. |
| `/home/jika/typescript/typescript-ui/packages/lib/docs/components/List.md`, `## Keyboard` | The list's keyboard contract as documented, including the sentence the library plan adds about seeding the highlight. |
| [`vitest.config.ts`](vitest.config.ts) | States the node-environment / verify-DOM-behaviour-live split this plan's manual-only verification follows. |

---

## Non-Goals

- **No automated test for the palette.** Loom's harness is node-environment with no DOM and
  no library components under test; standing one up for a change this small would break the
  repository's established split. The library plan carries the automated coverage for
  `setFocusedIndex` and the arrow entry rule.
- **No preview-on-highlight.** Deliberately removed after live use; nothing here brings it
  back.[^no-side-effects]
- **No change to fuzzy ranking, the result cap, command mode's `>` prefix, or the panel's
  geometry.** Which row is first is unchanged; only whether it starts highlighted.
- **No fix for the palette's other backlog entry** (`TODO.md:16-19`, the library's missing
  per-row disabled flag). Unrelated, and it needs a different library change.

---

## Notes

[^no-side-effects]: `plans/implemented/command-palette.md`'s closing Implementation Notes
    record that the palette's original highlight-preview mechanism — opening the highlighted
    file as a temp tab as the user typed or arrowed — was deleted after two rounds of live
    testing: activating a tab pulled DOM focus out of the query field, and once that was
    fixed, "a file silently opening (even as a temp tab) from typing or arrowing alone,
    before any explicit confirmation" was itself rejected. `setSelectFollowsFocus(false)`
    (`src/shell/CommandPalette.ts:56`) is what enforces that today: it stops the list's
    `moveFocus` from running its selection reducer, so no `"action"` event — and therefore no
    `handleCommit` — fires on arrow keys. `setFocusedIndex` fires no event at all, so seeding
    the highlight cannot reintroduce the behaviour.

[^helper]: The alternative — three `setFocusedIndex(0)` calls, one after each existing
    `setItemsArray` — was rejected: the rule "a rebuilt result set always highlights its
    first row" would then live in three places and be one forgotten line away from the
    reported bug coming back in one mode only. Folding `setEmptyText` into the helper too
    was also rejected: the empty text is per-mode (`'No matching commands'` /
    `'Type to search files'` / `'No matching files'`) while the rows are per-query, and
    merging them would give the helper two unrelated jobs.

[^focus-not-selection]: `setSelectedIndex(0, false)` would set the selection *and* the focus
    position, so `Enter` would work — but the palette runs with
    `setSelectFollowsFocus(false)`, which means arrow keys move the focus mark without moving
    the selection. Seeding a selection would therefore leave the first row painted with the
    library's `.selected` wash while the dashed focus outline travels further down the list,
    showing two highlighted rows at once. `setFocusedIndex` moves only the mark the arrow keys move, so the initial
    highlight and the arrow-driven highlight look identical.

[^cross-repo]: The two plans share a file name because they are two halves of one reported
    defect, but neither declares `depends-on`. That key is resolved against the *same*
    repository's `plans/implemented/` directory and both files have identical stems, so
    `depends-on: [command-palette-first-item-focus]` here would resolve to this very plan.
    The ordering is stated in prose instead, and enforced by step 1's precondition check
    plus the `npm run typecheck` in `## Verification` — neither of which can pass against an
    unbuilt library.
