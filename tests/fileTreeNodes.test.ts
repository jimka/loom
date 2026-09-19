import { describe, it, expect, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { TreeNode } from '@jimka/typescript-ui/component/tree'
import { reconcileChildren, findNodeByPath } from '../src/explorer/fileTreeNodes'
import type { FileTreeNodeData } from '../src/explorer/fileTreeNodes'
import type { DirectoryItem } from '../src/data/workspace'
import { EMPTY_IGNORE_CHAIN } from '../src/data/gitignore'
import { baseName } from '../src/data/paths'

/**
 * A file tree node literal for `path`, shaped the way `FileTree` builds one.
 *
 * @param path - The entry's absolute path.
 * @param isDir - Whether the entry is a folder.
 * @param children - The folder's loaded children, when it has any.
 * @returns The node.
 */
function node(path: string, isDir: boolean, children?: TreeNode[]): TreeNode {
    const data: FileTreeNodeData = { path, isDir, parentChain: EMPTY_IGNORE_CHAIN }

    return children === undefined ? { label: baseName(path), data } : { label: baseName(path), data, children }
}

/**
 * A directory listing entry for `path`, as `listDirectory` returns one.
 *
 * @param path - The entry's absolute path.
 * @param isDir - Whether the entry is a folder.
 * @returns The listing entry.
 */
function item(path: string, isDir: boolean): DirectoryItem {
    return { name: baseName(path), path, isDir }
}

/** A `createNode` spy that builds a fresh node literal for every entry it is given. */
function nodeFactory(): Mock<(entry: DirectoryItem) => TreeNode> {
    return vi.fn((entry: DirectoryItem): TreeNode => node(entry.path, entry.isDir))
}

/**
 * The path a node carries in its payload.
 *
 * @param treeNode - The node to read.
 * @returns The node's absolute path.
 */
function pathOf(treeNode: TreeNode): string {
    return (treeNode.data as FileTreeNodeData).path
}

describe('reconcileChildren', () => {
    it('keeps a surviving entry, adds a new one, and drops a vanished one', () => {
        const lib = node('/p/lib', true)
        const existing = [lib, node('/p/a.ts', false)]
        const createNode = nodeFactory()
        const libItem = item('/p/lib', true)
        const bItem = item('/p/b.ts', false)

        const result = reconcileChildren(existing, [libItem, bItem], createNode)

        expect(result).toHaveLength(2)
        expect(result[0]).toBe(lib)
        expect(pathOf(result[1])).toBe('/p/b.ts')
        expect(createNode).toHaveBeenCalledOnce()
        expect(createNode).toHaveBeenCalledWith(bItem)
    })

    it('builds a new node when an entry flips from a file to a folder', () => {
        const file = node('/p/x', false)
        const createNode = nodeFactory()
        const folderItem = item('/p/x', true)

        const result = reconcileChildren([file], [folderItem], createNode)

        expect(result).toHaveLength(1)
        expect(result[0]).not.toBe(file)
        expect(createNode).toHaveBeenCalledWith(folderItem)
    })

    it('treats a renamed entry as a new one', () => {
        const old = node('/p/old.ts', false)
        const createNode = nodeFactory()

        const result = reconcileChildren([old], [item('/p/new.ts', false)], createNode)

        expect(result).toHaveLength(1)
        expect(result[0]).not.toBe(old)
        expect(pathOf(result[0])).toBe('/p/new.ts')
        expect(createNode).toHaveBeenCalledOnce()
    })

    it("follows the listing's order, reusing every surviving node", () => {
        const upper = node('/p/B.ts', false)
        const lower = node('/p/a.ts', false)
        const createNode = nodeFactory()

        const result = reconcileChildren([upper, lower], [item('/p/a.ts', false), item('/p/B.ts', false)], createNode)

        expect(result).toHaveLength(2)
        expect(result[0]).toBe(lower)
        expect(result[1]).toBe(upper)
        expect(createNode).not.toHaveBeenCalled()
    })

    it('returns no children for an empty listing', () => {
        expect(reconcileChildren([node('/p/a.ts', false)], [], nodeFactory())).toEqual([])
    })

    it('builds a node for every entry when nothing was shown before', () => {
        const createNode = nodeFactory()

        const result = reconcileChildren([], [item('/p/lib', true), item('/p/a.ts', false)], createNode)

        expect(result.map(pathOf)).toEqual(['/p/lib', '/p/a.ts'])
        expect(createNode).toHaveBeenCalledTimes(2)
    })

    it('returns a new array and leaves the existing children untouched', () => {
        const a = node('/p/a.ts', false)
        const b = node('/p/b.ts', false)
        const existing = [a, b]

        const result = reconcileChildren(existing, [item('/p/b.ts', false), item('/p/c.ts', false)], nodeFactory())

        expect(result).not.toBe(existing)
        expect(existing).toHaveLength(2)
        expect(existing[0]).toBe(a)
        expect(existing[1]).toBe(b)
    })
})

describe('findNodeByPath', () => {
    const a = node('/p/src/a.ts', false)
    const lib = node('/p/src/lib', true)
    const src = node('/p/src', true, [a, lib])
    const readme = node('/p/readme.md', false)
    const roots = [src, readme]

    it('finds a root-level node', () => {
        expect(findNodeByPath(roots, '/p/readme.md')).toBe(readme)
    })

    it('finds a nested node', () => {
        expect(findNodeByPath(roots, '/p/src/a.ts')).toBe(a)
    })

    it('does not find a path below a folder that has not loaded', () => {
        expect(findNodeByPath(roots, '/p/src/lib/x.ts')).toBeNull()
    })

    it('does not find a path that is not in the tree', () => {
        expect(findNodeByPath(roots, '/p/missing.ts')).toBeNull()
        expect(findNodeByPath([], '/p/readme.md')).toBeNull()
    })

    it('does not mistake a folder sharing a name prefix for an ancestor', () => {
        const b = node('/p/srcx/b.ts', false)
        const srcx = node('/p/srcx', true, [b])

        expect(findNodeByPath([src, srcx, readme], '/p/srcx/b.ts')).toBe(b)
    })

    it('never descends into a file', () => {
        expect(findNodeByPath([node('/p/f', false)], '/p/f/g')).toBeNull()
    })

    it('finds a nested node in a Windows-shaped tree', () => {
        const file = node('C:\\p\\src\\a.ts', false)
        const folder = node('C:\\p\\src', true, [file])

        expect(findNodeByPath([node('C:\\p\\readme.md', false), folder], 'C:\\p\\src\\a.ts')).toBe(file)
    })
})
