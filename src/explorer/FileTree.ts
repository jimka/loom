import { callable, Event } from '@jimka/typescript-ui/core'
import { Tree, IconLabelTreeNodeRenderer } from '@jimka/typescript-ui/component/tree'
import type { TreeNode } from '@jimka/typescript-ui/component/tree'
import { Menu, Notification, Dialog } from '@jimka/typescript-ui/overlay'
import type { MenuItemConfig } from '@jimka/typescript-ui/component/container'
import {
    listDirectory, tryReadTextFile, pathExists, watchDirectory, writeFileText, createDirectory, renamePath, removePath,
} from '../data/workspace'
import type { DirectoryItem, StopWatching } from '../data/workspace'
import { expansionOrder } from '../data/session'
import { refreshTargets, mergeRefreshTargets } from '../data/watchEvents'
import type { RefreshTarget } from '../data/watchEvents'
import { glyphNameForPath } from '../fileIcons'
import { joinPath, parentDir } from '../data/paths'
import {
    GITIGNORE_NAME, EMPTY_IGNORE_CHAIN, isHiddenName, extendIgnoreChain, isIgnoredByChain, buildRootIgnoreChain,
} from '../data/gitignore'
import type { IgnoreChain } from '../data/gitignore'
import { messageOf } from '../errors'
import { promptNewEntryName, promptRenameName, confirmDelete } from './fileTreePrompts'
import type { SelectedEntry } from './entryProperties'
import { reconcileChildren, findNodeByPath } from './fileTreeNodes'
import type { FileTreeNodeData } from './fileTreeNodes'

/** How long changed paths accumulate before the tree refreshes, in
 *  milliseconds. Batches the several messages one native flush still delivers
 *  into a single refresh pass. */
const TREE_REFRESH_DEBOUNCE_MS = 150

/** A folder's visible entries and the ignore chain that governs them. */
interface DirectoryListing {
    items: DirectoryItem[]
    chain: IgnoreChain
}

/** Constructor parameters for {@link FileTree}. */
export interface FileTreeParams {
    /** Invoked with a file's path when a file row is selected — a single click or an arrow-key move. */
    onSelectFile: (path: string) => void
    /** Invoked with the selected row — a file or a directory — or `null` when
     *  the selection is cleared. Fires on a single click, an arrow-key move,
     *  and every selection the tree makes itself. */
    onSelectEntry: (entry: SelectedEntry | null) => void
    /** Invoked with a file's path when a file row is double-clicked. */
    onOpenFile: (path: string) => void
    /** Called after the tree deletes a file or folder, with its path. */
    onPathDeleted: (path: string) => void
    /** Called after the tree renames a file or folder, with its old and new paths. */
    onPathRenamed: (oldPath: string, newPath: string) => void
    /** Called with the raw batch of changed paths the watcher reported, before any tree filtering, and
     *  whether the batch can have changed what a directory lists — `false` for a file whose content was
     *  only rewritten in place, such as a save. */
    onPathsChanged: (paths: string[], listingChanged: boolean) => void
}

/**
 * The project file tree: a `Tree` subclass that loads one directory per
 * expansion — nothing is read ahead of what the user opens.
 */
class FileTree extends Tree {
    private readonly _onSelectFile: (path: string) => void
    private readonly _onSelectEntry: (entry: SelectedEntry | null) => void
    private readonly _onOpenFile: (path: string) => void
    private readonly _onPathDeleted: (path: string) => void
    private readonly _onPathRenamed: (oldPath: string, newPath: string) => void
    private readonly _onPathsChanged: (paths: string[], listingChanged: boolean) => void
    private readonly _menu = Menu()
    private _root: string | null = null
    private _rootChain: IgnoreChain = EMPTY_IGNORE_CHAIN
    private _showHidden = false
    private _showIgnored = false
    private _stopWatching: StopWatching | null = null
    private _pendingTargets: RefreshTarget[] = []
    private _refreshTimer: ReturnType<typeof setTimeout> | null = null
    /** Every refresh — the watcher's, the tree's own actions', a Save As's,
     *  and the Show Hidden/Show Ignored toggles' — chains onto this so they
     *  run one at a time: each reconciles against the children the previous
     *  one installed, and an older listing never lands over a newer one. */
    private _refreshChain: Promise<void> = Promise.resolve()

