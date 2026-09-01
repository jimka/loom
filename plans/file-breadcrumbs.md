---
touches-shared: [src/EditorController.ts, src/editor/FileEditor.ts, src/data/paths.ts, tests/paths.test.ts, README.md, TODO.md]
---

# File Breadcrumbs — Implementation Plan

## Overview

Add a thin band above each open file's editor showing where that file sits in
the project: a file glyph followed by the file's path written as
`src › editor › FileEditor.ts`. [`TODO.md:21`](TODO.md#L21) calls this
"File-type breadcrumbs just above the code editor"; read here as the
VSCode-style breadcrumb bar — the open file's path segments, led by the same
file icon the tree already draws.[^interpretation]

The band is a new `FileBreadcrumbs` component that
[`FileEditor`](src/editor/FileEditor.ts) mounts in a `Border` NORTH region
above its `CodeEditor`. Because `FileEditor` is a tab's content, each tab
carries its own band and switching tabs switches it — no cross-tab
synchronisation is needed.

Three source files change, plus the path-helper tests and the two docs.
[`src/data/paths.ts`](src/data/paths.ts) gains two pure helpers that turn a
path into displayable segments;
[`src/editor/FileEditor.ts:32`](src/editor/FileEditor.ts#L32) swaps its `Fit`
layout for a `Border`; and
[`src/EditorController.ts:75`](src/EditorController.ts#L75) starts remembering
the chosen project folder so the band can shorten paths against it.

---

## Architecture Decisions

### The band lives inside `FileEditor`, as a `Border` NORTH region

`FileEditor` swaps its `Fit` layout manager for a
`Border`, holding the band NORTH and the `CodeEditor` CENTER. This mirrors
[`src/shell/EditorShell.ts:53`](src/shell/EditorShell.ts#L53), where the shell
already stacks its menu bar NORTH over a CENTER body and a status bar SOUTH
with the same `new BorderLayout({ spacing: 0 })`.[^inside-fileeditor]

### Segments are plain text, not clickable

The band renders a single non-interactive string. Clicking a segment does
nothing.[^no-click]

### The whole trail is one `IconText`, not a component per segment

The band holds exactly one child, called the trail: an
[`IconText`](../typescript-ui/packages/lib/docs/components/IconText.md) pairing
the `file-code` glyph with a `Text` carrying the joined segment string.
`IconText`'s inner `Text` truncates with an ellipsis by default, so a path too
long for the pane degrades on its own.[^one-icontext]

### Paths are shown relative to the project folder, absolute when outside it

A file inside the open project folder shows only the part below that folder;
anything else shows every segment of its own path. `EditorController` gains a
`_projectRoot` field for this and pushes changes into every open
`FileEditor`.[^root-relative]

### Band metrics and colours are taken from the library's `StatusBar`

The band is `STATUS_BAR_HEIGHT` tall with `Insets(0, 6, 0, 6)`, and paints
itself from the `--ts-ui-statusbar-*` custom properties. `STATUS_BAR_HEIGHT` is
imported, not retyped.[^statusbar-metrics]

---

## Public API

### `src/data/paths.ts` — two new exports

```typescript
/**
 * Every non-empty segment of `path`, split on both `/` and `\`.
 *
 * @param path - A file or directory path, absolute or relative.
 * @returns The segments, leading/trailing/repeated separators dropped.
 */
export function pathSegments(path: string): string[]

/**
 * `path` rewritten relative to `root`, or `null` when `path` does not sit
 * strictly below `root`.
 *
 * @param root - The directory to measure against, or `null` when none is open.
 * @param path - The path to rewrite.
 * @returns The portion of `path` below `root`, or `null`.
 */
export function relativeTo(root: string | null, path: string): string | null
```

### `src/editor/FileBreadcrumbs.ts` — new component

```typescript
/** Constructor parameters for FileBreadcrumbs. */
export interface FileBreadcrumbsParams {
  /** The file's absolute path on disk. */
  path: string
  /** The open project folder, or `null` when none is open. */
  projectRoot: string | null
}

class FileBreadcrumbs extends Container {
  constructor(params: FileBreadcrumbsParams)

  /** Repoints the band at a new path and redraws the trail. */
  setPath(path: string): void

  /** Repoints the band at a new project folder and redraws the trail. */
  setProjectRoot(root: string | null): void
}

const FileBreadcrumbsCallable = callable(FileBreadcrumbs)
type FileBreadcrumbsCallable = FileBreadcrumbs
export { FileBreadcrumbsCallable as FileBreadcrumbs }
```

Backing fields: `_path: string`, `_projectRoot: string | null`, and
`_trail: IconText` (readonly). Both setters write their field and then call the
private `render()`.

### `src/editor/FileEditor.ts` — one added parameter, one added method

```typescript
export interface FileEditorParams {
  path: string
  text: string
  /** The open project folder, or `null` when none is open. */
  projectRoot: string | null
  onDirtyChange: (file: FileEditor) => void
}

class FileEditor extends Container {
  /** Repoints the breadcrumb band at a new project folder. */
  setProjectRoot(root: string | null): void
}
```

`FileEditor` stores the band as `_breadcrumbs: FileBreadcrumbs` (readonly) and
forwards both `setPath` and `setProjectRoot` to it. It keeps no project-root
field of its own — the band owns that state.

### `src/EditorController.ts` — one new private field

`private _projectRoot: string | null = null`, written only by
`openProjectFolder` and read only by `openFile`. No accessor: nothing outside
the controller reads it.

---

## Internal Structure

### `pathSegments`

```typescript
export function pathSegments(path: string): string[] {
  return path.split(/[/\\]/).filter(segment => segment.length > 0)
}
```

The split pattern is the one
[`baseName`](src/data/paths.ts#L11) already uses, so a Windows path resolves
the same way.

| `path` | result |
| --- | --- |
| `/p/src/main.ts` | `['p', 'src', 'main.ts']` |
| `src/main.ts` | `['src', 'main.ts']` |
| `C:\p\main.ts` | `['C:', 'p', 'main.ts']` |
| `/p//src/` | `['p', 'src']` |

### `relativeTo`

```typescript
export function relativeTo(root: string | null, path: string): string | null {
  if (root === null) {
    return null
  }

  const sep = root.includes('\\') ? '\\' : '/'
  const prefix = root.endsWith(sep) ? root : root + sep

  return path.startsWith(prefix) ? path.slice(prefix.length) : null
}
```

Matching is a plain string-prefix test against `root` plus a separator, so a
partial segment name never counts as a match. The separator is chosen the way
[`joinPath`](src/data/paths.ts#L44) chooses it — `\` when `root` contains one,
`/` otherwise.

| `root` | `path` | result | why |
| --- | --- | --- | --- |
| `/p` | `/p/src/main.ts` | `src/main.ts` | below the root |
| `/p/` | `/p/src/main.ts` | `src/main.ts` | trailing separator not doubled |
| `/p` | `/project/a.ts` | `null` | `/p` is not a whole segment of `/project/…` |
| `/p` | `/p` | `null` | the root itself is not below itself |
| `C:\p` | `C:\p\src\main.ts` | `src\main.ts` | backslash root picks `\` |
| `null` | `/p/src/main.ts` | `null` | no folder open |

### `FileBreadcrumbs.render`

```typescript
private render(): void {
  const shown = relativeTo(this._projectRoot, this._path) ?? this._path

  this._trail.setText(pathSegments(shown).join(SEGMENT_SEPARATOR))
}
```

| project root | file path | band text |
| --- | --- | --- |
| `/home/j/loom` | `/home/j/loom/src/editor/FileEditor.ts` | `src › editor › FileEditor.ts` |
| `/home/j/loom` | `/home/j/loom/README.md` | `README.md` |
| `/home/j/loom` | `/etc/hosts` | `etc › hosts` |
| `null` | `/home/j/loom/src/main.ts` | `home › j › loom › src › main.ts` |

### `FileBreadcrumbs` construction

```typescript
super({
  layoutManager: new HBox({ itemAlign: 'center' }),
  components: [{ component: trail, constraints: { weight: 1 } }],
  insets: new Insets(0, BAND_PAD, 0, BAND_PAD),
  minSize: { width: 0, height: STATUS_BAR_HEIGHT },
  preferredSize: { width: 0, height: STATUS_BAR_HEIGHT },
  backgroundColor: BAND_BACKGROUND,
  foregroundColor: BAND_FOREGROUND,
})
```

`weight: 1` hands the `IconText` the band's full width so its inner `Text` has
room to ellipsise rather than overflow. `itemAlign: 'center'` centres the
glyph and text in the fixed-height band — `HBox` otherwise aligns on the
baseline, which in a band with one child leaves it riding the top edge.

### Module constants

```typescript
/** Written between segments. U+203A, matching the `•`/`—` chrome characters the
 *  window title and tab labels already use, so no new glyph registration is
 *  needed in `src/main.ts`. */
const SEGMENT_SEPARATOR = ' › '

/** The glyph leading the trail — the same one `FileTree` draws on every file
 *  row (`src/explorer/FileTree.ts:38`), and already registered at
 *  `src/main.ts:19`. */
const TRAIL_GLYPH = 'file-code'

/** Horizontal inset, in pixels. Mirrors the library `StatusBar`'s own
 *  `Insets(0, 6, 0, 6)` (StatusBar.ts:60) so Loom's two chrome strips indent
 *  their text identically. */
const BAND_PAD = 6

/** Band fill. The `StatusBar` token, whose fallback is the shipped themes'
 *  own value and the same grey `FileTree` paints (`src/explorer/FileTree.ts:31`). */
const BAND_BACKGROUND = 'var(--ts-ui-statusbar-bg, rgb(245, 245, 245))'

/** Trail text and glyph colour — the `StatusBar` token, fallback as shipped. */
const BAND_FOREGROUND = 'var(--ts-ui-statusbar-color, rgb(60, 60, 60))'
```

---

## Ordered Implementation Steps

1. **`src/data/paths.ts`** — append `pathSegments` and `relativeTo` exactly as
   given in `## Internal Structure`, each with the JSDoc from `## Public API`.
   Keep the file import-free.

2. **`tests/paths.test.ts`** — add a `describe('pathSegments')` block and a
   `describe('relativeTo')` block, one `it` per row of the two tables in
   `## Internal Structure`. Follow the existing blocks' style: one `expect` per
   `it`, a sentence-shaped test name. Run `npm test` — the new blocks pass, the
   existing ones are untouched.

3. **Create `src/editor/FileBreadcrumbs.ts`.** Imports:
   `Container, callable` from `@jimka/typescript-ui/core`; `Insets` from
   `@jimka/typescript-ui/primitive`; `HBox` from `@jimka/typescript-ui/layout`;
   `IconText` from `@jimka/typescript-ui/component/display`;
   `STATUS_BAR_HEIGHT` from `@jimka/typescript-ui/component/container`;
   `pathSegments, relativeTo` from `../data/paths`. Declare the five module
   constants, the `FileBreadcrumbsParams` interface, and the class. Build the
   `IconText` into a local `const trail = new IconText(TRAIL_GLYPH, '')` before
   `super(...)`, then assign the fields and call `render()` at the end of the
   constructor. Close with the `callable()` export triple, copying the shape at
   [`src/editor/FileEditor.ts:91`](src/editor/FileEditor.ts#L91).

4. **`src/editor/FileEditor.ts`** — add `projectRoot: string | null` to
   `FileEditorParams` (documented "The open project folder, or `null` when none
   is open"). In the constructor, build
   `const breadcrumbs = FileBreadcrumbs({ path: params.path, projectRoot: params.projectRoot })`
   beside the existing `const editor = …`, then replace the `super(...)` call at
   line 32 with the `Border` form, copying the constraints shape from
   [`src/shell/EditorShell.ts:53`](src/shell/EditorShell.ts#L53):

   ```typescript
   super({
     layoutManager: new BorderLayout({ spacing: 0 }),
     components: [
       { component: breadcrumbs, constraints: { placement: Placement.NORTH } },
       { component: editor,      constraints: { placement: Placement.CENTER } },
     ],
   })
   ```

   Store `this._breadcrumbs = breadcrumbs`. Swap the `Fit` import for
   `Border as BorderLayout` from `@jimka/typescript-ui/layout`, and add
   `Placement` from `@jimka/typescript-ui/primitive` and `FileBreadcrumbs` from
   `./FileBreadcrumbs`.

5. **`src/editor/FileEditor.ts`** — extend `setPath` with
   `this._breadcrumbs.setPath(path)` after the existing `setLanguage` call, and
   add `setProjectRoot(root: string | null): void` forwarding to
   `this._breadcrumbs.setProjectRoot(root)`. Check:
   `grep -n 'Fit' src/editor/FileEditor.ts` — expect zero matches.

6. **`src/EditorController.ts`** — add
   `private _projectRoot: string | null = null` beside `_projectRootListener`,
   and rewrite `openProjectFolder` (lines 75–81) to an early return so the
   root is recorded and pushed before the listener fires:

   ```typescript
   async openProjectFolder(): Promise<void> {
     const root = await pickProjectFolder()

     if (root === null) {
       return
     }

     this._projectRoot = root

     for (const file of this._openFiles.values()) {
       file.setProjectRoot(root)
     }

     this._projectRootListener?.(root)
   }
   ```

7. **`src/EditorController.ts`** — pass the root when opening a file, at line
   110: `FileEditor({ path, text, projectRoot: this._projectRoot, onDirtyChange: this.handleDirtyChange })`.
   Check: `npm run typecheck` passes, which is what proves every `FileEditor(…)`
   call site was updated (`projectRoot` is required, not optional).

8. **`README.md`** — add a Highlights bullet for the band (see
   `## Documentation Impact`).

9. **`TODO.md`** — delete the `**File-type breadcrumbs** just above the code
   editor.` bullet from the High section (line 21).

10. **Verify** per `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Create | `src/editor/FileBreadcrumbs.ts` |
| Modify | `src/data/paths.ts` |
| Modify | `src/editor/FileEditor.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `tests/paths.test.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Unit-testable (`tests/paths.test.ts`, node environment)

Every row of the `pathSegments` and `relativeTo` tables in
`## Internal Structure` is one test case. In addition:

- `pathSegments('')` returns `[]` — an empty string has no segments.
- `relativeTo('/p', '/p/')` returns `''` — a path that is the root plus a bare
  separator has nothing below it. (`pathSegments('')` then yields `[]`, so the
  band would show an empty trail; no caller can produce this, since every
  `FileEditor` path names a file.)

### Manual verification (`npm run tauri:dev`)

The band is DOM-and-layout behaviour, which the node-environment test harness
cannot exercise — the same reason
[`vitest.config.ts`](vitest.config.ts) limits the suite to the pure helpers.

- **Opens with the right text.** Open a folder, open `src/editor/FileEditor.ts`
  from the tree: a grey band between the tab strip and the code shows a file
  glyph and `src › editor › FileEditor.ts`.
- **A root-level file shows one segment.** Open `README.md` from the same
  folder: the band shows `README.md`.
- **Each tab has its own band.** Open a second file and switch tabs: the band
  changes with the tab.
- **Save As repoints it.** Save As an open file to a different folder inside
  the project: the band redraws to the new location, and the tab label changes
  as it already does.
- **A new project folder re-shortens open files.** With a file open, open a
  different folder that also contains it: the band re-measures against the new
  folder. A file no longer inside the open folder falls back to showing every
  segment of its own path, as the `/etc/hosts` row above shows.
- **A long path ellipsises.** Drag the split gutter until the editor pane is
  narrow: the trail truncates with an ellipsis at its right end and the band
  never pushes the editor sideways.
- **The editor is unaffected.** Typing, syntax highlighting, Format Document,
  and the dirty-dot all behave as before; the code area is `STATUS_BAR_HEIGHT`
  shorter than it was.

---

## Verification

- `npm run typecheck` — passes. This is the check that every `FileEditor(…)`
  call site now supplies `projectRoot`.
- `npm test` — passes, including the new `pathSegments` and `relativeTo` blocks.
- `grep -n 'Fit' src/editor/FileEditor.ts` — zero matches.
- `grep -rn 'File-type breadcrumbs' TODO.md` — zero matches.
- `npm run build` — passes.
- `npm run tauri:dev` — work through every bullet under *Manual verification*.

---

## Documentation Impact

- **`README.md`** — add a bullet to *Highlights*, after the *Tabbed editing*
  bullet, in the existing bold-lead-in style:

  > - **Breadcrumbs** — a path band above each editor showing where the open
  >   file sits inside the project folder.

- **`TODO.md`** — remove the *File-type breadcrumbs* bullet from *High*
  (line 21). No other TODO entry references it; the *File type icons* bullet
  directly above stays, and is the item that would later swap the band's fixed
  `file-code` glyph for a per-extension one.

- No library documentation changes: nothing in `@jimka/typescript-ui` is
  touched.

---

## Potential Challenges

- **The band could render at zero height** if `Border` sized its NORTH region
  from content rather than preferred size. It sizes from
  `getPreferredSize().height`, floored by `getMinSize()`, so the plan sets both
  to `STATUS_BAR_HEIGHT` rather than relying on content measurement.
- **`Text` inherits the band's colour only if nothing overrides it.** `Text`
  sets no colour of its own and `Glyph` renders in `currentColor`, so one
  `foregroundColor` on the band tints both; if a future theme change breaks
  that, set the colour on `this._trail.getTextComponent()` instead.
- **`openProjectFolder` changes shape** from `if (root !== null) { … }` to an
  early return. The `_projectRootListener?.(root)` call must stay last, so the
  tree reloads only after the open editors have been repointed.

---

## Critical Files

- [`src/editor/FileEditor.ts`](src/editor/FileEditor.ts) — the component the
  band mounts into; line 32 is the `super(...)` call being replaced, line 91 the
  `callable()` export triple to copy.
- [`src/shell/EditorShell.ts:53`](src/shell/EditorShell.ts#L53) — the precedent
  for the `Border` + `Placement` composition.
- [`src/explorer/FileTree.ts`](src/explorer/FileTree.ts) — the second
  `callable()`-exported component, and the source of both the `file-code` glyph
  name (line 38) and the explorer grey (line 31).
- [`src/EditorController.ts`](src/EditorController.ts) — `openProjectFolder`
  (lines 75–81) and the `FileEditor` construction (line 110).
- [`src/data/paths.ts`](src/data/paths.ts) — `baseName`'s split pattern and
  `joinPath`'s separator choice, both reused by the new helpers.
- [`src/main.ts:19`](src/main.ts#L19) — the glyph registry call; confirms
  `file-code` is already registered and no new registration is needed.
- [`../typescript-ui/packages/lib/docs/components/IconText.md`](../typescript-ui/packages/lib/docs/components/IconText.md)
  — the `IconText(glyph, text, options?)` contract.
- [`../typescript-ui/packages/lib/src/typescript/lib/component/container/StatusBar.ts`](../typescript-ui/packages/lib/src/typescript/lib/component/container/StatusBar.ts)
  — `STATUS_BAR_HEIGHT` (line 17) and the insets the band mirrors (line 60).
- [`../sqladmin/frontend/src/shell/AppHeader.ts`](../sqladmin/frontend/src/shell/AppHeader.ts)
  — the sibling app's chrome strip: a `Container` + `HBox` of a glyph and text,
  themed through `var(--ts-ui-…, fallback)` and exported via `callable()`.

---

## Non-Goals

- **Clickable segments.** No segment reveals its folder in the tree, opens a
  sibling picker, or changes the selection.[^no-click]
- **Symbol breadcrumbs.** VSCode extends the trail past the file into the
  symbol under the cursor. That needs a language service, which
  [`TODO.md:40`](TODO.md#L40) defers wholesale.
- **Per-extension icons.** The glyph is always `file-code`. Choosing a glyph per
  file type is the separate *File type icons* TODO item; when that lands, this
  one call site adopts its resolver.
- **A setting to hide the band.** There is no settings surface to hang it on —
  the View menu carries one toggle today, for the explorer.
- **Changing the tab strip.** The band sits below the tabs, inside the tab's
  own content, and no `TabPanel` or `TabBar` behaviour changes.

---

## Notes

[^interpretation]: `TODO.md`'s wording, "File-type breadcrumbs", is read as
    *breadcrumbs, led by the file's type icon*. Three things point that way.
    The item sits directly beneath *File type icons in the tree and tab strip*,
    so the "file-type" prefix reads as carried over from its neighbour. The
    original implementation plan
    (`../typescript-ui/plans/implemented/code-editor-desktop-app.md`) never
    mentions breadcrumbs or path navigation, so nothing there defines a
    narrower meaning. And the one other reading — a band naming the file's
    language — is already served: `EditorController.syncActive`
    (`src/EditorController.ts:334`) puts `languageForPath`'s answer in the
    status bar, and duplicating it above the editor would add nothing.

[^inside-fileeditor]: The alternative seam was wrapping `controller.tabs` in
    `EditorShell`, which would have put the band *above* the tab strip rather
    than between the strip and the code — the wrong order, and it would then
    have needed a `"activate"` listener to follow the active tab. Mounting
    inside `FileEditor` gets per-tab state for free: `Tab` already shows and
    hides the whole `FileEditor` on switch, and `saveAs`
    (`src/EditorController.ts:168`) already funnels a path change through
    `FileEditor.setPath`, which is the only place the band needs to be told.

[^no-click]: `Tree.revealByPredicate(predicate)` would technically make
    click-to-reveal work — it walks the tree depth-first, awaiting each lazy
    branch's `loadChildren` until the predicate matches, then expands the
    ancestors and scrolls the row into view. Its own documentation calls it a
    "reveal this object" action and warns it is "not on a hot path", and the
    cost is why it is not used here: the walk descends into every directory it
    passes before reaching the target, so revealing `src/editor` in a
    real project means a `readDir` of many unrelated folders. `TODO.md` asks
    only for breadcrumbs above the editor; a reveal interaction is a separate
    feature that wants a path-directed expansion API the library does not have
    yet.

[^one-icontext]: One component per segment would only pay off if segments were
    individually clickable or hoverable, which the decision above rules out.
    One `IconText` also gets truncation for free: its inner `Text` defaults to
    `truncate: true`, which caps `minSize.width` at 100 and applies
    `text-overflow: ellipsis`, so a narrow pane shortens the trail instead of
    letting it overflow. A per-segment `HBox` would need
    `ScrollStrip` or hand-written eliding to reach the same place.

[^root-relative]: Absolute paths were the simpler option — no controller state
    at all — but `/home/jika/typescript/loom/src/editor/FileEditor.ts` is seven
    segments of which four never change, and the four constant ones are the
    part that pushes the interesting end off the edge of a narrow pane.
    Shortening against the open folder is also what VSCode does. The state cost
    is small: one field on `EditorController`, set in one place, plus a loop
    over `_openFiles` so tabs opened before a folder change catch up. The band
    holds the root rather than `FileEditor` because `FileEditor` would only be
    storing it to hand it straight back on every redraw.

[^statusbar-metrics]: The band and the status bar are the same kind of object —
    a one-line chrome strip pinned to an edge of the editing area — so matching
    them exactly is cheaper to justify than any new number. `STATUS_BAR_HEIGHT`
    is exported from `@jimka/typescript-ui/component/container`, so the height
    is imported rather than retyped and cannot drift. The `var(--ts-ui-…,
    fallback)` colour form is the one
    `../sqladmin/frontend/src/shell/AppHeader.ts` uses; the fallbacks are the
    values the shipped themes actually set (`rgb(245, 245, 245)` /
    `rgb(60, 60, 60)`), and the background fallback is byte-identical to the
    grey `FileTree` hardcodes, so the explorer and the band match whether or not
    a theme is ever installed.
