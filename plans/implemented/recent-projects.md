---
depends-on: [session-persistence, welcome-screen]
touches-shared: [src/data/session.ts, src/EditorController.ts, src/shell/session.ts, src/shell/EditorShell.ts, src/shell/WelcomeScreen.ts, src/main.ts, tests/session.test.ts]
---

# Recent Projects / Recent Files List — Implementation Plan

## Overview

Loom has no way to reopen a folder or file except through the native OS
picker. This plan adds two most-recently-used lists — recent project
folders and recent files — surfaced from a new "Open Recent" submenu on the
File menu, and from a "Recent Projects" section on the welcome screen.

The lists live as two new fields on `SessionState`
([`plans/session-persistence.md`](session-persistence.md)'s `src/data/session.ts`),
written to the same `session.json` that plan already builds — no new storage
mechanism, no new Tauri capability. `EditorController` gains the in-memory
lists and records into them from its two existing open commands,
`openFile` and `openProjectFolder`. `EditorShell` reads them into a new File
menu submenu and into `WelcomeScreen`
([`plans/welcome-screen.md`](welcome-screen.md)), which gains a small
button list under its Open Folder button — the extension point that plan's
`## Non-Goals` reserved for exactly this.

This plan depends on both `session-persistence.md` and `welcome-screen.md`;
neither is implemented yet, so every citation into `EditorController.ts` and
`EditorShell.ts` below targets the shape those two plans leave those files
in, not today's code.[^depends-on]

---

## Architecture Decisions

### Recent history is two more fields on the existing `session.json`

`SessionState` gains `recentProjects: string[]` and `recentFiles: string[]`,
written and read through the same `readSessionText`/`writeSessionText` pair
`session-persistence.md` already builds. No new file, no new capability
grant.[^same-storage]

### Recent files span every project, not just the current one

A file opened through `EditorController.openFile` is recorded regardless of
which project (if any) is open. Loom already treats an open file as
independent of the current project root — `session-persistence.md`'s own
`restoreFiles` reopens tabs "even when the project folder is gone" — so a
recent-files list scoped to "only files under the current root" would be a
narrower rule than the app already applies elsewhere.[^files-not-scoped]
Recent *projects* have no such question: each entry is a project root by
definition.

### Recording happens on success; nothing is proactively pruned

An entry is recorded only once the open it represents actually succeeds —
after `readFileText` resolves, or once `pickProjectFolder` returns a real
path. A failed open is never recorded, so a broken path can't get into the
list from a failed attempt. The list is otherwise never validated or
rewritten: a project or file that is later deleted stays in the list until
it ages out past `MAX_RECENT_ENTRIES`, and clicking it fails exactly the way
the equivalent existing action already fails — `openFile`'s existing
`Dialog.error`, or a recent-project's `openRecentProject` call landing on
whatever `EditorShell`'s project-root handling already does with a bad
path.[^no-proactive-prune] This success-gated, never-rewritten recording is
the same "degrade at the point of use, don't invent new handling" rule
`session-persistence.md` applies to stale `openFiles`/`projectRoot` entries,
adapted to a history list instead of a live-state snapshot.

### Restoring tabs on launch does not touch recent files

`restoreFiles` (`session-persistence.md`) has its own silent reopen path
that never calls `openFile`, so replaying a previous session's tabs never
re-records them. Recording is reserved for a discrete "the user opened this"
action — a tree click, a File-menu click, or the first read of a file —
not for the automatic replay of files that were already open.[^no-restore-record]

### Ten entries, one shared cap

Both lists share one constant, `MAX_RECENT_ENTRIES = 10`: long enough to be
useful, short enough that the File-menu submenu never needs to
scroll.[^cap-choice]

### Two surfaces: a File-menu submenu, and the welcome screen's reserved list

The File menu gets an "Open Recent" item whose `submenu` lists recent
projects, then a separator, then recent files — built from a provider
function so it is recomputed on every open, the same pattern the File menu's
own `enabled` checks already use for `hasActiveFile()`/`isActiveDirty()`.
The library's `MenuItemConfig.submenu` and a submenu's own `items` provider
already support exactly this case; this plan is simply the first place in
Loom that uses them, not a new pattern invented for this feature. The
welcome screen gets a "Recent Projects" section
under its Open Folder button — the extension point `welcome-screen.md`'s
`## Non-Goals` names explicitly: "a titled list of recent-project buttons
appends below the Open Folder button." Recent *files* do not appear on the
welcome screen — that plan's extension point names projects only, and the
welcome screen's own copy is about getting a project open, not about
individual files.

### `openRecentProject` reuses the picker's own success path

`EditorController.openRecentProject(root)` records the entry and then calls
`this._projectRootListener?.(root)` — the exact call `openProjectFolder`
makes once the picker returns a path. A recent-project click is handled
identically to a fresh pick from here on; `EditorShell` needs no new
listener, no new failure handling.

### The welcome screen's recent-project list rebuilds; its heading and hint keep mutating in place

`WelcomeScreen.setRecentProjects` disposes and rebuilds a dedicated child
`Container` holding the recent-project buttons, the same
dispose-before-detach shape `../sqladmin/frontend/src/shell/StartPage.ts`
uses for its own recent-tables/saved-queries lists (`buildQuickActions`,
`appendList`, lines 230–241 and 269–284). `welcome-screen.md`'s own decision
to mutate the heading and hint `Text`s in place stands unchanged — that
decision was scoped to two fixed labels. The newly added recent-projects
section is instead a length-changing list, the case that plan's own
footnote said the rebuild hazard was "worth taking on" for.[^scoped-rebuild]

---

## Public API

### `src/data/session.ts` (modified — adds to `session-persistence.md`'s module)

```ts
export interface SessionState {
  // ...existing fields from session-persistence.md...
  /** Recently opened project folders, most-recent first. */
  recentProjects: string[]
  /** Recently opened files, most-recent first, independent of which project (if any) they were opened from. */
  recentFiles: string[]
}

/** The most recent-projects or recent-files entries kept, oldest dropped first — long enough to be useful, short enough that the File-menu submenu never needs to scroll (matching the length most editors cap an in-menu recent list at). */
export const MAX_RECENT_ENTRIES = 10

/** Returns a new list with `path` moved to the front, any earlier occurrence removed, capped at {@link MAX_RECENT_ENTRIES}. Leaves `list` unmutated. */
export function withRecent(list: string[], path: string): string[]
```

### `src/EditorController.ts` (modified)

```ts
/** Seeds the in-memory recent-projects/recent-files lists from a loaded session. Call once, right after construction, before any command that might record into them. */
seedRecents(projects: string[], files: string[]): void

/** Recently opened project folders, most-recent first. */
getRecentProjects(): string[]

/** Recently opened files, most-recent first. */
getRecentFiles(): string[]

/** Points the tree at `root` without the native picker — the counterpart to {@link openProjectFolder} for a path already known, e.g. a Recent Projects entry. */
openRecentProject(root: string): void
```

Backing fields: `private _recentProjects: string[] = []` and
`private _recentFiles: string[] = []`, beside the existing `_openFiles` map.

### `src/shell/EditorShell.ts` (modified)

```ts
interface MenuBarActions extends AcceleratorActions {
  hasActiveFile: () => boolean
  isActiveDirty: () => boolean
  /** Recently opened project folders, most-recent first — read by the Open Recent submenu. */
  getRecentProjects: () => string[]
  /** Recently opened files, most-recent first — read by the Open Recent submenu. */
  getRecentFiles: () => string[]
  /** Reopens a recent project's root, bypassing the native picker. */
  onOpenRecentProject: (path: string) => void
  /** Reopens a recent file — the same action a tree click runs. */
  onOpenRecentFile: (path: string) => void
}
```

### `src/shell/WelcomeScreen.ts` (modified — extends `welcome-screen.md`'s component)

```ts
export interface WelcomeScreenParams {
  onOpenFolder: () => void
  /** The recent-projects list to show initially, most-recent first — kept current afterwards via {@link WelcomeScreen.setRecentProjects}. */
  recentProjects: string[]
  /** Invoked with a recent project's root path when its button is pressed. */
  onOpenRecentProject: (path: string) => void
}

class WelcomeScreen extends Container {
  /** Rebuilds the Recent Projects section from `projects`, most-recent first. The section is omitted entirely when `projects` is empty. */
  setRecentProjects(projects: string[]): void
}
```

`src/shell/session.ts`'s `captureSession` gains two more fields in its
returned object — no signature change, covered in `## Internal Structure`.

---

## Internal Structure

### `withRecent` (`src/data/session.ts`)

```ts
export function withRecent(list: string[], path: string): string[] {
  return [path, ...list.filter(entry => entry !== path)].slice(0, MAX_RECENT_ENTRIES)
}
```

### `EditorController`'s recording (`src/EditorController.ts`)

`openFile` gains one recording call on each of its two success paths — the
early return for an already-open tab, and after `readFileText` resolves —
never on the `Dialog.error` failure path:

```ts
async openFile(path: string): Promise<void> {
  const existing = this._openFiles.get(path)

  if (existing) {
    this.recordRecentFile(path)
    this.tabs.getTab().setActiveContent(existing)

    return
  }

  let text: string

  try {
    text = await readFileText(path)
  } catch (error) {
    await Dialog.error('Could not open file', messageOf(error))

    return
  }

  this.recordRecentFile(path)

  const file = this.addFileTab(path, text)

  this.tabs.getTab().setActiveContent(file)
  this.syncActive()
}
```

`openProjectFolder` gains one recording call, and a new sibling method reuses
it:

```ts
async openProjectFolder(): Promise<void> {
  const root = await pickProjectFolder()

  if (root !== null) {
    this.recordRecentProject(root)
    this._projectRootListener?.(root)
  }
}

openRecentProject(root: string): void {
  this.recordRecentProject(root)
  this._projectRootListener?.(root)
}

private recordRecentProject(root: string): void {
  this._recentProjects = withRecent(this._recentProjects, root)
}

private recordRecentFile(path: string): void {
  this._recentFiles = withRecent(this._recentFiles, path)
}
```

`seedRecents`/getters:

```ts
seedRecents(projects: string[], files: string[]): void {
  this._recentProjects = projects
  this._recentFiles = files
}

getRecentProjects(): string[] {
  return [...this._recentProjects]
}

getRecentFiles(): string[] {
  return [...this._recentFiles]
}
```

Import `withRecent` from `./data/session`.

### `captureSession`'s extra fields (`src/shell/session.ts`)

`session-persistence.md` step 10's returned object literal gains two more
entries, read the same way `getOpenFilePaths`/`getActiveFilePath` already
are:

```ts
recentProjects: targets.controller.getRecentProjects(),
recentFiles: targets.controller.getRecentFiles(),
```

### The File menu's Open Recent submenu (`src/shell/EditorShell.ts`)

```ts
function buildRecentItems(actions: MenuBarActions): MenuItemConfig[] {
  const projects = actions.getRecentProjects()
  const files = actions.getRecentFiles()
  const items: MenuItemConfig[] = projects.map(root => ({
    text: projectName(root),
    glyph: 'folder',
    action: () => actions.onOpenRecentProject(root),
  }))

  if (projects.length > 0 && files.length > 0) {
    items.push({ separator: true })
  }

  items.push(...files.map(path => ({
    text: baseName(path),
    glyph: 'file-code',
    action: () => actions.onOpenRecentFile(path),
  })))

  return items
}
```

`buildMenuBar`'s File-menu items array gains one entry, right after
`Open Folder…`:

```ts
{
  text: 'Open Recent',
  glyph: 'clock-rotate-left',
  enabled: actions.getRecentProjects().length > 0 || actions.getRecentFiles().length > 0,
  submenu: { label: 'Open Recent', items: () => buildRecentItems(actions) },
},
```

### `WelcomeScreen`'s recent-projects section (`src/shell/WelcomeScreen.ts`)

Extends `welcome-screen.md`'s constructor/body (its `## Internal Structure`
code block) with one more child container and one more method:

