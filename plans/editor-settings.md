---
depends-on: [typescript-ui-0-11-adoptions]
touches-shared: [src/EditorController.ts, src/editor/FileEditor.ts, src/shell/EditorShell.ts, src/shell/commands.ts, src/main.ts, src/data/settings.ts, tests/settings.test.ts, tests/commands.test.ts, README.md, TODO.md]
---

# Editor Settings — Implementation Plan

## Overview

`CodeEditor` already has six options Loom never sets: `tabSize`, `lineWrap`,
`lineNumbers`, `lint`, `highlightWhitespace` and `placeholder`. `Body` has an
app-wide `resizeMode` (`'live'` or `'outline'`) for gutter and window-edge
drags. This plan makes each of them a Loom setting in the existing two-layer
model ([src/data/settings.ts:11](src/data/settings.ts#L11)), resolved the same
way as every other field: workspace file, then global file, then
`DEFAULT_SETTINGS`.

The editor options are applied by one new method,
`FileEditor.applyEditorSettings`, called when a `FileEditor` is built and
again for every open editor whenever `EditorController.applySettings`
([src/EditorController.ts:1119](src/EditorController.ts#L1119)) runs — at
startup and on every project switch. A **View > Word Wrap** checkbox row and a
command-palette toggle flip `lineWrap` for every open editor and write it to
the app-wide settings file, the way **Dark Theme** does today. `resizeMode` is
pushed into `Body` at the same two points that already apply the theme.

Every default keeps today's behaviour except one: an empty untitled tab now
shows a short hint (see *The untitled-buffer hint is on by default*).

---

## Architecture Decisions

### Every new key is a flat, top-level setting

The seven keys sit beside `formatOnSave` and `theme`, named as the library
names them, and resolve field by field like `showHiddenFiles`
([src/data/settings.ts:75](src/data/settings.ts#L75)).[^flat-keys]

| Key | Type | Default | Library option |
|---|---|---|---|
| `tabSize` | positive integer | unset (`null`) | `CodeEditor` `tabSize` |
| `lineWrap` | boolean | `false` | `CodeEditor` `lineWrap` |
| `lineNumbers` | boolean | `true` | `CodeEditor` `lineNumbers` |
| `lint` | boolean | `false` | `CodeEditor` `lint` |
| `highlightWhitespace` | boolean | `false` | `CodeEditor` `highlightWhitespace` |
| `untitledPlaceholder` | string (`""` hides it) | Loom's hint text | `CodeEditor` `placeholder`, untitled buffers only |
| `resizeMode` | `"live"` \| `"outline"` | `"live"` | `Body.setResizeMode` |

Each default except `untitledPlaceholder` is the library's own default, which
is what Loom runs with today because it never sets the option.[^defaults]

### Every editor option is applied through one method, at build time and on change

`FileEditor.applyEditorSettings(settings)` calls each `CodeEditor` setter
whose getter does not already match. The `FileEditor` constructor calls it
once; `EditorController` calls it on every open file whenever the editor
settings change. This mirrors how `EditorController.pushProjectRoot`
([src/EditorController.ts:621](src/EditorController.ts#L621)) pushes the
project root into every open file.[^live-setters]

A settings-file edit still applies at the next project switch or restart, not
on save — the rule `settings-file.md` set for every setting.

### `tabSize` and `formatting.indentWidth` stay two settings; the library joins them

Loom adds no code to bridge them. `tabSize` sets the live editor's tab-stop
width and the indent that Tab and auto-indent insert. `format()` takes its
indent width from the `formatting.indentWidth` Loom passes, and, when that is
absent, from the editor's own `tabSize`.[^tabsize-format]

| `tabSize` | `formatting.indentWidth` | Tab key inserts | Format Document / format-on-save indents by |
|---|---|---|---|
| unset | unset | 2 spaces (CodeMirror default) | the engine default (2 for Prettier and `sql-formatter`) |
| `4` | unset | 4 spaces | 4 |
| `4` | `2` | 4 spaces | 2 — the formatter-only override wins |
| unset | `4` | 2 spaces | 4 |

### `lint` ships off, with no per-language exceptions

`lint` defaults to `false` and, when on, applies to every language alike. Loom
maps `.ts`, `.tsx`, `.js` and `.jsx` to the library's single `javascript`
language ([src/editor/languages.ts:13](src/editor/languages.ts#L13)), whose
grammar is TypeScript without JSX. That grammar reports some valid TypeScript
as a parse error, and every JSX tag.[^lint-evidence] Loom does not switch lint
off per extension: that would be a Loom-side workaround for a library gap. The
gaps are recorded under **Library Gaps** and in a new TODO.md known issue.

`highlightWhitespace` has no such problem: it is a pure rendering option, off
by default.

### The untitled-buffer hint is on by default

`untitledPlaceholder` defaults to
`Plain text until saved — the file name you save it under picks the language`.
The hint shows only in an empty editor whose file has no path yet (a *File >
New File* tab), and only until the first keystroke. Setting it to `""` hides
it. This is the one default that changes what a user sees today.[^hint-default]

| Buffer | `untitledPlaceholder` | Placeholder shown |
|---|---|---|
| untitled (`path === null`) | default text | the default text |
| untitled | `""` | none |
| a file on disk, even an empty one | any | none |
| an untitled buffer just saved as `a.ts` | any | none — cleared by `setPath` |

### The Word Wrap toggle copies the Dark Theme toggle, including the write-back

The View menu gets a **Word Wrap** `CheckboxMenuRow`, and the palette gets a
`toggle-word-wrap` command. Both call `EditorController.selectLineWrap(wrap)`,
which applies the value to every open editor first, then records it in the
app-wide settings file. This is the same apply-then-save order as `selectTheme`
([src/shell/theme.ts:47](src/shell/theme.ts#L47)), with the same
`Dialog.error` on a failed write. The project's own settings file is never
written. With a workspace value pinned, the toggle still flips the live value,
and the next project switch returns to the project's value. That matches the
theme toggle exactly.[^write-back]

### The theme writer becomes a general field writer

`withTheme(text, theme)` ([src/data/settings.ts:219](src/data/settings.ts#L219))
becomes `withSettingFields(text, fields)`, which merges any set of top-level
fields onto the file's raw JSON. `saveGlobalTheme`
([src/shell/settings.ts:62](src/shell/settings.ts#L62)) becomes
`saveGlobalSettingFields(fields)`. `selectTheme` and `selectLineWrap` both use
it.[^general-writer]

### `resizeMode` is pushed into `Body` where the theme is applied

`main.ts` calls `body.setResizeMode(settings.resizeMode)` right after
`await bodyReady` ([src/main.ts:70](src/main.ts#L70)).
`EditorShell.openProjectRoot` calls
`Body.getInstance().setResizeMode(resolved.resizeMode)` next to
`applyTheme(resolved.theme)` ([src/shell/EditorShell.ts:502](src/shell/EditorShell.ts#L502)).
The library reads the mode when a drag starts, so a project switch applies it
to the next drag, with no restart.[^resize-reach]

In `'outline'` mode a drag moves only a thin line; the panes, and the editors
in them, are laid out once on release, and Escape cancels the drag. This
covers the explorer `Split`, the Files view's `Accordion`, every split inside
the editor `Dock`, and floating windows' edges. The trade-off: the content no
longer reflows while you drag. No performance number is claimed; nobody has
measured it in WebKitGTK.

### The parser's per-field `if` blocks become a reader table

`parseSettingsOverride` ([src/data/settings.ts:117](src/data/settings.ts#L117))
is 45 lines with one `if` per field; seven more fields would take it past 70.
It becomes a loop over a `SETTINGS_READERS` table, the shape the same file
already uses for the `formatting` block (`FORMATTING_READERS`,
[src/data/settings.ts:296](src/data/settings.ts#L296)). The table's
`satisfies` clause makes a field with no reader a compile error.[^reader-table]

### The settings file Loom creates stays `{ "version": 1 }`

`ensureGlobalSettingsFile` and `ensureWorkspaceSettingsFile` keep writing the
empty override. Writing the defaults into a new file would freeze them there,
so a later change to a default would never reach that user. README documents
the keys instead.

---

## Public API

All Loom-internal; nothing here is exported from a package.

### `src/data/settings.ts`

```ts
import type { ResizeMode } from '@jimka/typescript-ui/core'

export interface Settings {
    // …existing fields…
    /** Tab-stop and Tab-key indent width, in columns; `null` leaves CodeMirror's own defaults. */
    tabSize: number | null
    /** Whether long lines wrap instead of scrolling horizontally. */
    lineWrap: boolean
    /** Whether the line-number gutter is shown. */
    lineNumbers: boolean
    /** Whether parse errors are underlined. */
    lint: boolean
    /** Whether spaces, tabs and trailing whitespace are drawn visibly. */
    highlightWhitespace: boolean
    /** The hint an empty untitled buffer shows; `''` shows none. */
    untitledPlaceholder: string
    /** Whether gutter and window-edge drags reflow live or move an outline. */
    resizeMode: ResizeMode
}

export interface SettingsOverride {
    // …existing fields…
    tabSize?: number
    lineWrap?: boolean
    lineNumbers?: boolean
    lint?: boolean
    highlightWhitespace?: boolean
    untitledPlaceholder?: string
    resizeMode?: ResizeMode
}

/** The subset of {@link Settings} each open editor applies to its own `CodeEditor`. */
export type EditorSettings = Pick<Settings, 'tabSize' | 'lineWrap' | 'lineNumbers' | 'lint' | 'highlightWhitespace' | 'untitledPlaceholder'>

/** Every top-level field a settings file can carry, except `version`. */
export type SettingsFields = Omit<SettingsOverride, 'version'>

/** Picks {@link EditorSettings} out of a resolved snapshot. */
export function editorSettingsOf(settings: Settings): EditorSettings

/** The placeholder a buffer shows: `hint` for an untitled buffer, `null` otherwise or when `hint` is `''`. */
export function placeholderForBuffer(path: string | null, hint: string): string | null

/** Renders the settings-file text with `fields` set, every other field left as it was. Replaces `withTheme`. */
export function withSettingFields(text: string | null, fields: SettingsFields): string
```

`withTheme` is deleted.

### `src/shell/settings.ts`

```ts
/** Records `fields` in the app-wide settings file, creating it if absent. Replaces `saveGlobalTheme`. */
export async function saveGlobalSettingFields(fields: SettingsFields): Promise<void>
```

`saveGlobalTheme` is deleted.

### `src/editor/FileEditor.ts`

```ts
export interface FileEditorParams {
    // …existing fields…
    /** The editor options to apply on construction. */
    editorSettings: EditorSettings
}

class FileEditor {
    /** Applies each editor option whose live value differs; the placeholder only while the buffer has no path. */
    applyEditorSettings(settings: EditorSettings): void
}
```

### `src/EditorController.ts`

```ts
class EditorController {
    /** Backing field: the editor options every open and future `FileEditor` gets. */
    private _editorSettings: EditorSettings

    /** Whether editors currently wrap long lines — read by the View menu and the palette. */
    isLineWrapping(): boolean

    /** Applies `wrap` to every open editor, then records it in the app-wide settings file. */
    async selectLineWrap(wrap: boolean): Promise<void>

    /** Stores `settings` and applies them to every open file. */
    private pushEditorSettings(settings: EditorSettings): void
}
```

### `src/shell/commands.ts` and `src/shell/EditorShell.ts`

`PaletteCommandActions` ([src/shell/commands.ts:36](src/shell/commands.ts#L36))
and `MenuBarActions` ([src/shell/EditorShell.ts:98](src/shell/EditorShell.ts#L98))
each gain:

```ts
    /** Whether editors wrap long lines — read live each time the menu or the palette opens. */
    isWordWrap: () => boolean
    /** Turns word wrap on or off and records the choice in the app-wide settings file. */
    onToggleWordWrap: (value: boolean) => void
```

---

## Internal Structure

### `src/data/settings.ts`

New defaults, appended to `DEFAULT_SETTINGS` with a comment each:

```ts
    // Unset: CodeMirror's own defaults (4-column tab stops, a 2-space indent
    // unit), which is what every editor used before this setting existed.
    tabSize: null,
    // The library's own default, unchanged from before this setting existed.
    lineWrap: false,
    // The library's own default, unchanged from before this setting existed.
    lineNumbers: true,
    // Off: the `javascript` grammar marks some valid TypeScript, and all JSX,
    // as parse errors (see TODO.md), so on-by-default would flag correct code.
    lint: false,
    // The library's own default, unchanged from before this setting existed.
    highlightWhitespace: false,
    // An untitled buffer has no language until it is saved; this says so.
    untitledPlaceholder: 'Plain text until saved — the file name you save it under picks the language',
    // The library's own default — panes reflow on every frame of a drag.
    resizeMode: 'live',
```

`resolveSettings` gains one line per key, the same shape as the existing ones:

```ts
        tabSize: workspace?.tabSize ?? global?.tabSize ?? DEFAULT_SETTINGS.tabSize,
        lineWrap: workspace?.lineWrap ?? global?.lineWrap ?? DEFAULT_SETTINGS.lineWrap,
        lineNumbers: workspace?.lineNumbers ?? global?.lineNumbers ?? DEFAULT_SETTINGS.lineNumbers,
        lint: workspace?.lint ?? global?.lint ?? DEFAULT_SETTINGS.lint,
        highlightWhitespace: workspace?.highlightWhitespace ?? global?.highlightWhitespace ?? DEFAULT_SETTINGS.highlightWhitespace,
        untitledPlaceholder: workspace?.untitledPlaceholder ?? global?.untitledPlaceholder ?? DEFAULT_SETTINGS.untitledPlaceholder,
        resizeMode: workspace?.resizeMode ?? global?.resizeMode ?? DEFAULT_SETTINGS.resizeMode,
```

`??` passes `''` through, so a workspace `untitledPlaceholder: ""` hides a hint
the global file sets.

The new reader, placed after `readOptionalNonEmptyString`:

```ts
/**
 * Reads a field expected to be a string, the empty string included.
 *
 * @param value - The field's raw value.
 * @returns The string, or `undefined` when absent or the wrong type.
 */
function readOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined
}
```

The choice list and the reader table, placed after `THEME_CHOICES`
([src/data/settings.ts:288](src/data/settings.ts#L288)) and before
`FORMATTING_READERS`:

```ts
/** The top-level `resizeMode` field's allowed values — the library's `ResizeMode`. */
const RESIZE_MODE_CHOICES: readonly ResizeMode[] = ['live', 'outline']

/** Every top-level field except `version` and the nested `formatting` block. */
type ScalarSettingsFields = Omit<SettingsOverride, 'version' | 'formatting'>

/**
 * Every top-level scalar field, mapped to the reader that validates it. The
 * `satisfies` clause makes the table exhaustive, as {@link FORMATTING_READERS}
 * does for the `formatting` block.
 */
const SETTINGS_READERS = {
    formatOnSave: readOptionalBoolean,
    showHiddenFiles: readOptionalBoolean,
    showIgnoredFiles: readOptionalBoolean,
    titleBarTemplate: readOptionalNonEmptyString,
    tabMaxWidthPx: readOptionalPositiveNumber,
    theme: (value: unknown) => readOptionalChoice(value, THEME_CHOICES),
    tabSize: readOptionalPositiveInteger,
    lineWrap: readOptionalBoolean,
    lineNumbers: readOptionalBoolean,
    lint: readOptionalBoolean,
    highlightWhitespace: readOptionalBoolean,
    untitledPlaceholder: readOptionalString,
    resizeMode: (value: unknown) => readOptionalChoice(value, RESIZE_MODE_CHOICES),
} satisfies { [K in keyof ScalarSettingsFields]-?: (value: unknown) => ScalarSettingsFields[K] | undefined }
```

`tabSize` uses `readOptionalPositiveInteger` because `format()` hands it to
Prettier as `tabWidth` when `indentWidth` is absent, and Prettier rejects a
fractional `tabWidth`.

`parseSettingsOverride` keeps its JSDoc and becomes:

```ts
export function parseSettingsOverride(text: string): SettingsOverride | null {
    const doc = parseDocument(text)

    if (doc === null) {
        return null
    }

    const override: Record<string, unknown> = { version: 1 }

    for (const [field, read] of Object.entries(SETTINGS_READERS)) {
        const parsed = read(doc[field])

        // Assigned only when defined, so the override never holds a key whose
        // value is `undefined` — `resolveSettings`' `??` chain depends on it.
        if (parsed !== undefined) {
            override[field] = parsed
        }
    }

    const formatting = parseFormatting(doc.formatting)

    if (formatting !== undefined) {
        override.formatting = formatting
    }

    // The reader table is the type bridge, as in `parseFormatting`: each key
    // was written by the reader declared for that exact field.
    return override as SettingsOverride
}
```

The two pure helpers and the writer:

```ts
export function editorSettingsOf(settings: Settings): EditorSettings {
    return {
        tabSize: settings.tabSize,
        lineWrap: settings.lineWrap,
        lineNumbers: settings.lineNumbers,
        lint: settings.lint,
        highlightWhitespace: settings.highlightWhitespace,
        untitledPlaceholder: settings.untitledPlaceholder,
    }
}

export function placeholderForBuffer(path: string | null, hint: string): string | null {
    return path === null && hint !== '' ? hint : null
}

export function withSettingFields(text: string | null, fields: SettingsFields): string {
    const doc = text === null ? null : parseJsonObject(text)

    // `version: 1` before `fields`, as `withTheme` had it: a file carrying some
    // other version keeps every field it had and starts being read again.
    // `fields` cannot carry `version` (its type omits it). Indented to 2
    // spaces to match `serializeSettingsOverride`.
    return JSON.stringify({ ...(doc ?? {}), version: 1, ...fields }, null, 2)
}
```

Move `withTheme`'s JSDoc onto `withSettingFields`, reworded for "`fields`"
instead of "`theme`". Update `parseJsonObject`'s JSDoc, which names
`withTheme`, to name `withSettingFields`.

### `src/editor/FileEditor.ts`

```ts
    /**
     * Applies each editor option whose live value differs from `settings`.
     * Skipping a matching option keeps a one-field change (the Word Wrap
     * toggle) from reconfiguring the other options or reloading the lint
     * source of every open editor. The placeholder applies only while this
     * buffer has no path; {@link setPath} clears it.
     *
     * @param settings - The editor options to apply.
     */
    applyEditorSettings(settings: EditorSettings): void {
        const editor = this._editor
        const placeholder = placeholderForBuffer(this._path, settings.untitledPlaceholder)

        if (editor.getTabSize() !== settings.tabSize) {
            editor.setTabSize(settings.tabSize)
        }

        if (editor.getLineWrap() !== settings.lineWrap) {
            editor.setLineWrap(settings.lineWrap)
        }

        if (editor.getLineNumbers() !== settings.lineNumbers) {
            editor.setLineNumbers(settings.lineNumbers)
        }

        if (editor.getLint() !== settings.lint) {
            editor.setLint(settings.lint)
        }

        if (editor.getHighlightWhitespace() !== settings.highlightWhitespace) {
            editor.setHighlightWhitespace(settings.highlightWhitespace)
        }

        if (editor.getPlaceholder() !== placeholder) {
            editor.setPlaceholder(placeholder)
        }
    }
```

The constructor calls `this.applyEditorSettings(params.editorSettings)` after
`this._path` and `this._editor` are assigned — directly before the existing
`editor.on('change', this.handleChange)` line. Each setter only caches its
value until the editor mounts, and the mount builds its configuration from
those cached values.

`setPath` gains `this._editor.setPlaceholder(null)` after the
`this._editor.setLanguage(...)` line: a saved buffer is no longer untitled.

### `src/EditorController.ts`

```ts
    /** The editor options every open and future `FileEditor` gets — set by {@link applySettings} and {@link selectLineWrap}. */
    private _editorSettings: EditorSettings = editorSettingsOf(DEFAULT_SETTINGS)
```

`applySettings` gains `this.pushEditorSettings(editorSettingsOf(settings))`
directly before its `this.syncActive()` line. Its JSDoc's first sentence names
the editor options too.

```ts
    /** Whether editors currently wrap long lines. */
    isLineWrapping(): boolean {
        return this._editorSettings.lineWrap
    }

    /**
     * Applies `wrap` to every open editor, then records it in the app-wide
     * settings file. Applied first, so a failed write still leaves the
     * editors switched and reports only that the choice was not remembered —
     * the order `selectTheme` uses.
     *
     * @param wrap - Whether long lines should wrap.
     */
    async selectLineWrap(wrap: boolean): Promise<void> {
        this.pushEditorSettings({ ...this._editorSettings, lineWrap: wrap })

        try {
            await saveGlobalSettingFields({ lineWrap: wrap })
        } catch (error) {
            await Dialog.error('Could not save the word wrap setting', messageOf(error))
        }
    }

    /**
     * Stores `settings` as the options every future `FileEditor` gets, and
     * applies them to every file already open — hidden tabs included, so a
     * background tab is up to date when it is next shown.
     *
     * @param settings - The editor options to apply.
     */
    private pushEditorSettings(settings: EditorSettings): void {
        this._editorSettings = settings

        for (const file of this._openFiles.values()) {
            file.applyEditorSettings(settings)
        }
    }
```

Both `FileEditor({ … })` calls — in `newFile`
([src/EditorController.ts:454](src/EditorController.ts#L454)) and in
`addFileTab` ([src/EditorController.ts:599](src/EditorController.ts#L599)) —
gain `editorSettings: this._editorSettings`.

### `src/shell/commands.ts`

Appended to the fixed list directly after the `toggle-dark-theme` entry:

```ts
        {
            id: 'toggle-word-wrap',
            title: actions.isWordWrap() ? 'Turn Off Word Wrap' : 'Turn On Word Wrap',
            enabled: true,
            run: () => actions.onToggleWordWrap(!actions.isWordWrap()),
        },
```

### `src/shell/EditorShell.ts`

In the `actions` object, after `onToggleDarkTheme`:

```ts
            isWordWrap: () => controller.isLineWrapping(),
            onToggleWordWrap: (value: boolean) => { void controller.selectLineWrap(value) },
```

In `buildMenuBar`'s View menu, after the Dark Theme row:

```ts
                { separator: true },
                { row: () => {
                        const row = CheckboxMenuRow({ text: 'Word Wrap', checked: actions.isWordWrap() })

                        row.on('action', () => { actions.onToggleWordWrap(row.isChecked()) })

                        return row
                    } },
```

---

## Ordered Implementation Steps

All steps run from the implementation worktree's root.

### Setup

1. **Install and link the library.** Run `npm ci`. Then replace the installed
   library with the local checkout:
   `rm -rf node_modules/@jimka/typescript-ui && ln -s /home/jika/typescript/typescript-ui/packages/lib node_modules/@jimka/typescript-ui`.
   Do not change `package.json`'s `^0.11.0` range. Checks:
   - `readlink node_modules/@jimka/typescript-ui` → `/home/jika/typescript/typescript-ui/packages/lib`.
   - `grep -c setResizeMode node_modules/@jimka/typescript-ui/dist/lib/types/core/Body.d.ts` → at least `1`.
   - `grep -c 'setLint\|setTabSize' node_modules/@jimka/typescript-ui/dist/lib/types/component/editor/CodeEditor.d.ts` → at least `2`.
   - `git diff --stat package.json package-lock.json` → empty.
2. **Baseline.** `npm run typecheck && npm test` → clean. Note the passing
   test count.
3. **Scratch project and red by-eye baseline.** Build `qa-settings/` as in
   **Verification › By eye** item 1. Run case M0 against the unmodified code;
   it must show the settings being ignored. Stop the dev server. Keep
   `qa-settings/` for the end.

### Part 1 — the settings model (test-first)

4. **[tests/settings.test.ts](tests/settings.test.ts)** — write the tests
   listed under **Expected Behaviour › Unit** (E1–E6). Rename the `withTheme`
   import and `describe` block to `withSettingFields`, rewriting each call as
   `withSettingFields(text, { theme: … })`; the expected objects stay as they
   are. Check: `npx vitest run tests/settings.test.ts` fails (new names not
   exported, new fields not parsed).
5. **[src/data/settings.ts](src/data/settings.ts)** — in this order:
   1. Add `import type { ResizeMode } from '@jimka/typescript-ui/core'`.
   2. Add the seven fields to `Settings` and `SettingsOverride`, and the seven
      defaults to `DEFAULT_SETTINGS`, as in **Internal Structure**.
   3. Add the seven lines to `resolveSettings`.
   4. Add `EditorSettings`, `SettingsFields`, `editorSettingsOf` and
      `placeholderForBuffer`, each with a JSDoc block, after `resolveSettings`.
   5. Replace `withTheme` with `withSettingFields`; update `parseJsonObject`'s
      JSDoc.
   6. Add `readOptionalString`, `RESIZE_MODE_CHOICES`, `ScalarSettingsFields`
      and `SETTINGS_READERS`; rewrite `parseSettingsOverride` as the loop.

   Checks: `npx vitest run tests/settings.test.ts` passes;
   `grep -n "withTheme" src tests -r` → only `src/shell/settings.ts` (fixed
   next).
6. **Mutation check.** In `resolveSettings`, swap `workspace?.lineWrap` and
   `global?.lineWrap` → the E3 workspace-wins case fails. In
   `placeholderForBuffer`, drop `path === null &&` → an E5 case fails. Revert
   both; the file passes again.
7. **[src/shell/settings.ts](src/shell/settings.ts)** — replace
   `saveGlobalTheme(theme)` with `saveGlobalSettingFields(fields)`, body
   `await writeSettingsText(withSettingFields(await readSettingsText(), fields))`.
   Fix the imports (`withSettingFields`, `SettingsFields`; drop `withTheme`,
   `ThemeName`).
8. **[src/shell/theme.ts](src/shell/theme.ts)** — import
   `saveGlobalSettingFields` instead of `saveGlobalTheme`; `selectTheme` calls
   `await saveGlobalSettingFields({ theme })`. Checks:
   `grep -rn "withTheme\|saveGlobalTheme" src tests` → no matches;
   `npm run typecheck && npm test` → clean.

### Part 2 — applying the editor options

9. **[src/editor/FileEditor.ts](src/editor/FileEditor.ts)** — import
   `placeholderForBuffer` and `type EditorSettings` from `'../data/settings'`;
   add `editorSettings` to `FileEditorParams`; add `applyEditorSettings`; call
   it from the constructor; add the `setPlaceholder(null)` line to `setPath`.
   Check: `npm run typecheck` reports exactly the two `FileEditor({ … })`
   calls in `src/EditorController.ts` missing `editorSettings`.
10. **[src/EditorController.ts](src/EditorController.ts)** — import
    `editorSettingsOf`, `type EditorSettings` from `'./data/settings'` and
    `saveGlobalSettingFields` from `'./shell/settings'`; add
    `_editorSettings`, `isLineWrapping`, `selectLineWrap` and
    `pushEditorSettings`; pass `editorSettings` in `newFile` and
    `addFileTab`; extend `applySettings`. Check: `npm run typecheck` → clean.

### Part 3 — the Word Wrap toggle

11. **[tests/commands.test.ts](tests/commands.test.ts)** — add
    `isWordWrap: () => false` and `onToggleWordWrap: () => {}` to the
    `actions` helper; write E7. Check: `npx vitest run tests/commands.test.ts`
    fails.
12. **[src/shell/commands.ts](src/shell/commands.ts)** — add the two members
    to `PaletteCommandActions` after `onToggleDarkTheme`, and the
    `toggle-word-wrap` entry. Check: `npx vitest run tests/commands.test.ts`
    passes.
13. **[src/shell/EditorShell.ts](src/shell/EditorShell.ts)** — add the two
    members to `MenuBarActions` after `onToggleDarkTheme`, the two `actions`
    entries, and the View-menu row. Check: `npm run typecheck` → clean.

### Part 4 — `resizeMode`

14. **[src/main.ts](src/main.ts)** — after `const body = await bodyReady`, add
    `body.setResizeMode(settings.resizeMode)`. Extend the comment above
    `bodyReady` with one sentence: the resize mode is applied once settings
    are read, since `Body.init` runs before they are.
15. **[src/shell/EditorShell.ts](src/shell/EditorShell.ts)** — add `Body` to
    the `@jimka/typescript-ui/core` import; in `openProjectRoot`, directly
    after `applyTheme(resolved.theme)`, add
    `Body.getInstance().setResizeMode(resolved.resizeMode)`. Add "the resize
    mode" to the method's JSDoc list of what a project switch reapplies.
    Check: `npm run typecheck && npm test` → clean.

### Part 5 — documentation

16. **[README.md](README.md)** — the edits under **Documentation Impact**.
17. **[TODO.md](TODO.md)** — the two edits under **Documentation Impact**.
18. **Final checks** — everything under **Verification**, then
    `rm -rf qa-settings` and `git status --short` shows only the files in the
    table below.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src/data/settings.ts` |
| Modify | `src/shell/settings.ts` |
| Modify | `src/shell/theme.ts` |
| Modify | `src/editor/FileEditor.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `src/shell/commands.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `src/main.ts` |
| Modify | `tests/settings.test.ts` |
| Modify | `tests/commands.test.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |
| Create, then delete before committing | `qa-settings/` (by-eye scratch project) |

---

## Expected Behaviour

### Unit (vitest, `tests/settings.test.ts` and `tests/commands.test.ts`)

**E1 — defaults keep today's behaviour.** `DEFAULT_SETTINGS` matches
`{ tabSize: null, lineWrap: false, lineNumbers: true, lint: false, highlightWhitespace: false, resizeMode: 'live' }`,
and `DEFAULT_SETTINGS.untitledPlaceholder` is a non-empty string. The existing
`resolveSettings(null, null)` equals `DEFAULT_SETTINGS` case keeps passing.

**E2 — parsing.** One `it` per row, each parsing `{"version":1, <field>}`:

| Field in the file | Parsed override |
|---|---|
| `"tabSize": 4` | `{ version: 1, tabSize: 4 }` |
| `"tabSize": 2.5` | `{ version: 1 }` |
| `"tabSize": 0` | `{ version: 1 }` |
| `"tabSize": "4"` | `{ version: 1 }` |
| `"lineWrap": true` | `{ version: 1, lineWrap: true }` |
| `"lineWrap": "yes"` | `{ version: 1 }` |
| `"lineNumbers": false` | `{ version: 1, lineNumbers: false }` |
| `"lint": true` | `{ version: 1, lint: true }` |
| `"highlightWhitespace": true` | `{ version: 1, highlightWhitespace: true }` |
| `"untitledPlaceholder": ""` | `{ version: 1, untitledPlaceholder: '' }` |
| `"untitledPlaceholder": "Hi"` | `{ version: 1, untitledPlaceholder: 'Hi' }` |
| `"untitledPlaceholder": 3` | `{ version: 1 }` |
| `"resizeMode": "outline"` | `{ version: 1, resizeMode: 'outline' }` |
| `"resizeMode": "Outline"` | `{ version: 1 }` |
| `"resizeMode": true` | `{ version: 1 }` |

Plus: a document carrying every new field and a bad `formatOnSave`
(`"formatOnSave": "no"`) parses every new field and drops `formatOnSave`. All
existing `parseSettingsOverride` cases keep passing unchanged.

**E3 — resolution.**

| Global | Workspace | Effective |
|---|---|---|
| `{ lineWrap: true }` | `null` | `lineWrap: true` |
| `{ lineWrap: true }` | `{ lineWrap: false }` | `lineWrap: false` |
| `{ lineWrap: true }` | `{}` (bare) | `lineWrap: true` |
| `{ tabSize: 4 }` | `null` | `tabSize: 4` |
| `null` | `null` | `tabSize: null` |
| `{ untitledPlaceholder: 'Hi' }` | `{ untitledPlaceholder: '' }` | `untitledPlaceholder: ''` |
| `{ resizeMode: 'outline' }` | `{ lint: true }` | `resizeMode: 'outline'`, `lint: true` |

**E4 — `editorSettingsOf`.** Given `{ ...DEFAULT_SETTINGS, tabSize: 4, lint: true }`,
returns exactly
`{ tabSize: 4, lineWrap: false, lineNumbers: true, lint: true, highlightWhitespace: false, untitledPlaceholder: DEFAULT_SETTINGS.untitledPlaceholder }`
(`toEqual`, so a stray `theme` or `resizeMode` key fails it).

**E5 — `placeholderForBuffer`.**

| `path` | `hint` | Result |
|---|---|---|
| `null` | `'Hint'` | `'Hint'` |
| `null` | `''` | `null` |
| `'/p/a.ts'` | `'Hint'` | `null` |
| `'/p/a.ts'` | `''` | `null` |

**E6 — `withSettingFields`.** The seven ported `withTheme` cases, plus:

| `text` | `fields` | Parsed result |
|---|---|---|
| `'{"version":1,"theme":"dark"}'` | `{ lineWrap: true }` | `{ version: 1, theme: 'dark', lineWrap: true }` |
| `'{"version":1,"lineWrap":true}'` | `{ lineWrap: false }` | `{ version: 1, lineWrap: false }` — `false` is written, not dropped |
| `null` | `{ theme: 'dark', lineWrap: true }` | `{ version: 1, theme: 'dark', lineWrap: true }` |

**E7 — palette (`tests/commands.test.ts`).**
- Both fixed-order cases list fourteen ids, ending
  `'toggle-dark-theme', 'toggle-word-wrap'`; rename "thirteen" to "fourteen"
  in both test names.
- `toggle-word-wrap` joins the always-enabled list.
- Title is `'Turn On Word Wrap'` when `isWordWrap` returns `false`,
  `'Turn Off Word Wrap'` when `true`.
- `run()` calls `onToggleWordWrap(true)` when `isWordWrap` returns `false`,
  and `onToggleWordWrap(false)` when `true`.

### Manual (browser shell — `CodeEditor` mounts nothing under vitest)

Cases M0–M6 under **Verification › By eye**:

- A project switch re-applies every editor option to editors already open,
  including the tab that came from the previous project.
- The untitled hint shows the default text, follows `untitledPlaceholder`, and
  never appears in a file read from disk.
- `lint` underlines a real JSON error. With lint on, it also underlines the
  valid `let done!: boolean` line in a `.ts` file — the recorded library gap,
  expected, not a failure.
- With `tabSize: 8` and no `formatting.indentWidth`, *Format Document* on JSON
  indents by 8.
- The Word Wrap menu row and palette command flip wrapping in every open
  editor, and each reflects the current state when opened.
- `resizeMode: "outline"` holds the editor's width during a gutter drag and
  applies it on release; `"live"` resizes during the drag.

For the user, in `npm run tauri:dev` (the browser shell writes nothing):

- **T1.** Toggle *View > Word Wrap*, quit, relaunch: the choice survives, and
  `settings.json` under Loom's config folder holds `"lineWrap"` beside any
  fields it had.
- **T2.** In a New File tab, *Save As* `x.ts`, then select all and delete:
  no hint shows.

---

## Verification

- `npm run typecheck`, `npm test`, `npm run build` — all clean; the test count
  is the step-2 baseline plus the new cases.
- `grep -rn "withTheme\|saveGlobalTheme" src tests` → no matches.
- `grep -n "FileEditor({" src/EditorController.ts` → two matches, each passing
  `editorSettings`.
- The mutation checks in step 6.
- **By eye, browser shell.** From the worktree:
  1. Build the scratch project:
     ```bash
     mkdir -p qa-settings/plain qa-settings/tuned/.loom
     long=$(printf 'x%.0s' $(seq 1 300))
     printf 'const s = "%s"\n\tconst tabbed = 1\nconst trailing = 2   \nlet done!: boolean\n' "$long" > qa-settings/plain/wide.ts
     printf '{"a": 1,}\n' > qa-settings/tuned/broken.json
     printf '{\n"a": {\n"b": 1\n}\n}\n' > qa-settings/tuned/nested.json
     cat > qa-settings/tuned/.loom/settings.json <<'EOF'
     { "version": 1, "tabSize": 8, "lineWrap": true, "lineNumbers": false, "lint": true,
       "highlightWhitespace": true, "untitledPlaceholder": "Scratch buffer", "resizeMode": "outline" }
     EOF
     ```
     The browser shell reads files under the checkout, so the workspace file
     in `tuned/.loom/` is read on *Open Folder…*. Every write is a no-op, and
     the global settings file is never found, so all settings checks go
     through this workspace file and the live toggles.
  2. `npm run dev:browser -- --port 1431 --strictPort` and open the page with
     the chrome-devtools tools. To open a project, set
     `window.__FAKE_PROJECT_ROOT__` to the folder's absolute path with
     `evaluate_script`, then click *Open Folder…*.
  3. **Reading** — run this with `evaluate_script` on the visible editor:
     ```js
     () => {
         const ed = [...document.querySelectorAll('.cm-editor')].find(e => e.offsetParent !== null)
         const c = ed.querySelector('.cm-content')
         return {
             wrap: c.classList.contains('cm-lineWrapping'),
             tab: getComputedStyle(c).tabSize,
             numbers: ed.querySelector('.cm-lineNumbers') !== null,
             lintErrors: ed.querySelectorAll('.cm-lintRange-error').length,
             whitespace: ed.querySelectorAll('.cm-highlightSpace, .cm-highlightTab, .cm-trailingSpace').length,
             placeholder: ed.querySelector('.cm-placeholder')?.textContent ?? null,
         }
     }
     ```
     Wait one second before reading `lintErrors`: the linter runs after a
     short delay.
  4. **Drag probe** — run with `evaluate_script`:
     ```js
     async () => {
         const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
         const gutter = [...document.querySelectorAll('*')].find(e => getComputedStyle(e).cursor === 'ew-resize')
         const width = () => [...document.querySelectorAll('.cm-editor')].find(e => e.offsetParent !== null).getBoundingClientRect().width
         const r = gutter.getBoundingClientRect()
         const x = r.left + r.width / 2
         const y = r.top + r.height / 2
         const before = width()
         gutter.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0, buttons: 1 }))
         document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + 120, clientY: y, buttons: 1 }))
         await frames()
         const during = width()
         document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x + 120, clientY: y, button: 0 }))
         await frames()
         return { before, during, after: width() }
     }
     ```
  5. Run the cases:
     - **M0 (red baseline, before any code change).** Open `tuned`, then
       double-click `broken.json`. Reading: `wrap: false`, `numbers: true`,
       `lintErrors: 0` — the settings are ignored. Stop here in step 3.
     - **M1 — defaults.** Open `plain`; double-click `wide.ts`. Reading:
       `{ wrap: false, tab: '4', numbers: true, lintErrors: 0, whitespace: 0, placeholder: null }`.
       *File > New File*: `placeholder` is
       `Plain text until saved — the file name you save it under picks the language`.
     - **M2 — a project switch reaches open editors.** Keep both tabs open,
       open `tuned`. On the untitled tab: `wrap: true`, `tab: '8'`,
       `numbers: false`, `placeholder: 'Scratch buffer'`. Click the
       `wide.ts` tab: `wrap: true`, `tab: '8'`, `numbers: false`,
       `whitespace` above 0, and after a second `lintErrors` at least 1 (the
       `let done!` line — the recorded gap).
     - **M3 — lint on a real error.** Double-click `broken.json`; after a
       second, `lintErrors` is at least 1.
     - **M4 — `tabSize` reaches Format Document.** Double-click
       `nested.json`, run *Edit > Format Document*. The second `.cm-line`'s
       text starts with exactly 8 spaces before `"a"`.
     - **M5 — the Word Wrap toggle.** Open the View menu: *Word Wrap* is
       checked. Click it: the reading shows `wrap: false`; click another tab:
       `wrap: false` there too. Open the palette (Ctrl+P, type `>`):
       *Turn On Word Wrap* is listed; run it: `wrap: true` again.
     - **M6 — resize mode.** With `tuned` open, run the drag probe: `during`
       equals `before`, `after` differs from `before` by about 120. Open
       `plain` and run it again: `during` already differs from `before`. If
       the probe moves nothing in either mode (the synthetic events do not
       start a drag), say so in the hand-off and leave this case to the user
       in `npm run tauri:dev`.
  6. Stop the server, `rm -rf qa-settings`, and confirm `git status --short`
     lists only the files in **Files to Create / Modify / Delete**.

---

## Documentation Impact

No library API changes. Loom's own docs:

- **README.md, *Settings* bullet** ([README.md:153](README.md#L153)). Replace
  the sentence starting "Covers whether saving reformats…" with:

  > Covers whether saving reformats the document and in what style (indent
  > width, line width, quote style, and the rest — per language, only where
  > that language's formatter honours the field); the editors' tab width
  > (`tabSize`, also the indent width formatting uses when `formatting` sets
  > no `indentWidth`), word wrap, line numbers, parse-error underlines
  > (`lint`, off by default — it marks some valid TypeScript and all JSX as
  > errors), visible whitespace, and the hint an empty untitled tab shows; the
  > drag mode for the explorer, editor-group and floating-window edges
  > (`resizeMode`: `"live"` reflows the content as you drag, `"outline"` moves
  > a line and lays out once on release, which is cheaper with several
  > editors on screen); the tree's default Show Hidden/Show Ignored state, the
  > window title template, the tab strip's width cap, and the light/dark
  > theme — see [`src/data/settings.ts`](src/data/settings.ts) for the full
  > set and each one's default. A change made by editing either file applies
  > at the next launch or project switch.

- **README.md, new *Word wrap* bullet** directly after the *Theme* bullet:

  > - **Word wrap** — *View > Word Wrap* (and the matching command-palette
  >   entry) wraps long lines in every open editor at once. Like the theme,
  >   the choice is written to the app-wide settings file.

- **README.md, *New files* bullet** ([README.md:138](README.md#L138)): append
  "An empty untitled tab shows a hint that it stays plain text until saved;
  the `untitledPlaceholder` setting changes or hides it."

- **TODO.md, *The visible editors' own resize work…*** ([TODO.md:113](TODO.md#L113)):
  append to the entry:

  > The `resizeMode` setting (`"outline"`) sidesteps this cost rather than
  > removing it: the panes hold still while a line follows the pointer, and
  > each visible editor re-measures once, on release. The trade-off is that
  > the content no longer reflows during the drag. Not measured in WebKitGTK
  > yet.

- **TODO.md, new known issue**, after that entry:

  > - **Lint marks valid TypeScript, and every JSX tag, as an error.** Loom
  >   maps `.ts`, `.tsx`, `.js` and `.jsx` to the library's one `javascript`
  >   language, whose grammar (`@lezer/javascript` 1.5.4, TypeScript dialect,
  >   no JSX) fails on some valid TypeScript: an arrow function's type
  >   predicate (`(x): x is T => …`), a definite assignment (`let x!: T`),
  >   `export { type T }`, labelled or optional tuple elements,
  >   `typeof import('…')`, `declare module '…'`, `import x = require('…')`
  >   and `abstract new () => T`. With the `lint` setting on, three of Loom's
  >   own 72 TypeScript files show a false error. JSX is not parsed at all, so
  >   `.jsx`/`.tsx` files are also mis-highlighted, with lint on or off. That
  >   is why `lint` is off by default. The fix belongs upstream: a JSX option
  >   on the `javascript` language, like `sql`'s `dialect`, which Loom would
  >   pass for `.jsx`/`.tsx`; and the TypeScript false positives in the
  >   grammar itself.

---

## Potential Challenges

- **A user with `tabSize` set sees format-on-save output change.** With no
  `formatting.indentWidth`, the formatter now indents by `tabSize`. This is
  the library's documented rule, and README now states it; a user who wants
  Prettier's 2 sets `formatting.indentWidth: 2`.
- **The lint gutter appears when lint turns on**, shifting text right by one
  gutter column. This is the library's own behaviour, not a regression.
- **A Word Wrap toggle while the global settings file is open in a tab** makes
  the watcher report an external change to that tab. The theme toggle already
  does the same; no handling needed.
- **The drag probe may not drive the gutter** if a future library version
  stops listening for `mousedown`. M6 then falls back to the user's
  `tauri:dev` check.
- **`SETTINGS_READERS` is declared after `THEME_CHOICES` and
  `RESIZE_MODE_CHOICES`**, so the `const`s it closes over exist when a reader
  first runs.

---

## Critical Files

- [src/data/settings.ts](src/data/settings.ts) — the settings shape, parser,
  merge rule, `withTheme` (being generalised) and `FORMATTING_READERS`, the
  reader-table precedent.
- [tests/settings.test.ts](tests/settings.test.ts) — the test style to extend.
- [src/shell/theme.ts](src/shell/theme.ts) — `selectTheme`, the
  apply-then-save precedent `selectLineWrap` copies.
- [src/shell/settings.ts](src/shell/settings.ts) — `saveGlobalTheme`, being
  generalised.
- [src/EditorController.ts](src/EditorController.ts) — `applySettings`,
  `pushProjectRoot` (the push-to-every-open-file precedent), `newFile`,
  `addFileTab`.
- [src/editor/FileEditor.ts](src/editor/FileEditor.ts) — constructor and
  `setPath`.
- [src/shell/EditorShell.ts](src/shell/EditorShell.ts) — `MenuBarActions`, the
  `actions` object, the Dark Theme menu row, `openProjectRoot`.
- [src/shell/commands.ts](src/shell/commands.ts) and
  [tests/commands.test.ts](tests/commands.test.ts) — the `toggle-dark-theme`
  entry and its tests.
- [plans/implemented/app-theme-switching.md](plans/implemented/app-theme-switching.md)
  — the write-back decision this plan reuses.
- Library: `docs/components/CodeEditor.md` (Construction, Formatting options,
  Linting) and `docs/layouts/Split.md` (*Live or outline resizing*) under
  `/home/jika/typescript/typescript-ui/packages/lib/`.

---

## Library Gaps

Recorded for the user to decide on; this plan works around neither.

- **The `javascript` language's lint source flags valid TypeScript.** The
  error nodes come from `@lezer/javascript` 1.5.4's TypeScript dialect (the
  constructs listed in the TODO.md entry above). The library could document
  the limitation in `CodeEditor.md`'s *Linting* section, or carry a grammar
  fix upstream.
- **The `javascript` language has no JSX option.** It loads
  `javascript({ typescript: true })` and ignores its `languageOptions`, so a
  `.jsx`/`.tsx` file cannot be parsed as JSX. A `jsx` field in its language
  options, like `sql`'s `dialect`, would let Loom pass `{ jsx: true }` for
  those two extensions.

---

## Non-Goals

- **Live reload of an edited settings file.** Unchanged from
  `settings-file.md`: an edit applies at the next launch or project switch.
- **A Word Wrap keyboard shortcut** (VS Code's Alt+Z). Not asked for; the
  menu row and the palette entry cover it.
- **Menu or palette toggles for the other new settings.** Only Word Wrap was
  asked for.
- **`spellcheck`.** The library has it, but code identifiers are not words; no
  one asked for it.
- **Typing tabs instead of spaces.** The library's `tabSize` always sets a
  spaces indent unit, and there is no live "indent with tabs" option;
  `formatting.useTabs` still shapes only the formatter's output, as today.
- **Per-language `lint`.** See *`lint` ships off, with no per-language
  exceptions*.

---

## Notes

[^flat-keys]: Every existing scalar setting is a flat top-level key; only
    `formatting` is nested, because it passes the library's own
    `FormatOptions` bag straight through. A nested `editor` block would be a
    second nesting convention with a different merge rule to explain. Keeping
    the library's own option names (`lineWrap`, not `wordWrap`) means README
    and the library docs use the same words; the menu row says "Word Wrap"
    because that is what editors call it.

[^defaults]: `CodeEditorOptions` documents `lineWrap`, `highlightWhitespace`
    and `lint` as default `false`, `lineNumbers` as default `true`, and
    `tabSize` as unset; `Body`'s resize mode is `'live'` until changed. Loom
    passes none of these today, so these are exactly today's values.

[^live-setters]: All six options have a setter that caches the value and,
    once the editor is mounted, reconfigures a CodeMirror compartment
    (`CodeEditor.ts`, `setLineWrap`/`setPlaceholder`/`setHighlightWhitespace`/
    `setLint`/`setTabSize`/`setLineNumbers`). None needs the editor rebuilt.
    The mount reads the cached values, so calling the setters before mount is
    the same as passing construction options — which is why one method serves
    both. The setters do not skip an unchanged value: `setLint(true)` reloads
    the lint source, and `setLineNumbers` rebuilds the gutter. The
    getter-compare in `applyEditorSettings` is what keeps a Word Wrap toggle
    from touching anything else in every open editor.

[^tabsize-format]: `CodeEditor.format()` (library `CodeEditor.ts`, the
    `indentWidth` defaulting helper next to `format`) returns the caller's
    options untouched when they carry `indentWidth` or the editor has no
    `tabSize`; otherwise it adds `indentWidth: tabSize`. Loom always passes
    its resolved `formatting` block, which is `{}` unless the user set
    something, so an absent `indentWidth` falls through to `tabSize`. Mapping
    `tabSize` into `formatting.indentWidth` in Loom was rejected: it would
    duplicate the library's own rule and make an explicit `indentWidth`
    impossible to tell apart from a derived one.

[^lint-evidence]: Checked by running `@lezer/javascript` 1.5.4 (the version
    in Loom's `node_modules`) with `dialect: 'ts'`, as the library's
    `javascript({ typescript: true })` does. Isolated constructs that produce
    error nodes: `(x): x is T => …`, `let x!: T`, `export { type T }`,
    `[a: string, b?: number]`, `[string, number?]`, `typeof import('./x')`,
    `declare module 'x' { … }`, `import fs = require('fs')`,
    `abstract new () => object`, and any JSX element. Over real files: 3 of
    Loom's 72 `src`/`tests` TypeScript files and 31 of the first 400 library
    source files contain at least one false error. Plain modern JavaScript
    (optional chaining, private fields, static blocks, `for await`, regex
    flags) parsed clean. Other grammars are much closer: no false errors in
    Loom's JSON files or the library's CSS files, 3 of 80 Python files; JSON
    with comments or a trailing comma is flagged, which is correct for strict
    JSON. Limiting lint per extension in Loom was rejected as a Loom-side
    workaround for a library gap, which `CLAUDE.md` rules out.

[^hint-default]: A placeholder setting whose default is "no hint" would be a
    feature no one sees: users do not write hint text for themselves. The
    useful hint is one Loom writes, and the one fact worth telling a user in
    an empty untitled tab is that it has no language until saved
    (`languageForPath(null)` is `null`; `setPath` picks the language on
    save). The hint only shows in an empty, never-saved buffer and vanishes
    on the first keystroke, so it changes no file and costs nothing to
    ignore. VS Code shows a similar hint in untitled files by default.

[^write-back]: `app-theme-switching.md`'s `[^write-back]` footnote set this
    rule: a toggle that reverts on relaunch is not the feature being asked
    for, only the global file is written because a project's
    `.loom/settings.json` may be committed and shared, and a pinned workspace
    value wins again at the next re-resolution. Word wrap is the same kind of
    personal display preference as the theme. The live value is held in
    `EditorController._editorSettings` rather than read back from one editor,
    because with no file open there is no editor to read, and the next New
    File must still get the toggled value.

[^general-writer]: A second near-copy (`withLineWrap`) would differ from
    `withTheme` by one key. Generalising keeps the one merge rule — raw
    object, unknown fields kept, `version` forced to `1` — in one function.
    The old name has no other caller, so it is deleted rather than kept as a
    wrapper (pre-1.0 rule: unused code is removed). The existing `withTheme`
    tests port directly, so the merge rule stays covered.

[^resize-reach]: `Body.setResizeMode` writes a page-wide value
    (`core/ResizeDrag.ts`, `setAppResizeMode`) that `Split`, `Accordion`,
    `Table` and every window read when a drag starts, unless that owner has
    its own mode. Neither Loom's explorer `Split` nor the `Dock`'s internal
    `Split`s (`overlay/Dock.ts`, `layout/DockRegion.ts`, built with no
    `resizeMode`) set one, so all of them follow the app-wide value. It cannot
    go into `Body.init` in `main.ts`: `Body.init` runs on the module's first
    tick so the web font starts loading early, before settings are read. The
    library's `Split` docs describe the same trade-off: outline mode costs
    nothing while the gutter moves, for a pane with an expensive child such as
    a code editor.

[^reader-table]: The global code conventions ask for a function past ~30
    lines to be split. A table keeps the per-field validation choice visible
    in one place and turns a forgotten field into a type error, which a long
    `if` ladder does not. `FORMATTING_READERS` already does this for the
    nested block, so this is the same file's own pattern applied one level
    up. Existing `parseSettingsOverride` tests compare with `toEqual`, so the
    changed key order in the result does not affect them.
