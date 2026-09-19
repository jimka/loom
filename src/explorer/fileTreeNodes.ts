// The file tree's node payload and its pure node-list rules — matching a
// fresh directory listing against the nodes already shown, and finding a
// loaded node by path — split out of FileTree.ts so they stay unit testable in
// vitest's `node` environment: FileTree.ts imports ../data/workspace, the
// app's Tauri entry point. The same split searchResults.ts makes for
// SearchPanel.ts.
import type { TreeNode } from '@jimka/typescript-ui/component/tree'
import type { DirectoryItem } from '../data/workspace'
import type { IgnoreChain } from '../data/gitignore'
import { relativeTo } from '../data/paths'

/** Domain payload `FileTree` attaches to every node via `TreeNode.data`. */
export interface FileTreeNodeData {
    path: string
    isDir: boolean
    /** The ignore chain governing this node from above — what `FileTree`'s
     *  listing takes as its `parentChain`. Rewritten in place each time the
     *  node's parent folder is re-listed. */
    parentChain: IgnoreChain
}

/**
 * The child list for a re-listed folder: `items`, in listing order, each
 * mapped to the node in `existing` with the same path and the same kind when
 * there is one, and to `createNode(item)` otherwise. Nodes in `existing` that
 * match no item are left out. Always returns a new array and never changes
 * `existing`.
 *
 * @param existing - The folder's current children.
 * @param items - The folder's fresh listing, already filtered.
 * @param createNode - Builds the node for an entry with no surviving match.
 * @returns The children to hand to `Tree.setChildren`.
 */
export function reconcileChildren(
    existing: readonly TreeNode[],
    items: readonly DirectoryItem[],
    createNode: (item: DirectoryItem) => TreeNode,
): TreeNode[] {
    const byPath = new Map<string, TreeNode>()

    for (const node of existing) {
        byPath.set((node.data as FileTreeNodeData).path, node)
    }

    return items.map(item => {
        const match = byPath.get(item.path)

        return match !== undefined && (match.data as FileTreeNodeData).isDir === item.isDir ? match : createNode(item)
    })
}

/**
 * Finds the loaded node for `path`, walking down from `nodes` through the one
 * node per level whose path is `path` or an ancestor of it. Performs no I/O:
 * a path below a folder that has not loaded its children is not found.
 *
 * Paths are compared as strings: a node matches only when its path equals
 * `path` exactly, and an ancestor is recognised by its path being a prefix
 * of `path` up to a separator. `FileTree` builds every child's path by
 * joining its name onto its parent's, so an ancestor's path is always such
 * a prefix. A string test, rather than `isUnderRoot`'s segment split, keeps
 * each step cheap: it runs once per sibling at every level, for every target
 * of a watcher batch that may name thousands of paths.
 *
 * @param nodes - The root nodes to start from.
 * @param path - The absolute path to find.
 * @returns The matching node, or `null` when it isn't loaded.
 */
export function findNodeByPath(nodes: readonly TreeNode[], path: string): TreeNode | null {
    let level: readonly TreeNode[] | undefined = nodes

    while (level !== undefined) {
        const next: TreeNode | undefined = level.find(node => isSameOrAncestor((node.data as FileTreeNodeData).path, path))

        if (next === undefined) {
            return null
        }

        if ((next.data as FileTreeNodeData).path === path) {
            return next
        }

        level = next.children
    }

    return null
}

/**
 * Whether `candidate` is `path` itself or, by string prefix, a folder
 * containing it (see {@link findNodeByPath}).
 *
 * @param candidate - A loaded node's path.
 * @param path - The path being looked up.
 * @returns Whether the descent should continue through `candidate`.
 */
function isSameOrAncestor(candidate: string, path: string): boolean {
    return candidate === path || relativeTo(candidate, path) !== null
}