```ts
class WelcomeScreen extends Container {
  private readonly _heading: Text
  private readonly _hint: Text
  private readonly _recentList: Container
  private readonly _onOpenRecentProject: (path: string) => void

  constructor(params: WelcomeScreenParams) {
    const heading = new Text('', { fontSize: HEADING_FONT_SIZE, fontWeight: '600' })
    const hint = new Text('', { foregroundColor: HINT_COLOR })

    const openFolder = Button({
      text: 'Open Folder…',
      glyph: 'folder',
      description: OPEN_FOLDER_SHORTCUT,
    })
    openFolder.on('action', params.onOpenFolder)

    const recentList = Container({ layoutManager: new VBox({ itemAlign: 'center', spacing: RECENT_LIST_SPACING }) })

    super({
      layoutManager: new VBox({ justify: 'center', itemAlign: 'center', spacing: CONTENT_SPACING }),
      backgroundColor: 'var(--ts-ui-input-bg, rgb(255, 255, 255))',
      components: [heading, hint, openFolder, recentList],
    })

    this._heading = heading
    this._hint = hint
    this._recentList = recentList
    this._onOpenRecentProject = params.onOpenRecentProject
    this.applyCopy(null)
    this.setRecentProjects(params.recentProjects)
  }

  setProjectRoot(root: string): void {
    this.applyCopy(root)
  }

  setRecentProjects(projects: string[]): void {
    for (const component of this._recentList.getComponents()) {
      component.dispose()
    }

    this._recentList.removeAllComponents()

    if (projects.length > 0) {
      this._recentList.addComponent(new Text('Recent Projects', { foregroundColor: HINT_COLOR }))

      for (const root of projects) {
        const button = Button({ text: projectName(root), glyph: 'folder', compact: true })

        button.on('action', () => this._onOpenRecentProject(root))
        this._recentList.addComponent(button)
      }
    }

    this._recentList.doLayout()
  }

  private applyCopy(projectRoot: string | null): void {
    const copy = welcomeCopy(projectRoot)

    this._heading.setText(copy.heading)
    this._hint.setText(copy.hint)
  }
}
```

