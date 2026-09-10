---
touches-shared: [src/main.ts, src/data/settings.ts, src/shell/settings.ts, src/shell/EditorShell.ts, src/shell/commands.ts, src/explorer/FileTree.ts, src/explorer/SearchPanel.ts, tests/settings.test.ts, tests/commands.test.ts, README.md, TODO.md]
---

# App-Level Theme Switching (Light/Dark) — Implementation Plan

## Overview

Loom never calls `ThemeManager`, so it runs on whatever theme the library
installs for itself: `Body`'s constructor calls
`ThemeManager.setTheme(ModernTheme)`, the flat light default. The library
already ships `DarkTheme`, and switching is a single call that rewrites the
CSS custom properties on `:root` — every live component, each `CodeEditor`'s
syntax colours included, recolours with no rebuild.[^library-does-the-work]

This plan adds a `theme` field to Loom's existing two-layer settings
(`'light'` or `'dark'`, default `'light'`), applies it at startup in
[src/main.ts:58](src/main.ts#L58) and on every project switch in
[src/shell/EditorShell.ts:434](src/shell/EditorShell.ts#L434), and puts a
**Dark Theme** checkbox row in the View menu beside the existing *Show Hidden
Files* / *Show Ignored Files* rows
([src/shell/EditorShell.ts:660](src/shell/EditorShell.ts#L660)), with a
matching command-palette entry. Flipping that row writes the choice back into
the app-wide settings file, so it survives a restart.

One new module, `src/shell/theme.ts`, owns the seam: the name-to-library-theme
map, the `ThemeManager` calls, and the read-back of the live theme. Two
hardcoded light-grey surfaces in the sidebar
([src/explorer/FileTree.ts:79](src/explorer/FileTree.ts#L79),
[src/explorer/SearchPanel.ts:129](src/explorer/SearchPanel.ts#L129)) become
theme tokens in the same change — left as literals they would paint a
light-grey slab over the dark UI.

---

## Architecture Decisions

### `theme` is an ordinary two-layer setting

`theme` joins `Settings` and `SettingsOverride` in
[src/data/settings.ts:8](src/data/settings.ts#L8), parsed with the existing
`readOptionalChoice` helper
([src/data/settings.ts:229](src/data/settings.ts#L229)) and resolved
workspace-over-global-over-default exactly like `showHiddenFiles`.[^settings-home]

| global `theme` | workspace `theme` | Live theme | Why |
| --- | --- | --- | --- |
| *(absent)* | *(absent)* | light | `DEFAULT_SETTINGS.theme` |
| `"dark"` | *(absent)* | dark | the global layer applies |
| `"dark"` | `"light"` | light | the workspace layer wins |
| `"Dark"` | *(absent)* | light | not a listed choice, so the field is dropped |

### The View-menu toggle writes the choice to the global settings file

`selectTheme` applies the theme and then records it in the app-wide
`settings.json`, merging the one field into whatever the file already holds.
The per-project file is never written.[^write-back]

### Theme application lives in a new `src/shell/theme.ts`

`applyTheme`, `currentThemeName`, and `selectTheme` go in a new module rather
than into `EditorController.applySettings`
([src/EditorController.ts:807](src/EditorController.ts#L807)), which owns tabs,
the status bar, and formatting — not app-wide chrome.[^new-module]

### The live theme is read back from `ThemeManager`, not mirrored in Loom

`currentThemeName()` returns `ThemeManager.getTheme().colorScheme === 'dark' ?
'dark' : 'light'`. The View menu's `checked` state and the palette command's
title both read it on open, the way *Show Hidden Files* reads
`tree.isShowingHidden()`.[^no-mirror]

### Loom's two hardcoded sidebar greys become theme tokens

Both sidebar views hardcode `rgb(245, 245, 245)`, which is exactly
`ModernTheme`'s `toolBar.background`. Each becomes
`var(--ts-ui-toolbar-bg, rgb(245, 245, 245))` — the same token the sidebar's
icon rail, a real `ToolBar`, already paints
([src/shell/EditorShell.ts:207](src/shell/EditorShell.ts#L207)).[^token-choice]

| Surface | Today | Becomes | Light | Dark |
| --- | --- | --- | --- | --- |
| File tree ([src/explorer/FileTree.ts:79](src/explorer/FileTree.ts#L79)) | `rgb(245, 245, 245)` | `var(--ts-ui-toolbar-bg, rgb(245, 245, 245))` | `rgb(245, 245, 245)` | `rgb(45, 45, 45)` |
| Search panel ([src/explorer/SearchPanel.ts:129](src/explorer/SearchPanel.ts#L129)) | `rgb(245, 245, 245)` | `var(--ts-ui-toolbar-bg, rgb(245, 245, 245))` | `rgb(245, 245, 245)` | `rgb(45, 45, 45)` |

The breadcrumb band
([src/editor/FileBreadcrumbs.ts:28](src/editor/FileBreadcrumbs.ts#L28)), the
welcome card ([src/shell/WelcomeScreen.ts:85](src/shell/WelcomeScreen.ts#L85)),
and the search panel's border
([src/explorer/SearchPanel.ts:130](src/explorer/SearchPanel.ts#L130)) already
read tokens and need no change.

### Two choices, not three

`ClassicTheme` is left out. Storing the choice as a string checked against a
fixed list — rather than as a boolean — leaves room to add `'classic'` later
without a schema change.[^two-choices]

---

## Public API

New in `src/data/settings.ts`:

```ts
/** The app's theme choices: `'light'` is the library's own default look. */
export type ThemeName = 'light' | 'dark'

/** The settings-file text with `theme` set, every other field left as it was. */
export function withTheme(text: string | null, theme: ThemeName): string
```

`Settings` gains `theme: ThemeName`; `SettingsOverride` gains
`theme?: ThemeName`; `DEFAULT_SETTINGS` gains `theme: 'light'`.

New in `src/shell/settings.ts`:

```ts
/** Records `theme` in the app-wide settings file, creating it if absent. */
export function saveGlobalTheme(theme: ThemeName): Promise<void>
```

New module `src/shell/theme.ts`:

```ts
/** Applies `theme` to the whole UI through `ThemeManager.setTheme`. */
export function applyTheme(theme: ThemeName): void

/** Which theme is live right now, read back from `ThemeManager`. */
export function currentThemeName(): ThemeName

/** Applies `theme` and records it in the app-wide settings file. */
export function selectTheme(theme: ThemeName): Promise<void>
```

`MenuBarActions` ([src/shell/EditorShell.ts:85](src/shell/EditorShell.ts#L85))
and `PaletteCommandActions`
([src/shell/commands.ts:36](src/shell/commands.ts#L36)) each gain:

```ts
    /** Whether the dark theme is live — read live each time the menu or the palette opens. */
    isDarkTheme: () => boolean
    /** Switches theme and records the choice in the app-wide settings file. */
    onToggleDarkTheme: (value: boolean) => void
```

---

## Internal Structure

`withTheme` merges onto the file's **raw** parsed object, not onto
`parseSettingsOverride`'s sanitized result, so a field the parser doesn't
recognise or rejects survives the write instead of being silently deleted.
Merging onto the raw object needs the JSON-object parse split out of the
existing private `parseDocument`
([src/data/settings.ts:158](src/data/settings.ts#L158)), which keeps its
`version` check and calls the extracted helper:

```ts
export function withTheme(text: string | null, theme: ThemeName): string {
    const doc = text === null ? null : parseJsonObject(text)

    // `version: 1` after the spread: a file carrying some other version keeps
    // every field it had and starts being read again. Indented to 2 spaces to
    // match `serializeSettingsOverride`.
    return JSON.stringify({ ...(doc ?? {}), version: 1, theme }, null, 2)
}
```

`src/shell/theme.ts`:

```ts
/** Each `theme` value's library theme. `ModernTheme` is the library's own default. */
const THEMES: Record<ThemeName, Theme> = {
    light: ModernTheme,
    dark: DarkTheme,
}

export async function selectTheme(theme: ThemeName): Promise<void> {
    applyTheme(theme)

    try {
        await saveGlobalTheme(theme)
    } catch (error) {
        await Dialog.error('Could not save the theme', messageOf(error))
    }
}
```

The theme is applied before the write is attempted, so a failed write leaves
the UI switched and reports only that the choice was not remembered — the same
`Dialog.error` treatment `EditorController.openGlobalSettings`
([src/EditorController.ts:816](src/EditorController.ts#L816)) gives a settings
file it cannot touch.

---

## Ordered Implementation Steps

1. **`src/data/settings.ts` — declare the field.** Add `export type ThemeName
   = 'light' | 'dark'` and `const THEME_CHOICES = ['light', 'dark'] as const`
   beside the other choice lists
   ([src/data/settings.ts:233](src/data/settings.ts#L233)). Add `theme:
   ThemeName` to `Settings`, `theme?: ThemeName` to `SettingsOverride`, and
   `theme: 'light'` to `DEFAULT_SETTINGS` with a comment saying it is the
   library's own default, so a fresh install looks exactly as it does today.
2. **`src/data/settings.ts` — parse and resolve it.** In
   `parseSettingsOverride`, read `const theme = readOptionalChoice(doc.theme,
   THEME_CHOICES)` and assign it under the same `!== undefined` guard the
   other fields use. In `resolveSettings`, add `theme: workspace?.theme ??
   global?.theme ?? DEFAULT_SETTINGS.theme`.
3. **`src/data/settings.ts` — add `withTheme`.** Extract the JSON-parse and
   object check out of `parseDocument` into a private `parseJsonObject(text:
   string): Record<string, unknown> | null`; leave `parseDocument`'s `version
   !== 1` check where it is, now calling `parseJsonObject`. Add the exported
   `withTheme` from `## Internal Structure`.
   Check: `npm test -- settings` still passes every existing case.
4. **`src/shell/settings.ts` — add `saveGlobalTheme`.** Import `withTheme` and
   `ThemeName` from `../data/settings` and `writeSettingsText` from
   `../data/workspace` (`readSettingsText` is already imported), then add
   `saveGlobalTheme` as given in `## Public API`, implemented as
   `await writeSettingsText(withTheme(await readSettingsText(), theme))`.
5. **Create `src/shell/theme.ts`.** Module comment, the `THEMES` map,
   `applyTheme`, `currentThemeName`, and `selectTheme` exactly as in
   `## Internal Structure`. Imports: `ThemeManager, ModernTheme, DarkTheme` and
   `type Theme` from `@jimka/typescript-ui/core`, `Dialog` from
   `@jimka/typescript-ui/overlay`, `type ThemeName` from `../data/settings`,
   `saveGlobalTheme` from `./settings`, `messageOf` from `../errors`.
6. **`src/main.ts` — apply at startup.** Import `applyTheme` from
   `./shell/theme` and call `applyTheme(settings.theme)` immediately after
   `const settings = await loadResolvedSettings(...)`
   ([src/main.ts:58](src/main.ts#L58)) — before `new EditorController()`, and
   therefore before the shell reaches the page. It must stay after the
   top-level `Body.init` call ([src/main.ts:37](src/main.ts#L37)), because
   `Body`'s constructor sets `ModernTheme` itself and would overwrite an
   earlier call.
7. **`src/shell/EditorShell.ts` — declare the two actions.** Add `isDarkTheme`
   and `onToggleDarkTheme` to `MenuBarActions` with the doc comments from
   `## Public API`, directly after `onToggleIgnored`
   ([src/shell/EditorShell.ts:105](src/shell/EditorShell.ts#L105)).
8. **`src/shell/EditorShell.ts` — wire them.** Import `applyTheme,
   currentThemeName, selectTheme` from `./theme`. In the `actions` object
   ([src/shell/EditorShell.ts:290](src/shell/EditorShell.ts#L290)), after
   `onToggleIgnored`, add:

   ```ts
            isDarkTheme: () => currentThemeName() === 'dark',
            onToggleDarkTheme: (value: boolean) => { void selectTheme(value ? 'dark' : 'light') },
   ```
9. **`src/shell/EditorShell.ts` — add the View-menu row.** After the *Show
   Ignored Files* row ([src/shell/EditorShell.ts:673](src/shell/EditorShell.ts#L673)),
   add `{ separator: true }` and a third `row:` entry built the same way:
   `CheckboxMenuRow({ text: 'Dark Theme', checked: actions.isDarkTheme() })`,
   with `row.on('action', () => { actions.onToggleDarkTheme(row.isChecked()) })`.
10. **`src/shell/EditorShell.ts` — reapply on a project switch.** In
    `openProjectRoot`, add `applyTheme(resolved.theme)` immediately after
    `this._controller.applySettings(resolved)`
    ([src/shell/EditorShell.ts:438](src/shell/EditorShell.ts#L438)), and name
    the theme in that method's doc comment where it lists what reloaded
    settings reapply.
11. **`src/shell/commands.ts` — add the palette command.** Add `isDarkTheme`
    and `onToggleDarkTheme` to `PaletteCommandActions`, then push a
    `toggle-dark-theme` entry directly after `toggle-ignored-files`
    ([src/shell/commands.ts:89](src/shell/commands.ts#L89)):

    ```ts
        {
            id: 'toggle-dark-theme',
            title: actions.isDarkTheme() ? 'Switch to Light Theme' : 'Switch to Dark Theme',
            enabled: true,
            run: () => actions.onToggleDarkTheme(!actions.isDarkTheme()),
        },
    ```
12. **`src/explorer/FileTree.ts` — token, not literal.** Replace
    `backgroundColor: 'rgb(245, 245, 245)'`
    ([src/explorer/FileTree.ts:79](src/explorer/FileTree.ts#L79)) with
    `backgroundColor: 'var(--ts-ui-toolbar-bg, rgb(245, 245, 245))'`, and add a
    one-line comment saying the token is the rail's own surface so the tree
    follows a theme switch.
13. **`src/explorer/SearchPanel.ts` — same token.** Replace the identical
    literal ([src/explorer/SearchPanel.ts:129](src/explorer/SearchPanel.ts#L129))
    with the same `var(...)` string, and update the existing comment above it
    (which says "matches FileTree's own tree") to name the shared token.
    Check: `grep -rn "rgb(245, 245, 245)'" src/` — expect zero matches. The
    trailing quote in that pattern is what makes it find bare literals only,
    leaving every `var(…, rgb(245, 245, 245))` fallback alone.
14. **`tests/settings.test.ts` — cover the field.** Add `parseSettingsOverride`
    cases (takes `"dark"`, takes `"light"`, drops `"Dark"`, drops a non-string,
    drops an unlisted value), `resolveSettings` cases (defaults to `'light'`,
    takes a global-only value, lets the workspace layer win), and a
    `withTheme` block covering every case in `## Expected Behaviour`.
15. **`tests/commands.test.ts` — cover the command.** Add `isDarkTheme: () =>
    false` and `onToggleDarkTheme: () => {}` to the `actions` factory, add
    `'toggle-dark-theme'` to both id-order assertions (renaming those two
    tests from "eleven" to "twelve") and to the always-enabled id loop, and add
    a title test for both states.
    Check: `npm test` — all green.
16. **`README.md`.** Add a **Theme** bullet to *Highlights*, directly before
    the **Settings** bullet, describing the View-menu toggle, the palette
    command, and that the choice persists. Add the theme to the list of what
    the settings files cover in the **Settings** bullet itself.
17. **`TODO.md`.** Delete the *App-level theme switching (light/dark)* bullet
    from `## High`. Add a bullet to `## Known issues / loose ends` recording
    that the three grey hint labels
    ([src/explorer/SearchPanel.ts:29](src/explorer/SearchPanel.ts#L29),
    [src/explorer/PropertiesPanel.ts:20](src/explorer/PropertiesPanel.ts#L20),
    [src/shell/WelcomeScreen.ts:34](src/shell/WelcomeScreen.ts#L34)) stay
    hardcoded mid-grey because the library has no muted-text token, and that
    mid-grey clears 4.5:1 against both schemes' backgrounds.

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Create | `src/shell/theme.ts` |
| Modify | `src/data/settings.ts` |
| Modify | `src/shell/settings.ts` |
| Modify | `src/main.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `src/shell/commands.ts` |
| Modify | `src/explorer/FileTree.ts` |
| Modify | `src/explorer/SearchPanel.ts` |
| Modify | `tests/settings.test.ts` |
| Modify | `tests/commands.test.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

Unit-testable (vitest, `node` environment — no DOM):

- `parseSettingsOverride('{"version":1,"theme":"dark"}')` → `{ version: 1,
  theme: 'dark' }`; `"light"` likewise.
- `parseSettingsOverride('{"version":1,"theme":"Dark"}')` → `{ version: 1 }` —
  capitalisation must match, as with `keywordCase`.
- `parseSettingsOverride('{"version":1,"theme":"solarized"}')` and
  `'{"version":1,"theme":3}'` → `{ version: 1 }`.
- `resolveSettings(null, null).theme` → `'light'`.
- `resolveSettings({ version: 1, theme: 'dark' }, null).theme` → `'dark'`.
- `resolveSettings({ version: 1, theme: 'dark' }, { version: 1, theme: 'light'
  }).theme` → `'light'` — the workspace layer wins.
- `resolveSettings({ version: 1, theme: 'dark' }, { version: 1 }).theme` →
  `'dark'` — a bare workspace override inherits.
- `withTheme(null, 'dark')` → text parsing back to `{ version: 1, theme:
  'dark' }`.
- `withTheme('not json', 'dark')` and `withTheme('[]', 'dark')` → the same
  fresh `{ version: 1, theme: 'dark' }`.
- `withTheme('{"version":1,"formatOnSave":false}', 'dark')` → parses back to
  `{ version: 1, formatOnSave: false, theme: 'dark' }` — siblings survive.
- `withTheme('{"version":1,"theme":"dark"}', 'light')` → `theme` is replaced,
  not duplicated.
- `withTheme('{"version":1,"madeUpField":7}', 'dark')` → `JSON.parse` of the
  result still has `madeUpField: 7`, even though `parseSettingsOverride` drops
  it.
- `withTheme('{"version":2,"formatOnSave":false}', 'dark')` → parses back to
  `{ version: 1, formatOnSave: false, theme: 'dark' }`.
- `buildPaletteCommands` returns twelve commands with `'toggle-dark-theme'`
  directly after `'toggle-ignored-files'`, always `enabled: true`.
- That command's title is `'Switch to Dark Theme'` when `isDarkTheme()` is
  `false` and `'Switch to Light Theme'` when it is `true`.
- Its `run()` calls `onToggleDarkTheme(true)` when the light theme is live, and
  `onToggleDarkTheme(false)` when the dark one is.

Manual verification (`npm run tauri:dev` — UI, menus, and real file writes):

- With no `theme` in either settings file, the app launches looking exactly as
  it does today, and *View > Dark Theme* is unchecked.
- Ticking *View > Dark Theme* recolours the whole window in place: menu bar,
  sidebar surfaces, status bar, breadcrumb band, and the open file's editor
  chrome and syntax colours. No reload, no relayout glitch.
- Reopening the View menu shows the row ticked; the palette's entry now reads
  *Switch to Light Theme*.
- The app-wide `settings.json` now contains `"theme": "dark"` alongside
  whatever fields it already had, and a restart comes up dark.
- Unticking the row returns to light and writes `"theme": "light"`.
- With `"theme": "light"` in a project's `.loom/settings.json` and `"dark"`
  globally, opening that project switches to light; the global file still says
  `"dark"`, so a project outside it comes up dark again.
- Toggling the row while that project is open switches the live theme
  immediately, and switching projects re-resolves back to the project's own
  value.
- In the dark theme, the sidebar tree and Search panel read as dark surfaces
  matching the rail beside them, with no light-grey slab.
- Persistence-failure path (`npm run dev` in a browser, where the Tauri
  filesystem plugin is unavailable): the theme still switches, and a *Could not
  save the theme* dialog reports that the choice was not remembered.

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — all green, including the new `settings` and `commands` cases.
- `npm run tauri:dev` — walk the manual list above, starting on the welcome
  screen with no project open, then with a project open and a file in a tab.
- `grep -rn "rgb(245, 245, 245)'" src/` — expect zero matches.
- `grep -rn 'ThemeManager' src/` — expect matches only in
  `src/shell/theme.ts`; no other module may call it directly.

---

## Documentation Impact

Loom publishes no API docs, so the impact is the two project documents
`README.md` and `TODO.md`, per steps 16 and 17. `src/data/settings.ts` is the
file README's **Settings** bullet points readers at for "the full set and each
one's default", so the new field's JSDoc and its `DEFAULT_SETTINGS` comment are
part of the user-facing documentation.

---

## Potential Challenges

- **The library symlink is currently dangling.** `node_modules/@jimka/typescript-ui`
  points at a removed worktree, so `npm run typecheck` fails on every
  `@jimka/typescript-ui/*` import before any of this plan's code is written.
  Re-link or reinstall the library first, and confirm a clean typecheck on an
  untouched tree before starting.
- **A brief light flash at startup for dark users.** `Body.init` sets
  `ModernTheme` at module load, and the settings read is asynchronous. Applying
  the theme before the shell is added (step 6) keeps the flash to the empty
  body background rather than a painted light UI.
- **A project switch re-resolves the theme.** `openProjectRoot` re-reads both
  settings layers, so a runtime toggle that was never written to disk would not
  survive one. The write-back (steps 4, 5, and 8) is what makes the toggle
  stick; do not drop it.
- **The two "eleven commands" tests fail until renamed.** Step 15 changes both
  the count in the assertion arrays and the test names; changing only the array
  leaves a test whose name lies.

---

## Critical Files

- `node_modules/@jimka/typescript-ui/llms.txt` — the capability manifest; its
  hard rule 6 ("Theme through design tokens, never hardcoded colours") is what
  steps 12 and 13 enforce.
- `node_modules/@jimka/typescript-ui/docs/concepts/theming.md` — `setTheme`'s
  contract, the built-in theme names, the token table, and the theme-change
  listener rules.
- [src/data/settings.ts](src/data/settings.ts) — the shape, parser, merge rule,
  and the `readOptionalChoice` helper this field reuses; the precedent for
  every decision about where the setting lives.
- [src/shell/settings.ts](src/shell/settings.ts) — the Tauri-backed settings
  layer `saveGlobalTheme` joins.
- [src/shell/EditorShell.ts:655](src/shell/EditorShell.ts#L655) — the View
  menu, including the two `CheckboxMenuRow` toggles the new row copies.
- [src/shell/commands.ts:83](src/shell/commands.ts#L83) — the two dynamic-title
  palette toggles the new command copies.
- [src/editor/FileBreadcrumbs.ts:28](src/editor/FileBreadcrumbs.ts#L28) —
  Loom's existing `var(--ts-ui-…, fallback)` form, which steps 12 and 13 follow.
- [src/main.ts:37](src/main.ts#L37) — `Body.init`, and why the theme call has
  to come after it.

---

## Non-Goals

- **A third theme.** `ClassicTheme` is not offered; the choice-string schema
  leaves room for it without a migration.
- **Following the OS colour scheme.** No `prefers-color-scheme` listener and no
  `'system'` value — the setting is an explicit choice.
- **A keyboard shortcut.** The View menu and the palette are the two entry
  points, matching *Show Hidden Files*.
- **A settings UI.** Hand-editing the JSON file stays the way every other
  setting is changed; the theme simply also has a menu row.
- **Custom themes.** `defineTheme` and Loom-authored palettes are out of scope.
- **Retokenising the grey hint labels.** See `## Open Questions`.
- **Writing any other setting from code.** `withTheme` is deliberately specific
  to `theme`; a generic settings writer is not part of this change.

---

## Open Questions

Both are upstream-library questions a human should rule on before
implementation; the plan's body assumes the answer is "proceed as written".

1. **The library has no muted/secondary text token.** Loom paints three hint
   labels `rgb(140, 140, 140)`
   ([src/explorer/SearchPanel.ts:29](src/explorer/SearchPanel.ts#L29),
   [src/explorer/PropertiesPanel.ts:20](src/explorer/PropertiesPanel.ts#L20),
   [src/shell/WelcomeScreen.ts:34](src/shell/WelcomeScreen.ts#L34)). Nothing in
   the `Theme` interface expresses "de-emphasised text" — the nearest values are
   `button.description.foreground` (a button-specific token) and the various
   `disabledColor`s (semantically wrong for a hint). Mid-grey stays legible on
   both `rgb(255, 255, 255)` and `rgb(30, 30, 30)`, so this plan leaves the
   three literals alone and records them in `TODO.md`. The alternative is adding
   a `text.muted` token to the library first and retokenising all three here.
2. **The theming doc's token table is incomplete.** `--ts-ui-toolbar-bg`,
   `--ts-ui-statusbar-bg`, `--ts-ui-accordion-border`, and the whole `list`
   block are emitted by `Theme.ts` but absent from
   `docs/concepts/theming.md`'s table, so the token this plan picks was found by
   reading the library's source — the thing the manifest exists to avoid. Worth
   fixing upstream; it changes nothing in Loom.

---

## Notes

[^library-does-the-work]: `ThemeManager` is a static class holding the active
    theme, the resolved scale snapshot, and a listener list; it persists
    nothing and expects the host app to own that. `setTheme` writes every token
    as a CSS custom property on `:root`, sets `color-scheme`, `color`, and
    `background-color` on `<html>` and `<body>`, re-resolves the scale, and
    fires the listeners. Library components subscribe where they need more than
    the cascade gives them: `CodeEditor` reconfigures its CodeMirror theme
    compartment from `ThemeManager.getTheme().colorScheme`, `Markdown` re-renders,
    `Tab` and `Button` refresh their chrome, and `Text` re-measures. `DarkTheme`
    is `defineTheme(BaseTheme, …)` with a palette plus
    `tab.underBorderFullWidth`, and `ModernTheme` is built the same way, so a
    light/dark switch changes colours only — no size token moves, and nothing in
    Loom needs to force a relayout.

[^settings-home]: The alternative home was `src/data/session.ts` /
    `workspaceState.ts`, which autosave app state on a debounce. Rejected: a
    theme is a preference a user sets deliberately, not a snapshot of where
    they left the window, and `formatOnSave` / `showHiddenFiles` /
    `titleBarTemplate` / `tabMaxWidthPx` already establish exactly this kind of
    field in the settings files. Reusing `readOptionalChoice` also means a
    mistyped value degrades to the default instead of reaching `ThemeManager`.

[^write-back]: This is the one deviation from the *Show Hidden Files*
    precedent, where the View-menu toggle changes live state and the settings
    file is only ever hand-edited. A tree filter that resets on relaunch is
    defensible; a theme that reverts to light on every launch unless you
    hand-edit JSON is not the feature being asked for. The write is small and
    well-precedented: `ensureGlobalSettingsFile` already creates that exact
    file from code via `serializeSettingsOverride(emptySettingsOverride())`, and
    `installSessionAutosave` already writes app-wide state on its own. Only the
    global file is written — toggling the theme must not edit a project's
    committed `.loom/settings.json`, which a team may be sharing. The
    consequence is the fourth row of the resolution table: with a workspace
    theme pinned, the toggle still switches the live theme, and the next
    re-resolution returns to the project's value. That matches how every other
    setting behaves on a project switch.

[^new-module]: `EditorController.applySettings` was the cheaper seam — one
    existing call site in `main.ts` and one in `openProjectRoot` — but the
    controller owns tabs, the status bar, and editor commands, and a global
    repaint is none of those. A separate module also keeps `ThemeManager` to a
    single import site, which the grep in `## Verification` pins, and matches
    the project's habit of small single-purpose shell modules
    (`treeSectionLabel.ts`, `welcomeText.ts`, `dropIntent.ts`). The new module
    cannot be unit-tested: `vitest.config.ts` runs the `node` environment with no DOM, so
    `ThemeManager.setTheme` has nothing to write to — hence the manual
    verification list.

[^no-mirror]: A `_theme` field on the shell would be a second source of truth
    that can drift from what the page is actually painted with, and would need
    seeding on startup and on every project switch. `colorScheme` is typed
    `string` in the `Theme` interface, so the comparison is a string compare
    rather than an exhaustive switch; with two choices, anything not `'dark'` is
    `'light'`.

[^token-choice]: `toolBar.background` and `statusBar.background` carry the same
    value in all three built-in themes (`rgb(245, 245, 245)` light,
    `rgb(45, 45, 45)` dark), so the pick is invisible today and only matters
    under a custom theme. The sidebar's rail is a real `ToolBar`
    ([src/shell/EditorShell.ts:207](src/shell/EditorShell.ts#L207)) painting
    `--ts-ui-toolbar-bg`, and the two views sit flush against it, so matching
    the rail is the requirement; the breadcrumb band keeps `--ts-ui-statusbar-bg`
    for the same reason, since it reads as a status strip. `Tree`'s own default
    is `var(--ts-ui-input-bg, rgb(255, 255, 255))` — the content-surface token,
    which is why Loom overrode it in the first place: the sidebar is meant to
    read as recessed chrome, not as a document surface. The `var()` fallback is
    kept so the surfaces still paint if a future theme drops the token.

[^two-choices]: The TODO entry this plan closes asks for light/dark, and the
    View menu's existing vocabulary is checkbox rows. Three themes would mean
    `RadioMenuRow`s and a three-way palette command for a variant nobody asked
    for. `THEME_CHOICES` plus `readOptionalChoice` means adding `'classic'`
    later is a one-line schema change, and an older Loom reading a file that
    already says `"classic"` drops the unknown value and falls back to light
    rather than breaking.
