import { describe, it, expect } from 'vitest'
import { fuzzyScore, filterAndRankFuzzy } from '../src/data/fuzzyMatch'

describe('fuzzyScore', () => {
    it('scores an empty query as 0 against any candidate', () => {
        expect(fuzzyScore('', 'src/shell/shortcuts.ts')).toBe(0)
        expect(fuzzyScore('', '')).toBe(0)
    })

    it('returns null when the query characters are not an ordered subsequence', () => {
        expect(fuzzyScore('xyz', 'src/EditorController.ts')).toBe(null)
    })

    // The worked "sh" example from the plan's Internal Structure, verified
    // against the exact three candidates and scores it documents.
    it('scores "sh" against src/shell/shortcuts.ts as 4 (segment-start s, non-contiguous non-segment-start h)', () => {
        expect(fuzzyScore('sh', 'src/shell/shortcuts.ts')).toBe(4)
    })

    it('scores "sh" against src/data/paths.ts as 4 (segment-start s, non-contiguous non-segment-start h in "paths")', () => {
        expect(fuzzyScore('sh', 'src/data/paths.ts')).toBe(4)
    })

    it('finds no match for "sh" in src/EditorController.ts (no h after the matched s)', () => {
        expect(fuzzyScore('sh', 'src/EditorController.ts')).toBe(null)
    })

    it('is case-insensitive', () => {
        expect(fuzzyScore('SH', 'src/shell/shortcuts.ts')).toBe(fuzzyScore('sh', 'src/shell/shortcuts.ts'))
    })

    it('rewards a contiguous run over scattered letters', () => {
        // Both candidates match "a" at the same non-segment-start index (1),
        // so the segment-start bonus is equal on both sides and only the
        // contiguous-run bonus can separate them: "xab" runs the match
        // straight through, "xaxb" interrupts it with an "x".
        const contiguous = fuzzyScore('ab', 'xab')
        const scattered = fuzzyScore('ab', 'xaxb')

        expect(contiguous).not.toBe(null)
        expect(scattered).not.toBe(null)
        expect(contiguous as number).toBeGreaterThan(scattered as number)
    })
})

describe('filterAndRankFuzzy', () => {
    const identity = (s: string): string => s

    it('excludes candidates that do not match', () => {
        const result = filterAndRankFuzzy('xyz', ['src/EditorController.ts', 'src/shell/shortcuts.ts'], identity, 10)

        expect(result).toEqual([])
    })

    it('ranks matches by descending score', () => {
        // "shell" matches src/shell/shortcuts.ts much more strongly (a
        // contiguous segment-start run) than src/data/paths.ts (scattered,
        // and "shell" doesn't even appear as a subsequence there once the
        // stronger candidate is included).
        const result = filterAndRankFuzzy('shell', ['src/shell/shortcuts.ts', 'src/EditorController.ts'], identity, 10)

        expect(result).toEqual(['src/shell/shortcuts.ts'])
    })

    it('breaks a tied score alphabetically by the rendered text, reproducing the "sh" tie', () => {
        const result = filterAndRankFuzzy('sh', ['src/shell/shortcuts.ts', 'src/data/paths.ts'], identity, 10)

        expect(result).toEqual(['src/data/paths.ts', 'src/shell/shortcuts.ts'])
    })

    it('caps the result at limit entries', () => {
        const items = ['aaa', 'aab', 'aac', 'aad']

        const result = filterAndRankFuzzy('a', items, identity, 2)

        expect(result.length).toBe(2)
    })

    it('matches an empty query against every item, in alphabetical order', () => {
        const result = filterAndRankFuzzy('', ['banana', 'apple'], identity, 10)

        expect(result).toEqual(['apple', 'banana'])
    })
})
