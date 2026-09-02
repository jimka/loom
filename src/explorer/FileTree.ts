import { callable } from '@jimka/typescript-ui/core'
import { Tree, IconLabelTreeNodeRenderer } from '@jimka/typescript-ui/component/tree'
import type { TreeNode } from '@jimka/typescript-ui/component/tree'
import { listDirectory } from '../data/workspace'
import type { DirectoryItem } from '../data/workspace'
import { expansionOrder } from '../data/session'
import { glyphNameForPath } from '../fileIcons'

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
   * Replaces the tree with `root`'s immediate children, directories first.
   * The root is recorded only once the listing succeeds, so a failed listing
   * leaves the previous root in place.
   *
   * @param root - The project folder to show.
   */
  async setProjectRoot(root: string): Promise<void> {
    const items = await listDirectory(root)

    this.setNodes(this.toNodes(items))
    this._root = root
  }

  /** The folder {@link setProjectRoot} last loaded successfully, or `null` when it never has. */
  getProjectRoot(): string | null {
    return this._root
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

  /** `loadChildren` for a lazily-expanded directory node. */
  private async loadInto(path: string): Promise<TreeNode[]> {
    return this.toNodes(await listDirectory(path))
  }

  /** Maps a directory listing into `TreeNode` literals. */
  private toNodes(items: DirectoryItem[]): TreeNode[] {
    return items.map(item => item.isDir
      ? {
          label: item.name,
          hasChildren: true,
          loadChildren: () => this.loadInto(item.path),
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
