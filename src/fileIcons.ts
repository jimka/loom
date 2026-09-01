// Base-name and extension → icon maps for the file tree and tab strip. Every
// glyph is a per-icon import from the library's bundled Font Awesome set, so
// a bundler drops the several thousand icons this module doesn't reference.
import type { NamedGlyphDef } from '@jimka/typescript-ui/component/display'
import { baseName, extensionOf } from './data/paths'
import { git_alt } from '@jimka/typescript-ui/glyphs/brands/git_alt'
import { docker } from '@jimka/typescript-ui/glyphs/brands/docker'
import { node_js } from '@jimka/typescript-ui/glyphs/brands/node_js'
import { rust } from '@jimka/typescript-ui/glyphs/brands/rust'
import { js } from '@jimka/typescript-ui/glyphs/brands/js'
import { python } from '@jimka/typescript-ui/glyphs/brands/python'
import { html5 } from '@jimka/typescript-ui/glyphs/brands/html5'
import { css3_alt } from '@jimka/typescript-ui/glyphs/brands/css3_alt'
import { sass } from '@jimka/typescript-ui/glyphs/brands/sass'
import { markdown } from '@jimka/typescript-ui/glyphs/brands/markdown'
import { gear } from '@jimka/typescript-ui/glyphs/solid/gear'
import { database } from '@jimka/typescript-ui/glyphs/solid/database'
import { terminal } from '@jimka/typescript-ui/glyphs/solid/terminal'
import { file_code } from '@jimka/typescript-ui/glyphs/solid/file_code'
import { file_lines } from '@jimka/typescript-ui/glyphs/solid/file_lines'
import { file_csv } from '@jimka/typescript-ui/glyphs/solid/file_csv'
import { file_image } from '@jimka/typescript-ui/glyphs/solid/file_image'
import { file_pdf } from '@jimka/typescript-ui/glyphs/solid/file_pdf'
import { file_zipper } from '@jimka/typescript-ui/glyphs/solid/file_zipper'
import { file } from '@jimka/typescript-ui/glyphs/solid/file'

/** Base names (lowercased) whose type lives in the whole name, not the suffix. */
const BASE_NAME_TO_GLYPH: Record<string, NamedGlyphDef> = {
  '.gitignore': git_alt,
  '.gitattributes': git_alt,
  '.gitmodules': git_alt,
  dockerfile: docker,
  'package.json': node_js,
  'package-lock.json': node_js,
  'cargo.toml': rust,
  'cargo.lock': rust,
  makefile: gear,
  '.env': gear,
}

/** Extensions (lowercased, as {@link extensionOf} returns them) → icon. */
const EXTENSION_TO_GLYPH: Record<string, NamedGlyphDef> = {
  js,
  jsx: js,
  mjs: js,
  cjs: js,
  ts: js,
  tsx: js,
  mts: js,
  cts: js,
  py: python,
  html: html5,
  htm: html5,
  css: css3_alt,
  scss: sass,
  sass,
  md: markdown,
  markdown,
  rs: rust,
  sql: database,
  db: database,
  sqlite: database,
  sh: terminal,
  bash: terminal,
  zsh: terminal,
  ps1: terminal,
  bat: terminal,
  cmd: terminal,
  json: file_code,
  xml: file_code,
  toml: gear,
  yaml: gear,
  yml: gear,
  ini: gear,
  cfg: gear,
  conf: gear,
  txt: file_lines,
  log: file_lines,
  csv: file_csv,
  tsv: file_csv,
  png: file_image,
  jpg: file_image,
  jpeg: file_image,
  gif: file_image,
  svg: file_image,
  webp: file_image,
  ico: file_image,
  bmp: file_image,
  pdf: file_pdf,
  zip: file_zipper,
  tar: file_zipper,
  gz: file_zipper,
  tgz: file_zipper,
  xz: file_zipper,
  '7z': file_zipper,
  rar: file_zipper,
}

/** Shown for any file neither table recognises. */
const DEFAULT_GLYPH: NamedGlyphDef = file

/**
 * Every glyph definition the two tables can return, deduplicated. `main.ts`
 * registers these. `glyphNameForPath` never returns a name outside this list,
 * because `new Glyph(name)` throws on an unregistered name.
 */
export const FILE_ICON_GLYPHS: readonly NamedGlyphDef[] = Array.from(new Set<NamedGlyphDef>([
  ...Object.values(BASE_NAME_TO_GLYPH),
  ...Object.values(EXTENSION_TO_GLYPH),
  DEFAULT_GLYPH,
]))

/**
 * Resolves the Glyph registry name for a file, from its base name first and
 * its extension second. A file matching neither table gets the plain-page
 * default, so this never returns an unregistered name.
 *
 * @param path - The file path.
 * @returns A glyph registry name that is always present in `FILE_ICON_GLYPHS`.
 */
export function glyphNameForPath(path: string): string {
  const nameKey = baseName(path).toLowerCase()

  // Object.hasOwn, not a truthiness/`in` check: a file literally named
  // "constructor" or "__proto__" must not resolve through Object.prototype
  // to an unregistered glyph name, which would throw at render time.
  if (Object.hasOwn(BASE_NAME_TO_GLYPH, nameKey)) {
    return BASE_NAME_TO_GLYPH[nameKey].name
  }

  const extKey = extensionOf(path)

  if (Object.hasOwn(EXTENSION_TO_GLYPH, extKey)) {
    return EXTENSION_TO_GLYPH[extKey].name
  }

  return DEFAULT_GLYPH.name
}