New constant, documented like the module's existing three:

```ts
/** Spacing between the recent-projects heading and each button — tighter than CONTENT_SPACING since these rows are one repeated group, not distinct page sections. */
const RECENT_LIST_SPACING = 6
```

Import `projectName` from `../data/paths`, alongside `Button`'s existing
import from `@jimka/typescript-ui/component/button`.

---

## Ordered Implementation Steps

1. **`src/data/session.ts`.** Add `recentProjects`/`recentFiles` to
   `SessionState`, both defaulting to `[]` in `emptySession()`. In
   `parseSession`, parse both fields with the same rule already applied to
   `openFiles` (an array of strings; any non-string entry drops the whole
   field to `[]`), then `.slice(0, MAX_RECENT_ENTRIES)` each. Add
   `MAX_RECENT_ENTRIES` and `withRecent` exactly as given in
   `## Public API`/`## Internal Structure`.

2. **`tests/session.test.ts`.** This file is created by
   `session-persistence.md` step 2; once it exists, extend it:
   - Add the `withRecent` cases from `## Expected Behaviour` below.
   - Extend the "complete, valid document" and
     `parseSession(serializeSession(state))` round-trip cases to populate
     `recentProjects`/`recentFiles`.
   - Add the `recentFiles`-present and `recentProjects`-with-a-bad-entry
     cases from `## Expected Behaviour`.
   - Add the over-cap case from `## Expected Behaviour`.
   - Find `session-persistence.md`'s own "unknown fields ignored" case,
     `parseSession('{"version":1,"recentProjects":[]}')`. `recentProjects`
     is a real field now, not an example of an unknown one — change its
     literal field name to `futureField`, matching
     `workspace-session-persistence.md`'s equivalent case for
     `WorkspaceState`.
   Run `npm test` — must pass before continuing.

