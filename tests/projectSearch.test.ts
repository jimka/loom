import { describe, it, expect } from 'vitest'
import { isProbablyBinary, findMatches, searchFiles, compileQuery, replaceAllInText, replaceOneInText } from '../src/data/projectSearch'
import type { ReadFileText, SearchMatch, SearchQuery, MatchLocation } from '../src/data/projectSearch'

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

/**
 * A {@link SearchQuery}, defaulting `caseSensitive` and `regexp` to `false`
 * so a test row can override only what it cares about.
 */
function query(text: string, overrides: Partial<SearchQuery> = {}): SearchQuery {
    return { text, caseSensitive: false, regexp: false, ...overrides }
}

/**
 * `findMatches` against a plain-substring, case-insensitive query — the
 * common case that most rows of the old suite exercised, compiled through
 * {@link compileQuery} rather than hand-rolled.
 *
 * @param path - The match's source path, carried through unchanged.
 * @param text - The file's text to scan.
 * @param needle - The plain substring to search for.
 * @param limit - The most matches to return.
 * @returns The matches found, in file order.
 */
function findPlain(path: string, text: string, needle: string, limit: number): SearchMatch[] {
    return findMatches(path, text, compileQuery(query(needle))!, limit)
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

describe('compileQuery', () => {
    it('returns null for an empty pattern, plain or regexp', () => {
        expect(compileQuery(query(''))).toBeNull()
        expect(compileQuery(query('', { regexp: true }))).toBeNull()
    })

    it('lowercases the needle for a case-insensitive substring query', () => {
        expect(compileQuery(query('Foo'))).toEqual({ kind: 'substring', needle: 'foo', caseSensitive: false })
    })

    it('keeps the needle as-is for a case-sensitive substring query', () => {
        expect(compileQuery(query('Foo', { caseSensitive: true }))).toEqual({
            kind: 'substring', needle: 'Foo', caseSensitive: true,
        })
    })

    it('compiles a case-insensitive regexp with the i flag added', () => {
        const compiled = compileQuery(query('a+', { regexp: true }))

        expect(compiled?.kind).toBe('regexp')
        expect((compiled as { re: RegExp }).re.source).toBe('a+')
        expect((compiled as { re: RegExp }).re.flags).toBe('gimu')
    })

    it('compiles a case-sensitive regexp with no i flag', () => {
        const compiled = compileQuery(query('a+', { caseSensitive: true, regexp: true }))

        expect(compiled?.kind).toBe('regexp')
        expect((compiled as { re: RegExp }).re.source).toBe('a+')
        expect((compiled as { re: RegExp }).re.flags).toBe('gmu')
    })

    it('returns null for an unbalanced group', () => {
        expect(compileQuery(query('(', { regexp: true }))).toBeNull()
    })

    it('returns null for a pattern the u flag rejects', () => {
        expect(compileQuery(query('a\\-b', { regexp: true }))).toBeNull()
    })
})

describe('findMatches', () => {
    it('matches case-insensitively and reports every occurrence on a line', () => {
        const matches = findPlain('/p/f.ts', 'const Foo = foo', 'foo', 10)

        expect(matches).toEqual([
            { path: '/p/f.ts', line: 1, column: 6, length: 3, lineText: 'const Foo = foo' },
            { path: '/p/f.ts', line: 1, column: 12, length: 3, lineText: 'const Foo = foo' },
        ])
    })

    it('matches only the exact case when caseSensitive is set', () => {
        const compiled = compileQuery(query('Foo', { caseSensitive: true }))!
        const matches = findMatches('/p/f.ts', 'const Foo = foo', compiled, 10)

        expect(matches).toEqual([{ path: '/p/f.ts', line: 1, column: 6, length: 3, lineText: 'const Foo = foo' }])
    })

    it('matches only the exact lowercase occurrence when caseSensitive is set', () => {
        const compiled = compileQuery(query('foo', { caseSensitive: true }))!
        const matches = findMatches('/p/f.ts', 'const Foo = foo', compiled, 10)

        expect(matches).toEqual([{ path: '/p/f.ts', line: 1, column: 12, length: 3, lineText: 'const Foo = foo' }])
    })

    it('resumes scanning after each hit so overlapping matches never double-count', () => {
        const matches = findPlain('/p/f.ts', 'aaaa', 'aa', 10)

        expect(matches.map(m => [m.line, m.column])).toEqual([[1, 0], [1, 2]])
    })

    it('splits on \\r\\n as one line break, excluding the \\r from the preceding line', () => {
        const matches = findPlain('/p/f.ts', 'a\r\nb', 'b', 10)

        expect(matches).toEqual([{ path: '/p/f.ts', line: 2, column: 0, length: 1, lineText: 'b' }])
    })

    it('splits on a bare \\n', () => {
        const matches = findPlain('/p/f.ts', 'a\nb\nc', 'c', 10)

        expect(matches).toEqual([{ path: '/p/f.ts', line: 3, column: 0, length: 1, lineText: 'c' }])
    })

    it("trims the reported line's leading whitespace", () => {
        const matches = findPlain('/p/f.ts', '    return x', 'return', 10)

        expect(matches).toHaveLength(1)
        expect(matches[0].lineText).toBe('return x')
    })

    it('truncates a long lineText to 120 characters plus an ellipsis', () => {
        const line = 'x'.repeat(300)
        const matches = findPlain('/p/f.ts', line, 'x', 1)

        expect(matches).toHaveLength(1)
        expect(matches[0].lineText).toBe(`${'x'.repeat(120)}…`)
    })

    it('stops at the given limit', () => {
        expect(findPlain('/p/f.ts', 'aaaa', 'a', 1)).toHaveLength(1)
    })

    it('returns no matches when the query is absent from the text', () => {
        expect(findPlain('/p/f.ts', 'abc', 'zzz', 10)).toEqual([])
    })

    it("carries the given path on every match", () => {
        const matches = findPlain('/p/f.ts', 'foo foo', 'foo', 10)

        expect(matches.every(m => m.path === '/p/f.ts')).toBe(true)
    })

    it('reports each digit run with its own length for a regexp query', () => {
        const compiled = compileQuery(query('\\d+', { regexp: true }))!
        const matches = findMatches('/p/f.ts', 'a1 b22', compiled, 10)

        expect(matches).toEqual([
            { path: '/p/f.ts', line: 1, column: 1, length: 1, lineText: 'a1 b22' },
            { path: '/p/f.ts', line: 1, column: 4, length: 2, lineText: 'a1 b22' },
        ])
    })

    it('matches greedily and resumes after the whole match for a regexp query', () => {
        const compiled = compileQuery(query('a+', { regexp: true }))!
        const matches = findMatches('/p/f.ts', 'aaa', compiled, 10)

        expect(matches).toEqual([{ path: '/p/f.ts', line: 1, column: 0, length: 3, lineText: 'aaa' }])
    })

    it('skips empty matches for a regexp that can match nothing, reporting only the non-empty one', () => {
        const compiled = compileQuery(query('X*', { regexp: true }))!
        const matches = findMatches('/p/f.ts', 'aXb', compiled, 10)

        expect(matches).toEqual([{ path: '/p/f.ts', line: 1, column: 1, length: 1, lineText: 'aXb' }])
    })

    it('reports no matches when every regexp match would be empty', () => {
        const compiled = compileQuery(query('x*', { regexp: true }))!
        expect(findMatches('/p/f.ts', 'ab', compiled, 10)).toEqual([])
    })

    it('anchors ^ and $ to the line itself', () => {
        const compiled = compileQuery(query('^foo$', { regexp: true }))!
        const matches = findMatches('/p/f.ts', 'Foo', compiled, 10)

        expect(matches).toEqual([{ path: '/p/f.ts', line: 1, column: 0, length: 3, lineText: 'Foo' }])
    })

    it('finds no anchored match when caseSensitive rules out the only candidate', () => {
        const compiled = compileQuery(query('^foo$', { caseSensitive: true, regexp: true }))!
        expect(findMatches('/p/f.ts', 'Foo', compiled, 10)).toEqual([])
    })

    it('never matches a pattern spanning a line break, even one containing a literal \\n', () => {
        const compiled = compileQuery(query('a\\nb', { regexp: true }))!
        expect(findMatches('/p/f.ts', 'a\nb', compiled, 10)).toEqual([])
    })

    it('still matches within a line for a pattern that would only span a break in the raw text', () => {
        const compiled = compileQuery(query('a', { regexp: true }))!
        const matches = findMatches('/p/f.ts', 'a\nb', compiled, 10)

        expect(matches).toEqual([{ path: '/p/f.ts', line: 1, column: 0, length: 1, lineText: 'a' }])
    })

    it("resets the shared RegExp's lastIndex on every line", () => {
        const compiled = compileQuery(query('\\d', { regexp: true }))!
        const matches = findMatches('/p/f.ts', 'a1\nb2', compiled, 10)

        expect(matches).toEqual([
            { path: '/p/f.ts', line: 1, column: 1, length: 1, lineText: 'a1' },
            { path: '/p/f.ts', line: 2, column: 1, length: 1, lineText: 'b2' },
        ])
    })

    it('reports the full match length for a long regexp match, with a truncated lineText', () => {
        const line = 'x'.repeat(300)
        const compiled = compileQuery(query('x+', { regexp: true }))!
        const matches = findMatches('/p/f.ts', line, compiled, 10)

        expect(matches).toHaveLength(1)
        expect(matches[0]).toMatchObject({ line: 1, column: 0, length: 300 })
        expect(matches[0].lineText).toBe(`${'x'.repeat(120)}…`)
    })
})

describe('searchFiles', () => {
    const noCancel = (): boolean => false
    const limits = { maxMatches: 200, maxFiles: 2000 }
    const substringConst = compileQuery(query('const'))!

    it('reports one file of two as a match, and counts both as searched', async () => {
        const files = new Map([['/p/a.ts', 'nothing here'], ['/p/b.ts', 'const x = 1']])
        const batches: SearchMatch[][] = []

        const outcome = await searchFiles(
            [...files.keys()], substringConst, fakeReadText(files), batch => batches.push(batch), noCancel, limits,
        )

        expect(outcome).toEqual({ completion: 'complete', matchCount: 1, fileCount: 1, filesSearched: 2 })
        expect(batches).toHaveLength(1)
    })

    it('reports both files for a regexp query, sharing one compiled RegExp', async () => {
        const files = new Map([['/p/a.ts', 'a1'], ['/p/b.ts', 'b22']])
        const batches: SearchMatch[][] = []
        const compiled = compileQuery(query('\\d+', { regexp: true }))!

        const outcome = await searchFiles(
            [...files.keys()], compiled, fakeReadText(files), batch => batches.push(batch), noCancel, limits,
        )

        expect(outcome).toEqual({ completion: 'complete', matchCount: 2, fileCount: 2, filesSearched: 2 })
        expect(batches).toHaveLength(2)
    })

    it('skips a file whose read rejects and still reports the next matching file', async () => {
        const files = new Map([['/p/b.ts', 'const x = 1']])
        const batches: SearchMatch[][] = []

        const outcome = await searchFiles(
            ['/p/a.ts', '/p/b.ts'], substringConst, fakeReadText(files), batch => batches.push(batch), noCancel, limits,
        )

        expect(outcome).toEqual({ completion: 'complete', matchCount: 1, fileCount: 1, filesSearched: 2 })
        expect(batches).toEqual([[{ path: '/p/b.ts', line: 1, column: 0, length: 5, lineText: 'const x = 1' }]])
    })

    it('skips a binary file and still counts it as searched', async () => {
        const files = new Map([['/p/a.png', 'x' + NUL + 'PNG']])
        const batches: SearchMatch[][] = []
        const compiled = compileQuery(query('PNG'))!

        const outcome = await searchFiles(
            ['/p/a.png'], compiled, fakeReadText(files), batch => batches.push(batch), noCancel, limits,
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
            [...files.keys()], substringConst, trackedRead, () => {}, noCancel, { maxMatches: 2, maxFiles: 2000 },
        )

        expect(outcome.completion).toBe('match-limit')
        expect(outcome.matchCount).toBe(2)
        expect(readPaths).toEqual(['/p/a.ts', '/p/b.ts'])
    })

    it('stops at maxFiles', async () => {
        const files = new Map(['a', 'b', 'c', 'd', 'e'].map(name => [`/p/${name}.ts`, 'nothing']))

        const outcome = await searchFiles(
            [...files.keys()], substringConst, fakeReadText(files), () => {}, noCancel, { maxMatches: 200, maxFiles: 2 },
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

        const outcome = await searchFiles([...files.keys()], substringConst, fakeReadText(files), batch => batches.push(batch), isCancelled, limits)

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

        const outcome = await searchFiles([...files.keys()], substringConst, fakeReadText(files), batch => batches.push(batch), isCancelled, limits)

        expect(outcome.completion).toBe('cancelled')
        expect(batches).toEqual([])
    })

    it('finds no matches for a file whose only candidate differs in case, case-sensitive query', async () => {
        const files = new Map([['/p/a.ts', 'const x = 1']])
        const compiled = compileQuery(query('CONST', { caseSensitive: true }))!

        const outcome = await searchFiles([...files.keys()], compiled, fakeReadText(files), () => {}, noCancel, limits)

        expect(outcome).toEqual({ completion: 'complete', matchCount: 0, fileCount: 0, filesSearched: 1 })
    })

    it('never reports an empty batch for a file with no matches', async () => {
        const files = new Map([['/p/a.ts', 'nothing here'], ['/p/b.ts', 'const x = 1']])
        const batches: SearchMatch[][] = []

        await searchFiles([...files.keys()], substringConst, fakeReadText(files), batch => batches.push(batch), noCancel, limits)

        expect(batches).toHaveLength(1)
        expect(batches[0]).not.toEqual([])
    })
})

describe('replaceAllInText', () => {
    it('replaces every case-insensitive occurrence of a plain substring', () => {
        const compiled = compileQuery(query('foo'))!
        const result = replaceAllInText('const Foo = foo', compiled, 'X')

        expect(result).toEqual({ text: 'const X = X', count: 2 })
    })

    it('replaces only the exact-case occurrence when caseSensitive is set', () => {
        const compiled = compileQuery(query('foo', { caseSensitive: true }))!
        const result = replaceAllInText('const Foo = foo', compiled, 'X')

        expect(result).toEqual({ text: 'const Foo = X', count: 1 })
    })

    it('substitutes captured groups for a regexp replacement template', () => {
        const compiled = compileQuery(query('(\\w+)=(\\d+)', { regexp: true }))!
        const result = replaceAllInText('x=5', compiled, '$2=$1')

        expect(result).toEqual({ text: '5=x', count: 1 })
    })

    it('substitutes $& with the whole match', () => {
        const compiled = compileQuery(query('foo', { regexp: true }))!
        const result = replaceAllInText('foo', compiled, '[$&]')

        expect(result).toEqual({ text: '[foo]', count: 1 })
    })

    it('resolves $$ to a literal $, leaving the following digit untouched', () => {
        const compiled = compileQuery(query('foo', { regexp: true }))!
        const result = replaceAllInText('foo', compiled, '$$1')

        expect(result).toEqual({ text: '$1', count: 1 })
    })

    it('returns the original text unchanged when every match would be empty', () => {
        const text = 'ab'
        const compiled = compileQuery(query('x*', { regexp: true }))!
        const result = replaceAllInText(text, compiled, 'Y')

        expect(result.text).toBe(text)
        expect(result.count).toBe(0)
    })

    it('keeps each line\'s own line ending untouched', () => {
        const compiled = compileQuery(query('foo'))!
        const result = replaceAllInText('foo\r\nfoo\n', compiled, 'X')

        expect(result).toEqual({ text: 'X\r\nX\n', count: 2 })
    })

    it('never matches a pattern spanning a line break', () => {
        const text = 'foo\nbar'
        const compiled = compileQuery(query('foo\\nbar', { regexp: true }))!
        const result = replaceAllInText(text, compiled, 'X')

        expect(result.text).toBe(text)
        expect(result.count).toBe(0)
    })

    it('returns the original text unchanged when nothing matches', () => {
        const text = 'nothing'
        const compiled = compileQuery(query('zzz'))!
        const result = replaceAllInText(text, compiled, 'X')

        expect(result.text).toBe(text)
        expect(result.count).toBe(0)
    })
})

describe('replaceOneInText', () => {
    function at(line: number, column: number, length: number): MatchLocation {
        return { line, column, length }
    }

    it('replaces the occurrence at the given location', () => {
        const compiled = compileQuery(query('foo'))!
        const result = replaceOneInText('const foo = 1', at(1, 6, 3), compiled, 'bar')

        expect(result).toBe('const bar = 1')
    })

    it('returns null when the line has moved since the match was found', () => {
        const compiled = compileQuery(query('foo'))!
        const result = replaceOneInText('const bar = 1', at(1, 6, 3), compiled, 'bar')

        expect(result).toBeNull()
    })

    it("returns null when the target line no longer exists", () => {
        const compiled = compileQuery(query('a'))!
        const result = replaceOneInText('only one line', at(5, 0, 1), compiled, 'X')

        expect(result).toBeNull()
    })

    it('replaces only the targeted regexp occurrence, leaving an earlier one on the same line untouched', () => {
        const compiled = compileQuery(query('(\\w)=(\\d)', { regexp: true }))!
        const result = replaceOneInText('a=1 b=2', at(1, 4, 3), compiled, '$2=$1')

        expect(result).toBe('a=1 2=b')
    })

    it('respects caseSensitive when verifying the targeted occurrence', () => {
        const compiled = compileQuery(query('foo', { caseSensitive: true }))!
        const result = replaceOneInText('Foo foo', at(1, 4, 3), compiled, 'X')

        expect(result).toBe('Foo X')
    })
})
