import { callable } from '@jimka/typescript-ui/core'
import { Tree, IconLabelTreeNodeRenderer } from '@jimka/typescript-ui/component/tree'
import type { TreeNode } from '@jimka/typescript-ui/component/tree'
import { listDirectory, tryReadTextFile, pathExists, watchDirectory } from '../data/workspace'
import type { DirectoryItem, StopWatching } from '../data/workspace'
import { expansionOrder } from '../data/session'
import { refreshTargets, minimalRoots } from '../data/watchEvents'
import { glyphNameForPath } from '../fileIcons'
import { joinPath } from '../data/paths'
import {
    GITIGNORE_NAME, EMPTY_IGNORE_CHAIN, isHiddenName, extendIgnoreChain, isIgnoredByChain, buildRootIgnoreChain,
} from '../data/gitignore'
import type { IgnoreChain } from '../data/gitignore'

/** How long changed paths accumulate before the tree refreshes, in
 *  milliseconds. Batches the several messages one native flush still delivers
 *  into a single rebuild. */
const TREE_REFRESH_DEBOUNCE_MS = 150

/** Domain payload `FileTree` attaches to every node via `TreeNode.data`. */
interface FileTreeNodeData {
    path: string
    isDir: boolean
    /** The ignore chain governing this node from above — what `loadDirectory` takes as its `parentChain`. */
    parentChain: IgnoreChain
}

/** Constructor parameters for {@link FileTree}. */
export interface FileTreeParams {
    /** Invoked with a file's path when a file row is selected — a single click or an arrow-key move. */
    onSelectFile: (path: string) => void
    /** Invoked with a file's path when a file row is double-clicked. */
    onOpenFile: (path: string) => void
}

/**
 * The project file tree: a `Tree` subclass that loads one directory per
 * expansion — nothing is read ahead of what the user opens.
 */
class FileTree extends Tree {
    private readonly _onSelectFile: (path: string) => void
    private readonly _onOpenFile: (path: string) => void
    private _root: string | null = null
    private _rootChain: IgnoreChain = EMPTY_IGNORE_CHAIN
    private _showHidden = false
    private _showIgnored = false
    private _stopWatching: StopWatching | null = null
    private _pendingDirs = new Set<string>()
    private _refreshTimer: ReturnType<typeof setTimeout> | null = null
    /** Every {@link refreshSubtree} call chains onto this so at most one rebuild runs at a time. */
    private _refreshChain: Promise<void> = Promise.resolve()

    constructor(params: FileTreeParams) {
        super({
            expandTrigger: 'click',
            rowOverflow: 'scroll',
            backgroundColor: 'rgb(245, 245, 245)',
            minSize: { width: 160, height: 0 },
            preferredSize: { width: 300, height: 0 },
        })

        this._onSelectFile = params.onSelectFile
        this._onOpenFile = params.onOpenFile

        this.setRendererFactory(() => new IconLabelTreeNodeRenderer(
            node => {
                const data = node.data as FileTreeNodeData

                return data.isDir ? 'folder' : glyphNameForPath(data.path)
            },
        ))

        this.on('selection', this.handleSelection)
        this.on('dblclick', this.handleDblClick)
    }

    /** `"selection"`: browses the selected node's file in the temp tab; a directory selection opens nothing. */
    private handleSelection = (nodes: TreeNode[]): void => {
        const data = nodes[0]?.data as FileTreeNodeData | undefined

        if (data && !data.isDir) {
            this._onSelectFile(data.path)
        }
    }

    /** `"dblclick"`: opens the node's file for keeps; a directory double-click opens nothing. */
    private handleDblClick = (node: TreeNode): void => {
        const data = node.data as FileTreeNodeData | undefined

        if (data && !data.isDir) {
            this._onOpenFile(data.path)
        }
    }

    /**
     * Points the tree at `root`: seeds the ignore chain governing everything
     * above it (walking up for a `.git`, per {@link buildRootIgnoreChain}),
     * then loads from it. `_root`/`_rootChain` are recorded only once that
     * listing succeeds, preserving the previous behaviour's invariant — a
     * failed open (a restored project folder that was since moved or deleted)
     * leaves the previous root in place rather than corrupting session state
     * with a dead one.
     *
     * @param root - The project folder to show.
     */
    async setProjectRoot(root: string): Promise<void> {
        const chain = await buildRootIgnoreChain(root, tryReadTextFile, pathExists)
        const nodes = await this.loadDirectory(root, chain)

        this.setNodes(nodes)
        this._root = root
        this._rootChain = chain
        this.startWatching(root)
    }

