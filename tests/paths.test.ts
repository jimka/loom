import { describe, it, expect } from 'vitest'
import { baseName, extensionOf, joinPath, sortDirEntries } from '../src/data/paths'

describe('baseName', () => {
  it('takes the last segment of a forward-slash path', () => {
    expect(baseName('/p/src/main.ts')).toBe('main.ts')
  })

  it('takes the last segment of a backslash path', () => {
    expect(baseName('C:\\p\\src\\main.ts')).toBe('main.ts')
  })

  it('keeps a dotfile whole', () => {
    expect(baseName('/p/.gitignore')).toBe('.gitignore')
  })

  it('keeps an extensionless name whole', () => {
    expect(baseName('/p/Makefile')).toBe('Makefile')
  })

  it('keeps every dot in a multi-dot name', () => {
    expect(baseName('/p/a.b.CSS')).toBe('a.b.CSS')
  })
})

describe('extensionOf', () => {
  it('returns the lowercased extension of a forward-slash path', () => {
    expect(extensionOf('/p/src/main.ts')).toBe('ts')
  })

  it('returns the lowercased extension of a backslash path', () => {
    expect(extensionOf('C:\\p\\src\\main.ts')).toBe('ts')
  })

  it('returns "" for a dotfile whose only dot leads the name', () => {
    expect(extensionOf('/p/.gitignore')).toBe('')
  })

  it('returns "" for a name with no dot', () => {
    expect(extensionOf('/p/Makefile')).toBe('')
  })

  it('splits on the last dot and lowercases it', () => {
    expect(extensionOf('/p/a.b.CSS')).toBe('css')
  })
})

describe('joinPath', () => {
  it('joins with "/" when the parent has no trailing separator', () => {
    expect(joinPath('/p/src', 'main.ts')).toBe('/p/src/main.ts')
  })

  it('joins with the parent\'s own "\\" separator', () => {
    expect(joinPath('C:\\p\\src', 'main.ts')).toBe('C:\\p\\src\\main.ts')
  })

  it('does not double a trailing separator', () => {
    expect(joinPath('/p/src/', 'main.ts')).toBe('/p/src/main.ts')
  })
})

describe('sortDirEntries', () => {
  it('sorts directories before files, each group case-insensitively by name', () => {
    const input = [
      { name: 'README.md', isDir: false },
      { name: 'src', isDir: true },
      { name: 'a.ts', isDir: false },
      { name: 'Docs', isDir: true },
    ]

    expect(sortDirEntries(input).map(e => e.name)).toEqual(['Docs', 'src', 'a.ts', 'README.md'])
  })

  it('breaks a case-insensitive tie with the raw name', () => {
    const input = [
      { name: 'test', isDir: false },
      { name: 'Test', isDir: false },
    ]

    expect(sortDirEntries(input).map(e => e.name)).toEqual(['Test', 'test'])
  })
})