3. **`src/EditorController.ts`.** Add the `_recentProjects`/`_recentFiles`
   fields beside `_openFiles`. Add `seedRecents`, `getRecentProjects`,
   `getRecentFiles`, `openRecentProject`, and the private
   `recordRecentProject`/`recordRecentFile` helpers from
   `## Internal Structure`. Add the two `recordRecentFile`/`recordRecentProject`
   calls into `openFile` and `openProjectFolder` exactly as shown — `openFile`'s
   shape here is `session-persistence.md` step 6's post-split version
   (`addFileTab` already factored out), not today's inline version. Import
   `withRecent` from `./data/session`.

4. **`src/shell/session.ts`.** Add the two `recentProjects`/`recentFiles`
   lines to `captureSession`'s returned object
   (`session-persistence.md` step 10).

5. **`src/main.ts`.** In `start()` (`session-persistence.md` step 16),
   add `controller.seedRecents(session.recentProjects, session.recentFiles)`
   immediately after `const controller = new EditorController()` — before
   `EditorShell(controller, session)` is constructed, so the shell's
   `WelcomeScreen` sees the seeded list at construction time. Add
   `import { clock_rotate_left } from '@jimka/typescript-ui/glyphs/solid/clock_rotate_left'`
   next to the file's other glyph imports, and add `clock_rotate_left` to the
   existing module-scope `Glyph.register(...)` call — that call stays outside
   `start()` per `session-persistence.md` step 16.

