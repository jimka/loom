import { describe, it, expect } from 'vitest'
import { searchResultNodes, searchSummaryText } from '../src/explorer/searchResults'
import type { SearchTreeNodeData } from '../src/explorer/searchResults'
import type { SearchMatch } from '../src/data/projectSearch'

const PATHS_1: SearchMatch = {
    path: '/p/src/data/paths.ts',
    line: 10,
    column: 5,
    length: 8,
    lineText: 'export function baseName(path: string): string {',
}

const PATHS_2: SearchMatch = {
    path: '/p/src/data/paths.ts',
    line: 62,
    column: 11,
    length: 8,
    lineText: 'return baseName(trimmed)',
}

const SHELL_1: SearchMatch = {
    path: '/p/src/shell/EditorShell.ts',
    line: 45,
    column: 3,
    length: 6,
    lineText: 'const explorer = Container({',
}

const README_1: SearchMatch = {
    path: '/p/README.md',
    line: 3,
    column: 1,
    length: 4,
    lineText: 'A local desktop code editor built on @jimka/typescript-ui.',
}

describe('searchResultNodes', () => {
    it('returns no nodes for an empty match list', () => {
        expect(searchResultNodes([], '/p')).toEqual([])
    })

    it('nests a single match under its folder chain and file', () => {
        const nodes = searchResultNodes([PATHS_1], '/p')

        expect(nodes).toHaveLength(1)

        const src = nodes[0]

        expect(src.label).toBe('src')
        expect((src.data as SearchTreeNodeData).kind).toBe('folder')
        expect(src.children).toHaveLength(1)

        const data = src.children![0]

        expect(data.label).toBe('data')
        expect((data.data as SearchTreeNodeData).kind).toBe('folder')
        expect(data.children).toHaveLength(1)

        const file = data.children![0]

        expect(file.label).toBe('paths.ts (1)')
        expect(file.data).toEqual({ kind: 'file', path: '/p/src/data/paths.ts' })
        expect(file.children).toHaveLength(1)

        const match = file.children![0]

        expect(match.label).toBe(`10: ${PATHS_1.lineText}`)
        expect(match.data).toEqual({ kind: 'match', match: PATHS_1 })
        expect(match.children).toBeUndefined()
    })

    it('groups two matches in the same file under one file node, in line order', () => {
        const nodes = searchResultNodes([PATHS_1, PATHS_2], '/p')
        const file = nodes[0].children![0].children![0]

        expect(file.label).toBe('paths.ts (2)')
        expect(file.children).toHaveLength(2)
        expect(file.children![0].data).toEqual({ kind: 'match', match: PATHS_1 })
        expect(file.children![1].data).toEqual({ kind: 'match', match: PATHS_2 })
    })

    it('sorts sibling folders alphabetically', () => {
        const nodes = searchResultNodes([PATHS_1, SHELL_1], '/p')
        const src = nodes[0]

        expect(src.label).toBe('src')
        expect(src.children!.map(child => child.label)).toEqual(['data', 'shell'])
    })

    it('sorts a folder before a file at the same level regardless of name', () => {
        const nodes = searchResultNodes([PATHS_1, README_1], '/p')

        expect(nodes.map(node => node.label)).toEqual(['src', 'README.md (1)'])
    })

    it('falls back to a flat, unsorted file list keyed by absolute path with no root', () => {
        const nodes = searchResultNodes([PATHS_1], null)

        expect(nodes).toHaveLength(1)
        expect(nodes[0].label).toBe('/p/src/data/paths.ts (1)')
        expect(nodes[0].data).toEqual({ kind: 'file', path: '/p/src/data/paths.ts' })
        expect(nodes[0].children).toHaveLength(1)
        expect(nodes[0].children![0].data).toEqual({ kind: 'match', match: PATHS_1 })
    })

    it('builds the full worked-example tree from a mixed match set', () => {
        const nodes = searchResultNodes([PATHS_1, PATHS_2, SHELL_1, README_1], '/p')

        expect(nodes.map(node => node.label)).toEqual(['src', 'README.md (1)'])

        const src = nodes[0]

        expect(src.children!.map(child => child.label)).toEqual(['data', 'shell'])

        const dataFolder = src.children![0]
        const pathsFile = dataFolder.children![0]

        expect(pathsFile.label).toBe('paths.ts (2)')
        expect(pathsFile.children!.map(child => child.data)).toEqual([
            { kind: 'match', match: PATHS_1 },
            { kind: 'match', match: PATHS_2 },
        ])

        const shellFolder = src.children![1]
        const shellFile = shellFolder.children![0]

        expect(shellFile.label).toBe('EditorShell.ts (1)')
        expect(shellFile.children![0].data).toEqual({ kind: 'match', match: SHELL_1 })

        const readmeFile = nodes[1]

        expect(readmeFile.label).toBe('README.md (1)')
        expect(readmeFile.children![0].data).toEqual({ kind: 'match', match: README_1 })
    })

    it('shares one folder node between a file directly inside it and a file in a subdirectory, on a Windows-style root', () => {
        // A Windows project root: relativeTo (data/paths.ts) keeps "\" as
        // its separator, but a folder reached only as an ancestor (via
        // pathSegments/join('/')) must resolve to the exact same node — not
        // a second one keyed under a "/"-joined path.
        const directMatch: SearchMatch = { ...PATHS_1, path: 'C:\\p\\src\\data\\paths.ts' }
        const nestedMatch: SearchMatch = { ...SHELL_1, path: 'C:\\p\\src\\data\\deep\\z.ts' }

        const nodes = searchResultNodes([directMatch, nestedMatch], 'C:\\p')

        expect(nodes).toHaveLength(1)

        const src = nodes[0]

        expect(src.label).toBe('src')
        expect(src.children!.map(child => child.label)).toEqual(['data'])
        expect(src.data).toEqual({ kind: 'folder', path: 'C:\\p\\src' })

        const data = src.children![0]

        expect(data.children!.map(child => child.label)).toEqual(['deep', 'paths.ts (1)'])
        expect(data.data).toEqual({ kind: 'folder', path: 'C:\\p\\src\\data' })
        expect(data.children![0].data).toEqual({ kind: 'folder', path: 'C:\\p\\src\\data\\deep' })
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

    it('reports an invalid regular expression', () => {
        expect(searchSummaryText({ phase: 'invalid-regex', matchCount: 0, fileCount: 0, filesSearched: 0 })).toBe(
            'Invalid regular expression.',
        )
    })

    it('shows a replacing indicator', () => {
        expect(searchSummaryText({ phase: 'replacing', matchCount: 0, fileCount: 0, filesSearched: 0 })).toBe('Replacing…')
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
