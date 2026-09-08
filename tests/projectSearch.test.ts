import { describe, it, expect } from 'vitest'
import { isProbablyBinary, findMatches, searchFiles } from '../src/data/projectSearch'
import type { ReadFileText, SearchMatch } from '../src/data/projectSearch'

/** A NUL character, built at runtime rather than typed as a raw byte in this
 *  source file — a literal NUL in a text file makes `git diff` treat it as
 *  binary, which is exactly the behaviour {@link isProbablyBinary} itself
 *  relies on to detect a binary file. */
const NUL = String.fromCharCode(0)

/**
 * An in-memory fake `ReadFileText`, mirroring `tests/fileIndex.test.ts`'s
 * `makeFakes`: `files` maps a path to its text; a path missing from the map
 * rejects, the same way an unreadable or over-sized file rejects for the
 * real `readFileText`.
 */
function fakeReadText(files: Map<string, string>): ReadFileText {
    return async (path: string) => {
        const text = files.get(path)

        if (text === undefined) {
            throw new Error('unreadable')
        }

        return text
    }
}

describe('isProbablyBinary', () => {
    it('is false for ordinary text', () => {
        expect(isProbablyBinary('const a = 1')).toBe(false)
    })

    it('is false for an empty string', () => {
        expect(isProbablyBinary('')).toBe(false)
    })

    it('is true for text carrying a NUL byte', () => {
        expect(isProbablyBinary('x' + NUL + 'PNG')).toBe(true)
    })

    it('is false when the NUL sits past the 8000-character sniff window', () => {
        expect(isProbablyBinary('a'.repeat(8000) + NUL)).toBe(false)
    })

    it('is true when the NUL sits just inside the sniff window', () => {
        expect(isProbablyBinary('a'.repeat(7999) + NUL)).toBe(true)
    })
})

describe('findMatches', () => {
    it('matches case-insensitively and reports every occurrence on a line', () => {
        const matches = findMatches('/p/f.ts', 'const Foo = foo', 'foo', 10)

        expect(matches).toEqual([
            { path: '/p/f.ts', line: 1, column: 6, length: 3, lineText: 'const Foo = foo' },
            { path: '/p/f.ts', line: 1, column: 12, length: 3, lineText: 'const Foo = foo' },
        ])
    })

    it('resumes scanning after each hit so overlapping matches never double-count', () => {
        const matches = findMatches('/p/f.ts', 'aaaa', 'aa', 10)

        expect(matches.map(m => [m.line, m.column])).toEqual([[1, 0], [1, 2]])
    })

    it('splits on \\r\\n as one line break, excluding the \\r from the preceding line', () => {
        const matches = findMatches('/p/f.ts', 'a\r\nb', 'b', 10)

        expect(matches).toEqual([{ path: '/p/f.ts', line: 2, column: 0, length: 1, lineText: 'b' }])
    })

    it('splits on a bare \\n', () => {
        const matches = findMatches('/p/f.ts', 'a\nb\nc', 'c', 10)

        expect(matches).toEqual([{ path: '/p/f.ts', line: 3, column: 0, length: 1, lineText: 'c' }])
    })

    it("trims the reported line's leading whitespace", () => {
        const matches = findMatches('/p/f.ts', '    return x', 'return', 10)

        expect(matches).toHaveLength(1)
        expect(matches[0].lineText).toBe('return x')
    })

    it('truncates a long lineText to 120 characters plus an ellipsis', () => {
        const line = 'x'.repeat(300)
        const matches = findMatches('/p/f.ts', line, 'x', 1)

        expect(matches).toHaveLength(1)
        expect(matches[0].lineText).toBe(`${'x'.repeat(120)}…`)
    })

    it('returns no matches for an empty query', () => {
        expect(findMatches('/p/f.ts', 'abc', '', 10)).toEqual([])
    })

    it('stops at the given limit', () => {
        expect(findMatches('/p/f.ts', 'aaaa', 'a', 1)).toHaveLength(1)
    })

    it('returns no matches when the query is absent from the text', () => {
        expect(findMatches('/p/f.ts', 'abc', 'zzz', 10)).toEqual([])
    })

    it("carries the given path on every match", () => {
        const matches = findMatches('/p/f.ts', 'foo foo', 'foo', 10)

        expect(matches.every(m => m.path === '/p/f.ts')).toBe(true)
    })
})