6. **`src/shell/EditorShell.ts`.** Extend `MenuBarActions`
   (today's `src/shell/EditorShell.ts:17`, unmodified by either prerequisite
   plan) with `getRecentProjects`, `getRecentFiles`, `onOpenRecentProject`,
   `onOpenRecentFile` from `## Public API`. In the constructor's `actions`
   object literal, add:
   ```ts
   getRecentProjects: () => controller.getRecentProjects(),
   getRecentFiles: () => controller.getRecentFiles(),
   onOpenRecentProject: (path: string) => controller.openRecentProject(path),
   onOpenRecentFile: (path: string) => { void controller.openFile(path) },
   ```

7. **`src/shell/EditorShell.ts`.** Add the module-level `buildRecentItems`
   helper from `## Internal Structure`, next to `buildMenuBar`. Add the
   `Open Recent` entry to the File menu's items array (today's
   `src/shell/EditorShell.ts:77`–`85`, unmodified by either prerequisite
   plan) right after the `Open Folder…` item. Add
   `import type { MenuItemConfig } from '@jimka/typescript-ui/component/container'`
   and `import { projectName, baseName } from '../data/paths'`.
   Check: `npm run typecheck` — clean.

8. **`src/shell/WelcomeScreen.ts`.** Add `recentProjects` and
   `onOpenRecentProject` to `WelcomeScreenParams`. Add the `_recentList`
   field, the `RECENT_LIST_SPACING` constant, and `setRecentProjects` from
   `## Internal Structure`; wire the constructor as shown. Import
   `projectName` from `../data/paths`.
   Check: `npm run typecheck` — clean.

9. **`src/shell/EditorShell.ts`.** Extend the `WelcomeScreen(...)`
   construction call (`welcome-screen.md` step 10) with the two new params,
   now that step 8 has added them to `WelcomeScreenParams`:
   ```ts
   const welcome = WelcomeScreen({
     onOpenFolder,
     recentProjects: controller.getRecentProjects(),
     onOpenRecentProject: (path: string) => controller.openRecentProject(path),
   })
   ```

10. **`src/shell/EditorShell.ts`.** Find where `welcome.setProjectRoot(root)`
    is called once a project root changes. `welcome-screen.md` step 11 places
    this inline in the `controller.setProjectRootListener(...)` callback;
    `session-persistence.md` step 14 replaces that same callback with a call
    into a new private `openProjectRoot(root)` method, which is the more
    likely landing spot once the two plans are reconciled — see
    `## Potential Challenges`. Wherever the call actually lands, add
    `welcome.setRecentProjects(controller.getRecentProjects())` immediately
    after it. Recording already happened inside `EditorController` before
    this listener fires, so `getRecentProjects()` here already includes the
    new entry.
    Check: `npm run typecheck` — clean.
    `grep -n 'controller.openProjectFolder\|controller.openRecentProject' src/shell/EditorShell.ts` —
    both appear, confirming the picker and the recent-project path are
    both wired.

11. **Docs.** Apply `## Documentation Impact`.

