---
depends-on: [session-persistence, workspace-session-persistence, sidebar-rail-and-search-tree]
touches-shared: [src/data/session.ts, src/data/workspaceState.ts, src/shell/session.ts, src/shell/EditorShell.ts]
---

# Remembering Which Explorer Sections Are Open — Implementation Plan

## Overview

`TODO.md`'s High list asks for the sidebar's open/closed state to survive a relaunch. Three pieces
of state are named there. Two are missing; the third is already done:

| Piece of state | Status today |
|---|---|
| The sidebar rail's active view (Files or Search) | **Not persisted.** The constructor hardcodes Files ([src/shell/EditorShell.ts:198](src/shell/EditorShell.ts#L198), [:193](src/shell/EditorShell.ts#L193)). |
| The Files view's two accordion sections (the tree section, *Properties*) | **Not persisted.** Both constraints hardcode `initiallyOpen: true` ([src/shell/EditorShell.ts:579](src/shell/EditorShell.ts#L579), [:586](src/shell/EditorShell.ts#L586)). |
| The file tree's own expanded directories | **Already persisted**, as `expandedDirs` in both files, captured from `FileTree.getExpandedPaths()` and replayed by `FileTree.expandPaths()` ([src/shell/session.ts:61](src/shell/session.ts#L61), [:83](src/shell/session.ts#L83)). Nothing to add. |

