import { callable } from '@jimka/typescript-ui/core'
import { Tree, IconLabelTreeNodeRenderer } from '@jimka/typescript-ui/component/tree'
import type { TreeNode } from '@jimka/typescript-ui/component/tree'
import { listDirectory } from '../data/workspace'
import type { DirectoryItem } from '../data/workspace'

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

  constructor(params: FileTreeParams) {
    super({ expandTrigger: 'click', rowOverflow: 'scroll', backgroundColor: 'rgb(245, 245, 245)' })

    this._onOpenFile = params.onOpenFile

    this.setRendererFactory(() => new IconLabelTreeNodeRenderer(
      node => (node.data as FileTreeNodeData).isDir ? 'folder' : 'file-code',
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
   *
   * @param root - The project folder to show.
   */
  async setProjectRoot(root: string): Promise<void> {
    this.setNodes(this.toNodes(await listDirectory(root)))
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