12. Run the manual checks in `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src/data/session.ts` |
| Modify | `tests/session.test.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `src/shell/session.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `src/shell/WelcomeScreen.ts` |
| Modify | `src/main.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### `withRecent` and parsing — unit-testable (`tests/session.test.ts`)

- `withRecent([], '/a')` returns `['/a']`.
- `withRecent(['/a', '/b'], '/c')` returns `['/c', '/a', '/b']`.
- `withRecent(['/a', '/b', '/c'], '/b')` returns `['/b', '/a', '/c']` — moved
  to the front, not duplicated.
- `withRecent` of a 10-entry list with an 11th, new path returns exactly 10
  entries: the new path first, the oldest of the previous 10 dropped.
- `withRecent` leaves its input array unmutated.
- `emptySession().recentProjects` and `.recentFiles` are both `[]`.
- A complete, valid `parseSession` document returns `recentProjects` and
  `recentFiles` verbatim (extend the existing full-document case).
- `parseSession('{"version":1,"recentFiles":["/p/a.ts","/p/b.ts"]}')`
  returns that `recentFiles` and empty defaults for every other field.
- `parseSession('{"version":1,"recentProjects":["/p",7]}')` returns
  `recentProjects: []` — one bad entry drops the whole array.
- `parseSession` of a `recentFiles` array with 12 entries returns only the
  first `MAX_RECENT_ENTRIES` (10) of them.
- `parseSession(serializeSession(state))` deep-equals `state` for a state
  with `recentProjects`/`recentFiles` populated (extend the existing
  round-trip case).
- `parseSession('{"version":1,"futureField":true}')` ignores the unknown
  field (the renamed case from step 2).

### Recording and menus — manual verification (`npm run tauri:dev`)

`EditorController`, the menu, and `WelcomeScreen` are DOM- and
library-driven; Loom's vitest runs with `environment: 'node'`, so these are
checked by hand.

- **Open Folder twice, two different folders.** File → Open Recent lists
  both projects, most-recent first.
- **Click a recent project.** The tree switches to that project, the same
  as picking it through the native dialog.
- **Open several files from the tree.** File → Open Recent lists them,
  most-recent first.
- **Reopen an already-open file from the tree.** It moves to the front of
  the recent-files list without duplicating.
- **Click a recent file.** It opens (or activates its existing tab), the
  same as clicking it in the tree.
- **Cold start with a populated `session.json`.** File → Open Recent already
  shows the previous session's history before anything new is opened.
- **Welcome screen, no project open, non-empty `recentProjects`.** A
  "Recent Projects" section with one button per entry appears below Open
  Folder…; clicking one opens that project.
- **Welcome screen on the very first launch (`recentProjects` empty).** No
  "Recent Projects" section appears — no empty placeholder.
- **Open a project from the welcome screen's own Recent Projects button,
  then close all tabs again.** The welcome screen's list now shows that
  project at the front.
- **Click a recent file whose path no longer exists.** The same
  "Could not open file" dialog `openFile` already shows for a bad tree
  click appears; the entry stays in the list.
- **Click a recent project whose folder no longer exists.** Behaves the
  same as picking a deleted folder through the native dialog would.
- **Quit and relaunch.** File → Open Recent still lists the same entries.
- **Relaunch with tabs restored from the previous session.** The restored
  tabs do not change Open Recent's file order — only a genuinely new open
  does.

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — the extended `tests/session.test.ts` passes alongside the
  existing suites.
- `grep -rn '@tauri-apps' src/ --include=*.ts` — matches only in
  `src/data/workspace.ts`; this plan adds no new filesystem calls.
- `grep -n 'MAX_RECENT_ENTRIES' src/data/session.ts` — one definition, used
  by both `parseSession` and `withRecent`.
- `npm run tauri:dev`, then the manual checklist in `## Expected Behaviour`.
  The entry points are the File menu and the welcome screen (shown with no
  project open, or after closing every tab).

---

## Documentation Impact

- **`README.md`** — add a Highlights bullet for Recent Projects & Files,
  immediately after the session-restore bullet `session-persistence.md`
  adds: reopening a recent folder or file from the File menu's Open Recent
  submenu, or a recent folder from the welcome screen.
- **`TODO.md`** — remove the *Recent projects / recent files list* bullet
  from `## High` (the three lines starting `- **Recent projects / recent
  files list**`). This plan is the one that finally removes it — every
  sibling plan (`session-persistence.md`, `workspace-session-persistence.md`,
  `welcome-screen.md`) explicitly left it in place, deferring to this one.

---

## Potential Challenges

- **`session-persistence.md` step 14 and `welcome-screen.md` step 11 both
  rewrite the same `controller.setProjectRootListener(...)` callback in
  `EditorShell`'s constructor, independently of each other.** Whoever
  implements the second of those two plans has to reconcile the two edits
  into one callback; this plan's step 9 depends on that reconciliation
  having happened, and names the likely landing spot (`openProjectRoot`)
  without assuming an exact line number.
- **Forgetting to dispose the previous recent-project buttons before
  removing them** leaks each rebuild's listeners and per-instance styles —
  the same hazard `../sqladmin/frontend/src/shell/StartPage.ts`'s own
  comment documents for its `rebuild` closure. `setRecentProjects` must call
  `dispose()` on every existing child before `removeAllComponents()`.
- **Forgetting to register `clock_rotate_left` in `main.ts`.** The File
  menu's Open Recent item silently renders without its icon if the glyph
  registry doesn't have it — check for it visually during the manual pass.

