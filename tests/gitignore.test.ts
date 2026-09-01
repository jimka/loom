import { describe, it, expect } from 'vitest'
import {
  isHiddenName, extendIgnoreChain, isIgnoredByChain, buildRootIgnoreChain, EMPTY_IGNORE_CHAIN,
} from '../src/data/gitignore'
import type { IgnoreChain, TryReadTextFile, PathExists } from '../src/data/gitignore'

describe('isHiddenName', () => {
  it('treats a leading-dot name as hidden', () => {
    expect(isHiddenName('.gitignore')).toBe(true)
    expect(isHiddenName('.git')).toBe(true)
    expect(isHiddenName('.env')).toBe(true)
  })

  it('treats an ordinary name as not hidden', () => {
    expect(isHiddenName('src')).toBe(false)
    expect(isHiddenName('README.md')).toBe(false)
    expect(isHiddenName('a.b.c')).toBe(false)
  })

  it('treats an empty name as not hidden', () => {
    expect(isHiddenName('')).toBe(false)
  })
})

describe('extendIgnoreChain', () => {
  it('returns the same chain, unchanged, when text is null', () => {
    const chain = extendIgnoreChain(EMPTY_IGNORE_CHAIN, '/p', '*.log\n')

    expect(extendIgnoreChain(chain, '/p/app', null)).toBe(chain)
    expect(extendIgnoreChain(chain, '/p/app', null).length).toBe(chain.length)
  })

  it('returns a chain one layer longer, with the new layer last, leaving the input untouched', () => {
    const chain = extendIgnoreChain(EMPTY_IGNORE_CHAIN, '/p', '*.log\n')
    const extended = extendIgnoreChain(chain, '/p/app', '!debug.log\n')

    expect(extended.length).toBe(chain.length + 1)
    expect(extended[extended.length - 1].dir).toBe('/p/app')
    expect(chain.length).toBe(1)
  })
})

/**
 * Builds the two-layer chain the plan's precedence table is verified
 * against: `/p/.gitignore` = `*.log` + `build/`, `/p/app/.gitignore` =
 * `!debug.log`.
 */
function buildSampleChain(): IgnoreChain {
  const outer = extendIgnoreChain(EMPTY_IGNORE_CHAIN, '/p', '*.log\nbuild/\n')

  return extendIgnoreChain(outer, '/p/app', '!debug.log\n')
}

describe('isIgnoredByChain', () => {
  it('lets a deeper negation override a shallower pattern', () => {
    const chain = buildSampleChain()

    expect(isIgnoredByChain(chain, '/p/app/debug.log', false)).toBe(false)
  })

  it('reaches an outer layer when the inner layer is silent', () => {
    const chain = buildSampleChain()

    expect(isIgnoredByChain(chain, '/p/app/other.log', false)).toBe(true)
  })

  it('matches a directory-only pattern against a directory', () => {
    const chain = buildSampleChain()

    expect(isIgnoredByChain(chain, '/p/build', true)).toBe(true)
  })

  it('does not match a directory-only pattern against a same-named file', () => {
    const chain = buildSampleChain()

    expect(isIgnoredByChain(chain, '/p/build.txt', false)).toBe(false)
  })

  it('returns false for an empty chain', () => {
    expect(isIgnoredByChain(EMPTY_IGNORE_CHAIN, '/p/a.log', false)).toBe(false)
  })

  it('returns false and does not throw for a path outside every layer', () => {
    const chain = buildSampleChain()

    expect(() => isIgnoredByChain(chain, '/other/a.log', false)).not.toThrow()
    expect(isIgnoredByChain(chain, '/other/a.log', false)).toBe(false)
  })

  it('returns false and does not throw for a path naming a layer\'s own directory, trailing separator included', () => {
    const chain = buildSampleChain()

    expect(() => isIgnoredByChain(chain, '/p/app/', true)).not.toThrow()
    expect(isIgnoredByChain(chain, '/p/app/', true)).toBe(false)
  })

  it('matches case-sensitively', () => {
    const chain = extendIgnoreChain(EMPTY_IGNORE_CHAIN, '/p', '*.LOG\n')

    expect(isIgnoredByChain(chain, '/p/a.log', false)).toBe(false)
  })

  it('matches a nested path against an outer layer', () => {
    const chain = extendIgnoreChain(EMPTY_IGNORE_CHAIN, '/p', 'node_modules\n')

    expect(isIgnoredByChain(chain, '/p/app/node_modules', true)).toBe(true)
  })
})

