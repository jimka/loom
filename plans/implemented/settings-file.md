---
depends-on: [format-on-save]
touches-shared: [src/EditorController.ts, src/data/workspace.ts, src/shell/EditorShell.ts, src/main.ts, README.md, TODO.md]
---

# Settings File — Implementation Plan

## Overview

Loom has no settings file today. Five values a user might reasonably want to
change are hardcoded: the format-on-save toggle, the tree's default
Show Hidden/Show Ignored state, the window title's template, and the tab
strip's per-tab width cap. This plan gives them a real home: a global JSON
file under Loom's existing config folder, and an optional per-project file
that overrides it, extending the same storage convention
[session-persistence.md](plans/implemented/session-persistence.md) and
[workspace-session-persistence.md](plans/implemented/workspace-session-persistence.md)
already built for session state.

Two new pure modules do the work: `src/data/settings.ts` (the settings
shape, its parser, and the merge rule — no Tauri imports, unit-tested) and
`src/shell/settings.ts` (the Tauri-backed load and lazy-create calls, mirroring
`src/shell/session.ts`). `src/data/workspace.ts` gains the raw file reads and
writes, next to the session file's own. `src/EditorController.ts`,
`src/explorer/FileTree.ts`'s existing setters, `src/shell/EditorShell.ts`, and
`src/main.ts` apply the resolved values; two new File-menu commands,
**Open Settings** and **Open Workspace Settings**, create each file on first
use and open it as an ordinary tab, since Loom's own editor is the natural
place to hand-edit its own settings.

This plan depends on
[format-on-save.md](plans/format-on-save.md), which is expected to have
already landed: it declares the module constant `FORMAT_ON_SAVE` in
`src/EditorController.ts`, directly below `SAVE_MESSAGE_DURATION_MS`, and that
constant is the specific thing step 6 below deletes and replaces with a
settings-backed field.

---

## Architecture Decisions

### A global file and a per-workspace file, both named `settings.json`, stored exactly where session state already is