describe('searchFiles', () => {
    const noCancel = (): boolean => false
    const limits = { maxMatches: 200, maxFiles: 2000 }

    it('reports one file of two as a match, and counts both as searched', async () => {
        const files = new Map([['/p/a.ts', 'nothing here'], ['/p/b.ts', 'const x = 1']])
        const batches: SearchMatch[][] = []

        const outcome = await searchFiles(
            [...files.keys()], 'const', fakeReadText(files), batch => batches.push(batch), noCancel, limits,
        )

        expect(outcome).toEqual({ completion: 'complete', matchCount: 1, fileCount: 1, filesSearched: 2 })
        expect(batches).toHaveLength(1)
    })

    it('skips a file whose read rejects and still reports the next matching file', async () => {
        const files = new Map([['/p/b.ts', 'const x = 1']])
        const batches: SearchMatch[][] = []

        const outcome = await searchFiles(
            ['/p/a.ts', '/p/b.ts'], 'const', fakeReadText(files), batch => batches.push(batch), noCancel, limits,
        )

        expect(outcome).toEqual({ completion: 'complete', matchCount: 1, fileCount: 1, filesSearched: 2 })
        expect(batches).toEqual([[{ path: '/p/b.ts', line: 1, column: 0, length: 5, lineText: 'const x = 1' }]])
    })

    it('skips a binary file and still counts it as searched', async () => {
        const files = new Map([['/p/a.png', 'x' + NUL + 'PNG']])
        const batches: SearchMatch[][] = []

        const outcome = await searchFiles(
            ['/p/a.png'], 'PNG', fakeReadText(files), batch => batches.push(batch), noCancel, limits,
        )

        expect(outcome).toEqual({ completion: 'complete', matchCount: 0, fileCount: 0, filesSearched: 1 })
        expect(batches).toEqual([])
    })

    it('stops at maxMatches without reading the file that would exceed it', async () => {
        const files = new Map([['/p/a.ts', 'const'], ['/p/b.ts', 'const'], ['/p/c.ts', 'const']])
        const readText = fakeReadText(files)
        const readPaths: string[] = []
        const trackedRead: ReadFileText = async path => {
            readPaths.push(path)

            return readText(path)
        }

        const outcome = await searchFiles(
            [...files.keys()], 'const', trackedRead, () => {}, noCancel, { maxMatches: 2, maxFiles: 2000 },
        )

        expect(outcome.completion).toBe('match-limit')
        expect(outcome.matchCount).toBe(2)
        expect(readPaths).toEqual(['/p/a.ts', '/p/b.ts'])
    })

    it('stops at maxFiles', async () => {
        const files = new Map(['a', 'b', 'c', 'd', 'e'].map(name => [`/p/${name}.ts`, 'nothing']))

        const outcome = await searchFiles(
            [...files.keys()], 'const', fakeReadText(files), () => {}, noCancel, { maxMatches: 200, maxFiles: 2 },
        )

        expect(outcome).toEqual({ completion: 'file-limit', matchCount: 0, fileCount: 0, filesSearched: 2 })
    })

    it('reports cancelled and stops after the run is cancelled mid-walk', async () => {
        const files = new Map([['/p/a.ts', 'const'], ['/p/b.ts', 'const']])
        const batches: SearchMatch[][] = []
        let calls = 0
        const isCancelled = (): boolean => {
            calls += 1

            // isCancelled is checked twice per file that reads successfully
            // (before its read starts, and again right after it resolves,
            // before its matches are reported) — the third call is the
            // top-of-loop check ahead of b.ts's own read, i.e. cancellation
            // arriving once a.ts's matches are already safely delivered.
            return calls === 3
        }

        const outcome = await searchFiles([...files.keys()], 'const', fakeReadText(files), batch => batches.push(batch), isCancelled, limits)

        expect(outcome.completion).toBe('cancelled')
        expect(batches).toHaveLength(1)
        expect(batches[0][0].path).toBe('/p/a.ts')
    })

    it("discards a file's matches when cancellation arrives while that file's read was in flight", async () => {
        const files = new Map([['/p/a.ts', 'const']])
        const batches: SearchMatch[][] = []
        let calls = 0
        const isCancelled = (): boolean => {
            calls += 1

            // The first call is the top-of-loop check before a.ts's read
            // starts (must be false, or the read never happens at all); the
            // second is the post-read check this test exists to pin down —
            // cancellation lands after the read resolves but before its
            // matches would otherwise be reported.
            return calls === 2
        }

        const outcome = await searchFiles([...files.keys()], 'const', fakeReadText(files), batch => batches.push(batch), isCancelled, limits)

        expect(outcome.completion).toBe('cancelled')
        expect(batches).toEqual([])
    })

    it('reads nothing for an empty query', async () => {
        const files = new Map([['/p/a.ts', 'const']])
        const readText = fakeReadText(files)
        let readCount = 0
        const trackedRead: ReadFileText = async path => {
            readCount += 1

            return readText(path)
        }

        const outcome = await searchFiles([...files.keys()], '', trackedRead, () => {}, noCancel, limits)

        expect(outcome).toEqual({ completion: 'complete', matchCount: 0, fileCount: 0, filesSearched: 0 })
        expect(readCount).toBe(0)
    })

    it('never reports an empty batch for a file with no matches', async () => {
        const files = new Map([['/p/a.ts', 'nothing here'], ['/p/b.ts', 'const x = 1']])
        const batches: SearchMatch[][] = []

        await searchFiles([...files.keys()], 'const', fakeReadText(files), batch => batches.push(batch), noCancel, limits)

        expect(batches).toHaveLength(1)
        expect(batches[0]).not.toEqual([])
    })
})
