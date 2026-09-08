// The search panel's result-tree- and status-formatting rules, split out of
// SearchPanel.ts so it stays unit testable — the same pure-formatting-module-
// beside-its-panel split entryProperties.ts makes for PropertiesPanel.ts.
import type { TreeNode } from '@jimka/typescript-ui/component/tree'
import { pathSegments, joinPath, parentDir, baseName, relativeTo, sortDirEntries } from '../data/paths'
import type { SearchMatch } from '../data/projectSearch'

/** Tags one search-results tree node's `data` payload with what kind of row it is. */
export type SearchTreeNodeData =
    | { kind: 'folder'; path: string }
    | { kind: 'file'; path: string }
    | { kind: 'match'; match: SearchMatch }

/** What the panel's status line is describing. */
export interface SearchStatus {
    phase: 'idle' | 'running' | 'failed' | 'complete' | 'match-limit' | 'file-limit'
    matchCount: number
    fileCount: number
    filesSearched: number
}

/**
 * Buckets `matches` by their file path, preserving each match's original
 * relative order within its bucket.
 *
 * @param matches - The matches to group.
 * @returns Each file's matches, keyed by its absolute path.
 */
function groupByFile(matches: readonly SearchMatch[]): Map<string, SearchMatch[]> {
    const byFile = new Map<string, SearchMatch[]>()

    for (const match of matches) {
        const bucket = byFile.get(match.path)

        if (bucket) {
            bucket.push(match)
        } else {
            byFile.set(match.path, [match])
        }
    }

    return byFile
}

/**
 * Builds one match's leaf node.
 *
 * @param match - The match the leaf describes.
 * @returns The leaf node, labeled with the match's line number and preview.
 */
function matchNode(match: SearchMatch): TreeNode {
    return { label: `${match.line}: ${match.lineText}`, data: { kind: 'match', match } }
}

/**
 * Builds one file's branch node, its children the file's own matches in
 * line order.
 *
 * @param path - The file's absolute path.
 * @param name - The file's displayed label, before its match count is appended.
 * @param fileMatches - The file's matches, in line order.
 * @returns The file branch node.
 */
function fileNode(path: string, name: string, fileMatches: SearchMatch[]): TreeNode {
    return {
        label: `${name} (${fileMatches.length})`,
        data: { kind: 'file', path },
        children: fileMatches.map(matchNode),
    }
}

/**
 * Sorts `nodes` directories-first, case-insensitively (via `sortDirEntries`),
 * recursing into every folder node so each level of the tree is ordered the
 * same way.
 *
 * @param nodes - One tree level's nodes.
 * @returns `nodes`, sorted and with every folder descendant sorted in place.
 */
function sortLevel(nodes: TreeNode[]): TreeNode[] {
    const sorted = sortDirEntries(nodes.map(node => ({
        name: node.label,
        isDir: (node.data as SearchTreeNodeData).kind === 'folder',
        node,
    }))).map(entry => entry.node)

    for (const node of sorted) {
        if ((node.data as SearchTreeNodeData).kind === 'folder') {
            node.children = sortLevel(node.children!)
        }
    }

    return sorted
}

/**
 * Groups `matches` by file, then by every directory between each file and
 * `root`, into `Tree`-ready root nodes — folders and files as branches (each
 * folder's children directories-first, case-insensitive; each file's own
 * children in line order, unsorted), matches as leaves. `root === null`
 * (search never actually finds anything then — `SearchPanel.listFiles`
 * resolves empty with no project open) falls back to a flat, unsorted list
 * of file branches keyed by absolute path.
 *
 * @param matches - The matches to build into a tree.
 * @param root - The open project folder, or `null` when none is open.
 * @returns The matches, grouped into a folder→file→match tree.
 */
