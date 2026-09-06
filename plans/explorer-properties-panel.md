---
touches-shared: [src/explorer/FileTree.ts, src/shell/EditorShell.ts, src/data/workspace.ts, README.md, TODO.md]
---

# Explorer Properties Panel — Implementation Plan

## Overview

Split the explorer sidebar into two collapsible sections stacked vertically:
the existing file tree on top, and a new properties panel below it showing the
name, path, type, size, and last-modified time of whichever tree row is
selected. The two sections live in an `Accordion` — the layout manager
`@jimka/typescript-ui` ships for exactly this shape — replacing the bare
`FileTree` that sits in the split's explorer pane today
([`src/shell/EditorShell.ts:117`](src/shell/EditorShell.ts#L117)).

Two files are new. [`src/explorer/entryProperties.ts`](src/explorer/entryProperties.ts)
is a pure module that turns a selected row plus its filesystem metadata into
label/value lines; [`src/explorer/PropertiesPanel.ts`](src/explorer/PropertiesPanel.ts)
is the component that paints them. Three existing source files change, plus
the two docs. [`src/data/workspace.ts`](src/data/workspace.ts) gains a
`statEntry` wrapper over the Tauri `stat` it already imports;
[`src/explorer/FileTree.ts:35`](src/explorer/FileTree.ts#L35) gains one
callback that reports the selected row — directory rows included, which
nothing reports today; and
[`src/shell/EditorShell.ts:93`](src/shell/EditorShell.ts#L93) builds the
accordion and wires the two together.

The tree keeps every behaviour it has. `onSelectFile` — the callback that
browses a file into the temp tab — is untouched, so a directory selection
still opens no tab.

---

## Architecture Decisions

### The sidebar becomes a `Container` laid out by `Accordion`

`EditorShell` builds a `Container({ layoutManager: new Accordion(…) })`, adds
the tree and the properties panel to it with an `AccordionConstraints` each,
and puts that container in the split pane where the tree used to go. This is
the same composition the shell already uses one line earlier for the split
itself — `const splitBody = Container({ layoutManager: split })` at
[`src/shell/EditorShell.ts:115`](src/shell/EditorShell.ts#L115).[^bare-container]

### The tree section carries `weight: 1`; the properties section carries none

The tree absorbs all the sidebar's leftover height and the properties panel
sits at whatever height its content needs.[^weight-not-fill]

### `FileTree` gains an `onSelectEntry` callback reporting the selected row

`FileTreeParams` gains `onSelectEntry: (entry: SelectedEntry | null) => void`,
fired for a file row and a directory row alike, and fired with `null` when the
selection is cleared. The existing `onSelectFile` keeps firing for file rows
only, so `EditorShell`'s temp-tab behaviour is unchanged.[^new-callback]

### `onSelectEntry` reports the selection's anchor row, from every path that changes it

`FileTree` reports through one private method that reads `Tree.getSelectedNode`
— the anchor row, the one a plain click or an arrow-key move last landed on,
already how [`selectedPath`](src/explorer/FileTree.ts#L439) reads the
selection. That method is called
from the `"selection"` event handler and from each of the four places
`FileTree` changes the selection itself, so the panel tracks the highlighted
row however it got highlighted.[^anchor-and-programmatic]

### Metadata comes from a new `statEntry` in `src/data/workspace.ts`

`statEntry(path)` wraps the `stat` that module already imports
([`src/data/workspace.ts:7`](src/data/workspace.ts#L7)) and resolves `null`
when the path is missing or unreadable — the swallow-and-degrade shape
`tryReadTextFile` ([`src/data/workspace.ts:145`](src/data/workspace.ts#L145)),
`pathExists` ([`src/data/workspace.ts:161`](src/data/workspace.ts#L161)) and
`isDirectory` ([`src/data/workspace.ts:211`](src/data/workspace.ts#L211))
already use.[^stat-entry]

### Row formatting is a pure module, unit-tested; the component only paints

`src/explorer/entryProperties.ts` holds the size and timestamp formatting and
the row list, with no imports that touch the DOM. `src/explorer/PropertiesPanel.ts`
writes those strings into `Text` components. This mirrors
[`src/shell/welcomeText.ts:1`](src/shell/welcomeText.ts#L1), split out of
`WelcomeScreen` for the same reason.[^pure-split]

### The panel is a two-page `Card` deck: an empty line, or the grid

The panel's own layout manager is a `Card` holding a muted "nothing selected"
line and a `LabeledGrid` of five rows, one visible at a time. This mirrors
`buildEditorDeck` at
[`src/shell/EditorShell.ts:335`](src/shell/EditorShell.ts#L335), which switches
the editor pane between the tab strip and the welcome screen the same
way.[^card-deck]

### The grid's rows are built once and updated by `setText`

The five label/value pairs are added to the `LabeledGrid` in the constructor
and never added or removed again; a new selection rewrites the value `Text`s
in place. `FileBreadcrumbs.updateTrail`
([`src/editor/FileBreadcrumbs.ts:118`](src/editor/FileBreadcrumbs.ts#L118))
updates its trail the same way.[^fixed-rows]

---

## Public API

### `src/data/workspace.ts` — one new type, one new function

```typescript
/** A file or folder's metadata, as the properties panel consumes it. */
export interface EntryInfo {
    /** The entry's size in bytes, as the platform reports it. */
    size: number
    /** The last-modified time, or `null` when the platform does not report one. */
    modified: Date | null
}

/**
 * Reads `path`'s metadata, resolving `null` when it is missing or unreadable —
 * which includes a path outside the app's filesystem scope. Works on a
 * directory as well as a file.
 *
 * @param path - The file or directory to read.
 * @returns The entry's metadata, or `null`.
 */
export async function statEntry(path: string): Promise<EntryInfo | null>
```

### `src/explorer/entryProperties.ts` — new pure module

```typescript
/** A file-tree row the properties panel can describe. */
export interface SelectedEntry {
    /** The entry's absolute path on disk. */
    path: string
    /** Whether the entry is a directory. */
    isDir: boolean
}

/** One label/value line in the properties panel. */
export interface PropertyRow {
    label: string
    value: string
}

/** Written wherever a value is unavailable — an em-dash, not an empty cell, so a blank row still reads as deliberate. */
export const NO_VALUE = '—'

/** The panel's row labels, in display order. {@link entryPropertyRows} returns one row per label, in this order. */
export const PROPERTY_LABELS = ['Name', 'Path', 'Type', 'Size', 'Modified'] as const

/**
 * The five lines describing `entry`.
 *
 * @param entry - The selected tree row.
 * @param info - `entry`'s metadata, or `null` when it could not be read.
 * @param projectRoot - The open project folder, or `null` when none is open.
 * @returns One row per {@link PROPERTY_LABELS} entry, in that order.
 */
export function entryPropertyRows(
    entry: SelectedEntry,
    info: EntryInfo | null,
    projectRoot: string | null,
): PropertyRow[]

/**
 * `bytes` written in binary units: plain bytes below 1 KiB, otherwise the
 * largest unit that leaves a value under 1024, to one decimal place.
 *
 * @param bytes - The size to format.
 * @returns The formatted size, e.g. `"1.5 KiB"`.
 */
export function formatSize(bytes: number): string

/**
 * `when` written as `YYYY-MM-DD HH:MM` in local time.
 *
 * @param when - The timestamp to format.
 * @returns The formatted timestamp.
 */
export function formatTimestamp(when: Date): string
```

`EntryInfo` is imported here as a type only (`import type { EntryInfo } from
'../data/workspace'`), so this module still loads in vitest's `node`
environment.

### `src/explorer/PropertiesPanel.ts` — new component

```typescript
/** Constructor parameters for {@link PropertiesPanel}. */
export interface PropertiesPanelParams {
    /** The open project folder, or `null` when none is open — the Path row is shown relative to it. */
    projectRoot: string | null
}

class PropertiesPanel extends Container {
    /** Shows `entry`'s properties, or the empty line when `entry` is `null`. */
    setEntry(entry: SelectedEntry | null): void

    /** Repoints the panel at a new project folder and repaints the current row. */
    setProjectRoot(root: string | null): void
}

const PropertiesPanelCallable = callable(PropertiesPanel)
type PropertiesPanelCallable = PropertiesPanel
export { PropertiesPanelCallable as PropertiesPanel }
```

Backing fields: `_card: Card` (readonly), `_values: Text[]` (readonly, one per
`PROPERTY_LABELS` entry in the same order), `_projectRoot: string | null`, and
`_entry: SelectedEntry | null = null`.

### `src/explorer/FileTree.ts` — one added parameter

```typescript
export interface FileTreeParams {
    /** Invoked with the selected row — a file or a directory — or `null` when
     *  the selection is cleared. Fires on a single click, an arrow-key move,
     *  and every selection the tree makes itself. */
    onSelectEntry: (entry: SelectedEntry | null) => void
    // …the five existing callbacks, unchanged
}
```

Backing field `_onSelectEntry: (entry: SelectedEntry | null) => void`
(readonly), assigned in the constructor beside the existing five.

---

## Internal Structure

### `formatSize`

```typescript
export function formatSize(bytes: number): string {
    let value = bytes
    let unit = 0

    while (value >= SIZE_STEP && unit < SIZE_UNITS.length - 1) {
        value /= SIZE_STEP
        unit += 1
    }

    return unit === 0 ? `${value} ${SIZE_UNITS[0]}` : `${value.toFixed(SIZE_DECIMALS)} ${SIZE_UNITS[unit]}`
}
```

| `bytes` | result | why |
| --- | --- | --- |
| `0` | `0 B` | below one step, shown exactly |
| `1023` | `1023 B` | still below one step |
| `1024` | `1.0 KiB` | one step up, one decimal |
| `1536` | `1.5 KiB` | the decimal carries the half |
| `5 * 1024 * 1024` | `5.0 MiB` | two steps up |
| `1024 ** 5` | `1024.0 TiB` | clamped at the largest unit |

### `formatTimestamp`

```typescript
export function formatTimestamp(when: Date): string {
    return `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}`
        + ` ${pad2(when.getHours())}:${pad2(when.getMinutes())}`
}
```

Local time throughout, so the shown time matches the machine's clock.

| `when` | result |
| --- | --- |
| `new Date(2026, 0, 15, 9, 5)` | `2026-01-15 09:05` |
| `new Date(2026, 11, 31, 23, 59)` | `2026-12-31 23:59` |

### `entryPropertyRows`

```typescript
export function entryPropertyRows(entry: SelectedEntry, info: EntryInfo | null, projectRoot: string | null): PropertyRow[] {
    return [
        { label: 'Name', value: baseName(entry.path) },
        { label: 'Path', value: relativeTo(projectRoot, entry.path) ?? entry.path },
        { label: 'Type', value: entry.isDir ? 'Folder' : 'File' },
        { label: 'Size', value: entry.isDir || info === null ? NO_VALUE : formatSize(info.size) },
        { label: 'Modified', value: info === null || info.modified === null ? NO_VALUE : formatTimestamp(info.modified) },
    ]
}
```

`baseName` and `relativeTo` are the existing helpers at
[`src/data/paths.ts:10`](src/data/paths.ts#L10) and
[`src/data/paths.ts:162`](src/data/paths.ts#L162). The Path row is shortened
against the project folder the same way `FileBreadcrumbs` shortens its trail.

With project root `/home/j/loom`:

| entry | `info` | rows |
| --- | --- | --- |
| `/home/j/loom/src/main.ts`, file | `{ size: 1536, modified: 2026-01-15 09:05 }` | `main.ts` / `src/main.ts` / `File` / `1.5 KiB` / `2026-01-15 09:05` |
| `/home/j/loom/src`, folder | `{ size: 4096, modified: 2026-01-15 09:05 }` | `src` / `src` / `Folder` / `—` / `2026-01-15 09:05` |
| `/home/j/loom/gone.ts`, file | `null` | `gone.ts` / `gone.ts` / `File` / `—` / `—` |
| `/etc/hosts`, file | `{ size: 220, modified: 2026-01-15 09:05 }` | `hosts` / `/etc/hosts` / `File` / `220 B` / `2026-01-15 09:05` |
| `/home/j/loom/src/main.ts`, file, root `null` | `{ size: 0, modified: null }` | `main.ts` / `/home/j/loom/src/main.ts` / `File` / `0 B` / `—` |

### `entryProperties.ts` module constants

```typescript
/** Size units, ascending, each {@link SIZE_STEP}× the previous. Binary units
 *  (KiB, not KB) because the step is 1024, matching how
 *  `src/data/workspace.ts`'s own `MAX_OPEN_BYTES` comment reads
 *  `5 * 1024 * 1024` as "5 MiB". */
const SIZE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const

/** The factor between two adjacent {@link SIZE_UNITS} entries. */
const SIZE_STEP = 1024

/** Decimal places shown for every unit above bytes — one separates 1.4 from
 *  1.5 MiB without implying byte-level precision the unit no longer carries. */
const SIZE_DECIMALS = 1

/** Width every date and time field is zero-padded to, in characters — two, the
 *  fixed width of every `YYYY-MM-DD HH:MM` field but the year. */
const DATE_FIELD_WIDTH = 2
```

### `PropertiesPanel` construction

```typescript
const card = new Card()
const values = PROPERTY_LABELS.map(() => new Text('', { truncate: true }))
const grid = LabeledGrid({ columns: 1 })
const empty = new Text(EMPTY_TEXT, { foregroundColor: EMPTY_COLOR })

PROPERTY_LABELS.forEach((label, index) => { grid.addField(label, values[index]) })
grid.setId(GRID_PAGE_ID)
empty.setId(EMPTY_PAGE_ID)

super({
    layoutManager: card,
    insets: new Insets(PANEL_PAD, PANEL_PAD, PANEL_PAD, PANEL_PAD),
    components: [empty, grid],
})
```

`truncate: true` caps each value `Text`'s reported minimum width, so a long
path ellipsises inside the sidebar instead of forcing the pane wider.

### `PropertiesPanel` update path

```typescript
setEntry(entry: SelectedEntry | null): void {
    this._entry = entry

    if (entry === null) {
        this._card.setVisibleComponentId(EMPTY_PAGE_ID)

        return
    }

    this.applyRows(entry, null)
    this._card.setVisibleComponentId(GRID_PAGE_ID)
    void this.loadInfo(entry)
}

private async loadInfo(entry: SelectedEntry): Promise<void> {
    const info = await statEntry(entry.path)

    if (this._entry === entry) {
        this.applyRows(entry, info)
    }
}

private applyRows(entry: SelectedEntry, info: EntryInfo | null): void {
    entryPropertyRows(entry, info, this._projectRoot).forEach((row, index) => {
        this._values[index].setText(row.value)
    })
}
```

Name, Path and Type are painted synchronously, before the metadata read
starts, so they never lag a click. The `this._entry === entry` check is what
stops a slow read for an earlier row from overwriting a newer selection —
`FileTree.startWatching` guards a late watch registration with the same
check-after-await shape ([`src/explorer/FileTree.ts:636`](src/explorer/FileTree.ts#L636)).

### `PropertiesPanel` module constants

```typescript
/** The `Card` deck's two page ids. */
const EMPTY_PAGE_ID = 'properties-empty'
const GRID_PAGE_ID = 'properties-grid'

/** Shown while no tree row is selected. */
const EMPTY_TEXT = 'Select a file or folder in the tree.'

/** The empty line's colour — the muted grey `WelcomeScreen` paints its own hint
 *  line (`src/shell/WelcomeScreen.ts:34`), so the two empty states read alike. */
const EMPTY_COLOR = 'rgb(140, 140, 140)'

/** Padding around the panel's content, in pixels. Mirrors `FileBreadcrumbs`'s
 *  own `BAND_PAD` (`src/editor/FileBreadcrumbs.ts:24`) so Loom's chrome indents
 *  its text by one consistent amount. */
const PANEL_PAD = 6
```

### `FileTree.notifySelectedEntry`

```typescript
private notifySelectedEntry(): void {
    const data = this.getSelectedNode()?.data as FileTreeNodeData | undefined

    this._onSelectEntry(data === undefined ? null : { path: data.path, isDir: data.isDir })
}
```

Reads the anchor node the way `selectedPath`
([`src/explorer/FileTree.ts:439`](src/explorer/FileTree.ts#L439)) already
does, so one method covers every way the selection can change.

### `EditorShell` sidebar construction

```typescript
const properties = PropertiesPanel({ projectRoot: session.projectRoot })
const explorerAccordion = new Accordion({ compact: true })
const treeSection = new AccordionConstraints(FILES_SECTION_LABEL, true, 'folder')

treeSection.weight = TREE_SECTION_WEIGHT

const explorer = Container({
    layoutManager: explorerAccordion,
    minSize: EXPLORER_MIN_SIZE,
    preferredSize: EXPLORER_PREFERRED_SIZE,
})

explorer.addComponent(tree, treeSection)
explorer.addComponent(properties, new AccordionConstraints(PROPERTIES_SECTION_LABEL, true, 'circle-info'))
splitBody.addComponent(explorer, { weight: 0 })
```

Both section glyphs are already registered at
[`src/main.ts:31`](src/main.ts#L31) — `folder` for the tree, `circle-info` for
the About button — so no glyph import is added.

### `EditorShell` module constants

```typescript
/** The tree section's header label. */
const FILES_SECTION_LABEL = 'Files'

/** The properties section's header label. */
const PROPERTIES_SECTION_LABEL = 'Properties'

/** The tree section's accordion weight. Any positive weight makes the tree the
 *  sole section that absorbs the sidebar's leftover height; 1 is the library's
 *  own default share. */
const TREE_SECTION_WEIGHT = 1

/** The explorer pane's floor and starting width, in pixels. Carried over
 *  verbatim from the `minSize`/`preferredSize` `FileTree` declares for itself
 *  (`src/explorer/FileTree.ts:74`), so the pane keeps the width it has today
 *  even when both accordion sections are collapsed and the accordion would
 *  otherwise report no width of its own. */
const EXPLORER_MIN_SIZE = { width: 160, height: 0 }
const EXPLORER_PREFERRED_SIZE = { width: 300, height: 0 }
```

---

## Ordered Implementation Steps

1. **`src/data/workspace.ts`** — add the `EntryInfo` interface next to
   `DirectoryItem` ([line 18](src/data/workspace.ts#L18)), and add `statEntry`
   immediately after `isDirectory` ([line 211](src/data/workspace.ts#L211)).
   The body is a `try { const info = await stat(path); return { size:
   info.size, modified: info.mtime } } catch { return null }`. No new import —
   `stat` is already imported on
   [line 7](src/data/workspace.ts#L7).

2. **Create `src/explorer/entryProperties.ts`.** No runtime imports beyond
   `baseName, relativeTo` from `../data/paths`; `EntryInfo` comes in as
   `import type` from `../data/workspace`. Open with a header comment saying
   the module stays free of Tauri and component imports so it runs in vitest's
   `node` environment, copying the wording at
   [`src/shell/welcomeText.ts:1`](src/shell/welcomeText.ts#L1). Declare the
   four module constants, the private `pad2(value: number): string` helper
   (`String(value).padStart(DATE_FIELD_WIDTH, '0')`), then the exports exactly
   as given in `## Public API` and `## Internal Structure`.

3. **Create `tests/entryProperties.test.ts`** — a `describe` block per
   exported function, one `it` per row of the three tables in
   `## Internal Structure`, plus one `it` asserting
   `entryPropertyRows(…).map(row => row.label)` equals `[...PROPERTY_LABELS]`.
   Follow `tests/welcomeText.test.ts`'s style: one `expect` per `it`, a
   sentence-shaped test name. Run `npm test` — the new block passes, the
   existing ones are untouched.

4. **Create `src/explorer/PropertiesPanel.ts`.** Imports: `Container, callable`
   from `@jimka/typescript-ui/core`; `Insets` from
   `@jimka/typescript-ui/primitive`; `Card` from `@jimka/typescript-ui/layout`;
   `Text` from `@jimka/typescript-ui/component/input`; `LabeledGrid` from
   `@jimka/typescript-ui/component/container`; `statEntry` and
   `type EntryInfo` from `../data/workspace`; `PROPERTY_LABELS,
   entryPropertyRows` and `type SelectedEntry` from `./entryProperties`.
   Declare the five module constants, `PropertiesPanelParams`, and the class
   with the constructor, `setEntry`, `setProjectRoot`, `loadInfo`, and
   `applyRows` as given in `## Internal Structure`. End the constructor with
   `card.setVisibleComponentId(EMPTY_PAGE_ID)`. Close with the `callable()`
   export triple, copying the shape at
   [`src/explorer/FileTree.ts:729`](src/explorer/FileTree.ts#L729).

5. **`src/explorer/FileTree.ts`** — add `import type { SelectedEntry } from
   './entryProperties'`, add the `onSelectEntry` field to `FileTreeParams`
   ([line 35](src/explorer/FileTree.ts#L35)) with the doc comment from
   `## Public API`, declare the `_onSelectEntry` backing field beside
   `_onSelectFile` ([line 53](src/explorer/FileTree.ts#L53)), and assign it in
   the constructor beside `this._onSelectFile = params.onSelectFile`
   ([line 78](src/explorer/FileTree.ts#L78)).

6. **`src/explorer/FileTree.ts`** — add the private `notifySelectedEntry`
   method from `## Internal Structure`, placed directly after `selectedPath`
   ([line 439](src/explorer/FileTree.ts#L439)), then call it from five places:

   | method | line today | where the call goes |
   | --- | --- | --- |
   | `handleSelection` | [99](src/explorer/FileTree.ts#L99) | last statement, after the existing `_onSelectFile` `if` |
   | `setProjectRoot` | [308](src/explorer/FileTree.ts#L308) | after `this.startWatching(root)` |
   | `selectPath` | [337](src/explorer/FileTree.ts#L337) | inside the `if (node)` block, after `this.selectNode(node)` |
   | `reselect` | [453](src/explorer/FileTree.ts#L453) | last statement, outside the `if` — so a row the rebuild removed reports `null` |
   | `reload` | [500](src/explorer/FileTree.ts#L500) | after the `this.setNodes(...)` call |

   Check: `grep -c 'this.notifySelectedEntry()' src/explorer/FileTree.ts` —
   expect `5`.

7. **`src/shell/EditorShell.ts`** — add the five module constants from
   `## Internal Structure` beside `EXPLORER_PANE_INDEX`
   ([line 33](src/shell/EditorShell.ts#L33)), and update that constant's own
   doc comment to say the pane holds the explorer accordion rather than the
   tree. Add `Accordion, AccordionConstraints` to the existing
   `@jimka/typescript-ui/layout` import ([line 4](src/shell/EditorShell.ts#L4))
   and `import { PropertiesPanel } from '../explorer/PropertiesPanel'` beside
   the `FileTree` import ([line 9](src/shell/EditorShell.ts#L9)).

8. **`src/shell/EditorShell.ts`** — in the constructor, add
   `onSelectEntry: entry => properties.setEntry(entry)` to the `FileTree({…})`
   call ([line 93](src/shell/EditorShell.ts#L93)) — the parameter's type comes
   from `FileTreeParams`, so no `SelectedEntry` import is needed here; build
   `properties` and the
   accordion container exactly as in `## Internal Structure`, placed between
   the `splitBody` creation ([line 115](src/shell/EditorShell.ts#L115)) and
   `splitBody.addComponent(deck, …)` ([line 118](src/shell/EditorShell.ts#L118));
   and replace `splitBody.addComponent(tree, { weight: 0 })`
   ([line 117](src/shell/EditorShell.ts#L117)) with the `explorer` form. The
   `properties` const must be declared before the `FileTree({…})` call it is
   captured by.

   Check: `grep -n 'addComponent(tree' src/shell/EditorShell.ts` — one match,
   `explorer.addComponent(tree, treeSection)`.

9. **`src/shell/EditorShell.ts`** — add `properties.setProjectRoot(root)` to
   the `setProjectRootListener` callback, beside the existing
   `welcome.setProjectRoot(root)`
   ([line 175](src/shell/EditorShell.ts#L175)). Update the class doc comment
   ([lines 71-77](src/shell/EditorShell.ts#L71)) so "explorer tree beside the
   editor deck" reads "explorer accordion (file tree over properties panel)
   beside the editor deck".

10. **`README.md`** — add the *Properties* highlight bullet and extend the
    Architecture paragraph's component list, both as given in
    `## Documentation Impact`.

11. **`TODO.md`** — add the deferred section-state item to `## Low`, as given
    in `## Documentation Impact`.

12. **Run the whole `## Verification` list.**

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Create | `src/explorer/entryProperties.ts` |
| Create | `src/explorer/PropertiesPanel.ts` |
| Create | `tests/entryProperties.test.ts` |
| Modify | `src/data/workspace.ts` |
| Modify | `src/explorer/FileTree.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Unit-testable (`tests/entryProperties.test.ts`, node environment)

- `formatSize` returns each result in the `## Internal Structure` table:
  `0 B`, `1023 B`, `1.0 KiB`, `1.5 KiB`, `5.0 MiB`, `1024.0 TiB`.
- `formatTimestamp(new Date(2026, 0, 15, 9, 5))` is `2026-01-15 09:05` — a
  one-digit month, day, hour or minute is zero-padded — and a field already two
  digits wide is left alone (`new Date(2026, 11, 31, 23, 59)` →
  `2026-12-31 23:59`).
- `entryPropertyRows` returns exactly five rows, whose labels equal
  `PROPERTY_LABELS` in order, for every input.
- A file under the project root gets a project-relative Path and a formatted
  Size and Modified — row 1 of the `entryPropertyRows` table.
- A folder gets `Folder` for Type and `NO_VALUE` for Size even when `info`
  reports a non-zero size, because a directory's `stat` size describes the
  directory entry rather than its contents — row 2.
- A `null` `info` gets `NO_VALUE` for both Size and Modified, while Name, Path
  and Type still describe the row — row 3.
- A path outside the project root keeps its absolute path in the Path row —
  row 4 — and so does any path when `projectRoot` is `null`; a `null`
  `info.modified` gets `NO_VALUE` for Modified — row 5.
- `formatSize(0)` is `0 B`, not `NO_VALUE` — an empty file has a known size.

### Manual verification (`npm run tauri:dev`)

- The sidebar shows two headers, *Files* and *Properties*, both expanded, with
  the tree filling the space above the properties rows.
- Clicking a file row fills all five rows; clicking a folder row fills them
  with `Folder` and a dashed Size.
- Arrow-keying up and down the tree moves the panel with the highlight, one
  row at a time.
- Before any click — a freshly launched app with a restored project — the panel
  shows *Select a file or folder in the tree.* and no rows.
- Collapsing the *Files* header leaves the properties rows in place and the
  rest of the sidebar empty; collapsing *Properties* gives the whole sidebar
  back to the tree; collapsing both leaves two headers and keeps the pane at
  its current width.
- *View > Toggle Explorer* (Ctrl/Cmd+B) still collapses and restores the whole
  sidebar, accordion and all.
- Dragging the split gutter still resizes the sidebar, and the width still
  comes back after a restart.
- Selecting a file, then saving it from another editor, updates the panel's
  Size and Modified once the tree's watcher refresh lands.
- Selecting a file, then deleting it from the tree's context menu, drops the
  panel back to the empty line.
- Renaming the selected file updates the Name and Path rows to the new name.
- Switching tabs moves the tree highlight and the panel with it.
- Opening a different project folder clears the panel to the empty line.
- A file with a very long path keeps the Path row inside the sidebar (an
  ellipsis, not a widened pane).

---

## Verification

- `npm run typecheck` — passes. This is the check that every `FileTree({…})`
  call site now supplies `onSelectEntry`.
- `npm test` — passes, including the new `tests/entryProperties.test.ts`.
- `grep -c 'this.notifySelectedEntry()' src/explorer/FileTree.ts` — expect `5`.
- `grep -n 'addComponent(tree' src/shell/EditorShell.ts` — one match, on
  `explorer.addComponent(tree, treeSection)`.
- `grep -rn '@tauri-apps' src/explorer/entryProperties.ts` — zero matches (the
  module stays loadable in the node test environment).
- `npm run build` — passes.
- `npm run tauri:dev` — work through every bullet under *Manual verification*.

---

## Documentation Impact

`README.md` gains a highlight bullet after **File tree**:

> - **Properties** — a second, collapsible section under the file tree,
>   showing the selected file or folder's name, path, type, size, and
>   last-modified time. Selecting a row with a click or the arrow keys updates
>   it; with nothing selected it says so.

and its Architecture paragraph's component list gains `Accordion`:

> `@jimka/typescript-ui`'s layout and editor components (`Tree`, `Tab`/`TabBar`,
> `Split`, `Accordion`, `MenuBar`, `CodeEditor`, `MarkdownViewer`)

`TODO.md` gains one `## Low` item, per that file's own stated purpose of
collecting each plan's `## Non-Goals`:

> - **Remembering which explorer sections are open.** The sidebar's *Files* and
>   *Properties* accordion sections both start expanded on every launch;
>   neither `session.json` nor `.loom/workspace.json` records their state.

No API-documentation page exists in this repo — `README.md` and `TODO.md` are
the only prose surfaces.

---

## Potential Challenges

- **The properties section's height changes on the first selection**, because
  `Card` reports the size of its visible page only and the empty line is
  shorter than the five-row grid. Expected, and it settles after the first
  click; do not pin a fixed height to hide it.
- **A directory's `stat` size is not its contents' total** — it is the size of
  the directory entry itself, typically 4096 on Linux. `entryPropertyRows`
  already returns `NO_VALUE` for a folder's Size; do not "fix" it by showing
  the number.
- **`mtime` can be `null`** on a platform that does not report it. The
  Modified row's `NO_VALUE` branch covers it; do not assume a `Date`.
- **A rapid click-drag down the tree issues one `statEntry` per row.** The
  `this._entry === entry` check in `loadInfo` keeps a stale read from
  overwriting a newer row, and each read is a single `stat` — no debounce is
  needed or wanted.
- **`Tree.selectNode` does not emit `"selection"`, and `Tree.setNodes` clears
  the selection without emitting either.** That is why step 6 adds four calls
  beyond the event handler; dropping any of them leaves the panel showing a row
  the tree no longer highlights.

---

## Critical Files

- [`src/explorer/FileTree.ts`](src/explorer/FileTree.ts) — the tree being
  extended; read `handleSelection` (line 99), `selectPath` (337), `reselect`
  (453), `reload` (500), and the `callable()` export (729).
- [`src/shell/EditorShell.ts`](src/shell/EditorShell.ts) — the mount point;
  read the constructor's split wiring (115-118), the `Toggle Explorer` action
  (132), the project-root listener (174), and `buildEditorDeck` (335), which is
  the `Card`-deck precedent this plan mirrors.
- [`src/editor/FileBreadcrumbs.ts`](src/editor/FileBreadcrumbs.ts) — the
  closest existing component in shape: a params interface, documented module
  constants, `Insets`, and an `updateTrail` that rewrites text in place.
- [`src/shell/WelcomeScreen.ts`](src/shell/WelcomeScreen.ts) — the empty-state
  precedent, and where `EMPTY_COLOR` comes from (line 34).
- [`src/shell/welcomeText.ts`](src/shell/welcomeText.ts) and
  [`tests/welcomeText.test.ts`](tests/welcomeText.test.ts) — the pure-module
  plus unit-test split this plan copies.
- [`src/data/workspace.ts`](src/data/workspace.ts) — the sole `@tauri-apps/*`
  entry point; read `tryReadTextFile`, `pathExists` and `isDirectory` for the
  swallow-and-degrade shape `statEntry` follows.
- [`../typescript-ui/packages/lib/docs/layouts/Accordion.md`](../typescript-ui/packages/lib/docs/layouts/Accordion.md)
  — the `Accordion` reference, in particular *Fill mode* (what `weight` without
  `fillHeight` does), *Compact mode*, and *Per-child constraints*.
- [`../typescript-ui/packages/lib/docs/components/LabeledGrid.md`](../typescript-ui/packages/lib/docs/components/LabeledGrid.md)
  — `addField`'s contract.

---

## Non-Goals

- **Persisting which accordion sections are open.** Both sections start
  expanded on every launch. Recording the state means a new field in both
  `SessionState` and `WorkspaceState`, both parsers, `captureSession`,
  `workspaceStateFromSession`, `applyWorkspaceOverlay`, and both schema test
  files — more machinery than the two bits it stores.[^no-section-persistence]
- **Draggable section sizes.** `Accordion` offers `resizable` gutters, but they
  come with their own `sectionSizes` persistence surface, which the point above
  rules out for this change.
- **Editing anything from the panel.** Every row is read-only text; renaming
  and deleting stay in the tree's context menu.
- **More metadata than the five rows.** No permissions, owner, symlink target,
  line count, or directory-contents total. Each is a separate decision about
  what a code editor should surface, and `EntryInfo` is trivially extensible
  later.
- **A properties view for the project root itself.** The root is not a tree
  row, so it can never be the selection.
- **Multi-row selection.** `Tree` supports Ctrl- and Shift-selection; the panel
  describes the anchor row only, and does not grow a "3 items selected"
  summary.

---

## Notes

[^bare-container]: `AccordionPanel` is the library's convenience wrapper around
    the same manager, but its `addSection` surface takes no `LayoutConstraints`,
    and this plan needs a per-section `weight` (see the next decision). The
    library's own `AccordionPanel` documentation names that exact case —
    "reach for bare `new Container({ layoutManager: new Accordion() })` when you
    need custom `AccordionConstraints` per section". The bare form is also the
    shape `EditorShell` already uses for its `Split`, so nothing new is
    introduced.

[^weight-not-fill]: `Accordion` has two ways to hand out the container's
    leftover height. `fillHeight: true` shares it across every open section,
    which would pad the properties rows with empty space. A per-section
    `weight` with `fillHeight` off gives the whole leftover to the weighted
    sections only — the library's `computeFill` treats an unweighted section as
    weight `0` and skips it — so the tree grows and the properties panel stays
    at its content height. `FileTree` declares
    `preferredSize: { width: 300, height: 0 }`, and `Tree.getPreferredSize`
    honours an explicit constraint outright, so the tree's own preferred height
    contributes nothing and the whole remainder reaches it through the weight.

[^new-callback]: Broadening the existing `onSelectFile` to fire for directories
    was rejected: `EditorShell` wires it to
    `controller.openFile(path, 'temporary')`, so a directory selection would
    try to open a folder in a tab. A second callback keeps the two concerns —
    "browse this file" and "describe this row" — separate, which is also why
    the parameter is `SelectedEntry | null` rather than a bare path: the panel
    needs the directory flag and needs to hear about a cleared selection, and
    neither fits a `(path: string) => void` signature.

[^anchor-and-programmatic]: `Tree` emits `"selection"` for a click and an
    arrow-key move on any row, directory rows included — `_selectAtIndex` calls
    `_notifySelectionChange` regardless of the node's payload. It deliberately
    does *not* emit for `selectNode`, its programmatic setter, "so it must not
    re-trigger selection-driven side effects". `FileTree` calls `selectNode`
    from `selectPath` (syncing the tree to the active tab, and revealing a
    newly created or renamed entry) and from `reselect` (restoring the
    selection after a watcher-driven rebuild), and clears the selection outright
    via `setNodes` in `setProjectRoot` and `reload`. Reporting from all five
    places is what makes the panel track the highlight rather than only the
    clicks — and it is what makes an external write refresh the Size and
    Modified rows, since the watcher's rebuild ends in `reselect`. The anchor
    node is read rather than the event's `nodes[0]` because the anchor is
    well-defined under Ctrl/Shift multi-select while `getSelectedNodes()` order
    is not; `selectedPath` already reads the selection that way.

[^stat-entry]: `stat` follows symlinks and rejects for a missing path or one
    outside the app's filesystem scope, which is the same failure surface
    `pathExists` already swallows. Returning a narrow `EntryInfo` rather than
    Tauri's `FileInfo` keeps `@tauri-apps/*` types from leaking past
    `workspace.ts` — the module's own header comment calls itself the app's
    sole `@tauri-apps/*` entry point — and lets `entryProperties.ts` import the
    shape as a type without pulling the plugin into the test environment.

[^pure-split]: `vitest.config.ts` runs the suite in the `node` environment with
    no DOM, and any module importing a `@jimka/typescript-ui` component touches
    `document` at load time. Putting the formatting in its own module is what
    makes the size and timestamp rules testable at all; the component is left
    with nothing but `setText` calls, which is the part that has to be checked
    by eye anyway.

[^card-deck]: The alternative — one grid whose five values all read `—` when
    nothing is selected — was rejected because a column of dashes reads as
    broken rather than as empty. Toggling the grid's `setDisplayed(false)`
    instead of using a `Card` would also work, but `Card` is the pattern this
    codebase already reaches for when one of two views shows at a time, and it
    avoids depending on how each layout manager treats a `display: none` child.

[^fixed-rows]: `LabeledGrid` has `addField`/`addRow`/`addFullWidthRow` and no
    remove or clear method, so rebuilding the rows per selection would mean
    discarding and recreating the grid on every arrow-key press.
    `WelcomeScreen.setRecentProjects` does rebuild its children, but it has to —
    its row count varies. The properties panel's row count never does, so it
    takes the cheaper `FileBreadcrumbs` route and never calls `doLayout()` of
    its own.

[^no-section-persistence]: The state is also low-stakes in a way pane geometry
    is not: a collapsed section is one click from being reopened, and both
    sections start open, so a launch never hides anything the user cannot see
    how to get back. `Accordion` does expose the state — `isSectionOpen`,
    `openSection`/`closeSection`, and a `sectiontoggle` event — so adding this
    later is additive, not a redesign.
