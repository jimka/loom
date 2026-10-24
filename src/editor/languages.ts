// Extension → language id map. Every id it resolves to is one of the
// library's own built-in languages (javascript, json, html, sql, markdown,
// css, python), which the `@jimka/typescript-ui/component/editor` barrel
// registers as an import side effect, so this module registers nothing itself.
import { getLanguage } from '@jimka/typescript-ui/component/editor'
import { extensionOf } from '../data/paths'

/** The language id `languageForPath` resolves Markdown extensions to.
 *  {@link isMarkdownPath} compares against this same constant, so the two
 *  can never disagree about what counts as Markdown. */
const MARKDOWN_LANGUAGE = 'markdown'

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'javascript',
    tsx: 'javascript',
    mts: 'javascript',
    cts: 'javascript',
    json: 'json',
    html: 'html',
    htm: 'html',
    sql: 'sql',
    md: MARKDOWN_LANGUAGE,
    markdown: MARKDOWN_LANGUAGE,
    css: 'css',
    py: 'python',
}

/**
 * Resolves the CodeEditor language id for a file, from its extension. A file
 * with no extension, or one that maps to no known language, has none — nor
 * does a path-less buffer that has never been saved.
 *
 * @param path - The file path, or `null` for a buffer with no path yet.
 * @returns The language id, or `null` when the extension is unrecognised or `path` is `null`.
 */
export function languageForPath(path: string | null): string | null {
    if (path === null) {
        return null
    }

    return EXTENSION_TO_LANGUAGE[extensionOf(path)] ?? null
}

/**
 * Whether `path` names a Markdown file, by the same extension map
 * {@link languageForPath} resolves against.
 *
 * @param path - The file path, or `null` for a buffer with no path yet.
 * @returns `true` when the path's language is Markdown.
 */
export function isMarkdownPath(path: string | null): boolean {
    return languageForPath(path) === MARKDOWN_LANGUAGE
}

/**
 * Whether a language has a registered formatter — the question format-on-save
 * asks before reformatting a document. `false` for a language the library
 * registers with a grammar only (`python`), for an id no one registered, and
 * for a buffer with no language at all.
 *
 * @param languageId - A `CodeEditor` language id, or `null` when the editor has none.
 * @returns `true` when `CodeEditor.format()` would run a real formatter rather
 *   than its whole-document re-indent fallback.
 */
export function hasFormatter(languageId: string | null): boolean {
    return languageId !== null && getLanguage(languageId)?.loadFormatter !== undefined
}