The global file lives at `$CONFIG/loom/settings.json`, next to
`session.json` inside the same `CONFIG_DIR_NAME` folder
([src/data/workspace.ts:38-41](src/data/workspace.ts#L38)). The per-workspace
file lives at `<root>/.loom/settings.json`, next to `workspace.json` inside
the same `.loom` folder
([src/data/workspace.ts:44-47](src/data/workspace.ts#L44)). No new folder,
naming convention, or write-time bootstrapping is invented — both files reuse
the directory-creation and `.loom/.gitignore` marker `writeWorkspaceStateText`
already sets up.

### Each setting resolves independently: workspace beats global beats a hardcoded default

`resolveSettings(global, workspace)` merges field by field, so a workspace
file that overrides only `formatOnSave` still inherits every other field from
the global file (or the hardcoded default, if the global file doesn't set it
either). This is a deliberate departure from `WorkspaceState`'s own merge
rule, which replaces its five fields wholesale rather than field by
field.[^merge-divergence] An absent or unusable file at either layer
contributes nothing — the same "degrade silently, never throw" rule
`parseWorkspaceState` already applies.

| Setting | Hardcoded default | Global file | Workspace file | Effective |
|---|---|---|---|---|
| `formatOnSave` | `true` | absent | absent | `true` |
| `formatOnSave` | `true` | `false` | absent | `false` |
| `formatOnSave` | `true` | `false` | `true` | `true` |
| `showHiddenFiles` | `false` | `true` | absent | `true` |
| `titleBarTemplate` | `'{dirty}{name} — {app}'` | absent | `'{name}'` | `'{name}'` |

### `FORMAT_ON_SAVE` migrates to a field on `EditorController`, set by a new `applySettings` method

The module constant `FORMAT_ON_SAVE` ([format-on-save.md](plans/format-on-save.md),
`## Architecture Decisions`) is deleted. `formatBeforeSave`'s guard reads a
new private field, `_formatOnSave`, instead — set from `applySettings`, the
one method that pushes a resolved `Settings` snapshot into the controller.
`format-on-save.md` itself names this constant as the value a settings
migration must find and move ([format-on-save.md:43-48](plans/format-on-save.md#L43));
this is that migration.

### The title bar template covers only the file-active title; the empty-state title stays `APP_NAME`

`EditorController.syncActive` ([:618-636](src/EditorController.ts#L618),
subject to the line drift in [^line-drift]) builds two different strings: one
when a file is active (interpolating the file's name, a dirty marker, and
`APP_NAME`), and a literal `APP_NAME` when none is. Only the first is a
template in any real sense — the second has no per-file data to substitute,
so customizing it independently would be a second setting nobody asked
for.[^empty-title] The new `titleBarTemplate` setting, and `renderTitle`, the
pure function that expands it, apply only to the file-active string.

### The dirty marker is a placeholder slot, not itself configurable

`renderTitle`'s `{dirty}` placeholder always expands to the literal `'• '`
when the active file is dirty, `''` otherwise — the template controls where
that marker sits, not what it says. Making the marker text itself
configurable is a second, unrequested layer of customization on top of what
the backlog asked for.

### The tab width cap (`TAB_MAX_WIDTH`) is the one added setting

Beyond the three the backlog names, this plan also migrates
`TAB_MAX_WIDTH` ([src/EditorController.ts:20-21](src/EditorController.ts#L20)),
the tab strip's per-tab width cap in `"content"` mode. It is a genuine,
user-visible UI preference with no safety or correctness downside to
changing it, unlike every other module constant surveyed and left
alone.[^what-else]

### A minimal settings UI: two File-menu commands that create-then-open the file as a normal tab

`File > Open Settings` and `File > Open Workspace Settings` call
`ensureGlobalSettingsFile`/`ensureWorkspaceSettingsFile` (new, in
`src/shell/settings.ts`) to create the file with an empty override if it
doesn't exist yet, then hand its path to `EditorController.openFile`, the
same generic path-opening method tree clicks and Recent Files already
use.[^settings-ui] No settings panel, form, or validation is built — the file
is JSON, and Loom is a JSON-capable text editor.

### Settings are read once per cold start, and again on every project switch — no live reload

`main.ts`'s `start()` resolves settings once, before constructing
`EditorController`, exactly as it already resolves the session once before
restoring it. `EditorShell.openProjectRoot` — which already reloads
`.loom/workspace.json` fresh on every live `Open Folder…` switch
([workspace-session-persistence.md](plans/implemented/workspace-session-persistence.md),
`## Architecture Decisions`) — now also reloads and reapplies settings at the
same point, for free. Editing an open settings tab and saving it takes effect
the next time that resolution point is reached (a restart, or switching away
from and back to the project), matching the restart-to-apply behaviour
`FORMAT_ON_SAVE` already had as a hardcoded constant.[^no-watcher]

---

## Public API

### `src/data/settings.ts` (new — pure, no Tauri imports)

```typescript
/** The fully resolved settings the app runs with — always complete, never partial. */
export interface Settings {
    /** Whether saving reformats the document first, for a language with a registered formatter. */
    formatOnSave: boolean
    /** Whether the tree shows hidden (leading-dot) entries by default. */
    showHiddenFiles: boolean
    /** Whether the tree shows `.gitignore`-ignored entries by default. */
    showIgnoredFiles: boolean
    /** The window title template for when a file is active; see {@link renderTitle}. */
    titleBarTemplate: string
    /** The tab strip's per-tab width cap in `"content"` mode, in pixels. */
    tabMaxWidthPx: number
}

/** One settings file's contents: every field optional, `undefined` meaning "inherit from the next layer down." */
export interface SettingsOverride {
    version: 1
    formatOnSave?: boolean
    showHiddenFiles?: boolean
    showIgnoredFiles?: boolean
    titleBarTemplate?: string
    tabMaxWidthPx?: number
}

/** What every setting is when no file overrides it — today's exact hardcoded behaviour. */
export const DEFAULT_SETTINGS: Settings

/** A freshly-created settings file's contents: no field set, so everything inherits. */
export function emptySettingsOverride(): SettingsOverride

/** Parses a settings file's text, dropping any field of the wrong type; `null` when the document itself is unusable. */
export function parseSettingsOverride(text: string): SettingsOverride | null

/** Renders a settings override as the JSON text written to disk. */
export function serializeSettingsOverride(override: SettingsOverride): string

/** Merges the two override layers onto {@link DEFAULT_SETTINGS}, field by field, `workspace` winning over `global`. */
export function resolveSettings(global: SettingsOverride | null, workspace: SettingsOverride | null): Settings

/** Expands a title template's `{dirty}`/`{name}`/`{app}` placeholders. */
export function renderTitle(template: string, vars: { name: string; app: string; dirty: boolean }): string
```

### `src/data/workspace.ts` (modified)

```typescript
/** Reads the app-wide settings file's text, or `null` when it is absent or unreadable. */
export async function readSettingsText(): Promise<string | null>

/** Writes `text` to the app-wide settings file, creating its directory if needed. */
export async function writeSettingsText(text: string): Promise<void>

/** The app-wide settings file's absolute path. */
export async function globalSettingsPath(): Promise<string>

/** Reads `root`'s own settings file's text, or `null` when it (or its `.loom` folder) is absent or unreadable. */
export async function readWorkspaceSettingsText(root: string): Promise<string | null>

/** Writes `text` to `root`'s own settings file, creating its `.loom` folder if needed. */
export async function writeWorkspaceSettingsText(root: string, text: string): Promise<void>

/** `root`'s own settings file's absolute path — no I/O, pure path arithmetic. */
export function workspaceSettingsPath(root: string): string
```

### `src/shell/settings.ts` (new)

```typescript
/** Loads the effective settings: the global file layered under `root`'s own file, when `root` isn't `null`. */
export async function loadResolvedSettings(root: string | null): Promise<Settings>

/** The app-wide settings file's path, creating it with an empty override first if it doesn't exist yet. */
export async function ensureGlobalSettingsFile(): Promise<string>

/** `root`'s own settings file's path, creating it with an empty override first if it doesn't exist yet. */
export async function ensureWorkspaceSettingsFile(root: string): Promise<string>
```

### `src/EditorController.ts` (modified)

`FORMAT_ON_SAVE` and `TAB_MAX_WIDTH` are deleted. New private fields and
methods:

```typescript
class EditorController {
    private _formatOnSave: boolean = DEFAULT_SETTINGS.formatOnSave
    private _titleBarTemplate: string = DEFAULT_SETTINGS.titleBarTemplate

    /** Applies a resolved settings snapshot: format-on-save, the title template, and the tab width cap. Callable more than once — again on every project switch. */
    applySettings(settings: Settings): void

    /** Opens the app-wide settings file, creating it first if needed. */
    async openGlobalSettings(): Promise<void>

    /** Opens `root`'s own settings file, creating it first if needed. */
    async openWorkspaceSettings(root: string): Promise<void>

    // Unchanged signatures: constructor(), formatBeforeSave, savedMessage, save, saveAs, formatActive, openFile.
}
```

### `src/shell/EditorShell.ts` (modified)

```typescript
constructor(controller: EditorController, session: SessionState, settings: Settings)
```

`MenuBarActions` gains:

```typescript
interface MenuBarActions {
    onOpenSettings: () => void
    onOpenWorkspaceSettings: () => void
    hasProjectRoot: () => boolean
}
```

### Full call-site routing

| Setting | Backing field / owner | Applied by | Config field |
|---|---|---|---|
| `formatOnSave` | `EditorController._formatOnSave` | `applySettings` | `Settings.formatOnSave` / `SettingsOverride.formatOnSave` |
| `titleBarTemplate` | `EditorController._titleBarTemplate` | `applySettings` | `Settings.titleBarTemplate` / `SettingsOverride.titleBarTemplate` |
| `tabMaxWidthPx` | `EditorController.tabs.getTab()` (library-owned) | `applySettings`, via `.setMaxWidth(px)` | `Settings.tabMaxWidthPx` / `SettingsOverride.tabMaxWidthPx` |
| `showHiddenFiles` | `FileTree._showHidden` | `EditorShell`, via the existing `FileTree.setShowHidden` | `Settings.showHiddenFiles` / `SettingsOverride.showHiddenFiles` |
| `showIgnoredFiles` | `FileTree._showIgnored` | `EditorShell`, via the existing `FileTree.setShowIgnored` | `Settings.showIgnoredFiles` / `SettingsOverride.showIgnoredFiles` |

`FileTree` gains no new public API — `setShowHidden`/`setShowIgnored`
already exist for the View menu's checkboxes
([src/explorer/FileTree.ts:147,163](src/explorer/FileTree.ts#L147)) and are
reused as-is.

---

## Internal Structure

### `src/data/settings.ts`

```typescript
export const DEFAULT_SETTINGS: Settings = {
    formatOnSave: true,
    showHiddenFiles: false,
    showIgnoredFiles: false,
    titleBarTemplate: '{dirty}{name} — {app}',
    tabMaxWidthPx: 200,
}

export function emptySettingsOverride(): SettingsOverride {
    return { version: 1 }
}

export function resolveSettings(global: SettingsOverride | null, workspace: SettingsOverride | null): Settings {
    return {
        formatOnSave: workspace?.formatOnSave ?? global?.formatOnSave ?? DEFAULT_SETTINGS.formatOnSave,
        showHiddenFiles: workspace?.showHiddenFiles ?? global?.showHiddenFiles ?? DEFAULT_SETTINGS.showHiddenFiles,
        showIgnoredFiles: workspace?.showIgnoredFiles ?? global?.showIgnoredFiles ?? DEFAULT_SETTINGS.showIgnoredFiles,
        titleBarTemplate: workspace?.titleBarTemplate ?? global?.titleBarTemplate ?? DEFAULT_SETTINGS.titleBarTemplate,
        tabMaxWidthPx: workspace?.tabMaxWidthPx ?? global?.tabMaxWidthPx ?? DEFAULT_SETTINGS.tabMaxWidthPx,
    }
}

/**
 * Expands `template`'s placeholders: `{dirty}` first (`'• '` when
 * `vars.dirty`, `''` otherwise), then `{app}`, then `{name}` last — in that
 * order, so a file literally named `{app}.ts` can't have its own name
 * re-substituted by an earlier replacement pass.
 */
export function renderTitle(template: string, vars: { name: string; app: string; dirty: boolean }): string {
    return template
        .replaceAll('{dirty}', vars.dirty ? '• ' : '')
        .replaceAll('{app}', vars.app)
        .replaceAll('{name}', vars.name)
}

function parseDocument(text: string): Record<string, unknown> | null {
    // Identical in shape to `parseWorkspaceState`'s own `parseDocument`
    // (src/data/workspaceState.ts): JSON.parse, reject non-object/array,
    // reject anything but `version: 1`.
}

function readOptionalBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined
}

function readOptionalNonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readOptionalPositiveNumber(value: unknown): number | undefined {
    return typeof value === 'number' && value > 0 ? value : undefined
}

export function parseSettingsOverride(text: string): SettingsOverride | null {
    const doc = parseDocument(text)

    if (doc === null) {
        return null
    }

    const override: SettingsOverride = { version: 1 }
    const formatOnSave = readOptionalBoolean(doc.formatOnSave)
    const showHiddenFiles = readOptionalBoolean(doc.showHiddenFiles)
    const showIgnoredFiles = readOptionalBoolean(doc.showIgnoredFiles)
    const titleBarTemplate = readOptionalNonEmptyString(doc.titleBarTemplate)
    const tabMaxWidthPx = readOptionalPositiveNumber(doc.tabMaxWidthPx)

    if (formatOnSave !== undefined) override.formatOnSave = formatOnSave
    if (showHiddenFiles !== undefined) override.showHiddenFiles = showHiddenFiles
    if (showIgnoredFiles !== undefined) override.showIgnoredFiles = showIgnoredFiles
    if (titleBarTemplate !== undefined) override.titleBarTemplate = titleBarTemplate
    if (tabMaxWidthPx !== undefined) override.tabMaxWidthPx = tabMaxWidthPx

    return override
}

export function serializeSettingsOverride(override: SettingsOverride): string {
    return JSON.stringify(override, null, 2)
}
```

### `src/data/workspace.ts` — the shared `.loom` directory helper

`writeWorkspaceStateText`'s existing mkdir-plus-`.gitignore` setup is
factored into a private helper both it and the new
`writeWorkspaceSettingsText` call, rather than duplicating it:

```typescript
async function ensureWorkspaceDir(root: string): Promise<string> {
    const dir = joinPath(root, WORKSPACE_DIR_NAME)

    await mkdir(dir, { recursive: true })

    const gitignorePath = joinPath(dir, '.gitignore')

    if (!(await exists(gitignorePath))) {
        await writeTextFile(gitignorePath, WORKSPACE_GITIGNORE_CONTENTS)
    }

    return dir
}

export async function writeWorkspaceStateText(root: string, text: string): Promise<void> {
    const dir = await ensureWorkspaceDir(root)

    return writeTextFile(joinPath(dir, WORKSPACE_STATE_FILE_NAME), text)
}

export async function writeWorkspaceSettingsText(root: string, text: string): Promise<void> {
    const dir = await ensureWorkspaceDir(root)

    return writeTextFile(joinPath(dir, WORKSPACE_SETTINGS_FILE_NAME), text)
}
```

New name constants, alongside the existing ones
([src/data/workspace.ts:40-47](src/data/workspace.ts#L40)):

```typescript
const SETTINGS_FILE_NAME = 'settings.json'
const WORKSPACE_SETTINGS_FILE_NAME = 'settings.json'
```

### `src/shell/settings.ts`

```typescript
export async function loadResolvedSettings(root: string | null): Promise<Settings> {
    const globalText = await readSettingsText()
    const global = globalText === null ? null : parseSettingsOverride(globalText)
    const workspaceText = root === null ? null : await readWorkspaceSettingsText(root)
    const workspace = workspaceText === null ? null : parseSettingsOverride(workspaceText)

    return resolveSettings(global, workspace)
}

export async function ensureGlobalSettingsFile(): Promise<string> {
    if ((await readSettingsText()) === null) {
        await writeSettingsText(serializeSettingsOverride(emptySettingsOverride()))
    }

    return globalSettingsPath()
}

export async function ensureWorkspaceSettingsFile(root: string): Promise<string> {
    if ((await readWorkspaceSettingsText(root)) === null) {
        await writeWorkspaceSettingsText(root, serializeSettingsOverride(emptySettingsOverride()))
    }

    return workspaceSettingsPath(root)
}
```

### `src/EditorController.ts`

```typescript
applySettings(settings: Settings): void {
    this._formatOnSave = settings.formatOnSave
    this._titleBarTemplate = settings.titleBarTemplate
    this.tabs.getTab().setMaxWidth(settings.tabMaxWidthPx)
    this.syncActive()
}

async openGlobalSettings(): Promise<void> {
    try {
        const path = await ensureGlobalSettingsFile()

        await this.openFile(path)
    } catch (error) {
        await Dialog.error('Could not open settings', messageOf(error))
    }
}

async openWorkspaceSettings(root: string): Promise<void> {
    try {
        const path = await ensureWorkspaceSettingsFile(root)

        await this.openFile(path)
    } catch (error) {
        await Dialog.error('Could not open settings', messageOf(error))
    }
}
```

`formatBeforeSave`'s guard changes from `!FORMAT_ON_SAVE` to
`!this._formatOnSave`. `syncActive`'s file-active branch changes from:

```typescript
const title = file.isDirty() ? `• ${name} — ${APP_NAME}` : `${name} — ${APP_NAME}`
```

to:

```typescript
const title = renderTitle(this._titleBarTemplate, { name, app: APP_NAME, dirty: file.isDirty() })
```

The constructor's `TabPanel` options change `maxWidth: TAB_MAX_WIDTH` to
`maxWidth: DEFAULT_SETTINGS.tabMaxWidthPx` — the construction-time value is
always overwritten by `applySettings` before the shell is ever painted (see
step 8), so this only has to match today's behaviour, not carry the final
resolved value.

---

## Ordered Implementation Steps

Steps 1-3 are the test-first cycle for the pure module. Steps 4-9 wire it
through the app; nothing between them breaks the typecheck.

1. **[tests/settings.test.ts](tests/settings.test.ts)** (new) — write every
   case from **Expected Behaviour** below. Run `npm test` — fails, since
   `src/data/settings.ts` doesn't exist yet.

2. **[src/data/settings.ts](src/data/settings.ts)** (new) — implement
   `Settings`, `SettingsOverride`, `DEFAULT_SETTINGS`, `emptySettingsOverride`,
   `parseSettingsOverride`, `serializeSettingsOverride`, `resolveSettings`,
   `renderTitle`, per **Public API** and **Internal Structure**.

3. Check: `npm test` — green, including every new case.

4. **[src/data/workspace.ts](src/data/workspace.ts)** — add
   `SETTINGS_FILE_NAME`/`WORKSPACE_SETTINGS_FILE_NAME` next to the existing
   name constants ([:40-47](src/data/workspace.ts#L40)); factor
   `ensureWorkspaceDir` out of `writeWorkspaceStateText`
   ([:214-226](src/data/workspace.ts#L214)) and call it from both that
   function and the new `writeWorkspaceSettingsText`; add
   `readSettingsText`/`writeSettingsText`/`globalSettingsPath` next to
   `readSessionText`/`writeSessionText` ([:168-188](src/data/workspace.ts#L168));
   add `readWorkspaceSettingsText`/`writeWorkspaceSettingsText`/
   `workspaceSettingsPath` next to `readWorkspaceStateText`/
   `writeWorkspaceStateText`. All per **Internal Structure**.

5. **[src/shell/settings.ts](src/shell/settings.ts)** (new) — implement
   `loadResolvedSettings`, `ensureGlobalSettingsFile`,
   `ensureWorkspaceSettingsFile`, per **Internal Structure**.

6. **[src/EditorController.ts](src/EditorController.ts)** — locate
   `FORMAT_ON_SAVE` with `grep -n FORMAT_ON_SAVE src/EditorController.ts` and
   delete its declaration and doc comment; delete `TAB_MAX_WIDTH` and its doc
   comment ([:20-21](src/EditorController.ts#L20), unaffected by
   format-on-save.md's own edits[^line-drift]). Add
   `import type { Settings } from './data/settings'` and
   `import { DEFAULT_SETTINGS, renderTitle } from './data/settings'`, and
   `import { ensureGlobalSettingsFile, ensureWorkspaceSettingsFile } from './shell/settings'`.
   Add the `_formatOnSave`/`_titleBarTemplate` fields. Change the
   constructor's `tabOptions.maxWidth` to `DEFAULT_SETTINGS.tabMaxWidthPx`.
   Add `applySettings`, `openGlobalSettings`, `openWorkspaceSettings` per
   **Internal Structure**. Change `formatBeforeSave`'s guard to
   `this._formatOnSave` (locate it the same way, by
   `grep -n formatBeforeSave src/EditorController.ts`). Change `syncActive`'s
   title line to the `renderTitle` call above.

7. Check: `npm run typecheck` — clean.
   `grep -n 'FORMAT_ON_SAVE\|TAB_MAX_WIDTH' src/EditorController.ts` — zero
   matches.

8. **[src/shell/EditorShell.ts](src/shell/EditorShell.ts)** — add
   `settings: Settings` as the constructor's third parameter, with
   `import type { Settings } from '../data/settings'`. No import of
   `ensureGlobalSettingsFile`/`ensureWorkspaceSettingsFile` is needed here —
   those are only called from inside `controller.openGlobalSettings`/
   `openWorkspaceSettings`. Right after
   `const tree = FileTree({...})` ([:73](src/shell/EditorShell.ts#L73)), add:

   ```typescript
   tree.setShowHidden(settings.showHiddenFiles)
   tree.setShowIgnored(settings.showIgnoredFiles)
   ```

   Add `onOpenSettings`, `onOpenWorkspaceSettings`, `hasProjectRoot` to the
   `MenuBarActions` interface ([:31-52](src/shell/EditorShell.ts#L31)) and to
   the constructor's `actions` object ([:90-109](src/shell/EditorShell.ts#L90)):

   ```typescript
   hasProjectRoot: () => tree.getProjectRoot() !== null,
   onOpenSettings: () => { void controller.openGlobalSettings() },
   onOpenWorkspaceSettings: () => {
       const root = tree.getProjectRoot()

       if (root !== null) {
           void controller.openWorkspaceSettings(root)
       }
   },
   ```

   In `buildMenuBar`'s File menu ([:301-319](src/shell/EditorShell.ts#L301)),
   between the existing separator and the `Exit` item, insert:

   ```typescript
   { text: 'Open Settings', glyph: 'gear', action: actions.onOpenSettings },
   { text: 'Open Workspace Settings', glyph: 'gear', enabled: actions.hasProjectRoot(), action: actions.onOpenWorkspaceSettings },
   { separator: true },
   ```

   (leaving the original separator in place before this block, so `Exit`
   keeps a separator on both sides of the new pair).

   In `openProjectRoot` ([:169-180](src/shell/EditorShell.ts#L169)), after the
   existing `if (workspace) { ... }` block and before
   `this._autosave?.schedule()`, add:

   ```typescript
   const resolved = await loadResolvedSettings(root)

   tree.setShowHidden(resolved.showHiddenFiles)
   tree.setShowIgnored(resolved.showIgnoredFiles)
   this._controller.applySettings(resolved)
   ```

   Add `import { loadResolvedSettings } from './settings'` to the existing
   `./session` import group.

9. **[src/main.ts](src/main.ts)** — import `gear` from
   `@jimka/typescript-ui/glyphs/solid/gear` and add it to the existing
   `Glyph.register(...)` call ([:24](src/main.ts#L24)). Import
   `loadResolvedSettings` from `./shell/settings`. In `start()`
   ([:33-46](src/main.ts#L33)), after `const session = applyWorkspaceOverlay(...)`
   and before `const controller = new EditorController()`, add:

   ```typescript
   const settings = await loadResolvedSettings(session.projectRoot)
   ```

   After `controller.seedRecents(...)`, add `controller.applySettings(settings)`.
   Change `EditorShell(controller, session)` to
   `EditorShell(controller, session, settings)`.

10. Checks:
    - `npm run typecheck` — clean.
    - `npm test` — green.
    - `grep -rn 'DEFAULT_SETTINGS' src/EditorController.ts` — three matches
      (the two field initializers and the constructor's `maxWidth`).
    - `grep -n 'gear' src/main.ts` — two matches (the import and the
      `Glyph.register` call).

11. Run `npm run typecheck && npm test && npm run build` — all clean.

12. **[README.md](README.md)** — after the **Format Document** bullet
    (`README.md:48`; its own second line is whatever text
    format-on-save.md's own README edit left there), add the new bullet from
    **Documentation Impact**.

13. **[TODO.md](TODO.md)** — delete the **Transition hard-coded settings to a
    settings file** entry from `## High`. Confirm its exact current span with
    `grep -n 'Transition hard-coded settings' TODO.md` first — it sits at
    `TODO.md:43-48` today but shifts up 3 lines once format-on-save.md's own
    deletion of its **Format-on-save** bullet (`TODO.md:23-25` today) lands.

14. Run the manual cases in **Verification**.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `src/data/settings.ts` |
| Create | `src/shell/settings.ts` |
| Create | `tests/settings.test.ts` |
| Modify | `src/data/workspace.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `src/main.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Unit-testable — `tests/settings.test.ts`

**`parseSettingsOverride`**

| Input | Result |
|---|---|
| `''` | `null` |
| `'not json'` | `null` |
| `'[]'` | `null` |
| `'null'` | `null` |
| `'{"version":2}'` | `null` |
| `'{"version":1}'` | `{ version: 1 }` |
| `'{"version":1,"formatOnSave":false}'` | `{ version: 1, formatOnSave: false }` |
| `'{"version":1,"formatOnSave":"nope"}'` | `{ version: 1 }` — wrong type dropped, not whole-document invalidated |
| `'{"version":1,"tabMaxWidthPx":-5}'` | `{ version: 1 }` — non-positive dropped |
| `'{"version":1,"tabMaxWidthPx":300}'` | `{ version: 1, tabMaxWidthPx: 300 }` |
| `'{"version":1,"titleBarTemplate":""}'` | `{ version: 1 }` — empty string dropped |
| `'{"version":1,"titleBarTemplate":"{name}"}'` | `{ version: 1, titleBarTemplate: '{name}' }` |

**`emptySettingsOverride`** returns `{ version: 1 }`.

**`serializeSettingsOverride`** round-trips: `parseSettingsOverride(serializeSettingsOverride(x))` equals `x` for `x = { version: 1, formatOnSave: true }`.

**`resolveSettings`**

| `global` | `workspace` | Result |
|---|---|---|
| `null` | `null` | deep-equals `DEFAULT_SETTINGS` |
| `{ version: 1, formatOnSave: false }` | `null` | `formatOnSave: false`, every other field at its `DEFAULT_SETTINGS` value |
| `{ version: 1, formatOnSave: false }` | `{ version: 1, formatOnSave: true }` | `formatOnSave: true` |
| `{ version: 1, showHiddenFiles: true }` | `{ version: 1, tabMaxWidthPx: 100 }` | `showHiddenFiles: true` (from `global`) and `tabMaxWidthPx: 100` (from `workspace`) together |

**`renderTitle`**

| `template` | `vars` | Result |
|---|---|---|
| `'{dirty}{name} — {app}'` | `{ name: 'app.ts', app: 'Loom', dirty: false }` | `'app.ts — Loom'` |
| `'{dirty}{name} — {app}'` | `{ name: 'app.ts', app: 'Loom', dirty: true }` | `'• app.ts — Loom'` |
| `'{name}'` | `{ name: 'x.ts', app: 'Loom', dirty: false }` | `'x.ts'` |
| `'{app}: {name}'` | `{ name: 'x.ts', app: 'Loom', dirty: true }` | `'Loom: x.ts'` — no `{dirty}` slot, so the marker never appears |
| `'no placeholders'` | any `vars` | `'no placeholders'` |

### Manual verification — `npm run tauri:dev`

1. **A fresh install behaves exactly as before.** With no
   `$CONFIG/loom/settings.json` and no `.loom/settings.json` anywhere: saving
   a `.ts` file still reformats it, the tree still hides dotfiles and ignored
   entries by default, the window title still reads `<name> — Loom` /
   `• <name> — Loom`, and tabs are still capped around 200px.
2. **Open Settings creates and opens the global file.** *File > Open
   Settings* with no file yet: `$CONFIG/loom/settings.json` is created
   containing `{"version":1}` and opens as a tab.
3. **A global override takes effect after a restart.** Edit that file to
   `{"version":1,"formatOnSave":false}`, save it, restart the app: saving a
   `.ts` file no longer reformats it.
4. **Open Workspace Settings is disabled with no project open**, and enabled
   once one is: on the welcome screen the item is greyed out; after *Open
   Folder…* it is clickable and creates `<root>/.loom/settings.json`.
5. **A workspace override beats the global one.** With the global file
   still `{"formatOnSave":false}` from case 3, set
   `{"version":1,"formatOnSave":true}` in one project's workspace file, close
   and reopen that same folder (*File > Open Folder…* on it again): saving a
   `.ts` file in that project reformats it again; a different project (or no
   project) still does not.
6. **Hidden/ignored defaults apply per workspace.** Set
   `{"version":1,"showHiddenFiles":true}` in a project's workspace file,
   reopen that folder: the tree shows dotfiles immediately, and the View
   menu's *Show Hidden Files* checkbox shows checked.
7. **The title template is user-visible.** Set
   `{"version":1,"titleBarTemplate":"{name} [{app}]"}` globally, restart,
   open a file: the window title reads `<name> [Loom]`, with no `• ` marker
   even when the file is dirty (the template has no `{dirty}` slot).
8. **The tab width cap is user-visible.** Set `{"version":1,"tabMaxWidthPx":100}`
   globally, restart, open several long-named files: tabs are visibly
   narrower than today's default.
9. **Malformed settings degrade silently.** Put a trailing comma or a
   wrong-typed field in either file: the app starts normally, using
   defaults/inherited values for the broken field, with no dialog or crash.

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — green, with every new `settings.test.ts` case.
- `npm run build` — clean.
- `grep -n 'FORMAT_ON_SAVE\|TAB_MAX_WIDTH' src/EditorController.ts` — zero
  matches.
- `grep -rn 'DEFAULT_SETTINGS' src/EditorController.ts` — three matches.
- `grep -rln 'settings.json' src/` — `src/data/workspace.ts` and
  `src/shell/settings.ts` only.
- Manual: `npm run tauri:dev`, then cases 1-9 above.

---

## Documentation Impact

- **[README.md:48](README.md#L48)** — add, after the **Format Document**
  bullet:

  ```markdown
  - **Settings** — an app-wide `settings.json` under Loom's config folder,
    and an optional per-project override at `<project>/.loom/settings.json`.
    *File > Open Settings* and *File > Open Workspace Settings* create and
    open each file directly. Covers whether saving reformats the document,
    the tree's default Show Hidden/Show Ignored state, the window title
    template, and the tab strip's width cap — see
    [`src/data/settings.ts`](src/data/settings.ts) for the full set and each
    one's default.
  ```

- **[TODO.md](TODO.md)** — delete the **Transition hard-coded settings to a
  settings file** entry from `## High` (step 13 above locates its current
  span).

---

## Potential Challenges

- **A project switch can trigger two tree reloads.** `setShowHidden` and
  `setShowIgnored` each reload the tree on their own
  ([src/explorer/FileTree.ts:147-166](src/explorer/FileTree.ts#L147)); when a
  workspace's resolved settings change both flags at once, `openProjectRoot`
  calls both setters and pays for two reloads instead of one. Mitigation:
  none needed — a project switch isn't a hot path, and both setters already
  exist for a reason unrelated to this plan (the View menu's independent
  toggles).
- **Editing an open settings tab doesn't apply until the next resolution
  point.** Saving the tab changes the file on disk but not the running
  app's in-memory `_formatOnSave`/`_titleBarTemplate`/tab width, since those
  were already read. Mitigation: this matches the restart-to-apply behaviour
  `FORMAT_ON_SAVE` already had as a hardcoded constant — nothing regresses.
- **A malformed field is dropped with no feedback.** A wrong-typed or
  out-of-range field (a string `tabMaxWidthPx`, a negative one) is silently
  ignored rather than surfaced. Mitigation: matches `parseWorkspaceState`'s
  existing degrade-silently philosophy; a future settings validator is
  separate work.

---

## Critical Files

- [src/data/workspace.ts](src/data/workspace.ts) — `CONFIG_DIR_NAME`,
  `SESSION_FILE_NAME`, `WORKSPACE_DIR_NAME`, `WORKSPACE_STATE_FILE_NAME`
  ([:38-50](src/data/workspace.ts#L38)) and
  `readSessionText`/`writeSessionText`/`readWorkspaceStateText`/
  `writeWorkspaceStateText` ([:168-226](src/data/workspace.ts#L168)) — **the
  precedent every new read/write function in this plan mirrors exactly.**
- [src/data/session.ts](src/data/session.ts) and
  [src/data/workspaceState.ts](src/data/workspaceState.ts) — the pure
  shape/parser precedent `src/data/settings.ts` mirrors, and the
  wholesale-replace merge rule this plan deliberately departs from (see
  `## Architecture Decisions`).
- [src/shell/session.ts](src/shell/session.ts) — the Tauri-orchestration
  precedent `src/shell/settings.ts` mirrors.
- [plans/implemented/session-persistence.md](plans/implemented/session-persistence.md)
  and
  [plans/implemented/workspace-session-persistence.md](plans/implemented/workspace-session-persistence.md)
  — full reasoning behind the two-tier file convention this plan extends,
  including the `.vscode/settings.json`-vs-`.loom/` shareability discussion
  referenced in `## Non-Goals`.
- [plans/format-on-save.md](plans/format-on-save.md) — `FORMAT_ON_SAVE`'s
  origin, its own note pointing at this migration, and the restart-to-apply
  behaviour this plan preserves.
- [plans/implemented/tree-filtering.md](plans/implemented/tree-filtering.md)
  — `showHiddenFiles`/`showIgnoredFiles`'s existing shape: two independent
  flags on `FileTree`, read live by the View menu.
- [src/EditorController.ts](src/EditorController.ts),
  [src/shell/EditorShell.ts](src/shell/EditorShell.ts),
  [src/main.ts](src/main.ts) — every site this plan touches.

---

## Non-Goals

- **No live reload.** A settings file change applies at the next cold start
  or the next project switch, not while it's being edited. Building a file
  watcher is separate work with no signal of demand yet.
- **No settings panel, form, or schema validation.** The file is edited as
  JSON, in Loom itself; a malformed field is dropped silently, not flagged.
- **Workspace settings stay gitignored, like the rest of `.loom/`, not
  shared across a team by default** — unlike `.vscode/settings.json`.
  Carving out a gitignore exception for just `settings.json` risks the
  well-known negation-ordering pitfalls of `.gitignore` and wasn't asked
  for; deferred.
- **No keyboard shortcut for *Open Settings* / *Open Workspace Settings*.**
- **No rebindable keyboard shortcuts.** `shortcuts.ts`'s constants
  (`NEW_FILE_SHORTCUT` and friends) are a much larger feature — a binding
  registry and conflict detection — with no relation to the three settings
  named in the backlog.
- **No other module constant moves.** `MAX_RECENT_ENTRIES`,
  `SAVE_MESSAGE_DURATION_MS`, `MAX_OPEN_BYTES`,
  `PREVIEW_REFRESH_DEBOUNCE_MS`, and `SESSION_SAVE_DEBOUNCE_MS` were all
  surveyed and left alone; see [^what-else] for why.
- **No write-back from the View menu's live toggles.** Clicking *Show
  Hidden Files*/*Show Ignored Files* still only changes the running
  session, exactly as today — settings control the *default* the tree
  starts from, not what gets saved when a user flips a checkbox.
- **No versioning beyond `version: 1`.** A future incompatible schema
  change is separate work, matching `SessionState`/`WorkspaceState`'s own
  precedent.

---

## Notes

[^line-drift]: `format-on-save.md` inserts `FORMAT_ON_SAVE` and its doc
    comment between today's line 24 (`SAVE_MESSAGE_DURATION_MS`) and line 26
    (the `EditorController` class doc comment), and inserts
    `formatBeforeSave`/`savedMessage` between today's line 487
    (`saveDialogDefault`'s close) and `closeActive`. `TAB_MAX_WIDTH` (today's
    lines 20-21) sits above both insertions and keeps its line numbers.
    Everything from line 26 on shifts down by the first insertion's size, and
    everything from `closeActive` on shifts down again by the second's — so
    the constructor (today's lines 48-62) and `syncActive` (today's lines
    618-636) will both have moved by the time this plan runs, `syncActive` by
    more than the constructor. Every citation below to a location past line
    24 also gives a `grep` command that finds it by name instead — trust that
    over the raw number.

[^merge-divergence]: `WorkspaceState`'s `applyWorkspaceOverlay`
    ([src/data/workspaceState.ts:109-124](src/data/workspaceState.ts#L109))
    replaces `expandedDirs`/`openFiles`/`activeFile`/`paneSizes`/
    `collapsedPanes` together, as one unit, specifically because a
    workspace file that parses at all represents one coherent captured UI
    snapshot — "no override" and "override with an intentionally empty
    snapshot" are different outcomes that a partial merge couldn't tell
    apart (`workspace-session-persistence.md`, `## Architecture Decisions`,
    "An absent or unusable workspace file..."). Settings have no such
    snapshot character: `formatOnSave` and `tabMaxWidthPx` are independent
    named preferences a user would expect to override one at a time, the
    way `.vscode/settings.json` lets a project override just `editor.tabSize`
    without restating every other VS Code setting. Field-by-field merge is
    the correct semantics for that case, even though it's a different rule
    from `WorkspaceState`'s own.

[^empty-title]: The empty-state title is one literal call,
    `setWindowTitle(APP_NAME)`, with no file, name, or dirty flag in scope
    to interpolate — templating it would mean adding a second setting whose
    only possible content is `APP_NAME` itself, dressed up in a template
    nobody asked to customize. The backlog's own wording ("the window title
    bar template") points at the two-branch dirty/clean construction, which
    is where real per-file information appears.

[^what-else]: Every module-scope constant in `src/` was surveyed
    (`grep -rn '^const [A-Z_]* *=\|^export const [A-Z_]* *='  src/`).  Beyond
    the three the backlog names, only `TAB_MAX_WIDTH` qualifies as a
    user-visible behavioural preference with no downside to exposing it.
    The rest were left alone, each for a specific reason: `MAX_RECENT_ENTRIES`
    ([src/data/session.ts:36](src/data/session.ts#L36)) interacts with
    already-serialized `recentProjects`/`recentFiles` arrays — shrinking it
    would need truncation logic this plan doesn't otherwise need.
    `SAVE_MESSAGE_DURATION_MS` is a cosmetic status-bar timing with no
    signal of user demand. `MAX_OPEN_BYTES`
    ([src/data/workspace.ts:28](src/data/workspace.ts#L28)) is a safety rail
    against freezing the editor on an oversized file — exposing it invites
    disabling that protection with no warning UI to accompany it.
    `PREVIEW_REFRESH_DEBOUNCE_MS` and `SESSION_SAVE_DEBOUNCE_MS` are
    internal performance tuning, invisible to a user by design. Keyboard
    shortcuts (`shortcuts.ts`) are covered in `## Non-Goals` above, as a
    separate feature.

[^settings-ui]: An alternative considered and rejected: a dedicated
    settings panel or form. Loom has no such UI pattern anywhere today, the
    values in question are five scalars with no need for grouping or
    search, and Loom is already a general-purpose text editor — asking it
    to open its own JSON configuration as a file costs two menu items and
    two small "create if absent" functions, against building and
    maintaining a form UI with no reuse anywhere else in the app.

[^no-watcher]: A live file-watcher (Tauri's `plugin-fs` `watch`, or
    polling) was considered and rejected for this first cut: it would need
    to reconcile a change arriving while the same file is open, unsaved, in
    a Loom tab — exactly the kind of external-change handling
    `filesystem-watching.md`'s own tree-refresh problem is separate,
    not-yet-planned work for. Piggybacking settings resolution onto the
    project-switch point `EditorShell.openProjectRoot` already has costs
    nothing new to build and gives almost the same result for the common
    case of tuning a per-project setting.

---

## Implementation Notes

- **A real deviation from the plan's own claim that `FileTree` gains no new
  public API.** `## Architecture Decisions`'s "Full call-site routing" table
  states `setShowHidden`/`setShowIgnored` are "reused as-is," and
  `src/explorer/FileTree.ts` is absent from the frontmatter's
  `touches-shared` list. The audit loop's third and fourth rounds found
  this doesn't hold: `EditorShell.openProjectRoot` calls those two setters
  and then awaits `expandPaths` to restore saved tree expansion, but the
  setters were `void`-returning and fired their own reload
  (`FileTree.reload()` → `Tree.setNodes()`, which collapses all expansion)
  without exposing it to the caller. Round 3's first fix — reordering the
  calls so the setters ran before `expandPaths` — only *narrowed* the
  window instead of closing it, since the reload was still an unawaited,
  in-flight promise racing the subsequent `await`ed `expandPaths()`; a
  workspace with two or more nested expanded directories (each level in
  `expandPaths` awaiting its own `listChildren` round trip) could plausibly
  let the late-resolving reload land after `expandPaths` finished and
  collapse the tree right back — the exact regression this plan was meant
  not to introduce, against `workspace-session-persistence.md`'s
  expansion-restore guarantee. The real fix changes
  `FileTree.setShowHidden`/`setShowIgnored` from `void` to `async ...:
  Promise<void>`, `await`ing `reload()` internally instead of firing it
  loose — mirroring `FileTree.setProjectRoot`'s own already-awaitable
  reload, the established shape for "a setter that reloads" in this file.
  `EditorShell.openProjectRoot` now `await`s both calls before touching
  workspace state or expansion; its other two call sites (the constructor's
  initial seed, and the View menu's toggle handlers) wrap the call in
  `void`, matching this codebase's existing convention for an
  intentionally-unawaited async call (`void controller.saveActive()` and
  its many siblings in `EditorShell.ts`). Verified live against the exact
  failure shape: two independent three-level-deep expanded directory chains
  plus a workspace `showHiddenFiles: true` override (forcing a genuine
  settings-driven reload on every reopen, not a same-value no-op), reopened
  three times in a row under an isolated Xvfb display — full expansion and
  the hidden-file listing both survived every time.
- **`node_modules/@jimka/typescript-ui` needed re-pointing at the sibling
  checkout.** This worktree's `npm install` pulled the published `0.8.0`
  package from the registry rather than the local
  `../typescript-ui/packages/lib` checkout the other worktrees symlink to.
  The published version happened to carry every symbol this plan touches
  (`gear`, `setMaxWidth`), so typecheck would have passed either way here,
  but the symlink was restored anyway
  (`ln -s /home/jika/typescript/typescript-ui/packages/lib
  node_modules/@jimka/typescript-ui`) to match the rest of the batch's
  environment and avoid silently drifting from the in-development library —
  the same recurring dev-environment gap `format-on-save.md`'s own
  Implementation Notes already recorded.
- **The plan's own step-10 grep count undercounts by one.** `grep -rn
  'DEFAULT_SETTINGS' src/EditorController.ts` returns four matches, not the
  three the plan predicts, because the import line
  (`import { DEFAULT_SETTINGS, renderTitle } from './data/settings'`) is
  itself a match the plan's count didn't anticipate. The underlying
  invariant — the two field initializers and the constructor's `maxWidth`
  all read `DEFAULT_SETTINGS` — holds; only the literal grep count is off,
  the same kind of pre-existing wording imprecision `format-on-save.md`'s
  own notes recorded for its analogous check.
- **Manual verification (all nine `## Expected Behaviour` cases) was
  executed live, against an isolated display, not the user's desktop.**
  Following the precedent set by `format-on-save.md` and
  `command-palette.md`, an ephemeral `debian:bookworm-slim` Docker container
  (the user's own Docker daemon, no `sudo`) ran `Xvfb :99 -listen tcp -ac`
  plus `xdotool`/`imagemagick`, TCP-port-mapped to `127.0.0.1:6099`; the
  real `npm run tauri:dev` ran on the host (its own Rust/WebKitGTK
  toolchain, `CARGO_TARGET_DIR` pointed at the main tree's existing
  `src-tauri/target` so the unchanged Rust side rebuilt in seconds) with
  `DISPLAY=127.0.0.1:99`, `GDK_BACKEND=x11`, and fresh
  `XDG_CONFIG_HOME`/`XDG_DATA_HOME` scratch directories, so the real
  `~/.config/loom/session.json` was never touched (confirmed by its
  unchanged mtime before and after). A scratch project folder
  (`~/loom-settings-file-verify`, required by the fs plugin's `$HOME/**`
  scope) held a messy, unformatted `.ts` file and a hidden dotfile/folder.
  `xdotool` drove clicks, keys, and text entry; `import` (ImageMagick)
  captured screenshots; both ran via `docker exec` into the same container.

  All nine cases were confirmed across three app launches (a cold start,
  then two restarts): case 1 (fresh install — Welcome screen, title
  literally `Loom`); case 2 (*Open Settings* created
  `$CONFIG/loom/settings.json` with `{"version":1}` and opened it as a tab);
  case 3 (after a restart with a global `formatOnSave:false`, saving the
  messy `.ts` file left it byte-for-byte unformatted); case 4 (*Open
  Workspace Settings* greyed out on the welcome screen, enabled and creating
  `.loom/settings.json` once a folder was open); case 5 (setting the
  workspace file's own `formatOnSave:true` and reopening the same folder
  made the next save reformat the file again, overriding the global
  `false`); case 6 (the workspace's `showHiddenFiles:true` showed the
  `.loom` folder and the hidden dotfile immediately after reopening, with
  the View menu's *Show Hidden Files* checkbox reflecting checked); case 7
  (a global `titleBarTemplate:"{name} [{app}]"` changed the window title to
  exactly that, confirmed via `xdotool getwindowname`); case 8 (a global
  `tabMaxWidthPx:100` visibly truncated tab labels that fit fully at the
  200px default); and case 9 (a trailing-comma-corrupted global file — the
  whole document, not just one field, degrading to unusable JSON — started
  the app normally with no dialog or crash, falling back to the default
  title template and tab width while the still-valid workspace file's own
  `formatOnSave`/`showHiddenFiles` kept applying independently). The
  container, scratch project folder, and scratch `XDG_*`/screenshot
  directories were all removed afterward.
