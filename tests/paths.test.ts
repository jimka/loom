import { describe, it, expect } from 'vitest'
import { baseName, extensionOf, joinPath, sortDirEntries, isUnderRoot, projectName, pathSegments, relativeTo } from '../src/data/paths'

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

describe('projectName', () => {
  it('takes the last segment of a forward-slash path', () => {
    expect(projectName('/home/jika/loom')).toBe('loom')
  })

  it('trims a trailing "/" before splitting', () => {
    expect(projectName('/home/jika/loom/')).toBe('loom')
  })

  it('trims a trailing "\\" before splitting', () => {
    expect(projectName('C:\\dev\\loom\\')).toBe('loom')
  })

  it('falls back to the raw path when trimming leaves nothing', () => {
    expect(projectName('/')).toBe('/')
  })
})

describe('isUnderRoot', () => {
  it('accepts a path inside root', () => {
    expect(isUnderRoot('/p', '/p/src/a.ts')).toBe(true)
  })

  it('accepts the root itself', () => {
    expect(isUnderRoot('/p', '/p')).toBe(true)
  })

  it('rejects a same-prefix sibling', () => {
    expect(isUnderRoot('/p', '/p2/a.ts')).toBe(false)
  })

  it('rejects a same-prefix sibling one level deeper', () => {
    expect(isUnderRoot('/p/src', '/p/src2/a.ts')).toBe(false)
  })

  it('accepts a backslash path inside root', () => {
    expect(isUnderRoot('C:\\p', 'C:\\p\\src\\a.ts')).toBe(true)
  })
})

describe('pathSegments', () => {
  it('splits a forward-slash absolute path into its segments', () => {
    expect(pathSegments('/p/src/main.ts')).toEqual(['p', 'src', 'main.ts'])
  })

  it('splits a forward-slash relative path into its segments', () => {
    expect(pathSegments('src/main.ts')).toEqual(['src', 'main.ts'])
  })

  it('splits a backslash path into its segments', () => {
    expect(pathSegments('C:\\p\\main.ts')).toEqual(['C:', 'p', 'main.ts'])
  })

  it('drops repeated and trailing separators', () => {
    expect(pathSegments('/p//src/')).toEqual(['p', 'src'])
  })

  it('returns an empty array for an empty string', () => {
    expect(pathSegments('')).toEqual([])
  })
})

describe('relativeTo', () => {
  it('rewrites a path below the root as the part below it', () => {
    expect(relativeTo('/p', '/p/src/main.ts')).toBe('src/main.ts')
  })

  it('does not double a trailing separator on the root', () => {
    expect(relativeTo('/p/', '/p/src/main.ts')).toBe('src/main.ts')
  })

  it('returns null for a same-prefix sibling that is not really below the root', () => {
    expect(relativeTo('/p', '/project/a.ts')).toBeNull()
  })

  it('returns null for the root path itself', () => {
    expect(relativeTo('/p', '/p')).toBeNull()
  })

  it('picks the backslash separator when the root contains one', () => {
    expect(relativeTo('C:\\p', 'C:\\p\\src\\main.ts')).toBe('src\\main.ts')
  })

  it('returns null when no project folder is open', () => {
    expect(relativeTo(null, '/p/src/main.ts')).toBeNull()
  })

  it('returns an empty string for the root plus a bare trailing separator', () => {
    expect(relativeTo('/p', '/p/')).toBe('')
  })
})
