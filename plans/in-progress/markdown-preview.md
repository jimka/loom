---
touches-shared: [src/editor/FileEditor.ts, src/editor/FileBreadcrumbs.ts, src/editor/languages.ts, tests/languages.test.ts, README.md]
---

# Markdown Preview — Implementation Plan

## Overview

Give every open Markdown file a rendered view. A small toggle button at the
right end of the file's breadcrumb band switches that tab between the raw
`CodeEditor` and a rendered preview. The preview re-renders shortly after the
document changes rather than waiting for a save. Files of any other type are
unchanged and get no button.

Everything lives inside the tab. [`FileEditor`](src/editor/FileEditor.ts)
keeps its `Border` layout, but its CENTER region becomes a two-page `Card`
deck holding the existing `CodeEditor` and a lazily-built
[`MarkdownViewer`](../typescript-ui/packages/lib/docs/components/MarkdownViewer.md)
from `@jimka/typescript-ui`. Nothing outside `src/editor/` learns that
preview mode exists — [`EditorController`](src/EditorController.ts) and
[`EditorShell`](src/shell/EditorShell.ts) are untouched.

Three source files change, plus one test file and the README.
[`src/editor/languages.ts:36`](src/editor/languages.ts#L36) gains a predicate
that answers "is this a Markdown file";
[`src/editor/FileBreadcrumbs.ts:49`](src/editor/FileBreadcrumbs.ts#L49) gains a
trailing-widget slot; and
[`src/editor/FileEditor.ts:42`](src/editor/FileEditor.ts#L42) grows the deck,
the toggle, and the refresh timer.

---

## Architecture Decisions

### The source and preview views are `Card` deck pages inside `FileEditor`

`FileEditor`'s `Border` CENTER region holds a `Container` laid out by a
`Card`, with the `CodeEditor` as one page and the `MarkdownViewer` as the
other. This mirrors
[`buildEditorDeck`](src/shell/EditorShell.ts#L248), where the shell already
swaps its tab strip for the welcome screen with `new Card()` plus
`setVisibleComponentId`.[^card-deck]

### Deck pages are selected by the components' own generated ids

`FileEditor` never calls `setId`. It selects a page with
`card.setVisibleComponentId(this._editor.getId())` and
`card.setVisibleComponentId(preview.getId())`, reading each component's
auto-generated id rather than assigning a literal one.[^generated-ids]

### The renderer is the library's `MarkdownViewer`, not a bare `Markdown`

The preview page is one
[`MarkdownViewer`](../typescript-ui/packages/lib/docs/components/MarkdownViewer.md),
the library component that wraps a single `Markdown` instance in a
vertically-scrolling `Panel` and adds a floating heading outline and
width/zoom controls. Its defaults are kept: outline and controls both
on.[^markdown-viewer]

### The raw-source side stays the existing `CodeEditor`

The library's `MarkdownEditor` — a WYSIWYG surface whose value is a Markdown
string — has no role here and is not imported.[^no-markdown-editor]

### The toggle is a trailing widget on the breadcrumb band

`FileBreadcrumbs` gains one slot at the right end of its `HBox`, filled with
a glyph-only `ToggleButton`. No second chrome strip is added above the
editor.[^band-slot]

### Preview availability is re-resolved whenever the file's path changes

A file gets the toggle exactly when
`languageForPath(path) === 'markdown'`. `FileEditor` resolves that in its
constructor and again at the end of `setPath`, so a *Save As* that changes
the extension adds or removes the button.[^resolve-on-setpath]

| file | `languageForPath` | toggle |
| --- | --- | --- |
| `README.md` | `markdown` | shown |
| `notes.markdown` | `markdown` | shown |
| `src/main.ts` | `javascript` | absent |
| `Makefile` | `null` | absent |
| `Untitled-1` (never saved) | `null` | absent |
| `Untitled-1` after *Save As* `notes.md` | `markdown` | shown |

### The preview is built the first time it is opened, not per tab

`FileEditor` holds `_preview: MarkdownViewer | null`, starting `null`. The
first switch into preview mode constructs the viewer and adds it to the
deck; a tab whose preview is never opened never builds one.[^lazy-preview]

### Refreshes are debounced with `setTimeout`, mirroring the session autosave

A `"change"` from the `CodeEditor` schedules a refresh
`PREVIEW_REFRESH_DEBOUNCE_MS` later, replacing any refresh already pending.
The timer is a private field holding a `ReturnType<typeof setTimeout> | null`,
cleared and re-armed exactly as
[`installSessionAutosave`](src/shell/session.ts#L121) clears and re-arms
its own.[^debounce]

Two separate things keep the rendered view current, and both are needed.
Switching into preview mode pushes the editor's text immediately, which is
what covers ordinary typing: the source view is hidden while the preview is
up, so the two are never on screen at once. The debounced refresh covers a
document that changes *while* the preview is showing — today that means
*Edit > Format Document*, which reformats the hidden editor and emits a
`"change"`. Without the refresh, the preview would keep showing pre-format
text until the user toggled twice, so it is not dead code.

---

## Public API

### `src/editor/languages.ts` — one new export

```typescript
/**
 * Whether `path` names a Markdown file, by the same extension map
 * {@link languageForPath} resolves against.
 *
 * @param path - The file path, or `null` for a buffer with no path yet.
 * @returns `true` when the path's language is Markdown.
 */
export function isMarkdownPath(path: string | null): boolean
```

Backed by a module constant `const MARKDOWN_LANGUAGE = 'markdown'`, which the
`md`/`markdown` rows of `EXTENSION_TO_LANGUAGE` keep using as their literal
value.

### `src/editor/FileBreadcrumbs.ts` — one new method

```typescript
class FileBreadcrumbs extends Container {
  /**
   * Puts `component` at the right end of the band, replacing whatever was
   * there, or clears the slot when passed `null`.
   *
   * @param component - The trailing widget, or `null` to leave the slot empty.
   */
  setAction(component: Component | null): void
}
```

Backing field: `_action: Component | null = null`. `setAction` removes the
current action (when any) with `removeComponent`, then adds the new one with
`addComponent` and no constraints — an unweighted `HBox` child sits at its
preferred size, so it lands flush right of the weighted trail.

### `src/editor/FileEditor.ts` — no new public members

The class gains only private state and private methods:

```typescript
private readonly _body: Container            // the Card-laid deck host
private readonly _card: Card
private readonly _previewToggle: ToggleButton
private _preview: MarkdownViewer | null = null
private _previewing = false
private _refreshTimer: ReturnType<typeof setTimeout> | null = null
```

`FileEditorParams` is unchanged, and so are `getPath`, `setPath`,
`setProjectRoot`, `getName`, `getEditor`, `isDirty`, `needsSave`,
`markClean`, and `getLabel`. `getEditor()` keeps returning the `CodeEditor`
in both modes, so `EditorController`'s save and format paths need no change.

---

## Internal Structure

### Module constants — `src/editor/FileEditor.ts`

```typescript
/** How long an edit waits before the preview re-renders, in milliseconds.
 *  Shorter than `session.ts`'s 500ms save debounce: a session write is disk
 *  I/O whose only cost of firing late is a slightly larger loss window,
 *  while this one is an in-page re-render the user is watching happen, so it
 *  is tuned to feel immediate rather than to coalesce aggressively. Still
 *  long enough that a run of typing renders once at the end, not per key. */
const PREVIEW_REFRESH_DEBOUNCE_MS = 250

/** The toggle's icon. `eye` is already registered in `src/main.ts:24` for
 *  the View menu, so no new glyph registration is needed. */
const PREVIEW_GLYPH = 'eye'

/** The toggle's accessible name and hover tooltip. Not painted on the button
 *  face — `showText: false` collapses it to its glyph, which is what keeps it
 *  inside the band's fixed height. */
const PREVIEW_LABEL = 'Preview'
```

### The toggle

```typescript
const previewToggle = new ToggleButton(PREVIEW_LABEL, {
  glyph: PREVIEW_GLYPH,
  showText: false,
  flat: true,
  compact: true,
})
```

`showText: false` blanks the button's label but keeps `PREVIEW_LABEL` as the
tooltip and the `aria-label`. A compact glyph-only button resolves to
`Insets(2, 2, 2, 2)` around a 16px glyph — 20px tall, inside the band's 22px
`STATUS_BAR_HEIGHT`.

### The deck

```typescript
const card = new Card()
const body = Container({ layoutManager: card })

body.addComponent(editor)

super({
  layoutManager: new BorderLayout({ spacing: 0 }),
  components: [
    { component: breadcrumbs, constraints: { placement: Placement.NORTH } },
    { component: body,        constraints: { placement: Placement.CENTER } },
  ],
})
```

The deck starts with the editor as its only child, so `Card` resolves it as
the visible page without any `setVisibleComponentId` call.

### Mode switching

```typescript
// An arrow-function field, not a method: passed as a bare `this.handler`
// reference to `on("action", ...)`, matching the existing `handleChange`.
private readonly handlePreviewToggle = (): void => {
  this.setPreviewing(this._previewToggle.isSelected())
}

/**
 * Shows the source or the preview page, cancelling any pending refresh
 * first. Entering preview mode always pushes the editor's current text, so
 * the rendered view is never a stale snapshot from an earlier visit.
 *
 * @param previewing - `true` to show the preview, `false` to show the source.
 */
private setPreviewing(previewing: boolean): void {
  this.cancelPreviewRefresh()
  this._previewing = previewing

  if (!previewing) {
    this._card.setVisibleComponentId(this._editor.getId())

    return
  }

  const preview = this.ensurePreview()

  this.refreshPreview()
  this._card.setVisibleComponentId(preview.getId())
}

/** Builds the preview page on first use and adds it to the deck. */
private ensurePreview(): MarkdownViewer {
  if (this._preview !== null) {
    return this._preview
  }

  const preview = MarkdownViewer({ markdown: this._editor.getValue() })

  this._body.addComponent(preview)
  this._preview = preview

  return preview
}

/** Pushes the editor's current text into the preview, if one exists. */
private refreshPreview(): void {
  this._preview?.setMarkdown(this._editor.getValue())
}
```

### The refresh timer

```typescript
/** Re-arms the refresh timer. A no-op while the source page is showing. */
private schedulePreviewRefresh(): void {
  if (!this._previewing) {
    return
  }

  this.cancelPreviewRefresh()

  this._refreshTimer = setTimeout(() => {
    this._refreshTimer = null
    this.refreshPreview()
  }, PREVIEW_REFRESH_DEBOUNCE_MS)
}

/** Drops any pending refresh. */
private cancelPreviewRefresh(): void {
  if (this._refreshTimer !== null) {
    clearTimeout(this._refreshTimer)
    this._refreshTimer = null
  }
}
```

### What each event does

| event | source page showing | preview page showing |
| --- | --- | --- |
| `CodeEditor` `"change"` | dirty flag re-synced; no refresh armed | dirty flag re-synced; refresh armed for 250ms later |
| toggle clicked on | pending refresh cancelled, preview built if needed, current text pushed, preview page shown | — |
| toggle clicked off | — | pending refresh cancelled, source page shown |
| `setPath` to a Markdown name | toggle present (added if it wasn't) | toggle present, preview stays showing |
| `setPath` to a non-Markdown name | toggle removed | toggle removed, source page shown |
| tab closed | pending refresh cancelled by `destructor` | pending refresh cancelled by `destructor` |

### Preview availability

```typescript
/**
 * Adds or removes the preview toggle for the current path, and drops out of
 * preview mode when the file has stopped being Markdown. `setSelected` does
 * not fire the toggle's `"action"` event, so clearing it here cannot
 * re-enter `handlePreviewToggle`.
 */
private syncPreviewAvailability(): void {
  const available = isMarkdownPath(this._path)

  if (!available && this._previewing) {
    this._previewToggle.setSelected(false)
    this.setPreviewing(false)
  }

  this._breadcrumbs.setAction(available ? this._previewToggle : null)
}
```

### Splitting the change handler

The existing `handleChange` body moves verbatim into a new private
`syncDirty()`; `handleChange` becomes the two-line caller:

```typescript
private handleChange = (): void => {
  this.syncDirty()
  this.schedulePreviewRefresh()
}
```

### Teardown

```typescript
/**
 * Drops any pending refresh before the base class tears the subtree down.
 * `Tab` disposes a closed tab's content by default, so without this a timer
 * armed within the last 250ms would fire against a disposed viewer.
 */
protected destructor(): void {
  this.cancelPreviewRefresh()
  super.destructor()
}
```

---

## Ordered Implementation Steps

1. **`src/editor/languages.ts`** — add the module constant
   `const MARKDOWN_LANGUAGE = 'markdown'` above `EXTENSION_TO_LANGUAGE`, use
   it as the value of the `md` and `markdown` rows, and append the exported
   `isMarkdownPath` from `## Public API` after `languageForPath`. Keep
   `registerLanguage` calls last, where they already are.

2. **`tests/languages.test.ts`** — add a `describe('isMarkdownPath')` block
   below the existing `describe('languageForPath')`, one `it` per bullet of
   `## Expected Behaviour`'s *Unit-testable* list, in the file's existing
   style (one sentence-shaped name, one `expect`). Run `npm test` — the new
   block passes and the existing one is untouched.

3. **`src/editor/FileBreadcrumbs.ts`** — add
   `import type { Component } from '@jimka/typescript-ui/core'` beside the
   existing `Container, callable` import, add the private field
   `private _action: Component | null = null`, and add the `setAction` method
   from `## Public API` after `setProjectRoot`. Body: remove `this._action`
   from the container when it is not `null`, assign the new value, and add it
   when the new value is not `null`.

4. **`src/editor/FileEditor.ts`** — add the imports: `Card` from
   `@jimka/typescript-ui/layout` (alongside the existing
   `Border as BorderLayout`), `ToggleButton` from
   `@jimka/typescript-ui/component/button`, `MarkdownViewer` from
   `@jimka/typescript-ui/component/display`, and `isMarkdownPath` from
   `./languages` (alongside the existing `languageForPath`). Declare the three
   module constants from `## Internal Structure`.

5. **`src/editor/FileEditor.ts`** — declare the three new readonly fields
   `_body`, `_card`, and `_previewToggle` beside the existing `_editor` and
   `_breadcrumbs`. In the constructor, build `previewToggle`, `card`, and
   `body` exactly as `## Internal Structure` shows, before the `super(...)`
   call, and replace the CENTER entry at line 46 so it places `body` instead
   of `editor`. After the existing field assignments, store the three new
   fields, then — after `editor.on('change', this.handleChange)` — wire
   `previewToggle.on('action', this.handlePreviewToggle)` and call
   `this.syncPreviewAvailability()` as the constructor's last statement.
   Check: `grep -n 'component: editor' src/editor/FileEditor.ts` — expect zero
   matches.

6. **`src/editor/FileEditor.ts`** — declare the remaining three fields
   (`_preview`, `_previewing`, `_refreshTimer`) from `## Public API`, and add
   `handlePreviewToggle`, `setPreviewing`, `ensurePreview`, `refreshPreview`,
   `schedulePreviewRefresh`, `cancelPreviewRefresh`, and
   `syncPreviewAvailability` exactly as `## Internal Structure` gives them.

7. **`src/editor/FileEditor.ts`** — rename the existing `handleChange`'s body
   into a new private `syncDirty(): void`, and replace `handleChange` with the
   two-line arrow field from `## Internal Structure`. Keep the original
   method's doc comment on `syncDirty`.

8. **`src/editor/FileEditor.ts`** — append
   `this.syncPreviewAvailability()` as the last statement of `setPath`, after
   the existing `this._breadcrumbs.setPath(path)`.

9. **`src/editor/FileEditor.ts`** — add the `destructor` override from
   `## Internal Structure`, placed after `getLabel`.

10. **Check the seams.** `npm run typecheck` passes.
    `grep -rn 'setId' src/editor/` — expect zero matches (the deck must select
    pages by generated id, per `## Architecture Decisions`).
    `grep -rn 'MarkdownEditor' src/` — expect zero matches.
    `grep -rn 'marked\|markdown-it' package.json` — expect zero matches
    (`marked` is the library's own dependency; Loom must not gain one).

11. **`README.md`** — add the Highlights bullet and extend the Architecture
    paragraph, per `## Documentation Impact`.

12. **Verify** per `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Modify | `src/editor/languages.ts` |
| Modify | `src/editor/FileBreadcrumbs.ts` |
| Modify | `src/editor/FileEditor.ts` |
| Modify | `tests/languages.test.ts` |
| Modify | `README.md` |

---

## Expected Behaviour

### Unit-testable (`tests/languages.test.ts`, node environment)

One case per path-shaped row of the availability table in
`## Architecture Decisions` — its *Save As* row is a manual check below —
plus two edge cases the table does not cover:

- `isMarkdownPath('/p/README.md')` is `true`.
- `isMarkdownPath('/p/notes.markdown')` is `true`.
- `isMarkdownPath('/p/README.MD')` is `true` — `extensionOf` lowercases, so
  the uppercase extension resolves like the lowercase one.
- `isMarkdownPath('/p/src/main.ts')` is `false`.
- `isMarkdownPath('/p/Makefile')` is `false`.
- `isMarkdownPath('/p/notes.mdx')` is `false` — `mdx` is not in
  `EXTENSION_TO_LANGUAGE`.
- `isMarkdownPath(null)` is `false`.

### Manual verification (`npm run tauri:dev`)

Everything below is layout, DOM, and timing behaviour, which the node-environment
suite cannot exercise — the same reason
[`vitest.config.ts`](vitest.config.ts) limits the suite to the pure helpers.

- **The toggle appears only on Markdown files.** Open `README.md`: an eye
  button sits at the right end of the breadcrumb band. Open `src/main.ts` in
  another tab: no button, and the band looks exactly as it did before this
  change. Switching between the two tabs switches the band with them.
- **The toggle switches the view in place.** Click it on `README.md`: the
  code area is replaced, in the same tab and at the same size, by rendered
  prose with a heading outline pinned top-right and width/zoom buttons
  bottom-right. The tab strip, the breadcrumb band, and the status bar do not
  move. Click again: the `CodeEditor` comes back with its text, scroll
  position, and cursor intact.
- **Entering preview shows the current text, not a snapshot.** Preview
  `README.md`, toggle back to source, type `## Live` at the end, and toggle to
  preview again: the new heading is rendered. Repeat with the file left dirty
  across several toggles: the preview matches the editor every time.
- **A change made while the preview is up reaches it about a quarter-second
  later.** With the preview showing, run *Edit > Format Document*: the prose
  re-renders shortly after, without toggling. This is the one path that
  exercises the debounced refresh, because the source view is hidden — and so
  not typeable — whenever the preview is showing.
- **A long document scrolls inside the preview.** Preview a Markdown file
  longer than the pane: the prose scrolls within the tab, the tab itself does
  not grow, and exactly one vertical scrollbar appears.
- **Fenced code renders highlighted.** Preview a Markdown file containing a
  ` ```ts ` fenced block: it becomes a read-only syntax-highlighted block.
- **The status bar and dirty dot are unaffected.** With the preview showing,
  the status bar still reads `markdown`, and the tab keeps its dirty dot if
  the file was already modified.
- **Save works from preview.** With the preview showing, press Ctrl/Cmd+S: the
  file writes, the dirty dot clears, and the preview stays up.
- **Save As across types moves the button.** Save `notes.txt` as `notes.md`:
  the toggle appears. Then, with the preview showing, Save As back to
  `notes.txt`: the view drops back to source and the toggle disappears.
- **A new untitled buffer has no toggle until it is saved as Markdown.**
  Ctrl/Cmd+N shows a band with no button; Save As `scratch.md` adds one.
- **Links do not navigate the app away.** Preview a file containing an
  external link (`[x](https://example.com)`) and click it: the Loom window
  must still show Loom afterwards. Record the actual behaviour — a new OS
  window, a browser tab, or nothing at all are all acceptable; the app's own
  window navigating away is not, and would be a follow-up.
- **Closing a tab with a refresh in flight is clean.** With the preview
  showing, run *Format Document* and immediately close the tab: no console
  error appears.

---

## Verification

- `npm run typecheck` — passes.
- `npm test` — passes, including the new `isMarkdownPath` block.
- `grep -rn 'setId' src/editor/` — zero matches.
- `grep -rn 'MarkdownEditor' src/` — zero matches.
- `grep -n 'marked\|markdown-it' package.json` — zero matches.
- `grep -n 'component: editor' src/editor/FileEditor.ts` — zero matches.
- `npm run build` — passes. This is the check that `marked`, the library's own
  transitive dependency behind `Markdown`, resolves through Loom's bundler.
- `npm run tauri:dev` — work through every bullet under *Manual verification*.

---

## Documentation Impact

- **`README.md`** — add a bullet to *Highlights*, after the *Breadcrumbs*
  bullet, in the existing bold-lead-in style:

  > - **Markdown preview** — a toggle on the breadcrumb band of any Markdown
  >   file swaps the editor for a rendered view of it, with a heading outline
  >   and width/zoom controls, that refreshes as the document changes.

  In the *Architecture* paragraph, add `MarkdownViewer` to the parenthesised
  component list, after `CodeEditor`.

- **`TODO.md`** — no change. No backlog entry asks for a Markdown preview, and
  this plan's deferred items stay in `## Non-Goals` rather than being promoted
  to the backlog.

- No library documentation changes: nothing in `@jimka/typescript-ui` is
  touched.

---

## Potential Challenges

- **The deck host must not scroll.** `MarkdownViewer` declares
  `autoScroll: "y"` on itself; giving the `Card`-laid `Container` a scroll
  setting of its own would nest two scroll hosts and produce a doubled
  scrollbar — so leave the deck host with no scroll configuration at all.
- **The toggle must fit the 22px band.** A `flat` + `compact` glyph-only
  `ToggleButton` resolves to 20px (a 16px glyph inside `Insets(2, 2, 2, 2)`);
  if it renders taller and clips, the cause is a lost `showText: false`,
  which is what makes the button glyph-only in the first place.
- **A hidden page keeps its geometry.** `Card` hides the inactive page with
  `visibility: hidden`, not `display: none`, so the `CodeEditor` stays
  measured while the preview is up and needs no re-measure on the way back;
  do not add one.
- **`setSelected` is silent.** Clearing the toggle from
  `syncPreviewAvailability` must use `setSelected(false)`, which does not fire
  `"action"`; calling anything that does would re-enter the mode switch.
- **A pending refresh must not outlive the tab.** `Tab` disposes a closed
  tab's content by default, so the `destructor` override is what stops a
  refresh armed in the last quarter-second from firing against a disposed
  viewer — it is not optional cleanup.

---

## Critical Files

- [`src/editor/FileEditor.ts`](src/editor/FileEditor.ts) — the component being
  extended; line 42 is the `super(...)` whose CENTER entry changes, line 57 the
  `"change"` wiring, line 66 the handler being split, line 88 `setPath`.
- [`src/shell/EditorShell.ts:248`](src/shell/EditorShell.ts#L248) —
  `buildEditorDeck`, the `Card` deck precedent this plan mirrors.
- [`src/editor/FileBreadcrumbs.ts`](src/editor/FileBreadcrumbs.ts) — the band
  gaining the slot; line 58 is the `super(...)` whose `HBox` receives the new
  child, line 60 the weighted trail the toggle sits right of.
- [`src/shell/session.ts:104`](src/shell/session.ts#L104) —
  `installSessionAutosave`, the debounce precedent: the
  `ReturnType<typeof setTimeout> | null` field, the clear-then-re-arm, and the
  documented millisecond constant.
- [`src/editor/languages.ts`](src/editor/languages.ts) — the extension map the
  new predicate reads.
- [`src/main.ts:24`](src/main.ts#L24) — the `Glyph.register` call; confirms
  `eye` is already registered and no new registration is needed.
- [`../typescript-ui/packages/lib/docs/components/MarkdownViewer.md`](../typescript-ui/packages/lib/docs/components/MarkdownViewer.md)
  — the `MarkdownViewer(options)` contract and its `setMarkdown` method.
- [`../typescript-ui/packages/lib/docs/components/ToggleButton.md`](../typescript-ui/packages/lib/docs/components/ToggleButton.md)
  — `isSelected` / `setSelected` / `on("action")`.
- [`../typescript-ui/packages/lib/src/typescript/MarkdownEditorPanel.ts`](../typescript-ui/packages/lib/src/typescript/MarkdownEditorPanel.ts)
  — the library's own demo: line 62 is the `ToggleButton`-drives-a-mode
  precedent, lines 86–91 the `"change"` → `getValue()` → `setMarkdown` wiring.
- [`../typescript-ui/packages/lib/src/typescript/lib/layout/Card.ts`](../typescript-ui/packages/lib/src/typescript/lib/layout/Card.ts)
  — `setVisibleComponentId` matches on `getId()`, and hides the inactive page
  with `setVisible(false)`.
- [`../typescript-ui/packages/lib/src/typescript/lib/component/container/StatusBar.ts`](../typescript-ui/packages/lib/src/typescript/lib/component/container/StatusBar.ts)
  — `addRight`/`removeRight` and the "no taller than 21px" widget rule the
  band's slot inherits.

---

## Non-Goals

- **Side-by-side source and preview.** The tab shows one view at a time. A
  split would need a second `Split` inside the tab and a scroll-sync story
  that this plan does not open.
- **Scroll or cursor sync between the two views.** Toggling shows the preview
  from wherever it was last left, not from the line the cursor is on.
- **Remembering preview mode.** Preview state is per-tab and in-memory:
  reopening a file, or restarting Loom, comes back on the source view.
  `SessionState` is untouched.
- **A menu item or keyboard shortcut.** The toggle is the only way in.
  `src/shell/shortcuts.ts` and the View menu are untouched.
- **Preview for any other file type.** HTML, CSV, and images get no rendered
  view; only `languageForPath`'s `markdown` files do.
- **Editing in the preview.** The rendered view is read-only, which is what
  `MarkdownViewer`'s internal `Markdown` is; the library's WYSIWYG
  `MarkdownEditor` is not used.
- **Changing how links behave.** The preview keeps `Markdown`'s default link
  handling; giving Loom its own resolver — to open links in the OS browser, or
  to resolve a relative link into a new tab — is separate work needing a Tauri
  plugin Loom does not depend on.

---

## Notes

[^card-deck]: `buildEditorDeck` (`src/shell/EditorShell.ts:248`) is the
    codebase's existing answer to "show one of two components depending on
    state": a `Card` layout manager on a plain `Container`, both children
    added up front, and `setVisibleComponentId` called on each change. The
    alternative — calling `removeComponent`/`addComponent` on the `Border`'s
    CENTER slot at every toggle — would tear down and rebuild the
    `CodeEditor`'s CodeMirror view on the way back, losing scroll position,
    selection, and undo history, and has no precedent in this codebase.

[^generated-ids]: `EditorShell` assigns literal ids (`'editor-tabs'`,
    `'welcome-screen'`) because its deck is a singleton. `FileEditor` is not:
    one exists per open tab. `Component`'s id becomes the DOM element's `id`
    and the selector of its per-component CSS rule
    (`Component.setId`), so two tabs assigning the same literal would collide
    on both. Every component already has a unique auto-generated id from
    construction, and `Card.setVisibleComponentId` matches on `getId()`, so
    reading the ids back is both correct and less code than minting new ones.

[^markdown-viewer]: The library's own documentation makes the call: "Any
    consumer embedding one `Markdown` instance gets both for free by using
    `MarkdownViewer` instead of `Markdown` directly"
    (`packages/lib/docs/components/MarkdownViewer.md`). A bare `Markdown` is a
    `Component` that reports its measured content height and nothing more — it
    does not scroll, so Loom would have to wrap it in a `Panel` with
    `setAutoScroll('y')` (which is exactly what the library's own
    `MarkdownEditorPanel` demo does, and exactly what `MarkdownViewer` already
    is) and would still have no document outline. `MarkdownViewer` wraps one
    `Markdown` in that scrolling `Panel`, adds a heading minimap and
    width/zoom controls, and forwards `setMarkdown` while keeping the minimap
    in sync — so it is strictly the shorter path to the same preview, plus an
    outline that a code editor's preview pane genuinely wants. Its floating
    chrome is kept at the library defaults rather than switched off with
    `setMinimapVisible(false)`/`setControlsVisible(false)`: exercising the
    library's components as shipped is the point of this project, and both
    clusters are pinned over the prose rather than taking layout space from
    it.

[^no-markdown-editor]: `MarkdownEditor` is a Lexical-based WYSIWYG surface
    whose *value* is a Markdown string — an alternative to `CodeEditor`, not a
    companion to it. Adopting it would mean the "source" side of the toggle
    stops being raw text: Loom's syntax highlighting, *Format Document*, and
    the `getEditor().getValue()` that `EditorController.save` and `saveAs`
    write to disk are all `CodeEditor` contracts. The library's
    `MarkdownEditorPanel` demo pairs `MarkdownEditor` with `Markdown` because
    it is demonstrating `MarkdownEditor`; the half of that demo Loom needs is
    the viewer and the `"change"` → `getValue()` → `setMarkdown` wiring, which
    this plan reuses verbatim against the existing `CodeEditor`.

[^band-slot]: The band is already the file's own chrome strip, it already
    mirrors the library `StatusBar`'s height, insets, and colour tokens, and
    `StatusBar` already accepts trailing widgets through
    `addRight`/`removeRight` — so a trailing slot is the same mirror extended
    one step, not a new pattern. The slot is a single `setAction(component |
    null)` rather than the `addRight`/`removeRight` pair because `FileEditor`
    has exactly one trailing widget whose presence flips with the file's
    language; folding the add and the remove into one setter puts the
    "is it already attached?" bookkeeping in one place, where `addComponent`
    cannot be called twice on a component that already has a parent. The
    alternative was a second `ToolBar` strip between the band and the editor,
    which would spend another chrome strip's worth of vertical space on
    Markdown files only — making the code area change height as the user
    switches between a Markdown tab and any other.

[^resolve-on-setpath]: `setPath` is already the single funnel for a path
    change — `EditorController.saveAs` is its only caller, covering both a
    first save of an untitled buffer and a *Save As* to a new name — and it
    already re-resolves the syntax language there
    (`this._editor.setLanguage(languageForPath(path))`). Hanging the toggle's
    availability off the same call means the two never disagree, and it costs
    one line. Resolving once at construction instead would leave a buffer
    saved as `.md` with no way to preview it until the tab was closed and
    reopened.

[^lazy-preview]: A `MarkdownViewer` is a `Panel` with an `Anchor` layout, a
    `Markdown`, a minimap, and a five-button floating control cluster.
    Building one eagerly per `FileEditor` would pay that cost for every open
    tab, including the non-Markdown ones that can never show it. Building it
    on the first toggle keeps the cost proportional to use, and the nullable
    field is the only state it adds — `ensurePreview` is the single place that
    can populate it, and `setPreviewing` is its only caller.

[^debounce]: `installSessionAutosave` (`src/shell/session.ts:104`) is the
    codebase's only existing timing mechanism, and it is a plain
    `clearTimeout`/`setTimeout` pair over a
    `ReturnType<typeof setTimeout> | null`. This plan reuses that shape rather
    than introducing a reusable `debounce` helper: there would be two call
    sites with different lifetimes (one closure-scoped and flushable, one
    field-scoped and cancelled on dispose), which is not enough commonality to
    justify a new abstraction. The one structural difference is deliberate —
    the timer lives in a private field rather than a closure, because
    `destructor` has to be able to cancel it.
