// Pure settings shape, parser, and merge rule — no Tauri imports, so it runs
// in vitest's `node` environment. `src/shell/settings.ts` owns the
// Tauri-backed read/write and the two-layer resolution this module's shape
// feeds, mirroring the `session`/`workspaceState` split.

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
export const DEFAULT_SETTINGS: Settings = {
    formatOnSave: true,
    showHiddenFiles: false,
    showIgnoredFiles: false,
    titleBarTemplate: '{dirty}{name} — {app}',
    // Long enough for most file names, short enough that several tabs still
    // fit the strip — mirrors the value `TAB_MAX_WIDTH` hardcoded before this
    // setting existed (src/EditorController.ts).
    tabMaxWidthPx: 200,
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
    const showHiddenFiles = readOptionalBoolean(doc.showHiddenFiles)
    const showIgnoredFiles = readOptionalBoolean(doc.showIgnoredFiles)
    const titleBarTemplate = readOptionalNonEmptyString(doc.titleBarTemplate)
    const tabMaxWidthPx = readOptionalPositiveNumber(doc.tabMaxWidthPx)

    if (formatOnSave !== undefined) {
        override.formatOnSave = formatOnSave
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
    let parsed: unknown

    try {
        parsed = JSON.parse(text)
    } catch {
        return null
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return null
    }

    const doc = parsed as Record<string, unknown>

    if (doc.version !== 1) {
        return null
    }

    return doc
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