    /** The folder {@link setProjectRoot} last pointed the tree at, or `null` when it never has. */
    getProjectRoot(): string | null {
        return this._root
    }

    /**
     * Selects the node for `path`, syncing the tree to an external source of
     * truth (e.g. the active tab). A path already loaded — the common case,
     * since switching between already-open tabs revisits the same nodes —
     * takes {@link findLoadedNode}'s cheap in-memory lookup straight into
     * {@link Tree.selectNode}, which itself no-ops rather than force-expand a
     * collapsed ancestor. Only a path that has never been loaded pays for
     * {@link Tree.revealByPredicate}'s full reveal — expanding ancestors and
     * loading lazy branches on the way down, the same as {@link expandPaths}.
     * A no-op when `path` is `null`, or when it isn't found under the current
     * root (not loaded, not on disk, or no root is set).
     *
     * @param path - The file or directory path to select, or `null`.
     */
    async selectPath(path: string | null): Promise<void> {
        if (path === null) {
            return
        }

        const node = this.findLoadedNode(path) ?? await this.revealByPredicate(data => (data as FileTreeNodeData).path === path)

        if (node) {
            this.selectNode(node)
        }
    }

    /**
     * Re-lists `dir` and rebuilds every directory the tree had loaded below
     * it, re-applying the hidden/ignored filters and re-reading every
     * `.gitignore` on the way down. Expansion, selection, and scroll
     * position are preserved where the entries still exist. A no-op when
     * `dir` is not the project root and not a directory whose listing the
     * tree has loaded.
     *
     * Every call — from the watcher's own batched flush, from
     * `EditorShell`'s post-save hook, and from any future caller — is
     * chained onto {@link _refreshChain}, so at most one rebuild ever runs
     * at a time: a second rebuild starting before the first finishes would
     * snapshot expansion the first hadn't restored yet and collapse
     * whatever it hadn't reached.
     *
     * @param dir - The directory to refresh.
     */
    async refreshSubtree(dir: string): Promise<void> {
        const run = this._refreshChain.then(() => this.performRefreshSubtree(dir))

        this._refreshChain = run.then(() => undefined, () => undefined)

        return run
    }

    /** {@link refreshSubtree}'s actual work, run strictly after every earlier queued refresh. */
    private async performRefreshSubtree(dir: string): Promise<void> {
        if (this._root === null) {
            return
        }

        if (dir === this._root) {
            await this.rebuild(dir, null, this._rootChain)

            return
        }

        const node = this.findLoadedNode(dir)

        // A directory the tree never listed contributes nothing on screen, so
        // there is nothing to repair — and re-listing it here would eagerly
        // load a branch the user never opened.
        if (node === null || node.children === undefined) {
            return
        }

        const data = node.data as FileTreeNodeData

        if (!data.isDir) {
            return
        }

        await this.rebuild(dir, node, data.parentChain)
    }

    /**
     * Re-lists `dir` under `parentChain` and installs the result as `node`'s
     * children — or as the root node set when `node` is `null` — then
     * replays the expansion, selection, and scroll position `setNodes`
     * cleared.
     *
     * @param dir - The directory to re-list.
     * @param node - The node whose children to replace, or `null` to replace
     *   the whole root node set.
     * @param parentChain - The ignore chain governing `dir` from above.
     */
    private async rebuild(dir: string, node: TreeNode | null, parentChain: IgnoreChain): Promise<void> {
        const expanded = this.getExpandedPaths()
        const selected = this.selectedPath()
        const scrollY = this._scroller?.getScrollY() ?? 0
        const children = await this.loadDirectory(dir, parentChain)

        if (node === null) {
            this.setNodes(children)
        } else {
            node.children = children
            this.setNodes(this.getNodes())
        }

        await this.expandPaths(expanded)
        this.reselect(selected)

        // Restored last so it wins over any incidental scroll `reselect`
        // (via `selectNode`'s reveal behaviour) may have just caused —
        // `setNodes` clamped the offset to the rebuilt, still-collapsed
        // content height, and neither expansion nor selection replay it.
        this.setScrollY(scrollY)
    }

    /** The selected row's path, or `null` when nothing is selected. */
    private selectedPath(): string | null {
        const data = this.getSelectedNode()?.data as FileTreeNodeData | undefined

        return data?.path ?? null
    }