    constructor(params: FileTreeParams) {
        super({
            expandTrigger: 'click',
            rowOverflow: 'scroll',
            // The sidebar rail's own toolbar surface token, so the tree reads
            // as the rail's own recessed chrome and follows a theme switch,
            // rather than a hardcoded light-grey slab under a dark theme.
            backgroundColor: 'var(--ts-ui-toolbar-bg, rgb(245, 245, 245))',
            minSize: { width: 160, height: 0 },
            preferredSize: { width: 300, height: 0 },
        })

        this._onSelectFile = params.onSelectFile
        this._onSelectEntry = params.onSelectEntry
        this._onOpenFile = params.onOpenFile
        this._onPathDeleted = params.onPathDeleted
        this._onPathRenamed = params.onPathRenamed
        this._onPathsChanged = params.onPathsChanged

        this.setRendererFactory(() => new IconLabelTreeNodeRenderer(
            node => {
                const data = node.data as FileTreeNodeData

                return data.isDir ? 'folder' : glyphNameForPath(data.path)
            },
        ))

        this.on('selection', this.handleSelection)
        this.on('dblclick', this.handleDblClick)
        this.on('contextmenu', this.handleNodeContextMenu)
        Event.addSubtreeListener(this, 'contextmenu', this.handleBackgroundContextMenu)
    }

    /** `"selection"`: browses the selected node's file in the temp tab; a directory selection opens nothing. */
    private handleSelection = (nodes: TreeNode[]): void => {
        const data = nodes[0]?.data as FileTreeNodeData | undefined

        if (data && !data.isDir) {
            this._onSelectFile(data.path)
        }

        this.notifySelectedEntry()
    }

    /** `"dblclick"`: opens the node's file for keeps; a directory double-click opens nothing. */
    private handleDblClick = (node: TreeNode): void => {
        const data = node.data as FileTreeNodeData | undefined

        if (data && !data.isDir) {
            this._onOpenFile(data.path)
        }
    }

    /** `Tree`'s own `"contextmenu"` event: fires only when a row is right-clicked, with that row's node already resolved. */
    private handleNodeContextMenu = (node: TreeNode, event: MouseEvent): void => {
        const data = node.data as FileTreeNodeData
        const items = data.isDir ? this.buildDirectoryMenuItems(data.path) : this.buildFileMenuItems(data.path)

        this._menu.show(event.clientX, event.clientY, items)
    }

    /**
     * Raw `contextmenu` listener that fires for every right-click inside the
     * tree, row hits included. `Tree`'s own row-matching listener is
     * registered lazily, from `Tree.init()` on first render, while this one
     * registers eagerly in the constructor — so this entry is always the
     * *earlier* of the two in `Event`'s shared per-`(this, 'contextmenu')`
     * dispatch list, not the later one (see the Implementation Notes
     * superseding this plan's `^context-menu-dispatch` footnote). Checking
     * `event.defaultPrevented` synchronously would therefore always see
     * `false`, row hits included. Deferring the check to a microtask fixes
     * that: microtasks drain only after the whole synchronous dispatch for
     * this event — every listener, `Tree`'s row-matching handler included —
     * has already run, so `event.defaultPrevented` is reliably settled by
     * the time this reads it, regardless of registration order.
     */
    private handleBackgroundContextMenu = (event: MouseEvent): void => {
        queueMicrotask(() => {
            if (event.defaultPrevented || this._root === null) {
                return
            }

            this._menu.show(event.clientX, event.clientY, this.buildRootMenuItems(this._root))
        })
    }

