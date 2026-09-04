---
depends-on: [tab-doubleclick-event]
touches-shared: [src/EditorController.ts, README.md, TODO.md]
---

# Pin a Tab on Double-Click — Implementation Plan

## Overview

The tab strip has one **temp tab** — the tab a single click in the file tree
recycles, marked with a `~` prefix
([src/editor/FileEditor.ts:274-280](src/editor/FileEditor.ts#L274)). It becomes
permanent through
[`EditorController.pinTab`](src/EditorController.ts#L726), which today has
three callers: the first edit
([handleDirtyChange:764-771](src/EditorController.ts#L764)), a permanent open
of an already-open file — what a double-click in the tree produces
([openFile:332](src/EditorController.ts#L332)) — and a *Save As*
([saveAs:529](src/EditorController.ts#L529)). Double-clicking the tab **in the
strip** does nothing — the gap [TODO.md:34-39](TODO.md#L34) records, and the
one trigger VS Code's preview tabs have that Loom's temp tab lacks.

This plan adds that fourth caller. `EditorController` subscribes to the
library's `"tabdblclick"` event on `this.tabs.getTab()`, beside the three
subscriptions its constructor already makes
([EditorController.ts:66-68](src/EditorController.ts#L66)), and the handler
calls `pinTab`. One new private handler in one source file, plus a README
sentence and the retired TODO entry.

`"tabdblclick"` does not exist in `@jimka/typescript-ui` yet. It is added by
the sibling repository's own plan,
[`../typescript-ui/plans/tab-doubleclick-event.md`](../typescript-ui/plans/tab-doubleclick-event.md),
which must land first — hence the `depends-on` entry in this plan's
frontmatter.[^cross-repo-dependency]

---

## Architecture Decisions

### The trigger is the library's `"tabdblclick"` event

`EditorController` wires
`this.tabs.getTab().on('tabdblclick', this.handleTabDoubleClick)` in its
constructor, beside the `'beforetabclose'`, `'tabclose'` and `'activate'`
subscriptions already there
([EditorController.ts:66-68](src/EditorController.ts#L66)) — a fourth line in
the same block, wired to a fourth arrow-function handler field. It does **not**
register a raw `Event.addSubtreeListener` against the tab strip.[^why-library-event]

### The handler pins the double-clicked tab and does nothing else

`pinTab` already no-ops on an already-pinned tab, records the file in Recent
Files, and relabels the tab button. The handler adds no `syncActive()` call, no
focus move, and no second check.[^handler-does-one-thing]

Which double-clicks pin, and which do nothing:

| Gesture | Tab before | Tab after |
|---|---|---|
| double-click the `~README.md` tab button | temporary | `README.md`, pinned, added to Recent Files |
| double-click an already-pinned `main.ts` tab button | pinned | unchanged — `pinTab` returns early |
| double-click an `Untitled-1` tab button | pinned (a new file is never temporary) | unchanged |
| double-click inside the editor body, e.g. to select a word | temporary | unchanged — the event fires for tab buttons only |
| double-click the blank strip area right of the last tab | temporary | unchanged — same reason |

### `pinTab` stays private

The handler lives inside `EditorController`, so `pinTab` needs no visibility
change and `EditorController`'s public surface is untouched.

---

## Internal Structure

The new handler, placed directly after
[`handleActivate`](src/EditorController.ts#L825):

```typescript
/**
 * `"tabdblclick"`: pins the double-clicked tab, matching VS Code's
 * preview-tab behaviour. A no-op on an already-pinned tab — `pinTab` owns
 * that check.
 */
private handleTabDoubleClick = (content: Component): void => {
    this.pinTab(content as FileEditor)
}
```

The listener type is `(content: Component, index: number) => void` and the
handler declares only the first parameter — omitting trailing parameters is
what [`handleActivate`](src/EditorController.ts#L825) already does with the
identically-shaped `"activate"` payload, taking neither of its two. The
`content as FileEditor` cast is the same one
[`handleBeforeTabClose`](src/EditorController.ts#L777) and
[`handleTabClose`](src/EditorController.ts#L813) make: `EditorController` is
the sole owner of the strip, so every tab's content is a `FileEditor`.
`Component` is already imported, as a type, at
[line 1](src/EditorController.ts#L1).

---

## Ordered Implementation Steps

1. **`src/EditorController.ts`** — add the `handleTabDoubleClick`
   arrow-function field from `## Internal Structure` immediately after
   [`handleActivate`](src/EditorController.ts#L825), keeping the file's
   handlers in the same order as their constructor subscriptions.

2. **`src/EditorController.ts`** — subscribe it in the constructor on the line
   after the `'activate'` subscription
   ([line 68](src/EditorController.ts#L68)):
   `this.tabs.getTab().on('tabdblclick', this.handleTabDoubleClick)`.

3. `npm run typecheck` — clean. A failure reporting that `'tabdblclick'` is
   not assignable to `TabEvent` means the library dependency has not landed in
   the `@jimka/typescript-ui` this tree resolves; fix the environment (see
   `## Potential Challenges`), not the call.

4. `grep -rln 'tabdblclick' src/` — exactly one file,
   `src/EditorController.ts`. `grep -rn 'Event.addSubtreeListener' src/` —
   exactly one match, in `src/explorer/FileTree.ts`, unchanged from before this
   plan.

5. `grep -c 'pinTab' src/EditorController.ts` — exactly five: the definition,
   the three pre-existing callers, and the new handler.

6. **`README.md`** — extend the *Tabbed editing* bullet
   ([lines 36-40](README.md#L36)) so the sentence listing how a temp tab
   becomes permanent also names a double-click on the tab itself. Leave the
   *File tree* bullet's own double-click sentence
   ([lines 24-26](README.md#L24)) alone: it describes the tree, which this
   plan does not touch.

7. **`TODO.md`** — delete the **Double-clicking a temp tab should pin it.**
   entry under `## High` ([lines 34-39](TODO.md#L34)). `## High` keeps its
   other bullets, so no heading is removed.

8. `npm test` and `npm run build` — both clean; no test file changes.

9. Manual: `npm run tauri:dev`, then walk every case in
   `## Expected Behaviour` in the app window.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src/EditorController.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

Every case is **manual**. Loom's vitest suite covers pure modules only
(`tests/` holds path, session, settings, gitignore and similar helpers — no
component or DOM harness), and this change is a UI event handler, so there is
no automated red-green cycle to run. Verify all seven in `npm run tauri:dev`.

1. **Double-clicking a temp tab pins it.** Single-click `README.md` in the
   tree — its tab reads `~README.md`. Double-click that tab button. The label
   becomes `README.md` and the `~` is gone.
2. **The pinned tab survives the next tree click.** After case 1, single-click
   a different file in the tree. It opens in a *new* temp tab; the pinned
   `README.md` tab stays open beside it.
3. **The pinned file reaches Recent Files.** After case 1, *File > Open
   Recent* lists `README.md`.
4. **Double-clicking an already-pinned tab changes nothing.** Double-click the
   `README.md` tab again: the label, the tab order, the active tab, and the
   dirty dot are all unchanged, and no second Recent Files entry appears.
5. **Double-clicking inside the editor does not pin.** With a `~file.ts` temp
   tab active, double-click a word in the editor body. The word is selected
   (CodeMirror's own behaviour) and the tab still reads `~file.ts`.
6. **Double-clicking the blank strip area does not pin.** With a temp tab
   open, double-click the empty strip region to the right of the last tab. The
   temp tab keeps its `~`.
7. **Pinning does not move the caret.** Click into the temp tab's editor body
   and note the caret position, then double-click that tab's button. The caret
   is where it was, the document is unchanged, and the view has not scrolled —
   the handler never calls `focus()`. The label still loses its `~`.

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — clean; no test file changes, so the suite must be green
  unchanged.
- `npm run build` — clean.
- `grep -rln 'tabdblclick' src/` — exactly one file, `src/EditorController.ts`.
- `grep -c 'pinTab' src/EditorController.ts` — exactly five.
- `grep -rn 'Event.addSubtreeListener' src/` — exactly one match, in
  `src/explorer/FileTree.ts`.
- `grep -n 'Double-clicking a temp tab' TODO.md` — zero matches.
- `git diff --name-only` — exactly the three files in the table above.
- `git diff src/editor/ src/explorer/ src/shell/ src/data/` — empty.
- Manual: `npm run tauri:dev`, then cases 1-7 above.

---

## Documentation Impact

- **[README.md](README.md)** — the *Tabbed editing* bullet enumerates the ways
  a temp tab becomes permanent and is now one short of complete; step 6 fixes
  it. No other bullet describes tab pinning.
- **[TODO.md](TODO.md)** — the **Double-clicking a temp tab should pin it.**
  entry is this plan's own backlog entry and is deleted, matching how Loom
  retires a TODO entry when its feature lands (commit `02204dc`, *Document the
  settings file and retire its backlog entry*). The neighbouring **Library
  per-tab label styling** entry stays: italic temp-tab labels are a separate
  library gap this plan does not close.
- Loom has no `docs/` tree and no generated API reference. The library-side
  documentation for `"tabdblclick"` belongs to
  [`../typescript-ui/plans/tab-doubleclick-event.md`](../typescript-ui/plans/tab-doubleclick-event.md)
  and is not restated here.

---

## Potential Challenges

- **A fresh worktree's `node_modules/@jimka/typescript-ui` resolves to the
  published package, not the sibling checkout.** `npm install` pulls the
  registry version, which will not carry `"tabdblclick"`, so step 3's
  typecheck fails on a symbol this plan cannot fix in `src/`. Restore the
  symlink the main tree uses:
  `ln -s /home/jika/typescript/typescript-ui/packages/lib node_modules/@jimka/typescript-ui`.
  The library plan's branch must also be merged into that checkout. This is
  the recurring environment gap
  [`plans/implemented/format-on-save.md:627-637`](plans/implemented/format-on-save.md#L627)
  and [`settings-file.md:968-980`](plans/implemented/settings-file.md#L968)
  both record.
- **A double-click on a closeable tab's ✕ closes the tab on the first click.**
  Nothing pins, because the tab is gone before a second click lands. That is
  the same outcome a single click on the ✕ has, so no guard is needed here —
  the case is called out only so it is not mistaken for a bug during manual
  verification.

---

## Critical Files

- [`src/EditorController.ts`](src/EditorController.ts) — the constructor's
  existing tab subscriptions (66-68), `pinTab` (726-740), `handleDirtyChange`
  (764-771, the nearest existing pin trigger), `handleTabClose` (813) and
  `handleActivate` (825, where the new handler goes).
- [`src/editor/FileEditor.ts`](src/editor/FileEditor.ts) — `isTemporary` (254),
  `setTemporary` (264) and `getLabel` (274-280), the flag and label `pinTab`
  drives.
- [`src/explorer/FileTree.ts:88-91`](src/explorer/FileTree.ts#L88) — the
  tree's own gesture wiring, including the one
  `Event.addSubtreeListener(this, 'contextmenu', …)` call in Loom. Read it to
  see why that shape is not available here: `FileTree` **is** the component it
  registers on, while `EditorController` merely holds a `TabPanel`.
- [`node_modules/@jimka/typescript-ui/src/typescript/lib/layout/Tab.ts`](node_modules/@jimka/typescript-ui/src/typescript/lib/layout/Tab.ts) —
  the `TabEvent` union and the `on` overloads the new event joins.
- [`../typescript-ui/plans/tab-doubleclick-event.md`](../typescript-ui/plans/tab-doubleclick-event.md) —
  the library addition this plan consumes: the event's payload and exactly
  which targets fire it.
- [`plans/implemented/temp-tabs.md`](plans/implemented/temp-tabs.md) — where
  the temp tab, `pinTab` and the `~` label came from; its gesture table is the
  one this plan extends by a row.

---

## Non-Goals

- **No unpin.** Double-clicking a pinned tab does nothing; a pinned tab cannot
  be returned to temporary. Nothing in Loom needs the reverse direction, and
  VS Code offers none either.
- **No focus change.** Pinning does not move the caret into the editor.
  `openFile`'s `'permanent'` path focuses the editor because it *opens* a file;
  this gesture only changes an already-open tab's status.
- **No italic temp-tab label.** Styling a tab's label needs library support
  that does not exist; that gap keeps its own TODO entry.
- **No context-menu equivalent.** A *Keep Open* row on the tab context menu is
  a second surface for the same action and is not requested.
- **No new test file.** Loom has no component/DOM test harness, so the
  behaviour is pinned by the manual cases in `## Expected Behaviour`.

---

## Notes

[^cross-repo-dependency]: The `depends-on: [tab-doubleclick-event]` entry names
    a plan in the sibling `typescript-ui` repository, not in Loom's own
    `plans/`. Loom's `/implement` cannot check that off a local
    `plans/implemented/` listing, so treat it as an instruction to a human: the
    library branch must be merged and this tree's
    `node_modules/@jimka/typescript-ui` must resolve to that checkout before
    step 1. Step 3's typecheck is the mechanical detector — it is the first
    thing that fails if the dependency is missing.

[^why-library-event]: Doing this from Loom's side alone was investigated first
    and does not work. `Event.addSubtreeListener(this.tabs, 'dblclick', …)`
    would fire — `Tab.attach` appends the strip element inside the `TabPanel`'s
    element, so a tab button's `dblclick` does reach a subtree listener
    registered on the panel — but it fires for *every* double-click inside the
    panel, the `CodeEditor` body and the breadcrumb band included, and
    double-clicking a word to select it must not pin the tab. Narrowing it is
    what fails: nothing public maps an event target back to a tab. `Tab` holds
    its `TabBar` in a private field and exposes no accessor, and `TabBar`'s own
    target-to-cell walk (`isBarChromeTarget`) and cell lookup (`entryById`) are
    both private, leaving only the tab button's ARIA `aria-controls` attribute
    as an undocumented back door. The library's own
    [`ARCHITECTURE.md`](../typescript-ui/ARCHITECTURE.md) settles it twice
    over: *A component must not listen to another component's events through
    `Event`* reserves the whole `Event` API for listening on **self** — which
    is why `FileTree`'s `Event.addSubtreeListener(this, 'contextmenu', …)` is
    legal and this would not be, `FileTree` being the component it registers on
    — and it prescribes the remedy directly: *when a consumer needs an event a
    component doesn't yet expose, widen that component's `XEvent` union and add
    the `on` overload*. That is what the sibling plan does.

[^handler-does-one-thing]: `pinTab` clears the temporary flag, records the
    path in Recent Files, and calls `setTabName` with the relabelled name, so
    the handler has nothing left to do. In particular it must **not** call
    `syncActive()`, which `handleDirtyChange` calls for a different reason: the
    window title is rendered from the file's name and dirty flag only
    ([src/data/settings.ts](src/data/settings.ts)'s `renderTitle`, via
    [syncActive:850-869](src/EditorController.ts#L850)), and pinning changes
    neither, so there is no title or status-bar state to resync. The active tab
    does not need setting either — the first click of the double-click already
    activated it.