    /**
     * Re-selects `path` when the rebuild left a node for it. Deliberately not
     * `selectPath`: that falls back to `revealByPredicate`, which would load
     * every unloaded branch hunting for a path the refresh may have just
     * removed.
     *
     * @param path - The path to re-select, or `null`.
     */
    private reselect(path: string | null): void {
        const node = path === null ? null : this.findLoadedNode(path)

        if (node !== null) {
            this.selectNode(node)
        }
    }

    /** Whether hidden (leading-dot) entries are currently shown. */
    isShowingHidden(): boolean {
        return this._showHidden
    }

    /**
     * Sets whether hidden entries are shown, and reloads the tree from its
     * root to apply the change — which collapses every expansion (see the
     * plan's `## Potential Challenges`).
     *
     * @param value - Whether to show hidden entries.
     */
    setShowHidden(value: boolean): void {
        this._showHidden = value
        void this.reload()
    }

    /** Whether `.gitignore`-ignored entries are currently shown. */
    isShowingIgnored(): boolean {
        return this._showIgnored
    }

    /**
     * Sets whether ignored entries are shown, and reloads the tree from its
     * root to apply the change.
     *
     * @param value - Whether to show ignored entries.
     */
    setShowIgnored(value: boolean): void {
        this._showIgnored = value
        void this.reload()
    }

    /** Reloads the tree from `_root` using `_rootChain`; a no-op before any root is set. */
    private async reload(): Promise<void> {
        if (this._root === null) {
            return
        }

        this.setNodes(await this.loadDirectory(this._root, this._rootChain))
    }

    /** The absolute paths of the currently expanded directory nodes. */
    getExpandedPaths(): string[] {
        return this.getExpandedNodes().map(node => (node.data as FileTreeNodeData).path)
    }

    /**
     * Expands each of `paths` that still exists, ancestors first; unknown paths
     * are skipped. A path is found only among already-loaded nodes — an
     * ancestor's own expansion (earlier in {@link expansionOrder}'s replay
     * order) is what loads it, so no path needs its own directory read here.
     *
     * @param paths - The absolute directory paths to expand.
     */
    async expandPaths(paths: string[]): Promise<void> {
        for (const path of expansionOrder(paths)) {
            const node = this.findLoadedNode(path)

            if (node) {
                await this.expandNodeAsync(node)
            }
        }
    }

    /**
     * Depth-first search over the currently loaded nodes for the one carrying
     * `path`. Performs no I/O of its own — it finds a nested directory only
     * because an earlier {@link expandPaths} step already expanded (and
     * therefore loaded) its parent.
     *
     * @param path - The absolute path to find.
     * @returns The matching node, or `null` when it isn't loaded.
     */
    private findLoadedNode(path: string): TreeNode | null {
        const search = (nodes: TreeNode[]): TreeNode | null => {
            for (const node of nodes) {
                if ((node.data as FileTreeNodeData).path === path) {
                    return node
                }

                const found = node.children ? search(node.children) : null

                if (found) {
                    return found
                }
            }

            return null
        }

        return search(this.getNodes())
    }

    /**
     * Lists `dir`, extends `parentChain` with `dir`'s own `.gitignore` when it
     * has one, and maps the entries the current toggles don't exclude into
     * `TreeNode` literals. `dir`'s listing is checked for a `.gitignore` entry
     * before issuing the extra read — a directory without one costs nothing —
     * and that check runs before filtering, so a hidden `.gitignore` is never
     * dropped before its own rules are read (see the plan's architecture
     * decisions).
     *
     * @param dir - The directory to list.
     * @param parentChain - The ignore chain governing `dir` from above.
     * @returns `dir`'s visible children as tree nodes.
     */
    private async loadDirectory(dir: string, parentChain: IgnoreChain): Promise<TreeNode[]> {
        const items = await listDirectory(dir)
        const chain = items.some(item => !item.isDir && item.name === GITIGNORE_NAME)
            ? extendIgnoreChain(parentChain, dir, await tryReadTextFile(joinPath(dir, GITIGNORE_NAME)))
            : parentChain

        return this.toNodes(items.filter(item => this.isEntryVisible(item, chain)), chain)
    }

