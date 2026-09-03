import { describe, it, expect } from 'vitest'
import { listFilesRecursive } from '../src/data/fileIndex'
import type { ListDirectory } from '../src/data/fileIndex'
import type { DirectoryItem } from '../src/data/workspace'
import type { TryReadTextFile, PathExists } from '../src/data/gitignore'

/**
 * In-memory fakes mirroring `tests/gitignore.test.ts`'s `makeFakes`: `tree`
 * maps a directory path to its immediate children, `files` backs
 * `tryReadTextFile`, and every directory in `tree` is treated as existing
 * (so `buildRootIgnoreChain`'s upward `.git` walk terminates predictably).
 */
function makeFakes(
    tree: Map<string, DirectoryItem[]>,
    files: Map<string, string> = new Map(),
): { listDirectory: ListDirectory; tryReadTextFile: TryReadTextFile; pathExists: PathExists } {
    return {
        listDirectory: async (dir: string) => tree.get(dir) ?? [],
        tryReadTextFile: async (path: string) => files.get(path) ?? null,
        pathExists: async (path: string) => tree.has(path) || files.has(path),
    }
}

describe('listFilesRecursive', () => {
    it('flattens a nested directory tree to every file path, depth-first', async () => {
        const tree = new Map<string, DirectoryItem[]>([
            ['/p', [
                { name: 'a.ts', path: '/p/a.ts', isDir: false },
                { name: 'src', path: '/p/src', isDir: true },
            ]],
            ['/p/src', [
                { name: 'b.ts', path: '/p/src/b.ts', isDir: false },
            ]],
        ])
        const { listDirectory, tryReadTextFile, pathExists } = makeFakes(tree)

        const files = await listFilesRecursive('/p', listDirectory, tryReadTextFile, pathExists)

        expect(files).toEqual(['/p/a.ts', '/p/src/b.ts'])
    })

    it('excludes a dotfile and a .gitignore-matched file', async () => {
        const tree = new Map<string, DirectoryItem[]>([
            ['/p', [
                { name: '.env', path: '/p/.env', isDir: false },
                { name: '.gitignore', path: '/p/.gitignore', isDir: false },
                { name: 'kept.ts', path: '/p/kept.ts', isDir: false },
                { name: 'skipped.log', path: '/p/skipped.log', isDir: false },
            ]],
        ])
        const files = new Map([['/p/.gitignore', '*.log\n']])
        const { listDirectory, tryReadTextFile, pathExists } = makeFakes(tree, files)

        const result = await listFilesRecursive('/p', listDirectory, tryReadTextFile, pathExists)

        expect(result).toEqual(['/p/kept.ts'])
    })

    it("scopes a nested directory's own .gitignore rule to its own subtree", async () => {
        const tree = new Map<string, DirectoryItem[]>([
            ['/p', [
                { name: 'a.log', path: '/p/a.log', isDir: false },
                { name: 'sub', path: '/p/sub', isDir: true },
            ]],
            ['/p/sub', [
                { name: '.gitignore', path: '/p/sub/.gitignore', isDir: false },
                { name: 'b.log', path: '/p/sub/b.log', isDir: false },
            ]],
        ])
        const files = new Map([['/p/sub/.gitignore', '*.log\n']])
        const { listDirectory, tryReadTextFile, pathExists } = makeFakes(tree, files)

        const result = await listFilesRecursive('/p', listDirectory, tryReadTextFile, pathExists)

        // /p/a.log is outside sub's .gitignore scope and stays; /p/sub/b.log
        // is inside it and is excluded.
        expect(result).toEqual(['/p/a.log'])
    })

    it('returns an empty list for an empty directory tree', async () => {
        const tree = new Map<string, DirectoryItem[]>([['/p', []]])
        const { listDirectory, tryReadTextFile, pathExists } = makeFakes(tree)

        const result = await listFilesRecursive('/p', listDirectory, tryReadTextFile, pathExists)

        expect(result).toEqual([])
    })
})
