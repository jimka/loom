// Pure settings shape, parser, and merge rule — no Tauri imports, so it runs
// in vitest's `node` environment. `src/shell/settings.ts` owns the
// Tauri-backed read/write and the two-layer resolution this module's shape
// feeds, mirroring the `session`/`workspaceState` split.
import type { FormatOptions } from '@jimka/typescript-ui/component/editor'

/** The app's theme choices: `'light'` is the library's own default look. */
export type ThemeName = 'light' | 'dark'

/** The fully resolved settings the app runs with — always complete, never partial. */
export interface Settings {
    /** Whether saving reformats the document first, for a language with a registered formatter. */
    formatOnSave: boolean
    /** Style options handed to `CodeEditor.format()`; an absent field leaves that formatter's own default alone. */
    formatting: FormatOptions
    /** Whether the tree shows hidden (leading-dot) entries by default. */
    showHiddenFiles: boolean
    /** Whether the tree shows `.gitignore`-ignored entries by default. */
    showIgnoredFiles: boolean
    /** The window title template for when a file is active; see {@link renderTitle}. */
    titleBarTemplate: string
    /** The tab strip's per-tab width cap in `"content"` mode, in pixels. */
    tabMaxWidthPx: number
    /** Which of the library's built-in themes the app is painted with. */
    theme: ThemeName
}

/** One settings file's contents: every field optional, `undefined` meaning "inherit from the next layer down." */
export interface SettingsOverride {
    version: 1
    formatOnSave?: boolean
    formatting?: FormatOptions
    showHiddenFiles?: boolean
    showIgnoredFiles?: boolean
    titleBarTemplate?: string
    tabMaxWidthPx?: number
    theme?: ThemeName
}

/** What every setting is when no file overrides it — today's exact hardcoded behaviour. */
export const DEFAULT_SETTINGS: Settings = {
    formatOnSave: true,
    // Empty by design: an absent field means "leave that formatter's own
    // default alone", so a fresh install formats exactly as it did before
    // this setting existed and Loom restates no engine's defaults.
    formatting: {},
    showHiddenFiles: false,
    showIgnoredFiles: false,
    titleBarTemplate: '{dirty}{name} — {app}',
    // Long enough for most file names, short enough that several tabs still
    // fit the strip — mirrors the value `TAB_MAX_WIDTH` hardcoded before this
    // setting existed (src/EditorController.ts).
    tabMaxWidthPx: 200,
    // The library's own default look — a fresh install with no settings file
    // at all looks exactly as it did before this setting existed.
    theme: 'light',
}

/** A freshly-created settings file's contents: no field set, so everything inherits. */
export function emptySettingsOverride(): SettingsOverride {
    return { version: 1 }
}

/**
 * Merges the two override layers onto {@link DEFAULT_SETTINGS}, field by
 * field, `workspace` winning over `global`. An absent layer (either argument
 * `null`) contributes nothing to the merge, so a workspace file overriding
 * only one field still inherits every other field from the global file, or
 * the hardcoded default when the global file doesn't set it either.
 *
 * @param global - The app-wide settings file's parsed override, or `null` when absent/unusable.
 * @param workspace - The project's own settings file's parsed override, or `null` when absent/unusable/not applicable.
 * @returns The fully resolved settings.
 */
export function resolveSettings(global: SettingsOverride | null, workspace: SettingsOverride | null): Settings {
    return {
        formatOnSave: workspace?.formatOnSave ?? global?.formatOnSave ?? DEFAULT_SETTINGS.formatOnSave,
        formatting: { ...DEFAULT_SETTINGS.formatting, ...global?.formatting, ...workspace?.formatting },
        showHiddenFiles: workspace?.showHiddenFiles ?? global?.showHiddenFiles ?? DEFAULT_SETTINGS.showHiddenFiles,
        showIgnoredFiles: workspace?.showIgnoredFiles ?? global?.showIgnoredFiles ?? DEFAULT_SETTINGS.showIgnoredFiles,
        titleBarTemplate: workspace?.titleBarTemplate ?? global?.titleBarTemplate ?? DEFAULT_SETTINGS.titleBarTemplate,
        tabMaxWidthPx: workspace?.tabMaxWidthPx ?? global?.tabMaxWidthPx ?? DEFAULT_SETTINGS.tabMaxWidthPx,
        theme: workspace?.theme ?? global?.theme ?? DEFAULT_SETTINGS.theme,
    }
}