This plan adds two fields to each of the two existing schemas — `explorerView` and
`explorerSectionsOpen` — and wires them into the capture side
([`captureSession`](src/shell/session.ts#L55)) and the restore side (`EditorShell`'s constructor).
It touches four source files, two test files, and two docs. No library change is needed: `Accordion`
already exposes section open state both ways (`AccordionConstraints.initiallyOpen` going in,
`isSectionOpen` and the `sectiontoggle` event coming out).

A second, smaller fix falls out of the same change. `relabelTreeSection`
([src/shell/EditorShell.ts:267](src/shell/EditorShell.ts#L267)) rebuilds the whole accordion on every
project switch, and its own doc comment records that this resets both sections to `initiallyOpen` —
so a collapsed *Properties* section springs back open when the user opens another folder. Feeding
the live open flags into each rebuild's constraints makes that rebuild state-preserving.

---

## Architecture Decisions

### Two more fields on the two existing files, not a new store

`SessionState` and `WorkspaceState` each gain `explorerView: ExplorerView` and
`explorerSectionsOpen: boolean[]`, written and read through the `readSessionText`/`writeSessionText`
and `readWorkspaceStateText`/`writeWorkspaceStateText` pairs that already exist. No new file, no new
Tauri capability, and `version` stays at `1` — an older file simply lacks the two fields and takes
their defaults, which are today's behaviour.[^additive-fields]

### Both fields are per-project as well as app-wide

Both new fields go in `WorkspaceState` too, and both are copied by `workspaceStateFromSession` and
replaced by `applyWorkspaceOverlay` — exactly how `paneSizes`/`collapsedPanes` are already handled.
That keeps one rule intact: every `SessionState` field except `projectRoot`, `recentProjects`, and
`recentFiles` is workspace-scoped, with `.loom/workspace.json` winning when it exists.[^both-files]

| App session `projectRoot` | `.loom/workspace.json` | Effective `explorerView` / `explorerSectionsOpen` |
|---|---|---|
| `null` | (no root to look under) | `session.json`'s own values |
| `/p` | absent, or not a usable document | `session.json`'s own values |
| `/p` | `{"version":1}` | `'files'` / `[]` — a real "nothing was collapsed" save |
| `/p` | `{"version":1,"explorerView":"search","explorerSectionsOpen":[true,false]}` | `'search'` / `[true, false]` |
| `/p` | `{"version":1,"explorerView":"tree"}` | `'files'` / `[]` — the file parsed, so it replaces; its unknown view fell back to the default inside the parser, *not* to `session.json`'s value |

### Section state is stored as one open flag per section, in child order

`explorerSectionsOpen` is a `boolean[]` the same length as the accordion's section list — index `0`
the tree section, index `1` *Properties* — not a list of collapsed indices like `collapsedPanes`.
This is the shape SQLAdmin's own layout store uses for exactly this state
([../sqladmin/frontend/src/data/layoutStore.ts:53](../sqladmin/frontend/src/data/layoutStore.ts#L53)),
and it maps one-to-one onto `AccordionConstraints.initiallyOpen`.[^boolean-flags]

Two separate rules drop a bad saved array, and both drop it whole rather than repairing it entry by
entry — the discard policy `session-persistence.md` already settled for every array field. The
parser drops an array holding a non-boolean, the same way it drops an `expandedDirs` holding a
non-string. The pure function `sectionOpenFlags(saved, defaults)` then drops an array of the wrong
length:

| `saved` | `defaults` | Result | Why |
|---|---|---|---|
| `[true, true]` | `[true, true]` | `[true, true]` | length matches — taken as saved |
| `[false, true]` | `[true, true]` | `[false, true]` | length matches — the tree section stays closed |
| `[]` | `[true, true]` | `[true, true]` | field absent, or discarded by the parser — defaults |
| `[true]` | `[true, true]` | `[true, true]` | length mismatch — defaults |
| `[true, false, true]` | `[true, true]` | `[true, true]` | length mismatch — defaults |

### Both new pieces of state restore at construction, not by re-applying after layout

The rail view seeds `filesHandle`/`searchHandle`'s `selected` option and the content `Card`'s
initial page; the section flags seed each `AccordionConstraints`' `initiallyOpen`. Neither calls
`openSection`/`closeSection`/`selectExplorerView` during the restore. This mirrors
`session-persistence.md`'s settled decision *The split restores through `Split`'s constructor, not a
post-layout re-apply*, and it is the only ordering that works: `Accordion` builds its internal open
state during its first layout pass, so `openSection`/`closeSection` called before that pass are
no-ops.[^constructor-seeded]

### The shell holds the live open flags; the accordion is never read back

`EditorShell` keeps a `boolean[]` of the Files view's section open flags, updated from the
accordion's `sectiontoggle` event. That array — not `Accordion.isSectionOpen` — is what
`captureSession` reads and what seeds each accordion rebuild's constraints.[^shell-owned-flags]

### `EditorShell` schedules these two saves itself

`installSessionAutosave` ([src/shell/session.ts:104](src/shell/session.ts#L104)) gains no new
subscriptions. `selectExplorerView` and the `sectiontoggle` callback each call
`this._autosave?.schedule()` directly, the same way `openProjectRoot` already does
([src/shell/EditorShell.ts:446](src/shell/EditorShell.ts#L446)).[^shell-schedules]

### A live folder switch still resets the rail to Files and keeps the current section flags

`openProjectRoot` restores only the new project's `expandedDirs`, unchanged — it does not read the
new project's `explorerView` or `explorerSectionsOpen`. The project-root listener's `finally` block
keeps its existing `selectExplorerView('files')` call. The section flags carry across the switch
instead of resetting, which is the behaviour fix described in `## Overview`.[^live-switch-scope]

### The relabel rebuild stays; `Accordion` has no way to retitle a built header

`relabelTreeSection` still replaces the accordion wholesale to change the tree section's label, and
this plan makes that rebuild carry the open flags forward. The library has no `setSectionLabel`, so
there is no smaller seam available. That is a pre-existing library gap, recorded here rather than
worked around silently — filing it upstream would remove the rebuild entirely, and is the user's
call, not a prerequisite for this plan.[^relabel-gap]

---

## Public API

### `src/data/session.ts`

```typescript
/** Which of the sidebar rail's two views the explorer shows. */
export type ExplorerView = 'files' | 'search'

export interface SessionState {
    // …existing fields unchanged…
    /** Which sidebar-rail view the explorer was showing. */
    explorerView: ExplorerView
    /** The Files view's accordion sections' open flags, in child order (tree, then Properties). */
    explorerSectionsOpen: boolean[]
}

/**
 * The section open flags to apply: `saved` when its length matches `defaults`,
 * a copy of `defaults` otherwise.
 */
export function sectionOpenFlags(saved: boolean[], defaults: readonly boolean[]): boolean[]
```

`emptySession()` returns `explorerView: 'files'` and `explorerSectionsOpen: []`.

### `src/data/workspaceState.ts`

```typescript
export interface WorkspaceState {
    // …existing fields unchanged…
    /** Which sidebar-rail view this project's explorer was showing. */
    explorerView: ExplorerView
    /** This project's Files-view accordion section open flags, in child order. */
    explorerSectionsOpen: boolean[]
}
```

`emptyWorkspaceState()` returns the same two defaults. `ExplorerView` is imported from `./session`;
no new exported symbol.

### `src/shell/session.ts`

```typescript
/** The explorer's own persisted UI state, read live off the shell at capture time. */
export interface ExplorerStateSource {
    /** Which rail view the explorer currently shows. */
    getExplorerView: () => ExplorerView
    /** The Files view's section open flags, in child order. */
    getExplorerSectionsOpen: () => boolean[]
}

export interface SessionTargets {
    controller: EditorController
    tree: FileTree
    split: Split
    explorer: ExplorerStateSource
}
```

`captureSession`, `applySession`, and `installSessionAutosave` keep their signatures.

### `src/shell/EditorShell.ts`

```typescript
function buildFilesViewSections(
    root: string | null,
    sectionsOpen: readonly boolean[],
    onSectionToggle: SectionToggleCallback,
): FilesViewSections
```

The local `type ExplorerView = 'files' | 'search'` at
[src/shell/EditorShell.ts:69](src/shell/EditorShell.ts#L69) is deleted; the type is imported from
`../data/session` instead. `EditorShell`'s own public surface is unchanged.

---

## Internal Structure

### `src/data/session.ts` — the new readers and helper

`readExplorerView` mirrors the `VALID_LAYOUT_SIZE_UNITS`/`isLayoutSize` pair already in this file;
`readBooleanArray` mirrors `readNumberArray` ([src/data/session.ts:189](src/data/session.ts#L189))
line for line.

```typescript
/** The schema's only valid `explorerView`s — mirrors {@link ExplorerView}. */
const VALID_EXPLORER_VIEWS: readonly ExplorerView[] = ['files', 'search']

/**
 * Reads a field expected to be an {@link ExplorerView}.
 *
 * @param value - The field's raw value.
 * @returns The view, or `undefined` when the field is missing or names no known view.
 */
function readExplorerView(value: unknown): ExplorerView | undefined {
    return VALID_EXPLORER_VIEWS.includes(value as ExplorerView) ? (value as ExplorerView) : undefined
}

/**
 * Reads a field expected to be a boolean array. The whole array is dropped —
 * not repaired entry by entry — if any entry is not a boolean.
 *
 * @param value - The field's raw value.
 * @returns The boolean array, or `undefined` when the field is missing or any
 *   entry is invalid.
 */
function readBooleanArray(value: unknown): boolean[] | undefined {
    if (!Array.isArray(value)) {
        return undefined
    }

    return value.every(entry => typeof entry === 'boolean') ? (value as boolean[]) : undefined
}
```

`sectionOpenFlags` sits next to `expansionOrder` ([src/data/session.ts:116](src/data/session.ts#L116)) —
the file's other pure restore-side helper:

```typescript
/**
 * The section open flags to apply on restore: `saved` when it is the right
 * length, a copy of `defaults` otherwise.
 *
 * `defaults.length` is the live section count, so a saved array of any other
 * length belongs to a different section list than the one being restored into
 * and is discarded whole — the same whole-array discard policy
 * {@link parseSession} applies to a malformed array field.
 *
 * @param saved - The flags read out of the session or workspace file.
 * @param defaults - The live section list's default flags; its length is the
 *   expected section count.
 * @returns The flags to apply, always `defaults.length` long.
 */
export function sectionOpenFlags(saved: boolean[], defaults: readonly boolean[]): boolean[] {
    return saved.length === defaults.length ? [...saved] : [...defaults]
}
```

`parseSession`'s two new lines:

```typescript
explorerView: readExplorerView(doc.explorerView) ?? empty.explorerView,
explorerSectionsOpen: readBooleanArray(doc.explorerSectionsOpen) ?? empty.explorerSectionsOpen,
```

### `src/data/workspaceState.ts` — the same two readers, duplicated

`VALID_EXPLORER_VIEWS`, `readExplorerView`, and `readBooleanArray` are copied into this module
verbatim, private to it, exactly as `readStringArray`, `readNumberArray`, `readLayoutSizeArray`,
`isLayoutSize`, `VALID_LAYOUT_SIZE_UNITS`, and `parseDocument` already are. Do not extract a shared
module.[^duplicated-readers]

`workspaceStateFromSession` copies both fields verbatim, beside `paneSizes`/`collapsedPanes` — no
filtering, since neither field holds a path:

```typescript
explorerView: session.explorerView,
explorerSectionsOpen: session.explorerSectionsOpen,
```

`applyWorkspaceOverlay` takes both from `workspace`, in the same spread:

```typescript
explorerView: workspace.explorerView,
explorerSectionsOpen: workspace.explorerSectionsOpen,
```

### `src/shell/session.ts` — `captureSession`'s two new lines

```typescript
explorerView: targets.explorer.getExplorerView(),
explorerSectionsOpen: targets.explorer.getExplorerSectionsOpen(),
```

### `src/shell/EditorShell.ts` — module constants

```typescript
/** The Files view's accordion sections, in child order — the indices
 *  `SessionState.explorerSectionsOpen` stores a flag per. */
const TREE_SECTION_INDEX = 0
const PROPERTIES_SECTION_INDEX = 1

/** The Files view's sections' default open flags, in child order (tree, then
 *  Properties) — both open, which is what they did before any of this was
 *  persisted. The array's length is also the section count, so
 *  `sectionOpenFlags` discards a saved array of any other length; keep this in
 *  step if the Files view ever gains or loses a section. Mirrors SQLAdmin's own
 *  per-site `ACCORDION_DEFAULT_OPEN` table
 *  (`../sqladmin/frontend/src/data/layoutStore.ts:53`), which carries the same
 *  warning for the same reason. */
const FILES_SECTIONS_DEFAULT_OPEN: readonly boolean[] = [true, true]
```

`TREE_SECTION_INDEX` and `PROPERTIES_SECTION_INDEX` are used to index
`FILES_SECTIONS_DEFAULT_OPEN` and `sectionsOpen` inside `buildFilesViewSections`, so the two
sections' order is stated once by name instead of as bare `[0]`/`[1]` subscripts.

### `src/shell/EditorShell.ts` — `buildFilesViewSections`

```typescript
/**
 * Builds a new accordion and its two sections' constraints, the tree section
 * labelled from `root` and each section opened per `sectionsOpen`. Called once
 * at construction and again by `relabelTreeSection` every time the project root
 * changes, since rebuilding the accordion is the only way to change an
 * already-built header's label (see `relabelTreeSection`'s own doc comment).
 *
 * `sectionsOpen` is passed on every call, including the rebuilds: a fresh
 * `Accordion` reads each section's open state from its `AccordionConstraints`
 * exactly once, so handing it the live flags is what stops a project switch
 * from springing a collapsed section back open.
 *
 * @param root - The open project folder, or `null` when none is open.
 * @param sectionsOpen - The sections' open flags, in child order.
 * @param onSectionToggle - Called when the user opens or closes a section.
 * @returns The new accordion and its two sections' constraints.
 */
function buildFilesViewSections(
    root: string | null,
    sectionsOpen: readonly boolean[],
    onSectionToggle: SectionToggleCallback,
): FilesViewSections {
    const accordion = new Accordion({ compact: true, listeners: { sectiontoggle: onSectionToggle } })
    const treeSection = new AccordionConstraints(treeSectionLabel(root), sectionsOpen[TREE_SECTION_INDEX], 'folder')

    treeSection.weight = TREE_SECTION_WEIGHT

    return {
        accordion,
        treeSection,
        propertiesSection: new AccordionConstraints(PROPERTIES_SECTION_LABEL, sectionsOpen[PROPERTIES_SECTION_INDEX], 'circle-info'),
    }
}
```

`listeners: { sectiontoggle }` is the nested option bag `Accordion` actually reads
([../typescript-ui/packages/lib/src/typescript/lib/layout/Accordion.ts:102](../typescript-ui/packages/lib/src/typescript/lib/layout/Accordion.ts#L102)) and the
form its own docs call preferred — **not** a top-level `sectiontoggle` key, which is silently
ignored.

### `src/shell/EditorShell.ts` — constructor wiring

Replacing the current lines 182–193 and 198–199, in this order:

```typescript
// The Files view's live section open flags, seeded from the restored session.
// Held here rather than read back from the accordion because
// `relabelTreeSection` replaces the accordion wholesale and a fresh one reports
// nothing until its next layout pass.
const sectionsOpen = sectionOpenFlags(session.explorerSectionsOpen, FILES_SECTIONS_DEFAULT_OPEN)

// The live rail view, seeded from the restored session and updated only by
// `selectExplorerView`.
let currentView: ExplorerView = session.explorerView

const onSectionToggle = (index: number, open: boolean): void => {
    if (index >= 0 && index < sectionsOpen.length) {
        sectionsOpen[index] = open
    }

    this._autosave?.schedule()
}

const initialFilesSections = buildFilesViewSections(session.projectRoot, sectionsOpen, onSectionToggle)
const filesView = Container({ layoutManager: initialFilesSections.accordion })

filesView.addComponent(tree, initialFilesSections.treeSection)
filesView.addComponent(properties, initialFilesSections.propertiesSection)
filesView.setId(FILES_VIEW_ID)
searchPanel.setId(SEARCH_VIEW_ID)

const contentCard = new Card()
const content = Container({ layoutManager: contentCard, components: [filesView, searchPanel] })

// The rail's restore seed: the card's initial page here, and each handle's own
// `selected` option just below. These are the only places outside
// `selectExplorerView` that set either, and they are safe because nothing is
// subscribed to the handles yet.
contentCard.setVisibleComponentId(viewPageId(currentView))

const filesHandle = new ToggleButton(FILES_RAIL_LABEL, { glyph: 'folder', showText: false, selected: currentView === 'files' })
const searchHandle = new ToggleButton(SEARCH_RAIL_LABEL, { glyph: 'magnifying-glass', showText: false, selected: currentView === 'search' })
```

`selectExplorerView` records the view and schedules a save:

```typescript
const selectExplorerView = (view: ExplorerView): void => {
    currentView = view
    filesHandle.setSelected(view === 'files')
    searchHandle.setSelected(view === 'search')
    contentCard.setVisibleComponentId(viewPageId(view))
    this._autosave?.schedule()
}
```

`relabelTreeSection` passes the live flags and the same callback:

```typescript
const sections = buildFilesViewSections(root, sectionsOpen, onSectionToggle)
```

And the capture source. Declare it just before the `super()` call, beside `const menuBar`, and
assign it to a new `private readonly _explorerState: ExplorerStateSource` field after `super()`,
beside `this._tree = tree`:

```typescript
const explorerState: ExplorerStateSource = {
    getExplorerView: () => currentView,
    getExplorerSectionsOpen: () => [...sectionsOpen],
}
```

`getExplorerSectionsOpen` returns a copy, so a caller holding the captured snapshot can never write
back into the shell's live flags.

`restoreSession`'s targets literal gains it:

```typescript
const targets = { controller: this._controller, tree: this._tree, split: this._split, explorer: this._explorerState }
```

### `src/shell/EditorShell.ts` — `viewPageId`

```typescript
/**
 * The content `Card` page id showing `view` — one mapping, shared by the
 * constructor's restore seed and `selectExplorerView`.
 *
 * @param view - The rail view to show.
 * @returns The `Card` page id for `view`.
 */
function viewPageId(view: ExplorerView): string {
    return view === 'search' ? SEARCH_VIEW_ID : FILES_VIEW_ID
}
```

---

## Ordered Implementation Steps

1. **Both test files, together** — they have to move in one step, because five of their `it` blocks
   build a complete `SessionState` or `WorkspaceState` literal and every required field has to be
   there for the file to typecheck once step 2 lands:

   | File | Line | Literal | Add |
   |---|---|---|---|
   | `tests/session.test.ts` | 72 | `SessionState` | `explorerView`, `explorerSectionsOpen` |
   | `tests/session.test.ts` | 139 | `SessionState` | both |
   | `tests/workspaceState.test.ts` | 92 | `WorkspaceState` | both |
   | `tests/workspaceState.test.ts` | 169 | `SessionState` | both |
   | `tests/workspaceState.test.ts` | 180 | `WorkspaceState` | both |

   Give the two round-trip literals (`tests/session.test.ts:139`,
   `tests/workspaceState.test.ts:92`) non-default values — `explorerView: 'search'`,
   `explorerSectionsOpen: [false, true]` — so the round-trip proves both fields survive
   serialization. Every other `it` block spreads `emptySession()`/`emptyWorkspaceState()` and needs
   no change. Then extend `emptySession`'s and `emptyWorkspaceState`'s expected objects with the two
   defaults, and add every new case from `## Expected Behaviour`, importing `sectionOpenFlags` from
   `../src/data/session`.
   *Check:* `npm test` — both files fail (red); every other test file still passes.

2. **`src/data/session.ts`** — add `ExplorerView`, `VALID_EXPLORER_VIEWS`, the two `SessionState`
   fields, their `emptySession` defaults, the two `parseSession` lines, `readExplorerView`,
   `readBooleanArray`, and `sectionOpenFlags`, all per `## Internal Structure`.
   *Check:* `npm test -- tests/session.test.ts` — green.
   `npm test -- tests/workspaceState.test.ts` — still red, because `WorkspaceState` has not caught
   up yet. That is step 3's entry point.

3. **`src/data/workspaceState.ts`** — import `ExplorerView` from `./session`; add the two
   `WorkspaceState` fields, their `emptyWorkspaceState` defaults, the two `parseWorkspaceState`
   lines, the copies in `workspaceStateFromSession`, the replacements in `applyWorkspaceOverlay`,
   and the duplicated `VALID_EXPLORER_VIEWS`/`readExplorerView`/`readBooleanArray`.
   *Check:* `npm test` — green.

4. **`src/shell/session.ts`** — add `ExplorerStateSource`, add `explorer` to `SessionTargets`,
   import `ExplorerView` from `../data/session`, and add `captureSession`'s two lines. Leave
   `applySession` and `installSessionAutosave` alone.
   *Check:* `npx tsc --noEmit` — the only errors are in `src/shell/EditorShell.ts`'s
   `restoreSession`, where the `targets` literal is now missing `explorer`. Those errors are step
   5's entry point.

5. **`src/shell/EditorShell.ts`** — apply every `## Internal Structure` change for this file, in
   this order. Imports first — `SectionToggleCallback` is a type-only export of
   `@jimka/typescript-ui/layout`, so it needs its own `import type` line beside the existing value
   import from that module (the same two-line shape lines 6–7 already use for
   `@jimka/typescript-ui/component/container`):

   ```typescript
   import type { SectionToggleCallback } from '@jimka/typescript-ui/layout'
   import { sectionOpenFlags } from '../data/session'
   import type { SessionState, ExplorerView } from '../data/session'   // ExplorerView added
   import type { SessionAutosave, ExplorerStateSource } from './session' // ExplorerStateSource added
   ```

   Then: delete the local
   `type ExplorerView` at line 69; add `TREE_SECTION_INDEX`, `PROPERTIES_SECTION_INDEX`, and
   `FILES_SECTIONS_DEFAULT_OPEN`; add `viewPageId`; change `buildFilesViewSections`' signature and
   body; add the `_explorerState` field; apply the constructor wiring, `selectExplorerView`, and
   `relabelTreeSection` changes; add `explorer: this._explorerState` to `restoreSession`'s
   `targets`. Update `relabelTreeSection`'s doc comment: its current text says both sections "stay
   open regardless" after a rebuild, which this change makes false — say instead that each
   section's open state is re-seeded from the live flags, so a collapsed section stays collapsed.
   *Check:* `npx tsc --noEmit` — clean.

6. **Run the invariant checks:**
   - `grep -rn 'type ExplorerView' src/` — expect exactly one match, in `src/data/session.ts`.
   - `grep -c 'new AccordionConstraints' src/shell/EditorShell.ts` — expect `2`.
   - `grep -c 'AccordionConstraints(.*, true,' src/shell/EditorShell.ts` — expect `0`: no hardcoded
     open flag is left.
   - `grep -c 'explorerView' src/data/session.ts src/data/workspaceState.ts src/shell/session.ts src/shell/EditorShell.ts` —
     expect a non-zero count in all four.
   - `grep -c 'sectiontoggle' src/shell/EditorShell.ts` — expect `1` (the `listeners` bag key; the
     differently-cased `SectionToggleCallback` and `onSectionToggle` do not match).
   - `npm run typecheck`, `npm test`, `npm run build` — all clean.

7. **`README.md`** — apply the two bullet edits in `## Documentation Impact`.

8. **`TODO.md`** — delete the *Remembering which explorer sections are open* bullet from `## High`,
   per `## Documentation Impact`. No other file under `plans/` is edited.

9. **Manual pass** — work through every case under `## Expected Behaviour` ›
   *Manual verification*.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src/data/session.ts` |
| Modify | `src/data/workspaceState.ts` |
| Modify | `src/shell/session.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `tests/session.test.ts` |
| Modify | `tests/workspaceState.test.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Unit-testable — `tests/session.test.ts` (node environment)

`emptySession()` returns `explorerView: 'files'` and `explorerSectionsOpen: []` alongside its
existing fields.

| `parseSession` input | Result |
|---|---|
| `'{"version":1,"explorerView":"search"}'` | `{ ...emptySession(), explorerView: 'search' }` |
| `'{"version":1,"explorerView":"files"}'` | `emptySession()` |
| `'{"version":1,"explorerView":"tree"}'` | `emptySession()` — unknown view |
| `'{"version":1,"explorerView":"Search"}'` | `emptySession()` — match is case-sensitive |
| `'{"version":1,"explorerView":7}'` | `emptySession()` — wrong type |
| `'{"version":1,"explorerSectionsOpen":[true,false]}'` | `{ ...emptySession(), explorerSectionsOpen: [true, false] }` |
| `'{"version":1,"explorerSectionsOpen":[]}'` | `emptySession()` |
| `'{"version":1,"explorerSectionsOpen":[true,"no"]}'` | `emptySession()` — whole array dropped |
| `'{"version":1,"explorerSectionsOpen":false}'` | `emptySession()` — not an array |

`serializeSession`/`parseSession` round-trips a state carrying `explorerView: 'search'` and
`explorerSectionsOpen: [false, true]` unchanged.

`sectionOpenFlags` — the five rows of the table under `## Architecture Decisions` ›
*Section state is stored as one open flag per section, in child order*, plus: the returned array is
never the `saved` or `defaults` array itself (mutating the result leaves both inputs unchanged).

### Unit-testable — `tests/workspaceState.test.ts` (node environment)

| Case | Result |
|---|---|
| `emptyWorkspaceState()` | includes `explorerView: 'files'`, `explorerSectionsOpen: []` |
| `parseWorkspaceState('{"version":1,"explorerView":"search"}')` | `{ ...emptyWorkspaceState(), explorerView: 'search' }` |
| `parseWorkspaceState('{"version":1,"explorerView":"tree"}')` | `emptyWorkspaceState()` |
| `parseWorkspaceState('{"version":1,"explorerSectionsOpen":[false,true]}')` | `{ ...emptyWorkspaceState(), explorerSectionsOpen: [false, true] }` |
| `parseWorkspaceState('{"version":1,"explorerSectionsOpen":[0,1]}')` | `emptyWorkspaceState()` — whole array dropped |
| `workspaceStateFromSession` on a session with `projectRoot: '/p'`, `explorerView: 'search'`, `explorerSectionsOpen: [true, false]` | both copied verbatim |
| `applyWorkspaceOverlay` with a session at `'files'`/`[]` and a workspace at `'search'`/`[true, false]` | result is `'search'`/`[true, false]` |
| `applyWorkspaceOverlay` with a workspace at `'files'`/`[]` and a session at `'search'`/`[false, false]` | result is `'files'`/`[]` — a valid workspace file replaces, never merges |

### Manual verification (`npm run tauri:dev`)

Everything below is DOM- and event-driven, so none of it is reachable from the node test harness.

- **A collapsed *Properties* section survives a relaunch.** Collapse *Properties*, quit, relaunch:
  *Properties* is still collapsed to its header and the tree section is still open.
- **A collapsed tree section survives a relaunch**, and the explorer pane keeps its width. Collapse
  the tree section only, quit, relaunch: only *Properties* is open, and the pane is as wide as it
  was (`EXPLORER_MIN_SIZE`/`EXPLORER_PREFERRED_SIZE`,
  [src/shell/EditorShell.ts:81](src/shell/EditorShell.ts#L81), already cover the both-collapsed
  case).
- **Both sections collapsed survives a relaunch**: two headers and nothing else, pane width intact.
- **The rail's Search view survives a relaunch.** Switch to Search, quit, relaunch: the Search
  toggle is selected, the Files toggle is not, and the Search view is showing — with an empty query
  field that does **not** have keyboard focus.
- **Quitting inside the debounce window still saves.** Collapse a section and quit within half a
  second: the state comes back on relaunch, via the exit flush
  ([src/shell/EditorShell.ts:397](src/shell/EditorShell.ts#L397)).
- **A live folder switch no longer springs a collapsed section open.** Collapse *Properties*, then
  *Open Folder…* another project: *Properties* stays collapsed, the tree section's header shows the
  new project's name, and the rail resets to Files.
- **Each project remembers its own flags.** Open project A, collapse *Properties*, quit. Open
  project B (no `.loom/` yet), collapse the tree section instead, quit. Relaunch and reopen A: A's
  own `.loom/workspace.json` brings back *Properties* collapsed with the tree section open.
- **Tree expansion restores behind a collapsed tree section.** Expand several directories, collapse
  the tree section, quit, relaunch, then open the tree section: the same directories are still
  expanded.
- **A length mismatch falls back to both-open.** Hand-edit a project's
  `.loom/workspace.json` to `"explorerSectionsOpen": [true]` and relaunch: both sections are open,
  and every other field in that file still restores.
- **An unknown view falls back to Files.** Hand-edit `"explorerView": "banana"` and relaunch: the
  Files view shows, with no error dialog.
- **A pre-upgrade file still works.** With a `session.json` and `.loom/workspace.json` written
  before this change (neither field present), relaunch: Files view, both sections open, and tabs,
  expansion, and pane sizes all restore as before.
- **The app-wide file is the fallback.** Delete a project's `.loom/workspace.json`, leave
  `session.json` holding `"explorerView": "search"`, relaunch: the Search view shows.

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — clean, including the extended `tests/session.test.ts` and
  `tests/workspaceState.test.ts`.
- `grep -rn 'type ExplorerView' src/` — exactly one match, `src/data/session.ts`.
- `grep -c 'new AccordionConstraints' src/shell/EditorShell.ts` — `2`.
- `grep -c 'AccordionConstraints(.*, true,' src/shell/EditorShell.ts` — `0` (confirms both sections
  now read their open flag from state).
- `grep -c 'sectiontoggle' src/shell/EditorShell.ts` — `1`, the `listeners` bag key.
- `grep -n "selectExplorerView('files')" src/shell/EditorShell.ts` — still exactly one match, in
  the project-root listener's `finally` block (confirms the live-switch reset survived).
- `grep -c 'expandedDirs' src/shell/session.ts` — still `2` (the capture line and the replay line);
  this plan adds no tree-expansion logic.
- `npm run build` — passes.
- `npm run tauri:dev` — every case under `## Expected Behaviour` › *Manual verification*. The
  sidebar is the screen to exercise; the rail's two buttons and the Files view's two accordion
  headers are the controls.

---

## Documentation Impact

No API documentation site exists in this repository; `README.md` and `TODO.md` are the only prose
surfaces.

**`README.md`** — the Session-restore bullet ([README.md:88-92](README.md#L88)) lists what comes
back on relaunch and must now include the sidebar's own state:

> - **Session restore** — the last project folder, expanded tree directories, open tabs, the
>   explorer width, which sidebar view was showing, and which of its sections were open all come
>   back on the next launch. Once a project has been saved to once, all of that travels with the
>   project folder itself (in `.loom/workspace.json`) rather than only living in the app-wide file.

**`README.md`** — the Sidebar-rail bullet ([README.md:17-21](README.md#L17)) says only that
selecting a view shows its content; append one sentence:

> The view you last had selected, and which of the Files view's sections were open, come back on
> the next launch.

**`TODO.md`** — delete the *Remembering which explorer sections are open* bullet from `## High`
([TODO.md:22-25](TODO.md#L22)) outright. It is fully resolved: the tree's expanded directories were
already persisted, and the rail view plus the accordion sections are what this plan adds.

**No edit to `plans/implemented/sidebar-rail-and-search-tree.md`.** Its `## Non-Goals` bullet
*Persisting the selected rail view, or the search tree's expansion state* is half superseded by this
plan, but an implemented plan is a record of what shipped, not a live document — leave it alone. The
surviving half of that bullet, the search results tree's own expansion state, is restated in this
plan's `## Non-Goals`, which is where a reader now looks.

---

## Potential Challenges

- **`Accordion` reads `initiallyOpen` once per section, during its first layout pass.** Seeding
  through `AccordionConstraints` is therefore the only restore path that works at construction
  time; `openSection`/`closeSection` called before that pass hit an empty internal open-state array
  and silently do nothing. Mitigation: the plan never calls them.
- **The toggle callback must go in a nested `listeners` bag.** `new Accordion({ compact: true,
  sectiontoggle: fn })` typechecks against no option and is silently ignored — `AccordionOptions`
  declares `listeners?: { sectiontoggle?, sectionresize? }`. Mitigation: `## Internal Structure`
  gives the exact literal; step 6's grep confirms it.
- **A rebuilt accordion needs the callback re-attached.** `relabelTreeSection` constructs a new
  `Accordion`, so the `sectiontoggle` listener is attached per build, inside
  `buildFilesViewSections`, not once at the call site. Mitigation: the callback is a parameter of
  that function, so every build path has to pass it.
- **`this._autosave` is `null` during the restore, by design.** `selectExplorerView` and the
  `sectiontoggle` callback both use `this._autosave?.schedule()`, and `restoreSession` installs the
  autosave only after the restore finishes
  ([src/shell/EditorShell.ts:394](src/shell/EditorShell.ts#L394)) — so a restore can never save its
  own half-finished state. Do not add a suppression flag.
- **`this` inside constructor closures is fine here.** `onSectionToggle` and `selectExplorerView`
  are arrow functions defined before `super()` but invoked only after construction, the same shape
  the existing `onOpenRecentProject` closure at
  [src/shell/EditorShell.ts:172](src/shell/EditorShell.ts#L172) already uses.
- **Clicking the already-active rail button schedules a redundant save.** A `ToggleButton` flips on
  every click, so `selectExplorerView` re-selects it and schedules a write of an identical snapshot.
  That is harmless and matches what re-collapsing an already-collapsed `Split` pane does today; do
  not add a dirty check.
- **`node_modules/@jimka/typescript-ui` is currently a dangling symlink** in this checkout — it
  points at `typescript-ui/.worktrees/code-editor-reveal-center/packages/lib`, a worktree that no
  longer exists, so `npm run typecheck` and `npm run build` cannot run until it is repointed (the
  live library source is at `../typescript-ui/packages/lib`). `npm test` is unaffected — vitest
  strips the `import type` lines that reach the library. Mitigation: fix the symlink before step 4,
  the first step whose check runs `tsc`; this is an environment problem, not a change this plan
  makes.

---

## Critical Files

- [`src/data/session.ts`](src/data/session.ts) — the app-wide schema, its per-field degradation
  rules, and the `VALID_LAYOUT_SIZE_UNITS`/`readNumberArray` shapes the two new readers copy.
- [`src/data/workspaceState.ts`](src/data/workspaceState.ts) — the per-project schema, and the
  deliberate verbatim duplication of every reader from `session.ts`.
- [`src/shell/session.ts`](src/shell/session.ts#L55) — `captureSession`, `applySession`, and
  `installSessionAutosave`: the capture/restore/autosave seam.
- [`src/shell/EditorShell.ts`](src/shell/EditorShell.ts#L182) — the rail, the content `Card`, the
  Files-view accordion, `selectExplorerView`, `relabelTreeSection`, and `restoreSession`.
- [`src/main.ts`](src/main.ts#L48) — `start()`, confirming the shell's constructor already receives
  the workspace-overlaid session, which is why no restore code is added anywhere else.
- [`plans/implemented/workspace-session-persistence.md`](plans/implemented/workspace-session-persistence.md) —
  the precedent this plan's schema change mirrors. Read `## Architecture Decisions` ›
  *Tree expansion, open tabs, and split geometry are workspace-scoped* and
  *An absent or unusable workspace file falls back to the app-wide session*.
- [`plans/implemented/session-persistence.md`](plans/implemented/session-persistence.md) —
  `## Architecture Decisions` › *The split restores through `Split`'s constructor, not a post-layout
  re-apply* and *Stale entries degrade field by field, and arrays whole*.
- [`plans/implemented/sidebar-rail-and-search-tree.md`](plans/implemented/sidebar-rail-and-search-tree.md) —
  how the rail was built, and its *A project switch resets the rail to Files* decision this plan
  keeps.
- [`plans/implemented/explorer-properties-panel.md`](plans/implemented/explorer-properties-panel.md) —
  why the Files view is a `Container` laid out by a bare `Accordion`, and why the tree section
  carries `weight: 1`.
- [`../typescript-ui/packages/lib/docs/layouts/Accordion.md`](../typescript-ui/packages/lib/docs/layouts/Accordion.md) —
  *Per-child constraints* (`initiallyOpen`) and *Toggle callback* (the `listeners: { sectiontoggle }`
  bag).
- [`../sqladmin/frontend/src/data/layoutStore.ts`](../sqladmin/frontend/src/data/layoutStore.ts#L53) —
  SQLAdmin's worked example of persisting `Accordion` open state, and the library's most thorough
  reference app: `ACCORDION_DEFAULT_OPEN`, `readOpen`, and `_saveOpenSection`.

---

## Non-Goals

- **Persisting the Search view's query text or its results.** Restoring to Search shows an empty
  query field. Re-running a saved search on launch would mean reading every file in the project
  before the window is usable; nothing asks for it.
- **Persisting the search results tree's own expanded branches.** `SearchPanel` rebuilds that tree
  and calls `expandAll()` on every streamed batch, so there is no per-branch state to save — the
  surviving half of `sidebar-rail-and-search-tree.md`'s own non-goal.
- **Persisting accordion section *sizes*** (the heights a `resizable` accordion's gutters set).
  Loom's accordion is not resizable, so `sectionSizes`/`sectionresize` have nothing to record.
- **Restoring the newly-chosen project's view or section flags on a live *Open Folder…* switch.**
  A live switch keeps restoring only `expandedDirs`, per
  `workspace-session-persistence.md`'s *Cold start restores everything together; a live folder
  switch restores only the tree*.
- **Persisting whether the explorer pane itself is collapsed.** `collapsedPanes` already covers
  that, unchanged by this plan.
- **Any change to how tree expansion is captured or replayed.** `expandedDirs` already works; this
  plan adds nothing to `FileTree`.
- **A `version` bump, or a migration step.** The two fields are additive and each degrades to its
  default on its own.
- **Switching the Files view to `AccordionPanel`.** Investigated and rejected.[^accordion-panel]
- **Adding `Accordion.setSectionLabel` to the library.** Recorded as a gap; out of scope here.

---

## Notes

[^additive-fields]: This is the same move `plans/implemented/recent-projects.md` made — its
    `## Architecture Decisions` › *Recent history is two more fields on the existing `session.json`*
    added `recentProjects`/`recentFiles` to `SessionState` with no new file, no new capability grant,
    and no `version` bump, relying on `parseSession`'s per-field degradation to make an older file
    keep working. The alternative considered was a separate UI-layout store, which is what SQLAdmin
    does (`../sqladmin/frontend/src/data/layoutStore.ts`) — but SQLAdmin needs one because its
    layout state is keyed per signed-in user in `localStorage` and has no app-wide session file to
    live in. Loom has two such files already, both already carrying layout state
    (`paneSizes`/`collapsedPanes`), so a third storage mechanism would add a file to read, a write
    path to debounce, and a third place to look for "why did the sidebar come back like this."

[^both-files]: The alternative was keeping both fields app-wide only, on the reasoning that "which
    sidebar view I use" is a habit rather than a property of a project.
    `workspace-session-persistence.md` already argued and settled the equivalent question for
    `paneSizes`/`collapsedPanes` the other way — its `## Architecture Decisions` records that it
    reversed its own first draft, because a project with deeply nested paths wants a wider tree pane
    without changing every other project's width. The same argument applies here with more force: a
    project being read rather than edited wants *Properties* open, and a project being searched
    heavily wants the Search view; neither preference should follow the user into an unrelated
    folder. Keeping the fields in both files also leaves one rule to remember instead of a
    per-field table.

[^boolean-flags]: A `collapsedSections: number[]` field, mirroring `collapsedPanes`
    ([src/shell/session.ts:65](src/shell/session.ts#L65)), was the other candidate and was rejected.
    SQLAdmin — the library's own most thorough worked example, and the closest precedent for
    persisting `Accordion` state specifically — deliberately stores *panes* as collapsed indices
    (`collapsed?: number[]`) and *accordion sections* as open flags (`open?: boolean[]`) in the same
    blob (`../sqladmin/frontend/src/data/layoutStore.ts:61`), because an accordion's section count
    is fixed and known per site while a collapsed-index list is open-ended. Copying
    `collapsedPanes`' shape onto an accordion would diverge from that reference app's own split.
    Flags also fit the restore path exactly: `AccordionConstraints.initiallyOpen` wants one boolean
    per section, so an index list would have to be converted at both ends, and a stale index (say
    `[5]` from a future section list) would need its own range check rather than falling out of a
    single length comparison.

[^constructor-seeded]: `Accordion` builds its internal `_openState` array inside `createSection`,
    which runs from `doLayout` once the container has a DOM element
    ([../typescript-ui/packages/lib/src/typescript/lib/layout/Accordion.ts:1297](../typescript-ui/packages/lib/src/typescript/lib/layout/Accordion.ts#L1297)),
    reading each section's `initiallyOpen` constraint there. `openSection`/`closeSection` both
    return early when `index >= this._openState.length`
    ([Accordion.ts:855](../typescript-ui/packages/lib/src/typescript/lib/layout/Accordion.ts#L855)),
    so a restore that ran before the first layout pass would silently do nothing, and one scheduled
    to run after it would paint the default open state for a frame before correcting itself. Seeding
    the constraints avoids both. The rail view follows the same shape for the same reason — `ToggleButton`'s `selected`
    option and `Card`'s initial page, set once before any listener exists, rather than a
    `selectExplorerView` call during restore (which would also fire the autosave path).

[^shell-owned-flags]: `Accordion.isSectionOpen(index)` returns `this._openState[index] ?? false`
    ([Accordion.ts:940](../typescript-ui/packages/lib/src/typescript/lib/layout/Accordion.ts#L940)),
    and `_openState` is emptied by `detach()` and refilled only on the next layout pass. Because
    `relabelTreeSection` replaces the accordion on every project switch, there is a window after
    each switch in which the live accordion reports every section closed regardless of its
    constraints — and the autosave's 500ms debounce is exactly the kind of timer that can fire
    inside it. Keeping the flags in the shell removes the race entirely, and gives
    `buildFilesViewSections` something to read that does not depend on layout having run. It is also
    what SQLAdmin does: `_saveOpenSection` merges one index into a stored array rather than polling
    the accordion (`../sqladmin/frontend/src/data/layoutStore.ts:295`).

[^shell-schedules]: `installSessionAutosave` subscribes to events on the three long-lived objects it
    is handed — the tree, the tab strip, and the split — none of which is ever replaced. The
    accordion *is* replaced, on every project switch, so a subscription made there would be lost at
    the first switch and would have to be re-made from inside `EditorShell` anyway. `EditorShell`
    already schedules saves directly where it owns the event
    ([src/shell/EditorShell.ts:446](src/shell/EditorShell.ts#L446), the end of `openProjectRoot`),
    so this is the established split, not a new one: `installSessionAutosave` owns the stable
    subscriptions, the shell owns the ones tied to things it rebuilds.

[^live-switch-scope]: Two already-settled behaviours meet here, and both are left as they are.
    `workspace-session-persistence.md` settled that a live *Open Folder…* restores only the new
    project's tree expansion, not its tabs or split geometry — extending that to the view and the
    section flags would mean reversing a decision nothing in this request asks about.
    `sidebar-rail-and-search-tree.md` separately settled that a project switch resets the rail to
    Files, because the previous project's search results do not belong to the new one. Together they
    mean a switch writes the *current* view and flags into the new project's own
    `.loom/workspace.json`, the same way it already writes the current pane sizes there. The section
    flags carrying across the switch is a change, but in the direction the user asked for: a
    collapsed section staying collapsed is the feature, and the rebuild resetting it was the bug
    named in `relabelTreeSection`'s own doc comment.

[^duplicated-readers]: `src/data/session.ts` and `src/data/workspaceState.ts` already hold
    byte-identical private copies of `parseDocument`, `readOptionalString`, `readStringArray`,
    `readNumberArray`, `readLayoutSizeArray`, `isLayoutSize`, and `VALID_LAYOUT_SIZE_UNITS` —
    `workspace-session-persistence.md` introduced the second set knowingly, so that each schema
    module stays a self-contained description of one file's format with nothing to coordinate when
    one format diverges from the other. Extracting a shared reader module now would be a refactor of
    both modules bundled into an unrelated feature, and would couple two formats that are deliberately
    allowed to drift (`parseSession` degrades to an empty session; `parseWorkspaceState` returns
    `null`).

[^accordion-panel]: `AccordionPanel`
    (`@jimka/typescript-ui/component/container`, listed in the library's capability manifest under
    *Self-managing accordion of collapsible sections*) wraps a `Container` around an internal
    `Accordion` and takes a `sections` array (each entry carrying its own `initiallyOpen`) plus an
    `onSectionToggle` callback through its own options bag — on its face a neater fit than the bare
    `Container` + `Accordion` pair the Files view uses.
    It is the wrong tool for this file for two reasons. Its constructor sets
    `this.setLayoutManager(new Accordion())` unconditionally and its own comment explains why
    ("`AccordionPanel`'s identity is the `Accordion` manager. Override-by-options would defeat the
    class"), while `relabelTreeSection` exists precisely to swap in a differently-labelled manager
    — the one operation the class is built to prevent. And switching would reverse
    `explorer-properties-panel.md`'s settled *The sidebar becomes a `Container` laid out by
    `Accordion`* decision as a side effect of an unrelated feature. The bare pair already gives
    everything this plan needs: `AccordionConstraints.initiallyOpen` in, `listeners: { sectiontoggle }`
    out.

[^relabel-gap]: `Accordion.createSection` reads a section's `label` constraint exactly once, when it
    first discovers that child, and the library exposes no setter to retitle a built
    `AccordionHeader`. That is why `relabelTreeSection` exists at all, and its doc comment has
    recorded the constraint since `explorer-properties-panel.md` shipped — it predates this plan. An
    upstream `Accordion.setSectionLabel(index, label)` would delete the rebuild, and with it the
    reason the open flags have to be carried through `buildFilesViewSections` on every project
    switch. Per `CLAUDE.md`'s rule against papering over missing library capabilities, the gap is
    named here for the user to decide whether to file it; this plan does not depend on the answer,
    because seeding open state through `AccordionConstraints` is how the library intends sections to
    be initialised either way.
