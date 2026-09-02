import { callable } from '@jimka/typescript-ui/core'
import { Tree, IconLabelTreeNodeRenderer } from '@jimka/typescript-ui/component/tree'
import type { TreeNode } from '@jimka/typescript-ui/component/tree'
import { listDirectory, tryReadTextFile, pathExists } from '../data/workspace'
import type { DirectoryItem } from '../data/workspace'
import { expansionOrder } from '../data/session'
import { glyphNameForPath } from '../fileIcons'
import { joinPath } from '../data/paths'
import {
  GITIGNORE_NAME, EMPTY_IGNORE_CHAIN, isHiddenName, extendIgnoreChain, isIgnoredByChain, buildRootIgnoreChain,
} from '../data/gitignore'
import type { IgnoreChain } from '../data/gitignore'

/** Domain payload `FileTree` attaches to every node via `TreeNode.data`. */
interface FileTreeNodeData {
  path: string
  isDir: boolean
}

/** Constructor parameters for {@link FileTree}. */
export interface FileTreeParams {
  /** Invoked with a file's path when a file row (not a directory) is selected. */
  onOpenFile: (path: string) => void
}

/**
 * The project file tree: a `Tree` subclass that loads one directory per
 * expansion — nothing is read ahead of what the user opens.
 */
class FileTree extends Tree {
  private readonly _onOpenFile: (path: string) => void
  private _root: string | null = null
  private _rootChain: IgnoreChain = EMPTY_IGNORE_CHAIN
  private _showHidden = false
  private _showIgnored = false

  constructor(params: FileTreeParams) {
    super({
      expandTrigger: 'click',
      rowOverflow: 'scroll',
      backgroundColor: 'rgb(245, 245, 245)',
      minSize: { width: 160, height: 0 },
      preferredSize: { width: 300, height: 0 },
    })

    this._onOpenFile = params.onOpenFile

    this.setRendererFactory(() => new IconLabelTreeNodeRenderer(
      node => {
        const data = node.data as FileTreeNodeData

        return data.isDir ? 'folder' : glyphNameForPath(data.path)
      },
    ))

    this.on('selection', this.handleSelection)
  }

  /** Opens the selected node's file; a directory selection opens nothing. */
  private handleSelection = (nodes: TreeNode[]): void => {
    const data = nodes[0]?.data as FileTreeNodeData | undefined

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
  }

  /** The folder {@link setProjectRoot} last pointed the tree at, or `null` when it never has. */
  getProjectRoot(): string | null {
    return this._root
  }

  /**
   * Reveals and selects the node for `path`, expanding ancestors as needed —
   * loading any lazy branch on the way down, the same as {@link expandPaths}.
   * A no-op when `path` is `null`, or when it isn't found under the current
   * root (not loaded, not on disk, or no root is set).
   *
   * @param path - The file or directory path to select, or `null`.
   */
  async selectPath(path: string | null): Promise<void> {
    if (path === null) {
      return
    }

    const node = await this.revealByPredicate(data => (data as FileTreeNodeData).path === path)

    if (node) {
      this.selectNode(node)
    }
  }

  /**
   * Reloads the tree from its root while preserving which directories are
   * currently expanded — unlike {@link setShowHidden}/{@link setShowIgnored},
   * which intentionally collapse everything. A no-op before any root is set.
   */
  async refresh(): Promise<void> {
    if (this._root === null) {
      return
    }

    const expanded = this.getExpandedPaths()

    await this.reload()
    await this.expandPaths(expanded)
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
          data: { path: item.path, isDir: true } as FileTreeNodeData,
        }
      : {
          label: item.name,
          data: { path: item.path, isDir: false } as FileTreeNodeData,
        })
  }
}

const FileTreeCallable = callable(FileTree)
type FileTreeCallable = FileTree
export { FileTreeCallable as FileTree }