    /** A file row's menu: rename, delete, and copy its path. */
    private buildFileMenuItems(path: string): MenuItemConfig[] {
        return [
            { text: 'Rename', glyph: 'pen-to-square', action: () => { void this.renameEntry(path, false) } },
            { text: 'Delete', glyph: 'trash', action: () => { void this.deleteEntry(path, false) } },
            { separator: true },
            { text: 'Copy Path', glyph: 'copy', action: () => { void this.copyPath(path) } },
        ]
    }

    /** A directory row's menu: create inside it, then rename, delete, and copy its own path. */
    private buildDirectoryMenuItems(path: string): MenuItemConfig[] {
        return [
            { text: 'New File', glyph: 'file-circle-plus', action: () => { void this.createFile(path) } },
            { text: 'New Folder', glyph: 'folder-plus', action: () => { void this.createFolder(path) } },
            { separator: true },
            { text: 'Rename', glyph: 'pen-to-square', action: () => { void this.renameEntry(path, true) } },
            { text: 'Delete', glyph: 'trash', action: () => { void this.deleteEntry(path, true) } },
            { separator: true },
            { text: 'Copy Path', glyph: 'copy', action: () => { void this.copyPath(path) } },
        ]
    }

    /** Empty tree space's menu: create at the workspace root. */
    private buildRootMenuItems(root: string): MenuItemConfig[] {
        return [
            { text: 'New File', glyph: 'file-circle-plus', action: () => { void this.createFile(root) } },
            { text: 'New Folder', glyph: 'folder-plus', action: () => { void this.createFolder(root) } },
        ]
    }

    /**
     * Prompts for a new file's name inside `dir`, creates it, and opens it.
     * `selectPath` reveals it even when `dir` was collapsed or never loaded:
     * `refreshDirectory` is then a no-op (see `## Architecture Decisions`), but
     * `selectPath`'s own existing fallback — already used to sync the tree to
     * the active tab — expands and loads whatever is needed to find the new
     * path, so no separate "expand the directory" step is needed here.
     *
     * @param dir - The directory to create the new file inside.
     */
    private async createFile(dir: string): Promise<void> {
        const path = await promptNewEntryName(dir, 'file')

        if (path === null) {
            return
        }

        try {
            await writeFileText(path, '')
        } catch (error) {
            await Dialog.error('Could not create file', messageOf(error))

            return
        }

        await this.refreshDirectory(dir)
        await this.selectPath(path)
        this._onOpenFile(path)
    }

    /**
     * Prompts for a new folder's name inside `dir` and creates it. Mirrors
     * {@link createFile} but does not open a tab for the result.
     *
     * @param dir - The directory to create the new folder inside.
     */
    private async createFolder(dir: string): Promise<void> {
        const path = await promptNewEntryName(dir, 'folder')

        if (path === null) {
            return
        }

        try {
            await createDirectory(path)
        } catch (error) {
            await Dialog.error('Could not create folder', messageOf(error))

            return
        }

        await this.refreshDirectory(dir)
        await this.selectPath(path)
    }

    /** Prompts for `path`'s new name, renames it on disk, relocates any open tab under it, and refreshes the tree and selects the renamed entry.
     *
     * @param path - The file or folder to rename.
     * @param isDir - Whether `path` is a directory.
     */
    private async renameEntry(path: string, isDir: boolean): Promise<void> {
        const newPath = await promptRenameName(path, isDir)

        if (newPath === null) {
            return
        }

        try {
            await renamePath(path, newPath)
        } catch (error) {
            await Dialog.error('Could not rename', messageOf(error))

            return
        }

        this._onPathRenamed(path, newPath)
        await this.refreshDirectory(parentDir(path))
        await this.selectPath(newPath)
    }

    /**
     * Confirms, then deletes `path` from disk, closes any open tab under it,
     * and refreshes the tree.
     *
     * @param path - The file or folder to delete.
     * @param isDir - Whether `path` is a directory.
     */
    private async deleteEntry(path: string, isDir: boolean): Promise<void> {
        if (!(await confirmDelete(path, isDir))) {
            return
        }

        try {
            await removePath(path, isDir)
        } catch (error) {
            await Dialog.error('Could not delete', messageOf(error))

            return
        }

        this._onPathDeleted(path)
        await this.refreshDirectory(parentDir(path))
    }