/**
 * Expands `template`'s placeholders: `{dirty}` first (`'• '` when
 * `vars.dirty`, `''` otherwise), then `{app}`, then `{name}` last — in that
 * order, so a file literally named `{app}.ts` can't have its own name
 * re-substituted by an earlier replacement pass.
 *
 * @param template - The title template, e.g. `'{dirty}{name} — {app}'`.
 * @param vars - The values to substitute for each placeholder.
 * @returns The expanded title.
 */
export function renderTitle(template: string, vars: { name: string; app: string; dirty: boolean }): string {
    return template
        .replaceAll('{dirty}', vars.dirty ? '• ' : '')
        .replaceAll('{app}', vars.app)
        .replaceAll('{name}', vars.name)
}

/** Renders a settings override as the JSON text written to disk. */
export function serializeSettingsOverride(override: SettingsOverride): string {
    return JSON.stringify(override, null, 2)
}

/**
 * Parses `text`'s text, dropping any field of the wrong type; `null` when the
 * document itself is unusable — not JSON, not an object, or a `version`
 * other than `1`.
 *
 * @param text - The settings file's raw text.
 * @returns The parsed override, or `null` when `text` is unusable.
 */
export function parseSettingsOverride(text: string): SettingsOverride | null {
    const doc = parseDocument(text)

    if (doc === null) {
        return null
    }

    const override: SettingsOverride = { version: 1 }
    const formatOnSave = readOptionalBoolean(doc.formatOnSave)
    const formatting = parseFormatting(doc.formatting)
    const showHiddenFiles = readOptionalBoolean(doc.showHiddenFiles)
    const showIgnoredFiles = readOptionalBoolean(doc.showIgnoredFiles)
    const titleBarTemplate = readOptionalNonEmptyString(doc.titleBarTemplate)
    const tabMaxWidthPx = readOptionalPositiveNumber(doc.tabMaxWidthPx)
    const theme = readOptionalChoice(doc.theme, THEME_CHOICES)

    if (formatOnSave !== undefined) {
        override.formatOnSave = formatOnSave
    }

    if (formatting !== undefined) {
        override.formatting = formatting
    }

    if (showHiddenFiles !== undefined) {
        override.showHiddenFiles = showHiddenFiles
    }

    if (showIgnoredFiles !== undefined) {
        override.showIgnoredFiles = showIgnoredFiles
    }

    if (titleBarTemplate !== undefined) {
        override.titleBarTemplate = titleBarTemplate
    }

    if (tabMaxWidthPx !== undefined) {
        override.tabMaxWidthPx = tabMaxWidthPx
    }

    if (theme !== undefined) {
        override.theme = theme
    }

    return override
}

/**
 * Parses `text` as JSON and validates the top-level shape: an object with
 * `version: 1`. Anything else — invalid JSON, a non-object, an array, or a
 * different version — is not a usable settings document. Identical in shape
 * to `parseWorkspaceState`'s own `parseDocument` (../data/workspaceState.ts).
 *
 * @param text - The raw text to parse.
 * @returns The parsed document, or `null` when it is not a usable settings override.
 */
function parseDocument(text: string): Record<string, unknown> | null {
    const doc = parseJsonObject(text)

    if (doc === null || doc.version !== 1) {
        return null
    }

    return doc
}

/**
 * Parses `text` as JSON and validates only that the top level is a plain
 * object — no `version` check, unlike {@link parseDocument}. Split out for
 * {@link withTheme}, which merges onto whatever fields a document already
 * has regardless of its version, rather than onto `parseSettingsOverride`'s
 * sanitized result.
 *
 * @param text - The raw text to parse.
 * @returns The parsed object, or `null` when `text` isn't a JSON object.
 */
function parseJsonObject(text: string): Record<string, unknown> | null {
    let parsed: unknown

    try {
        parsed = JSON.parse(text)
    } catch {
        return null
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return null
    }

    return parsed as Record<string, unknown>
}

/**
 * Renders the settings-file text with `theme` set, every other field left as
 * it was. Merges onto the file's **raw** parsed object rather than
 * `parseSettingsOverride`'s sanitized result, so a field the parser doesn't
 * recognise or rejects survives the write instead of being silently dropped.
 *
 * @param text - The settings file's current raw text, or `null` when the file doesn't exist yet.
 * @param theme - The theme to record.
 * @returns The settings-file text to write.
 */
export function withTheme(text: string | null, theme: ThemeName): string {
    const doc = text === null ? null : parseJsonObject(text)

    // `version: 1` after the spread: a file carrying some other version keeps
    // every field it had and starts being read again. Indented to 2 spaces to
    // match `serializeSettingsOverride`.
    return JSON.stringify({ ...(doc ?? {}), version: 1, theme }, null, 2)
}

