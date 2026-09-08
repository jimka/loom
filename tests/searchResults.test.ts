import { describe, it, expect } from 'vitest'
import { searchResultRow, searchSummaryText } from '../src/explorer/searchResults'
import { glyphNameForPath } from '../src/fileIcons'
import type { SearchMatch } from '../src/data/projectSearch'

const MATCH: SearchMatch = {
    path: '/p/src/data/paths.ts',
    line: 42,
    column: 11,
    length: 8,
    lineText: 'return baseName(trimmed)',
}

describe('searchResultRow', () => {
    it('shows the path relative to the project root', () => {
        const row = searchResultRow(MATCH, '/p')

        expect(row.label).toBe('src/data/paths.ts:42 · return baseName(trimmed)')
        expect(row.tooltip).toBe('src/data/paths.ts:42')
    })

    it('falls back to the absolute path with no project root', () => {
        const row = searchResultRow(MATCH, null)

        expect(row.label).toBe('/p/src/data/paths.ts:42 · return baseName(trimmed)')
        expect(row.tooltip).toBe('/p/src/data/paths.ts:42')
    })

    it('falls back to the absolute path when the match sits outside the given root', () => {
        const row = searchResultRow(MATCH, '/other')

        expect(row.label).toBe('/p/src/data/paths.ts:42 · return baseName(trimmed)')
        expect(row.tooltip).toBe('/p/src/data/paths.ts:42')
    })

    it('keys the row uniquely by path, line, and column', () => {
        const row = searchResultRow(MATCH, '/p')

        expect(row.key).toBe('/p/src/data/paths.ts:42:11')
    })

    it("glyphs the row from the match's path", () => {
        const row = searchResultRow(MATCH, '/p')

        expect(row.glyph).toBe(glyphNameForPath(MATCH.path))
    })
})

describe('searchSummaryText', () => {
    it('prompts for a query while idle', () => {
        expect(searchSummaryText({ phase: 'idle', matchCount: 0, fileCount: 0, filesSearched: 0 })).toBe(
            'Enter a query to search the project.',
        )
    })

    it('shows a running indicator', () => {
        expect(searchSummaryText({ phase: 'running', matchCount: 0, fileCount: 0, filesSearched: 0 })).toBe('Searching…')
    })

    it('reports a failure to read the project folder', () => {
        expect(searchSummaryText({ phase: 'failed', matchCount: 0, fileCount: 0, filesSearched: 0 })).toBe(
            'Could not read the project folder.',
        )
    })

    it('reports no matches', () => {
        expect(searchSummaryText({ phase: 'complete', matchCount: 0, fileCount: 0, filesSearched: 40 })).toBe('No matches.')
    })

    it('uses the singular form for exactly one match in one file', () => {
        expect(searchSummaryText({ phase: 'complete', matchCount: 1, fileCount: 1, filesSearched: 40 })).toBe(
            '1 match in 1 file',
        )
    })

    it('uses the plural form for more than one match or file', () => {
        expect(searchSummaryText({ phase: 'complete', matchCount: 2, fileCount: 2, filesSearched: 40 })).toBe(
            '2 matches in 2 files',
        )
    })

    it('reports a completed run with several matches across several files', () => {
        expect(searchSummaryText({ phase: 'complete', matchCount: 37, fileCount: 12, filesSearched: 512 })).toBe(
            '37 matches in 12 files',
        )
    })

    it('names the match cap when the run stopped early', () => {
        expect(searchSummaryText({ phase: 'match-limit', matchCount: 200, fileCount: 46, filesSearched: 512 })).toBe(
            'First 200 matches in 46 files — narrow the query.',
        )
    })

    it('names the file cap when the run stopped early', () => {
        expect(searchSummaryText({ phase: 'file-limit', matchCount: 37, fileCount: 12, filesSearched: 2000 })).toBe(
            '37 matches in 12 files — stopped after 2000 files.',
        )
    })
})