---

## Critical Files

- [`plans/session-persistence.md`](session-persistence.md) — the storage
  mechanism this plan extends (`SessionState`, `captureSession`,
  `readSessionText`/`writeSessionText`) and the shape `EditorController.ts`/
  `main.ts` are left in once implemented; this plan's step citations into
  those files assume that plan's steps 6, 10, and 16.
- [`plans/welcome-screen.md`](welcome-screen.md) — `WelcomeScreen`'s
  reserved extension point (its `## Non-Goals`) and the component shape this
  plan extends.
- [`src/EditorController.ts`](src/EditorController.ts) — `openFile` and
  `openProjectFolder`, the two commands this plan adds recording to.
- [`src/shell/EditorShell.ts`](src/shell/EditorShell.ts) — `buildMenuBar`
  and `MenuBarActions`, unmodified by either prerequisite plan, so this
  plan's citations into them are exact.
- `../typescript-ui/packages/lib/src/typescript/lib/component/container/MenuItem.ts` —
  `MenuItemConfig.submenu` and `MenuConfig.items`' provider-function
  behaviour, the library feature this plan's Open Recent submenu relies on.
- `../sqladmin/frontend/src/shell/StartPage.ts` — `buildQuickActions`
  (line 230) and `appendList` (line 269), the precedent for a hide-when-empty
  recent-items list built from a dispose-then-rebuild container.

---

## Non-Goals

- **A "Clear Recent Projects/Files" command, or any proactive existence
  check.** See `## Architecture Decisions` — a failed open is simply never
  recorded; nothing removes an entry once added, short of the MRU cap.
- **Recent files on the welcome screen.** `welcome-screen.md`'s reserved
  extension point names projects only.
- **A keyboard accelerator for Open Recent.** None of Loom's peers bind one
  either; a fuzzy quick-open is `TODO.md`'s separate Medium-priority item.
- **Per-workspace recent lists.** Both lists stay app-wide, matching
  `workspace-session-persistence.md`'s own choice to keep `paneSizes` (a
  user preference, not project content) at the app level.
- **Disambiguating two recent files that share a base name in different
  folders.** The tab strip already has this same ambiguity today and Loom
  accepts it there.

---

## Notes

[^depends-on]: `SessionState`, `captureSession`, `EditorController.openFile`'s
    `addFileTab`-split shape, and `WelcomeScreen` itself do not exist in
    their needed form until `session-persistence.md` and `welcome-screen.md`
    are both implemented. This plan's steps cite those plans' step numbers
    rather than line numbers that do not exist yet, the same approach
    `workspace-session-persistence.md` takes toward `session-persistence.md`.

[^same-storage]: Three other options were considered and dropped. A
    separate `recent.json` would duplicate the read/write/debounce/flush
    machinery `session-persistence.md` already built for exactly this kind
    of small app-wide state, for no isolation benefit — nothing else reads
    `session.json` concurrently (Loom is single-window). Deriving the list
    from `.loom/workspace.json` (`workspace-session-persistence.md`) doesn't
    work at all: that file is per-project, and a recent-projects list is
    inherently cross-project. `localStorage` was already rejected for
    session state in `session-persistence.md`'s own `[^storage]` footnote,
    for the same origin-mismatch and durability reasons that apply here too.

[^files-not-scoped]: The alternative — only recording a file if it is under
    the currently open project root — would need a live `isUnderRoot` check
    against `EditorController`'s own state at record time, and would mean a
    file opened before its project's folder was ever opened in this app
    (or opened from outside any project at all, which nothing currently
    prevents) never appears in the list. Since `session-persistence.md`
    already reopens such files on restore, treating them differently for
    the *recent* list would be an inconsistency this plan doesn't want to
    introduce.

[^no-proactive-prune]: Validating every entry before every menu open would
    need an async existence check — `MenuConfig.items` only supports a
    synchronous provider (`MenuItemConfig[] | (() => MenuItemConfig[])`),
    so real-time validation isn't available without a library change, the
    same kind of out-of-scope constraint `welcome-screen.md` hit for the
    tree's empty state. Removing an entry the moment its open fails was also
    considered: `openFile` would need to report success/failure back to its
    caller (today it returns `Promise<void>` regardless of outcome), coupling
    the menu's bookkeeping to a return-type change on a widely-called method
    for a small polish gain. Recording only successes already keeps *new*
    garbage out of the list; a stale entry left behind by a later deletion
    ages out on its own once ten newer projects or files replace it.

