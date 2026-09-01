---
touches-shared: [src/EditorController.ts, src/shell/EditorShell.ts, src/data/paths.ts, tests/paths.test.ts, README.md, TODO.md]
---

# Welcome Screen — Implementation Plan

## Overview

Loom shows nothing useful before a file is open. The editor half of the shell
is `controller.tabs`, a `TabPanel` added straight into the shell's `Split` at
[src/shell/EditorShell.ts:37](src/shell/EditorShell.ts#L37); with no tabs it
renders an empty strip over blank space, and the explorer beside it is a bare
grey pane. Nothing tells the user to open a folder.

This plan adds a welcome screen: a new `WelcomeScreen` component that stands in
for the tab strip whenever no file is open. The shell wraps the tab strip and
the welcome screen in a `Card` deck — a layout manager that shows exactly one
child at a time — and `EditorController` gains one listener seam that reports
whether any file is open, mirroring its existing
[setProjectRootListener](src/EditorController.ts#L60).

The welcome screen covers both empty states with one component: no project
folder open, and a project open with no file tabs. Only its heading and hint
line differ between them, resolved by a small pure module so the rule is unit
testable in Loom's DOM-free test runner.

---

## Architecture Decisions

### A `Card` deck in the editor pane

The shell's `Split` gets a `Card`-managed `Container` in place of
`controller.tabs`. The deck holds the tab strip and the welcome screen, and
`Card.setVisibleComponentId` swaps between them by component id.[^card-deck]

The deck mirrors `buildCenterDeck` at
`../sqladmin/frontend/src/shell/SqlAdminShell.ts:299` — the sibling `sqladmin`
checkout that [src/shell/EditorShell.ts:28](src/shell/EditorShell.ts#L28)
already names as the shell's model. There, a `Card` deck holds the work area
and a `StartPage`, and a controller-injected toggle picks between them.

### The controller owns the "no file open" signal

`EditorController` gets `setEmptyStateListener(fn)`, storing `fn` and calling
it once immediately with the current state. `syncActive` then re-reports on
every change. The listener's argument is `this._openFiles.size === 0`, not the
active-tab lookup `syncActive` already does.[^registry-signal]

Registering-and-reflecting matches `setStartToggle` at
`../sqladmin/frontend/src/SqlAdminController.ts:424`, and it is what makes a
freshly started app show the welcome screen without the shell asserting an
initial page separately.

### One component, two copy variants

`WelcomeScreen` is a single `Card` page. Its heading and hint text change with
whether a project folder is open; its action does not.[^one-page]

The two variants:

| Project root | Heading | Hint |
|---|---|---|
| none open | `Welcome to Loom` | `Open a project folder to start editing.` |
| `/home/jika/typescript/loom` | `loom` | `Select a file in the explorer to start editing.` |

The heading's `Welcome to Loom` is built from `APP_NAME`
([src/appIdentity.ts:5](src/appIdentity.ts#L5)), not a second copy of the app's
name.

### The state-to-copy rule lives in a pure module

`src/shell/welcomeText.ts` exports `welcomeCopy(projectRoot)`, holding both
variants and nothing else. `WelcomeScreen.ts` imports it. Keeping the rule in
its own module is what makes it unit testable — Loom's vitest runs in the
`node` environment with no DOM, and any module that imports a library component
touches `document` at load time.[^pure-copy]

`../sqladmin/frontend/src/shell/startPageWelcome.ts` is split out of
`StartPage.ts` for exactly that reason.

### The welcome screen updates its text in place

`setProjectRoot(root)` calls `setText` on the two `Text` children rather than
disposing and rebuilding the page body.[^mutate-not-rebuild]

### The explorer tree keeps no empty state

An empty project tree stays as it is today: a blank pane. The library's `Tree`
exposes no empty-state hook, so giving it placeholder text would need a library
change.[^no-tree-empty-state] The welcome screen beside it carries the
"open a folder" message instead.

---

## Public API

### `src/data/paths.ts`

```typescript
export function projectName(root: string): string
```

The display name of a project folder: its last path segment, ignoring a
trailing separator.

| `root` | `projectName(root)` | Why |
|---|---|---|
| `/home/jika/loom` | `loom` | last segment |
| `/home/jika/loom/` | `loom` | trailing `/` trimmed before splitting |
| `C:\dev\loom\` | `loom` | trailing `\` trimmed too |
| `/` | `/` | trimming leaves `""` — fall back to the raw path |

### `src/shell/welcomeText.ts` (new)

```typescript
export interface WelcomeCopy {
  /** The page's large heading line. */
  heading: string
  /** The muted line under the heading. */
  hint: string
}

export function welcomeCopy(projectRoot: string | null): WelcomeCopy
```

### `src/shell/WelcomeScreen.ts` (new)

```typescript
export interface WelcomeScreenParams {
  /** Invoked when the Open Folder button is pressed. */
  onOpenFolder: () => void
}

class WelcomeScreen extends Container {
  constructor(params: WelcomeScreenParams)

  /** Repoints the page at `root`, swapping its copy to the project-open variant. */
  setProjectRoot(root: string): void
}
```

Exported through the `callable` wrapper, the same as `FileTree` and
`FileEditor`.

### `src/EditorController.ts`

```typescript
setEmptyStateListener(fn: (empty: boolean) => void): void
```

Backing field `private _emptyStateListener: ((empty: boolean) => void) | null = null`.
The setter stores `fn` and calls it once with the current state.

---

## Internal Structure

`WelcomeScreen`'s body is a single `VBox` column, centred on both axes, holding
the heading `Text`, the hint `Text`, and the Open Folder `Button` in that
order. The column is the extension point a future Recent Projects list appends
to, below the button — say so in the class doc comment, and add no placeholder
code for it now.

```typescript
class WelcomeScreen extends Container {
  private readonly _heading: Text
  private readonly _hint: Text

  constructor(params: WelcomeScreenParams) {
    const heading = new Text('', { fontSize: HEADING_FONT_SIZE, fontWeight: '600' })
    const hint = new Text('', { foregroundColor: HINT_COLOR })

    const openFolder = Button({
      text: 'Open Folder…',
      glyph: 'folder',
      description: OPEN_FOLDER_SHORTCUT,
    })
    openFolder.on('action', params.onOpenFolder)

    super({
      layoutManager: new VBox({ justify: 'center', itemAlign: 'center', spacing: CONTENT_SPACING }),
      backgroundColor: 'var(--ts-ui-input-bg, rgb(255, 255, 255))',
      components: [heading, hint, openFolder],
    })

    this._heading = heading
    this._hint = hint
    this.applyCopy(null)
  }

  setProjectRoot(root: string): void {
    this.applyCopy(root)
  }

  private applyCopy(projectRoot: string | null): void {
    const copy = welcomeCopy(projectRoot)

    this._heading.setText(copy.heading)
    this._hint.setText(copy.hint)
  }
}
```

Module constants, each with the documenting comment Loom uses for its other
tuning numbers (`TAB_MAX_WIDTH`, `SAVE_MESSAGE_DURATION_MS`):

- `HEADING_FONT_SIZE = 20`
- `CONTENT_SPACING = 12`
- `HINT_COLOR = 'rgb(140, 140, 140)'`

`OPEN_FOLDER_SHORTCUT` comes from
[src/shell/shortcuts.ts:18](src/shell/shortcuts.ts#L18) — the button's
`description` renders it as a smaller, dimmer second line, so the hint can
never drift from the real accelerator. The `folder` glyph is already registered
at [src/main.ts:19](src/main.ts#L19); do **not** add a `Glyph.register` call to
`WelcomeScreen.ts`, because Loom registers every glyph at its composition root.

The deck helper in `EditorShell.ts`, alongside the existing `buildMenuBar`:

```typescript
function buildEditorDeck(controller: EditorController, welcome: WelcomeScreen): Component {
  const card = new Card()
  const deck = Container({ layoutManager: card })

  controller.tabs.setId(EDITOR_PAGE_ID)
  welcome.setId(WELCOME_PAGE_ID)

  deck.addComponent(controller.tabs)
  deck.addComponent(welcome)

  controller.setEmptyStateListener(empty => {
    card.setVisibleComponentId(empty ? WELCOME_PAGE_ID : EDITOR_PAGE_ID)
  })

  return deck
}
```

No separate seeding call: `setEmptyStateListener` reports the current state as
it registers, which picks the page the deck opens on.

---

## Ordered Implementation Steps

1. **`src/data/paths.ts`** — add the exported `projectName(root: string): string`
   below `baseName` ([src/data/paths.ts:10](src/data/paths.ts#L10)). Strip
   trailing `/` and `\` with `root.replace(/[/\\]+$/, '')`, pass the result to
   `baseName`, and fall back to `root` when that is `''`. Keep the module
   import-free, as its header comment requires.

2. **`tests/paths.test.ts`** — add a `describe('projectName')` block with one
   case per row of the `projectName` table in `## Public API`.
   Check: `npm test` — the new block passes and the existing ones still do.

3. **`src/shell/welcomeText.ts`** (new) — export `WelcomeCopy` and
   `welcomeCopy`, importing `APP_NAME` from `../appIdentity` and `projectName`
   from `../data/paths`. Import nothing from `@jimka/typescript-ui`. Head the
   file with a comment saying why it is separate from `WelcomeScreen.ts` (the
   node test environment has no DOM).

4. **`tests/welcomeText.test.ts`** (new) — cover both rows of the copy table in
   `## Architecture Decisions`, plus one case asserting the no-project heading
   contains `APP_NAME` rather than a literal `'Loom'`.
   Check: `npm test`.

5. **`src/shell/WelcomeScreen.ts`** (new) — the component from
   `## Internal Structure`. Follow Loom's component file shape: an exported
   `WelcomeScreenParams` interface documented as
   `Constructor parameters for {@link WelcomeScreen}.`, a class extending
   `Container`, and the three-line `callable` export tail used by
   [src/explorer/FileTree.ts:83](src/explorer/FileTree.ts#L83). Imports:
   `Container, callable` from `@jimka/typescript-ui/core`, `VBox` from
   `@jimka/typescript-ui/layout`, `Text` from
   `@jimka/typescript-ui/component/input`, `Button` from
   `@jimka/typescript-ui/component/button`, `OPEN_FOLDER_SHORTCUT` from
   `./shortcuts`, and `welcomeCopy` from `./welcomeText`.

6. **`src/EditorController.ts`** — add the private field
   `_emptyStateListener` beside `_projectRootListener`
   ([src/EditorController.ts:36](src/EditorController.ts#L36)) and the public
   `setEmptyStateListener` beside `setProjectRootListener`
   ([src/EditorController.ts:60](src/EditorController.ts#L60)). The setter
   stores `fn` then calls `fn(this._openFiles.size === 0)`.

7. **`src/EditorController.ts`** — in `syncActive`
   ([src/EditorController.ts:320](src/EditorController.ts#L320)), add
   `this._emptyStateListener?.(this._openFiles.size === 0)` as the **first**
   statement of the method body, before `const file = this.getActiveFile()`.
   It must sit above the `if (!file)` early return, or the welcome screen never
   reappears after the last tab closes.

8. **`src/shell/EditorShell.ts`** — add the two deck page-id constants beside
   `EXPLORER_PANE_INDEX` ([src/shell/EditorShell.ts:14](src/shell/EditorShell.ts#L14)):

   ```typescript
   /** The `Card` deck page ids the editor pane switches between. */
   const EDITOR_PAGE_ID = 'editor-tabs'
   const WELCOME_PAGE_ID = 'welcome-screen'
   ```

   Update `EXPLORER_PANE_INDEX`'s doc comment: the other pane is now the
   editor deck, not the tabs.

9. **`src/shell/EditorShell.ts`** — add the module-level `buildEditorDeck`
   helper from `## Internal Structure`, next to `buildMenuBar`. Add three
   imports: `Card` onto the existing `@jimka/typescript-ui/layout` import,
   a separate `import type { Component } from '@jimka/typescript-ui/core'`
   (the form [src/EditorController.ts:1](src/EditorController.ts#L1) uses), and
   `WelcomeScreen` from `./WelcomeScreen`.

10. **`src/shell/EditorShell.ts`** — in the constructor, hoist the open-folder
    call into a shared local so the menu and the welcome button run the same
    callback, build the welcome screen and the deck, and put the deck in the
    split:

    ```typescript
    const openFolder = (): void => { void controller.openProjectFolder() }
    const tree = FileTree({ onOpenFile: (path: string) => { void controller.openFile(path) } })
    const welcome = WelcomeScreen({ onOpenFolder: openFolder })
    const deck = buildEditorDeck(controller, welcome)
    ```

    Replace [src/shell/EditorShell.ts:37](src/shell/EditorShell.ts#L37) with
    `splitBody.addComponent(deck, { weight: 1 })`, and set the menu bag's
    `onOpenFolder` to `openFolder`.
    Check: `grep -n 'controller.tabs' src/shell/EditorShell.ts` — every match is
    inside `buildEditorDeck`; the `Split` no longer takes the tab panel
    directly.

11. **`src/shell/EditorShell.ts`** — extend the project-root wiring at
    [src/shell/EditorShell.ts:62](src/shell/EditorShell.ts#L62) so the welcome
    screen re-reads its copy too:

    ```typescript
    controller.setProjectRootListener(root => {
      void tree.setProjectRoot(root)
      welcome.setProjectRoot(root)
    })
    ```

12. **`src/shell/EditorShell.ts`** — update the class doc comment: the split's
    second pane is the editor deck (tab strip plus welcome screen), not the tab
    strip alone.
    Check: `npm run typecheck` — clean.

13. **`README.md`** and **`TODO.md`** — the edits listed in
    `## Documentation Impact`.

14. Run the manual checks in `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `src/shell/WelcomeScreen.ts` |
| Create | `src/shell/welcomeText.ts` |
| Create | `tests/welcomeText.test.ts` |
| Modify | `src/data/paths.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `tests/paths.test.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Unit-testable

`projectName` (`tests/paths.test.ts`) — one case per row of the table in
`## Public API`:

- `projectName('/home/jika/loom')` is `'loom'`.
- `projectName('/home/jika/loom/')` is `'loom'`.
- `projectName('C:\\dev\\loom\\')` is `'loom'`.
- `projectName('/')` is `'/'`.

`welcomeCopy` (`tests/welcomeText.test.ts`):

- `welcomeCopy(null)` returns heading `'Welcome to Loom'` and hint
  `'Open a project folder to start editing.'`.
- `welcomeCopy('/home/jika/typescript/loom')` returns heading `'loom'` and hint
  `'Select a file in the explorer to start editing.'`.
- `welcomeCopy(null).heading` contains `APP_NAME` — asserted against the
  imported constant, so renaming the app does not leave a stale literal.

### Manual verification

`WelcomeScreen`, the `Card` deck, and the split geometry are DOM- and
event-driven; Loom's vitest runs with `environment: 'node'` and no DOM, so
these are checked by running `npm run tauri:dev` and exercising the window.

- **Cold start, no folder.** The editor area shows `Welcome to Loom`, the
  "Open a project folder" hint, and an Open Folder… button captioned
  `Ctrl/Cmd+O`. No tab strip is visible.
- **Open Folder from the welcome button.** The same native folder picker the
  File menu opens appears. After picking, the tree fills, the welcome screen
  stays visible, the heading becomes the folder's name and the hint becomes
  "Select a file in the explorer to start editing.".
- **Cancelling the picker** leaves the heading and hint unchanged.
- **Open a file from the tree.** The welcome screen disappears; the tab strip
  and editor appear.
- **Close the only tab** (✕ or Ctrl/Cmd+W). The welcome screen returns with the
  project-open copy, and the window title returns to `Loom`.
- **Two files open, close both.** The welcome screen returns only after the
  second close.
- **Close a dirty file and pick Cancel** in the unsaved-changes prompt. The tab
  stays and the welcome screen does not appear.
- **Save As on the only open file.** The welcome screen stays hidden.
- **Open a different folder while files are open.** The tabs stay and the
  welcome screen stays hidden; closing every tab then shows the new folder's
  name as the heading.
- **Drag the explorer gutter with the welcome screen showing.** The split
  resizes smoothly and the explorer pane does not snap to an unexpected width.
- **Toggle Explorer (Ctrl/Cmd+B) with the welcome screen showing.** The tree
  collapses and the welcome screen fills the window, still centred.

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — the `projectName` and `welcomeCopy` suites pass alongside the
  existing ones.
- `grep -n 'controller.tabs' src/shell/EditorShell.ts` — every match is inside
  `buildEditorDeck`; nothing else adds the tab panel to a layout.
- `grep -rn "'Loom'" src/` — matches only
  [src/appIdentity.ts:5](src/appIdentity.ts#L5); the welcome copy has no second
  literal.
- `npm run tauri:dev`, then walk the manual list in `## Expected Behaviour`.
  The entry point is the app's main window: the editor area right of the file
  tree.

---

## Documentation Impact

Loom publishes no package API, so there is no barrel or docs page to update.
Two repo docs change:

- **`README.md`** — add a Highlights bullet after the "File tree" entry:
  a welcome screen shown whenever no file is open, offering *Open Folder* and
  naming the current project.
- **`TODO.md`** — remove the `**Welcome screen** (no project open / no files
  open state).` bullet from `## High`. Leave the neighbouring
  **Recent projects / recent files list** bullet in place; this plan does not
  implement it.

---

## Potential Challenges

- **A capped max width on the welcome page leaks into the explorer gutter.**
  `Card.getMaxSize()` reports the visible child's max size, and `Split`'s drag
  handler clamps the dragged pane's floor against its partner's max — so a
  welcome page with a bounded max width makes the explorer snap open the moment
  the gutter is touched. Mitigation: set no `maxSize` on the welcome page or any
  of its children; a bare `Text` and `Button` each report an unbounded max, and
  `VBox` passes that through.[^split-max]
- **Both deck pages need an id.** `Card` matches pages on `Component.getId()`;
  when the requested id matches nothing it warns to the console and falls back
  to the first child, so a missing id shows the wrong page silently.
  `buildEditorDeck` must call `setId` on both pages before registering the
  listener that selects one.
- **`syncActive` runs a microtask late after a tab close.** `handleTabClose`
  defers it because `Tab` emits `"tabclose"` before selecting the next tab, so
  the welcome screen appears one microtask after the last tab closes rather
  than synchronously. That deferral is correct; do not move the deck toggle
  onto the `"tabclose"` handler to make it immediate.
- **`Button`'s click event is `"action"`, not `"click"`.** Register the
  Open Folder handler with `on('action', …)`.

---

## Critical Files

- [src/shell/EditorShell.ts](src/shell/EditorShell.ts) — the shell being
  changed: `EXPLORER_PANE_INDEX`, the `Split` composition, the `buildMenuBar`
  helper the new deck helper sits beside, and the project-root wiring.
- [src/EditorController.ts](src/EditorController.ts) —
  `setProjectRootListener` (the seam `setEmptyStateListener` mirrors),
  `_openFiles`, and `syncActive`.
- [src/explorer/FileTree.ts](src/explorer/FileTree.ts) — Loom's component file
  shape: exported params interface, class body, `callable` export tail. Also
  `setProjectRoot(root: string)`, whose signature `WelcomeScreen` copies.
- [src/data/paths.ts](src/data/paths.ts) — `baseName`, and the module's
  import-free rule.
- [src/shell/shortcuts.ts](src/shell/shortcuts.ts) — `OPEN_FOLDER_SHORTCUT`.
- `../sqladmin/frontend/src/shell/SqlAdminShell.ts` (sibling checkout beside
  this repo), `buildCenterDeck` at line 299 — the `Card`-deck precedent this
  plan follows.
- `../sqladmin/frontend/src/shell/StartPage.ts` — the start-page precedent. Its
  file-header comment documents the `Card` → `Split` max-width trap in
  `## Potential Challenges`.
- `../sqladmin/frontend/src/shell/startPageWelcome.ts` — the precedent for
  splitting a page's copy rule into a DOM-free, testable module.

---

## Non-Goals

- **Recent projects / recent files.** A separate High-priority `TODO.md` item
  with its own plan. The extension point is `WelcomeScreen`'s `VBox` column: a
  titled list of recent-project buttons appends below the Open Folder button.
  Document that in the class doc comment and add no code for it now.
- **A keyboard-shortcut legend on the page.** Only the Open Folder accelerator
  is surfaced, as the button's `description`.
- **Placeholder text inside the empty explorer tree.** Adding it would need a
  change to `@jimka/typescript-ui` (see `## Architecture Decisions`).
- **Auto-collapsing the explorer pane while no project is open.** It would
  fight the Toggle Explorer command's own collapsed state.
- **Restoring the last project on start.** Covered by the session-persistence
  `TODO.md` item.
- **Theming the welcome screen.** It uses the same `--ts-ui-input-bg` token the
  code editor paints with, and follows whatever theme the library defaults to.

---

## Notes

[^card-deck]: A `Card` deck keeps the welcome screen out of the tab model
    entirely: no placeholder tab to filter out of `_openFiles`, exclude from
    `hasActiveFile()`, or guard against being closed. The library's own `Dock`
    solves the same problem by docking a non-closeable, transient placeholder
    tab (`Dock.showEmptyState`), but that machinery is internal to `Dock` and
    Loom composes a plain `TabPanel`; reproducing it by hand would mean
    special-casing the placeholder in every method that reads the active tab.
    Rejected alternatives: swapping the split pane's child at runtime
    (`removeComponent`/`addComponent` churns layout state and loses the pane's
    dragged width), and adopting `Dock` in place of `TabPanel` (a much larger
    change already deferred in `TODO.md`'s Medium section). Unlike sqladmin's
    `StartPage`, the page id is set by the shell after construction rather than
    passed into the constructor — sqladmin passes it in only because its page
    uses `autoScroll`, which registers a wheel listener keyed to the id during
    construction. Loom's page does not scroll.

[^registry-signal]: `_openFiles` is the authoritative registry of open files,
    and `handleTabClose` deletes from it synchronously. `getActiveFile()`
    instead reads `Tab`'s activation state, which is momentarily stale during a
    close — that is exactly why `handleTabClose` defers `syncActive` to a
    microtask. Keying the deck off the map means the signal is correct
    regardless of when the notification runs, and it does not depend on `Tab`
    guaranteeing that a non-empty strip always has an active tab.

[^one-page]: The two states are one situation — no file is open — differing
    only in what the user should do next. Both offer the same action. Modelling
    them as two `Card` pages would duplicate the button wiring and add a third
    deck page for no behavioural gain, and modelling them as two components
    would duplicate the layout as well.

[^pure-copy]: `vitest.config.ts` sets `environment: 'node'` and its comment
    states the choice plainly: the unit tests cover pure data helpers, and
    component behaviour is verified live. A module that imports
    `@jimka/typescript-ui/component/*` touches `document` at load time, so a
    test importing `WelcomeScreen.ts` would fail on import alone. Keeping
    `welcomeCopy` in its own import-light module means the one rule with real
    branching gets a red-green cycle.

[^mutate-not-rebuild]: There are two `Text` children and one `Button`, and only
    the text changes. sqladmin's `StartPage` rebuilds because its body contains
    lists whose lengths change; its `rebuild` closure has to dispose every child
    by hand first, because `removeAllComponents` only detaches. That hazard is
    worth taking on for a list-bearing page and pointless for two labels.

[^no-tree-empty-state]: `AbstractSelectableList` carries `emptyText` /
    `emptyComponent` options and a `syncEmptyPlaceholder` pass, but `Tree`
    extends `VirtualRowView` instead and `TreeOptions` has no equivalent field.
    Adding one is a change to `@jimka/typescript-ui`, outside this plan and
    outside this repo.

[^split-max]: `Component.getMaxSize()` merges the explicit constraint with the
    layout manager's computed max using `Math.min`, so an explicit
    `maxSize: UNBOUNDED` on the page cannot rescue a bounded computation from
    below — the fix has to be that no child caps its own max width in the first
    place. `VBox` reports its cross-axis (width) max as the largest child max,
    unbounded if any child is unbounded, so leaving the children alone is
    sufficient. sqladmin hit the bounded case because its start page pins both
    content columns to a fixed 350px width and had to add an unbounded flex
    `Spacer` to compensate; Loom's centred column needs no fixed width, so the
    problem does not arise.

---

## Implementation Notes

The worktree's `node_modules/@jimka/typescript-ui` needed re-pointing at the
sibling `typescript-ui` checkout (`ln -s ../../../typescript-ui/packages/lib`,
mirroring the main tree's own symlink) after `npm install` replaced it with
the older published `0.8.0` package — the published build predates
`TabCloseController`/`Tab.setTabName`/`"beforetabclose"`, which
session-persistence's already-merged `EditorController.ts` depends on. This
isn't a plan defect, just dev-environment setup the worktree doesn't inherit
automatically; recorded here in case a later phase's worker hits the same
`tsc` errors in a fresh worktree.

Step 11's wiring extends `controller.setProjectRootListener`'s actual current
body (`void this.openProjectRoot(root)`, added by
`workspace-session-persistence`) rather than the plan's illustrative
`void tree.setProjectRoot(root)` snippet, which predates that refactor. The
instruction — "add `welcome.setProjectRoot(root)` alongside the existing
project-root handling" — is followed exactly; only the surrounding line
differs from the snippet shown.

Manual verification ran against a real `npm run tauri:dev` process (Linux/
WSL2, DISPLAY forwarded to a Windows host via WSLg), screenshotted with
Pillow's `ImageGrab` and driven with `pyautogui`, since no project skill for
launching Loom exists yet and a plain-browser `npm run dev` load crashes
before render (`@tauri-apps/plugin-os`'s `platform()`, read at
`workspace.ts` module-load time, throws outside a real Tauri IPC bridge).
Confirmed by screenshot: cold start showing "Welcome to Loom" / the
open-a-folder hint / the Open Folder… button captioned `Ctrl/Cmd+O` with no
tab strip; clicking that button raising the same native folder picker File >
Open Folder… uses; picking a folder (`/home/jika/typescript/loom`) filling
the tree while the welcome screen stayed visible and switched to the
project-open copy (heading `loom`, the file-select hint); opening a file
swapping to the tab strip and editor; closing the only open tab returning the
welcome screen with the project-open copy; and Toggle Explorer (Ctrl/Cmd+B)
with the welcome screen showing collapsing the tree while the welcome screen
filled the window, still centred, then restoring cleanly. Not conclusively
exercised: dragging the split gutter with the welcome screen showing — the
gutter's hit target proved too narrow to land reliably with synthetic
pointer input (one attempt landed inside the tree and drag-selected several
rows instead), so this fell back on the code-level confirmation already in
`## Potential Challenges`: `WelcomeScreen.ts` sets no `maxSize` anywhere,
which is the documented fix for the leak-into-the-gutter failure mode.
Cancelling the picker, closing two tabs in sequence, the dirty-file-cancel
case, Save As, and switching projects with files open were not exercised
live; each exercises only wiring this plan left untouched (`Dialog`,
`FileEditor`, `saveAs`, `openProjectRoot`), not the new deck/listener code
path.