    /** Copies `path` to the clipboard and shows a brief success toast — the only action with no visible tree change of its own.
     *
     * @param path - The path to copy.
     */
    private async copyPath(path: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(path)
            Notification.show('Path copied.', 'success')
        } catch (error) {
            await Dialog.error('Could not copy path', messageOf(error))
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
        this.notifySelectedEntry()
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
            this.notifySelectedEntry()
        }
    }

    /**
     * Re-lists `dir` in place: entries still there keep their rows,
     * expansion, loaded children and selection; new entries appear; vanished
     * ones disappear. Folders below `dir` are not re-read. A no-op when `dir`
     * is neither the project root nor a folder the tree has loaded. Queued on
     * {@link _refreshChain} behind every refresh already running.
     *
     * @param dir - The folder to re-list.
     */
    async refreshDirectory(dir: string): Promise<void> {
        return this.queueRefresh({ path: dir, deep: false })
    }

    /**
     * Runs `target`'s refresh after every refresh already queued on
     * {@link _refreshChain}.
     *
     * @param target - The path to re-list, and whether to go deep.
     * @returns A promise that settles, with the refresh's own outcome, once it has run.
     */
    private queueRefresh(target: RefreshTarget): Promise<void> {
        const run = this._refreshChain.then(() => this.performRefresh(target))

        this._refreshChain = run.then(() => undefined, () => undefined)

        return run
    }

    /**
     * {@link queueRefresh}'s actual work: finds `target`'s folder node and
     * re-lists it; skips a target that is not a loaded folder.
     *
     * @param target - The path to re-list, and whether to go deep.
     */
    private async performRefresh(target: RefreshTarget): Promise<void> {
        if (this._root === null) {
            return
        }

        if (target.path === this._root) {
            await this.relistDirectory(null, target.path, this._rootChain, target.deep)

            return
        }

        const node = this.findLoadedNode(target.path)

        // A folder the tree never listed contributes nothing on screen, so
        // there is nothing to repair — and re-listing it here would eagerly
        // load a branch the user never opened. A file target lands here too.
        if (node === null || node.children === undefined) {
            return
        }

        const data = node.data as FileTreeNodeData

        if (!data.isDir) {
            return
        }

        await this.relistDirectory(node, target.path, data.parentChain, target.deep)
    }

    /**
     * Reads `dir`, reconciles the listing against `node`'s current children
     * (or the root level when `node` is `null`), writes the fresh chain into
     * every child's `parentChain`, and installs the result. With `deep`,
     * then does the same for every loaded folder among the new children.
     *
     * @param node - The folder node to re-list, or `null` for the root level.
     * @param dir - The folder's path.
     * @param parentChain - The ignore chain governing `dir` from above.
     * @param deep - Whether to also re-list every loaded folder below `dir`.
     */
    private async relistDirectory(node: TreeNode | null, dir: string, parentChain: IgnoreChain, deep: boolean): Promise<void> {
        const listing = await this.readListing(dir, parentChain)

        // The project changed while the listing was read: this root-level
        // result belongs to the previous project.
        if (node === null && this._root !== dir) {
            return
        }

        const existing = node === null ? this.getNodes() : (node.children ?? [])
        const children = reconcileChildren(existing, listing.items, item => this.toNode(item, listing.chain))

        for (const child of children) {
            const data = child.data as FileTreeNodeData

            data.parentChain = listing.chain
        }

        this.applyChildren(node, children)

        if (deep) {
            await this.relistLoadedChildren(children)
        }
    }

    /**
     * A deep refresh's recursion: re-lists each folder in `children` that
     * has loaded its own children. A new folder node is never loaded, so
     * only a reused one is re-read.
     *
     * @param children - The child list just installed.
     */
    private async relistLoadedChildren(children: TreeNode[]): Promise<void> {
        for (const child of children) {
            const data = child.data as FileTreeNodeData

            if (!data.isDir || child.children === undefined) {
                continue
            }

            try {
                await this.relistDirectory(child, data.path, data.parentChain, true)
            } catch {
                // A folder removed while the refresh walked down; the removal
                // is its parent's own next watcher event.
            }
        }
    }

    /**
     * Installs `children` under `parent` with `Tree.setChildren`, then tells
     * the properties panel when that call dropped the selected row —
     * `setChildren` removes a node without emitting `"selection"`. A
     * selection that survives is not reported again: it still describes the
     * same entry, and a change to that entry itself reaches the panel through
     * {@link _onPathsChanged} instead.
     *
     * @param parent - The folder node whose children to replace, or `null` for the root level.
     * @param children - The new child list; stored by reference, so never changed afterwards.
     */
    private applyChildren(parent: TreeNode | null, children: TreeNode[]): void {
        const selected = this.getSelectedNode()

        this.setChildren(parent, children)

        if (this.getSelectedNode() !== selected) {
            this.notifySelectedEntry()
        }
    }

    /**
     * Reports the anchor row — the one a plain click or an arrow-key move
     * last landed on — to {@link _onSelectEntry}, or `null` when nothing is
     * selected. Called from every path that changes the selection, `Tree`'s
     * own `"selection"` event included, so the properties panel tracks the
     * highlighted row however it got highlighted.
     */
    private notifySelectedEntry(): void {
        const data = this.getSelectedNode()?.data as FileTreeNodeData | undefined

        this._onSelectEntry(data === undefined ? null : { path: data.path, isDir: data.isDir })
    }

    /** Whether hidden (leading-dot) entries are currently shown. */
    isShowingHidden(): boolean {
        return this._showHidden
    }

    /**
     * Sets whether hidden entries are shown, and re-filters every loaded
     * folder in place to apply the change — expansion, selection and scroll
     * are kept. Returns the re-filter's own promise, which settles once it is
     * done, so a caller that needs to sequence work after it (e.g. restoring
     * tree expansion afterward) can `await` it instead of racing it —
     * mirroring {@link setProjectRoot}'s own awaitable load.
     *
     * @param value - Whether to show hidden entries.
     */
    async setShowHidden(value: boolean): Promise<void> {
        this._showHidden = value
        await this.refilterTree()
    }

    /** Whether `.gitignore`-ignored entries are currently shown. */
    isShowingIgnored(): boolean {
        return this._showIgnored
    }

    /**
     * Sets whether ignored entries are shown, and re-filters every loaded
     * folder in place to apply the change — expansion, selection and scroll
     * are kept. Returns the re-filter's own promise, for the same reason
     * {@link setShowHidden} does.
     *
     * @param value - Whether to show ignored entries.
     */
    async setShowIgnored(value: boolean): Promise<void> {
        this._showIgnored = value
        await this.refilterTree()
    }

    /**
     * Re-applies the hidden/ignored toggles to every loaded folder in place,
     * through the same deep refresh a changed root `.gitignore` gets, queued
     * on {@link _refreshChain}. A no-op before any root is set.
     */
    private async refilterTree(): Promise<void> {
        if (this._root === null) {
            return
        }

        await this.queueRefresh({ path: this._root, deep: true })
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
     * Finds the loaded node carrying `path`, walking down from the root level
     * along the path (see {@link findNodeByPath}). Performs no I/O of its own
     * — it finds a nested directory only because an earlier
     * {@link expandPaths} step already expanded (and therefore loaded) its
     * parent.
     *
     * @param path - The absolute path to find.
     * @returns The matching node, or `null` when it isn't loaded.
     */
    private findLoadedNode(path: string): TreeNode | null {
        return findNodeByPath(this.getNodes(), path)
    }

    /**
     * Lists `dir`, extends `parentChain` with `dir`'s own `.gitignore` when it
     * has one, and keeps the entries the current toggles don't exclude.
     * `dir`'s listing is checked for a `.gitignore` entry before issuing the
     * extra read — a directory without one costs nothing — and that check
     * runs before filtering, so a hidden `.gitignore` is never dropped before
     * its own rules are read (see the plan's architecture decisions).
     *
     * @param dir - The directory to list.
     * @param parentChain - The ignore chain governing `dir` from above.
     * @returns `dir`'s visible entries and the chain that governs them.
     */
    private async readListing(dir: string, parentChain: IgnoreChain): Promise<DirectoryListing> {
        const items = await listDirectory(dir)
        const chain = items.some(item => !item.isDir && item.name === GITIGNORE_NAME)
            ? extendIgnoreChain(parentChain, dir, await tryReadTextFile(joinPath(dir, GITIGNORE_NAME)))
            : parentChain

        return { items: items.filter(item => this.isEntryVisible(item, chain)), chain }
    }

    /**
     * Lists `dir` (see {@link readListing}) and maps its visible entries into
     * `TreeNode` literals.
     *
     * @param dir - The directory to list.
     * @param parentChain - The ignore chain governing `dir` from above.
     * @returns `dir`'s visible children as tree nodes.
     */
    private async loadDirectory(dir: string, parentChain: IgnoreChain): Promise<TreeNode[]> {
        const listing = await this.readListing(dir, parentChain)

        return listing.items.map(item => this.toNode(item, listing.chain))
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
     * Builds one entry's node. A folder's `loadChildren` reads the node's own
     * `data.parentChain` when it runs — not `chain` as captured here — so a
     * refresh that rewrites that field reaches a folder that has not loaded
     * yet. The closure must therefore hold the very `data` object placed on
     * the node, never a copy. The folder extends that chain with its own
     * `.gitignore` when {@link loadDirectory} lists it.
     *
     * @param item - The directory entry.
     * @param chain - The ignore chain governing `item`'s directory.
     * @returns The entry's node.
     */
    private toNode(item: DirectoryItem, chain: IgnoreChain): TreeNode {
        const data: FileTreeNodeData = { path: item.path, isDir: item.isDir, parentChain: chain }

        if (!item.isDir) {
            return { label: item.name, data }
        }

        return {
            label: item.name,
            hasChildren: true,
            loadChildren: () => this.loadDirectory(data.path, data.parentChain),
            data,
        }
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

        void watchDirectory(root, (paths, listingChanged) => { this.handleFileSystemChange(paths, listingChanged) })
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
     * Reports a batch of changed paths, and — when the batch can have changed
     * a directory listing — records the batch's refresh targets (see
     * `refreshTargets`) and arms the refresh. A batch that only rewrote files in place, which is what every
     * save is, re-lists nothing: the tree shows each entry's name and icon,
     * and neither depends on the file's content.
     *
     * @param paths - The changed paths the watcher reported.
     * @param listingChanged - Whether the batch can have changed what a directory lists.
     */
    private handleFileSystemChange(paths: string[], listingChanged: boolean): void {
        if (this._root === null) {
            return
        }

        this._onPathsChanged(paths, listingChanged)

        if (!listingChanged) {
            return
        }

        this._pendingTargets.push(...refreshTargets(this._root, paths))

        if (this._pendingTargets.length > 0) {
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
     * Merges the pending targets (see `mergeRefreshTargets`) and queues each
     * on {@link _refreshChain}, ancestors first — so a folder its parent's
     * refresh just removed is skipped rather than read. The chain is what
     * keeps this flush's refreshes from interleaving with each other or with
     * a concurrent one from outside the watcher (a tree action, a Save As, a
     * toggle).
     */
    private async flushPendingRefresh(): Promise<void> {
        const targets = mergeRefreshTargets(this._pendingTargets)

        this._pendingTargets = []

        for (const target of targets) {
            try {
                await this.queueRefresh(target)
            } catch {
                // A folder that vanished between the event and the refresh
                // leaves the tree as it was.
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