/**
 * In-memory fakes for {@link buildRootIgnoreChain}'s two injected
 * dependencies: `files` backs `tryReadTextFile`, `dirs` backs `pathExists`.
 */
function makeFakes(files: Map<string, string>, dirs: Set<string>): { tryReadTextFile: TryReadTextFile; pathExists: PathExists } {
  return {
    tryReadTextFile: async (path: string) => files.get(path) ?? null,
    pathExists: async (path: string) => dirs.has(path),
  }
}

describe('buildRootIgnoreChain', () => {
  it('seeds the exclude file then the gitignore, both anchored at the repository root, with the gitignore taking precedence', async () => {
    const dirs = new Set(['/home/u/proj/.git'])
    // Conflicting content, not just distinct dirs: if the two layers landed
    // in the wrong order, `isIgnoredByChain` (innermost/last layer wins)
    // would see the exclude file's "a" last and return `true` instead.
    const files = new Map([
      ['/home/u/proj/.git/info/exclude', 'a\n'],
      ['/home/u/proj/.gitignore', '!a\n'],
    ])
    const { tryReadTextFile, pathExists } = makeFakes(files, dirs)

    const chain = await buildRootIgnoreChain('/home/u/proj/src', tryReadTextFile, pathExists)

    expect(chain.length).toBe(2)
    expect(chain[0].dir).toBe('/home/u/proj')
    expect(chain[1].dir).toBe('/home/u/proj')
    expect(isIgnoredByChain(chain, '/home/u/proj/a', false)).toBe(false)
  })

  it('seeds only the exclude file — never the opened folder\'s own .gitignore — when the opened folder is the repository root itself', async () => {
    const dirs = new Set(['/home/u/proj/.git'])
    // Distinguishable content, so the single seeded layer's identity is
    // pinned, not just its count: an implementation that seeded the root's
    // own .gitignore in the exclude file's place — exactly the confusion
    // this architecture decision exists to prevent, since loadDirectory adds
    // that file itself when it lists the opened folder — would still pass a
    // length-only assertion.
    const files = new Map([
      ['/home/u/proj/.git/info/exclude', 'exclude-only\n'],
      ['/home/u/proj/.gitignore', '!exclude-only\n'],
    ])
    const { tryReadTextFile, pathExists } = makeFakes(files, dirs)

    const chain = await buildRootIgnoreChain('/home/u/proj', tryReadTextFile, pathExists)

    expect(chain.length).toBe(1)
    expect(isIgnoredByChain(chain, '/home/u/proj/exclude-only', false)).toBe(true)
  })

  it('orders three layers root-exclude, root-gitignore, then the intermediate directory gitignore, with each override taking effect', async () => {
    const dirs = new Set(['/home/u/proj/.git'])
    // "a" conflicts between the root exclude and root gitignore, the same
    // way as the two-layer test above; "unrelated" in the src layer never
    // matches "a", so it can't mask an ordering mistake between the first two.
    const files = new Map([
      ['/home/u/proj/.git/info/exclude', 'a\n'],
      ['/home/u/proj/.gitignore', '!a\n'],
      ['/home/u/proj/src/.gitignore', 'unrelated\n'],
    ])
    const { tryReadTextFile, pathExists } = makeFakes(files, dirs)

    const chain = await buildRootIgnoreChain('/home/u/proj/src/app', tryReadTextFile, pathExists)

    expect(chain.length).toBe(3)
    expect(chain[0].dir).toBe('/home/u/proj')
    expect(chain[1].dir).toBe('/home/u/proj')
    expect(chain[2].dir).toBe('/home/u/proj/src')
    expect(isIgnoredByChain(chain, '/home/u/proj/a', false)).toBe(false)
  })

  it('returns an empty chain and terminates when pathExists knows nothing', async () => {
    const { tryReadTextFile, pathExists } = makeFakes(new Map(), new Set())

    const chain = await buildRootIgnoreChain('/home/u/proj/src', tryReadTextFile, pathExists)

    expect(chain).toBe(EMPTY_IGNORE_CHAIN)
  })
})