export function searchResultNodes(matches: readonly SearchMatch[], root: string | null): TreeNode[] {
    const byFile = groupByFile(matches)

    if (root === null) {
        return [...byFile.entries()].map(([path, fileMatches]) => fileNode(path, path, fileMatches))
    }

    const folders = new Map<string, TreeNode>()
    const topLevel: TreeNode[] = []

    // A freshly, explicitly typed `string` binding — not just a reference to
    // the now-narrowed `root` parameter. TypeScript's flow analysis does not
    // carry a parameter's null-narrowing into a nested function declaration
    // that closes over it (the guard above narrows `root` only within this
    // function's own top-level flow), so `folderChildren` closes over this
    // binding instead, whose declared type needs no flow narrowing to be `string`.
    const projectRoot: string = root

    /**
     * The children array of the folder node for `relDir` (a `/`-normalised
     * path relative to `root` — see the caller's own normalisation below),
     * creating and linking every missing ancestor folder node on the way.
     * `''` names `root` itself, whose children live in `topLevel`. A nested
     * `function` (hoisted) so it can recurse before its own declaration line
     * is reached in source order.
     *
     * Every folder's own absolute `path` is built by joining exactly one
     * name onto its *parent's own already-resolved* path via `joinPath` —
     * never by joining a whole multi-segment `relDir` onto `root` directly —
     * so it always comes out in `root`'s own separator convention (`\` on a
     * Windows root) with no `/`-from-`relDir` ever leaking into it.
     *
     * @param relDir - A directory's `/`-normalised path relative to `root`, or `''` for `root` itself.
     * @returns That directory's children array, ready to push into.
     */
    function folderChildren(relDir: string): TreeNode[] {
        if (relDir === '') {
            return topLevel
        }

        const existing = folders.get(relDir)

        if (existing) {
            return existing.children!
        }

        const segments = pathSegments(relDir)
        const name = segments[segments.length - 1]
        const parentRel = segments.slice(0, -1).join('/')
        const siblings = folderChildren(parentRel)
        const parentPath = parentRel === '' ? projectRoot : (folders.get(parentRel)!.data as { path: string }).path
        const node: TreeNode = { label: name, children: [], data: { kind: 'folder', path: joinPath(parentPath, name) } }

        siblings.push(node)
        folders.set(relDir, node)

        return node.children!
    }

    for (const [path, fileMatches] of byFile) {
        // Normalised to `/` regardless of `root`'s own separator: `relativeTo`
        // preserves whichever separator `root` uses (`\` on Windows), but
        // `folderChildren` above always computes `parentRel` by re-joining
        // `pathSegments` with `/` — the two must agree on one canonical
        // separator, or the same directory reached both directly (here) and
        // as an ancestor (there) would memoize under two different keys and
        // render as two duplicate folder nodes.
        const relDir = (relativeTo(root, parentDir(path)) ?? '').replace(/\\/g, '/')

        folderChildren(relDir).push(fileNode(path, baseName(path), fileMatches))
    }

    return sortLevel(topLevel)
}

/**
 * `count`, followed by `singular` when `count === 1`, `plural` otherwise.
 *
 * @param count - The count to pluralize against.
 * @param singular - The noun's singular form.
 * @param plural - The noun's plural form.
 * @returns `count` and the correctly-pluralized noun, space-separated.
 */
function pluralize(count: number, singular: string, plural: string): string {
    return `${count} ${count === 1 ? singular : plural}`
}

/**
 * The status line's text for a completed (or stopped) run: `N match(es) in N
 * file(s)`, prefixed or suffixed with a note when a limit cut the run short.
 *
 * @param status - The completed run's counts.
 * @returns The status line's text.
 */
function completionSummary(status: SearchStatus): string {
    const matches = pluralize(status.matchCount, 'match', 'matches')
    const files = pluralize(status.fileCount, 'file', 'files')

    if (status.phase === 'match-limit') {
        return `First ${status.matchCount} matches in ${files} — narrow the query.`
    }

    if (status.phase === 'file-limit') {
        return `${matches} in ${files} — stopped after ${status.filesSearched} files.`
    }

    return status.matchCount === 0 ? 'No matches.' : `${matches} in ${files}`
}

/**
 * The search panel's status line text for `status`.
 *
 * @param status - What the panel is currently describing.
 * @returns The text to show in the status line.
 */
export function searchSummaryText(status: SearchStatus): string {
    switch (status.phase) {
        case 'idle':
            return 'Enter a query to search the project.'
        case 'running':
            return 'Searching…'
        case 'failed':
            return 'Could not read the project folder.'
        default:
            return completionSummary(status)
    }
}
