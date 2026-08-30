import { describe, it, expect } from 'vitest'
import { languageForPath } from '../src/editor/languages'

describe('languageForPath', () => {
  it('resolves .ts to javascript', () => {
    expect(languageForPath('/p/src/main.ts')).toBe('javascript')
  })

  it('resolves .tsx to javascript', () => {
    expect(languageForPath('/p/src/app.tsx')).toBe('javascript')
  })

  it('resolves .md to markdown', () => {
    expect(languageForPath('/p/README.md')).toBe('markdown')
  })

  it('resolves an uppercase extension case-insensitively to the app-registered css', () => {
    expect(languageForPath('/p/style.CSS')).toBe('css')
  })

  it('resolves a dotfile with no extension to null', () => {
    expect(languageForPath('/p/.gitignore')).toBeNull()
  })

  it('resolves an extensionless name to null', () => {
    expect(languageForPath('/p/Makefile')).toBeNull()
  })

  it('resolves an unrecognised extension to null', () => {
    expect(languageForPath('/p/data.bin')).toBeNull()
  })

  it('resolves every javascript extension', () => {
    for (const ext of ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts']) {
      expect(languageForPath(`/p/f.${ext}`)).toBe('javascript')
    }
  })

  it('resolves .json to json', () => {
    expect(languageForPath('/p/f.json')).toBe('json')
  })

  it('resolves .html and .htm to html', () => {
    expect(languageForPath('/p/f.html')).toBe('html')
    expect(languageForPath('/p/f.htm')).toBe('html')
  })

  it('resolves .sql to sql', () => {
    expect(languageForPath('/p/f.sql')).toBe('sql')
  })

  it('resolves .markdown to markdown', () => {
    expect(languageForPath('/p/f.markdown')).toBe('markdown')
  })

  it('resolves .py to the app-registered python', () => {
    expect(languageForPath('/p/f.py')).toBe('python')
  })
})
