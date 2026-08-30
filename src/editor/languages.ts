// Extension → language id map, plus the two CodeMirror grammars the library
// doesn't ship. registerLanguage is called once here, at module scope,
// mirroring how the library's own component/editor barrel registers its
// five built-ins (javascript, json, html, sql, markdown) as an import side
// effect — importing this module is what makes css/python available too.
import { registerLanguage } from '@jimka/typescript-ui/component/editor'
import { extensionOf } from '../data/paths'

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
  md: 'markdown',
  markdown: 'markdown',
  css: 'css',
  py: 'python',
}

/**
 * Resolves the CodeEditor language id for a file, from its extension. A file
 * with no extension, or one that maps to no known language, has none.
 *
 * @param path - The file path.
 * @returns The language id, or `null` when the extension is unrecognised.
 */
export function languageForPath(path: string): string | null {
  return EXTENSION_TO_LANGUAGE[extensionOf(path)] ?? null
}

registerLanguage({
  id: 'css',
  label: 'CSS',
  loadExtension: async () => {
    const { css } = await import('@codemirror/lang-css')

    return css()
  },
})

registerLanguage({
  id: 'python',
  label: 'Python',
  loadExtension: async () => {
    const { python } = await import('@codemirror/lang-python')

    return python()
  },
})
