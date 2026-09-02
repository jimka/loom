import { describe, it, expect } from 'vitest'
import { glyphNameForPath, FILE_ICON_GLYPHS } from '../src/fileIcons'

describe('glyphNameForPath', () => {
  it('resolves .ts to the js icon (extension hit)', () => {
    expect(glyphNameForPath('/p/src/main.ts')).toBe('js')
  })

  it('resolves .tsx to the js icon (every javascript-family extension shares one icon)', () => {
    expect(glyphNameForPath('/p/src/app.tsx')).toBe('js')
  })

  it('resolves an uppercase extension case-insensitively', () => {
    expect(glyphNameForPath('/p/style.CSS')).toBe('css3-alt')
  })

  it('resolves .md to the markdown icon', () => {
    expect(glyphNameForPath('/p/README.md')).toBe('markdown')
  })

  it('lets a base-name row beat the json extension row', () => {
    expect(glyphNameForPath('/p/package.json')).toBe('node-js')
  })

  it('falls back to the extension row when there is no base-name row', () => {
    expect(glyphNameForPath('/p/other.json')).toBe('file-code')
  })

  it('resolves a dotfile via the base-name table', () => {
    expect(glyphNameForPath('/p/.gitignore')).toBe('git-alt')
  })

  it('resolves an extensionless name via the base-name table', () => {
    expect(glyphNameForPath('/p/Dockerfile')).toBe('docker')
  })

  it('matches a base-name row case-insensitively', () => {
    expect(glyphNameForPath('/p/DOCKERFILE')).toBe('docker')
  })

  it('lets a base-name row beat the toml extension row', () => {
    expect(glyphNameForPath('/p/src-tauri/Cargo.toml')).toBe('rust')
  })

  it('falls back to the extension row for an unmatched base name', () => {
    expect(glyphNameForPath('/p/other.toml')).toBe('gear')
  })

  it('resolves an unknown extension to the default icon', () => {
    expect(glyphNameForPath('/p/notes.bin')).toBe('file')
  })

  it('resolves an extensionless base-name match', () => {
    expect(glyphNameForPath('/p/Makefile')).toBe('gear')
  })

  it('splits a backslash path on both separators', () => {
    expect(glyphNameForPath('C:\\p\\src\\main.ts')).toBe('js')
  })

  it('does not resolve a prototype-chain property name to an unregistered icon', () => {
    // Both tables are plain object literals; an unguarded `obj[key]` lookup
    // would hit inherited Object.prototype members for a file named exactly
    // "constructor" or "__proto__", returning a name FILE_ICON_GLYPHS never
    // registers and throwing at render time.
    expect(glyphNameForPath('/p/constructor')).toBe('file')
    expect(glyphNameForPath('/p/x.constructor')).toBe('file')
    expect(glyphNameForPath('/p/__proto__')).toBe('file')
  })

  it('resolves an untitled buffer\'s bare display name to the default icon', () => {
    // EditorController.newFile() passes an untitled tab's display name
    // (e.g. "Untitled-1") straight through, rather than a path — an
    // extensionless base name that also has no base-name-table row, unlike
    // Makefile/Dockerfile above, so it falls all the way to DEFAULT_GLYPH.
    expect(glyphNameForPath('Untitled-1')).toBe('file')
  })
})

describe('FILE_ICON_GLYPHS', () => {
  it('contains no duplicate registry names', () => {
    expect(new Set(FILE_ICON_GLYPHS.map(g => g.name)).size).toBe(FILE_ICON_GLYPHS.length)
  })

  it('covers every result glyphNameForPath can produce', () => {
    const paths = [
      '/p/src/main.ts',
      '/p/src/app.tsx',
      '/p/style.CSS',
      '/p/README.md',
      '/p/package.json',
      '/p/other.json',
      '/p/.gitignore',
      '/p/Dockerfile',
      '/p/DOCKERFILE',
      '/p/src-tauri/Cargo.toml',
      '/p/other.toml',
      '/p/notes.bin',
      '/p/Makefile',
      'C:\\p\\src\\main.ts',
    ]

    for (const path of paths) {
      expect(FILE_ICON_GLYPHS.some(g => g.name === glyphNameForPath(path))).toBe(true)
    }
  })
})