[^no-restore-record]: If restoring five tabs on every launch also bumped
    all five to the front of `recentFiles`, the "recent" list would mostly
    reflect "what happened to be open last time" rather than genuine new
    activity, and would never make room for a file opened once and never
    reopened. Keeping `restoreFiles` and `openFile` on separate paths (as
    `session-persistence.md` already does, for its own reason — the dialog
    on failure) means this falls out for free rather than needing a
    "don't record" flag threaded through restore.

[^cap-choice]: No existing constant in this codebase caps a list's length —
    `TAB_MAX_WIDTH`, `MAX_OPEN_BYTES`, and `SESSION_SAVE_DEBOUNCE_MS` all
    bound a size or a duration, not a count. Ten matches the length most
    editors keep an in-menu recent list at (VS Code's and Sublime Text's own
    defaults) without needing the submenu to scroll; one shared constant for
    both lists keeps the rule simple rather than tuning two numbers
    independently for a difference that doesn't matter here.

[^scoped-rebuild]: `welcome-screen.md`'s `[^mutate-not-rebuild]` footnote
    reasons that the sqladmin `StartPage` rebuild-on-change hazard "is worth
    taking on for a list-bearing page and pointless for two labels." The
    recent-projects section is exactly the list-bearing case that footnote
    anticipated, so it gets the `StartPage` treatment — scoped to its own
    child container rather than the whole page, since the heading and hint
    are still just two fixed labels that don't need re-disposing every time
    the recent-projects list changes.

---

## Implementation Notes

The worktree's `node_modules/@jimka/typescript-ui` again needed re-pointing
at the sibling `typescript-ui` checkout after `npm install`, for the same
reason `welcome-screen.md`'s own Implementation Notes already record
(`TabCloseController`/`Tab.setTabName`/`"beforetabclose"` predate the
published `0.8.0` package) — not a new finding, just confirming the same
dev-environment setup was needed again in this fresh worktree.

Adding `recentProjects`/`recentFiles` as required `SessionState` fields
broke `tests/workspaceState.test.ts`, which is not in this plan's own
"Files to Create/Modify/Delete" table: two of its `applyWorkspaceOverlay`
cases build a full `SessionState` object literal (rather than spreading
`emptySession()`) and assert on a full literal `toEqual` result, so both
needed the two new fields added once `SessionState` grew them. This is the
same "a change in a shared shape affects more than the call site that
surfaced the request" sweep `worker.md`'s Post-edit verification calls for;
`applyWorkspaceOverlay` itself needed no change, since its `...session`
spread already carries the two new fields through unchanged.

Manual verification ran against a real `npm run tauri:dev` process (Linux/
WSL2, DISPLAY forwarded to a Windows host via WSLg), screenshotted with
Pillow's `ImageGrab` and driven with `pyautogui`, matching
`welcome-screen.md`'s own approach. Confirmed by screenshot: cold start
with a pre-existing `session.json` (no `recentProjects`/`recentFiles`
fields, so both default to empty) showing no Recent Projects section on the
welcome screen; opening a tree file recording it into `recentFiles` and
surfacing it (with the correct glyph, no stray separator) in a newly-enabled
File > Open Recent submenu; closing that tab returning to the welcome
screen with Recent Projects still absent (recording a file never touches
the welcome screen's project list); opening a second and third project
folder through the native picker each recording into `recentProjects` and
populating the welcome screen's Recent Projects section, most-recent
first; clicking a welcome-screen Recent Projects button switching to that
project and moving it to the front of the list; File > Open Recent showing
both projects (most-recent first) then a separator then the recent file,
and clicking the file entry opening it correctly even while a *different*
project was the active tree root, confirming recent files are genuinely
project-independent; and clicking a recent-project entry from the File
menu itself (as opposed to the welcome screen's own button) switching
projects the same way. Not separately exercised: a recent project or file
whose path no longer exists, and the quit/relaunch persistence round trip
— both replay `session-persistence.md`'s own already-verified
`readFileText`/`pickProjectFolder` failure paths and `session.json`
read/write, wired here through `recordRecentFile`/`recordRecentProject`
rather than exercising any new failure-handling code of this plan's own.