/**
 * Reads a field expected to be a boolean.
 *
 * @param value - The field's raw value.
 * @returns The boolean, or `undefined` when absent or the wrong type.
 */
function readOptionalBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined
}

/**
 * Reads a field expected to be a non-empty string.
 *
 * @param value - The field's raw value.
 * @returns The string, or `undefined` when absent, the wrong type, or empty.
 */
function readOptionalNonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Reads a field expected to be a positive number.
 *
 * @param value - The field's raw value.
 * @returns The number, or `undefined` when absent, the wrong type, or not positive.
 */
function readOptionalPositiveNumber(value: unknown): number | undefined {
    return typeof value === 'number' && value > 0 ? value : undefined
}

/**
 * Reads a field expected to be a positive whole number. Stricter than
 * {@link readOptionalPositiveNumber} because Prettier rejects a fractional
 * `tabWidth`/`printWidth` outright rather than rounding it.
 *
 * @param value - The field's raw value.
 * @returns The integer, or `undefined` when absent, the wrong type, fractional, or not positive.
 */
function readOptionalPositiveInteger(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * Reads a field expected to be one of a fixed set of strings.
 *
 * @param value - The field's raw value.
 * @param choices - The allowed values.
 * @returns The matching choice, or `undefined` when absent, the wrong type, or not listed.
 */
function readOptionalChoice<T extends string>(value: unknown, choices: readonly T[]): T | undefined {
    return typeof value === 'string' && (choices as readonly string[]).includes(value) ? value as T : undefined
}

const TRAILING_COMMA_CHOICES = ['none', 'es5', 'all'] as const
const ARROW_PARENS_CHOICES = ['always', 'avoid'] as const
const PROSE_WRAP_CHOICES = ['always', 'never', 'preserve'] as const
const HTML_WHITESPACE_CHOICES = ['css', 'strict', 'ignore'] as const
const KEYWORD_CASE_CHOICES = ['preserve', 'upper', 'lower'] as const

/** The top-level `theme` field's allowed values — kept as a choice list, like the `formatting` block's enum fields above, rather than a boolean, so a third theme can join later with no schema change. */
const THEME_CHOICES: readonly ThemeName[] = ['light', 'dark']

/**
 * Every {@link FormatOptions} field, mapped to the reader that validates it.
 * The `satisfies` clause is what makes this table exhaustive: a field with
 * no reader here, or a reader whose return type doesn't match the field's,
 * is a compile error rather than a setting that silently never applies.
 */
const FORMATTING_READERS = {
    indentWidth: readOptionalPositiveInteger,
    useTabs: readOptionalBoolean,
    lineWidth: readOptionalPositiveInteger,
    singleQuote: readOptionalBoolean,
    semicolons: readOptionalBoolean,
    trailingComma: (value: unknown) => readOptionalChoice(value, TRAILING_COMMA_CHOICES),
    arrowParens: (value: unknown) => readOptionalChoice(value, ARROW_PARENS_CHOICES),
    bracketSpacing: readOptionalBoolean,
    proseWrap: (value: unknown) => readOptionalChoice(value, PROSE_WRAP_CHOICES),
    htmlWhitespaceSensitivity: (value: unknown) => readOptionalChoice(value, HTML_WHITESPACE_CHOICES),
    keywordCase: (value: unknown) => readOptionalChoice(value, KEYWORD_CASE_CHOICES),
} satisfies { [K in keyof FormatOptions]-?: (value: unknown) => FormatOptions[K] | undefined }

/**
 * Reads the `formatting` block, dropping every field of the wrong type or
 * outside its allowed values; `undefined` when the block is absent, is not
 * an object, or has no usable field left.
 *
 * @param value - The raw `formatting` value from the settings document.
 * @returns The parsed options, or `undefined` when nothing usable survived.
 */
function parseFormatting(value: unknown): FormatOptions | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined
    }

    const doc = value as Record<string, unknown>
    const formatting: Record<string, unknown> = {}

    for (const [field, read] of Object.entries(FORMATTING_READERS)) {
        const parsed = read(doc[field])

        // Assigned only when defined, so the block never holds a key whose
        // value is `undefined` — the merge in `resolveSettings` and
        // `sql-formatter` downstream both depend on that.
        if (parsed !== undefined) {
            formatting[field] = parsed
        }
    }

    // The reader table is the type bridge: each key was written by the
    // reader declared for that exact field, which a string-keyed write
    // cannot express.
    return Object.keys(formatting).length === 0 ? undefined : formatting as FormatOptions
}