    /**
     * Whether `item` should be shown under the current toggles: a hidden entry
     * is dropped unless {@link _showHidden} is set, and an ignored entry is
     * dropped unless {@link _showIgnored} is set — independently, so either
     * toggle alone reveals only its own class of entry. Named distinctly from
     * `Component.isVisible` (this component's own on-screen visibility, an
     * unrelated inherited member) to avoid overriding it.
     *
     * @param item - The directory entry to test.
     * @param chain - The ignore chain governing `item`'s directory.
     * @returns Whether `item` should appear in the tree.
     */
    private isEntryVisible(item: DirectoryItem, chain: IgnoreChain): boolean {
        if (!this._showHidden && isHiddenName(item.name)) {
            return false
        }

        return this._showIgnored || !isIgnoredByChain(chain, item.path, item.isDir)
    }

    /**
     * Maps a directory listing into `TreeNode` literals. A directory node's
     * `loadChildren` closure receives `chain` unchanged, not the child's own
     * extended chain — the child extends it with its own `.gitignore` when
     * {@link loadDirectory} lists it.
     */
    private toNodes(items: DirectoryItem[], chain: IgnoreChain): TreeNode[] {
        return items.map(item => item.isDir
            ? {
                    label: item.name,
                    hasChildren: true,
                    loadChildren: () => this.loadDirectory(item.path, chain),
                    data: { path: item.path, isDir: true, parentChain: chain } as FileTreeNodeData,
                }
            : {
                    label: item.name,
                    data: { path: item.path, isDir: false, parentChain: chain } as FileTreeNodeData,
                })
    }

    /**
     * Points the watcher at `root`, replacing any watch already running. Not
     * awaited by `setProjectRoot`: registering a recursive watch on a large
     * project takes time the tree does not need to wait for. A watch that
     * lands after the root has moved on again is closed immediately rather
     * than stored.
     *
     * @param root - The project folder to watch.
     */
    private startWatching(root: string): void {
        this.stopWatching()

        void watchDirectory(root, paths => { this.handleFileSystemChange(paths) })
            .then(stop => {
                if (this._root === root) {
                    this._stopWatching = stop
                } else {
                    stop()
                }
            })
            .catch(() => {
                // No watcher: a browser-only `npm run dev` session with no
                // Tauri plugins, or an OS watch-descriptor limit. The tree
                // still works, it just does not follow outside changes.
            })
    }

    /** Releases the running watch, if any. */
    private stopWatching(): void {
        this._stopWatching?.()
        this._stopWatching = null
    }

    /**
     * Records the directories a batch of changed paths affects, and arms the
     * refresh.
     *
     * @param paths - The changed paths the watcher reported.
     */
    private handleFileSystemChange(paths: string[]): void {
        if (this._root === null) {
            return
        }

        for (const dir of refreshTargets(this._root, paths)) {
            this._pendingDirs.add(dir)
        }

        if (this._pendingDirs.size > 0) {
            this.scheduleRefresh()
        }
    }

    /** Arms the batch window. Already-armed is left alone, so a continuous
     *  stream of events still flushes every `TREE_REFRESH_DEBOUNCE_MS`. */
    private scheduleRefresh(): void {
        if (this._refreshTimer !== null) {
            return
        }

        this._refreshTimer = setTimeout(() => {
            this._refreshTimer = null
            void this.flushPendingRefresh()
        }, TREE_REFRESH_DEBOUNCE_MS)
    }

    /** Drops any armed batch window. */
    private cancelScheduledRefresh(): void {
        if (this._refreshTimer !== null) {
            clearTimeout(this._refreshTimer)
            this._refreshTimer = null
        }
    }

    /**
     * Refreshes each pending directory. `minimalRoots` has already removed
     * any target another target covers, so the order between the survivors
     * does not matter; `refreshSubtree`'s own {@link _refreshChain} is what
     * keeps this flush's rebuilds from interleaving with each other or with
     * a concurrent call from outside the watcher (e.g. `EditorShell`'s
     * post-save hook).
     */
    private async flushPendingRefresh(): Promise<void> {
        const dirs = minimalRoots([...this._pendingDirs])

        this._pendingDirs.clear()

        for (const dir of dirs) {
            try {
                await this.refreshSubtree(dir)
            } catch {
                // A directory that vanished between the event and the
                // refresh leaves the tree as it was.
            }
        }
    }

    /** Releases the watch and any armed refresh before the base class tears down. */
    protected destructor(): void {
        this.cancelScheduledRefresh()
        this.stopWatching()
        super.destructor()
    }
}

const FileTreeCallable = callable(FileTree)
type FileTreeCallable = FileTree
export { FileTreeCallable as FileTree }
