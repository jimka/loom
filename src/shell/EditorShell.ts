import { Container, callable } from '@jimka/typescript-ui/core'
import { Placement } from '@jimka/typescript-ui/primitive'
import { Border as BorderLayout, Split } from '@jimka/typescript-ui/layout'
import { MenuBar } from '@jimka/typescript-ui/component/menubar'
import { FileTree } from '../explorer/FileTree'
import type { EditorController } from '../EditorController'
import type { SessionState } from '../data/session'
import type { SessionAutosave } from './session'
import { applySession, installSessionAutosave, loadWorkspaceState } from './session'
import {
  OPEN_FOLDER_SHORTCUT, SAVE_SHORTCUT, SAVE_AS_SHORTCUT, CLOSE_FILE_SHORTCUT,
  FORMAT_SHORTCUT, TOGGLE_EXPLORER_SHORTCUT, EXIT_SHORTCUT, installAccelerators,
} from './shortcuts'
import type { AcceleratorActions } from './shortcuts'

/** The tree pane's index in the shell's `Split` — 0, the only other pane being the editor tabs. */
const EXPLORER_PANE_INDEX = 0

/** The menu-bar action callbacks the shell wires to the controller and the split. */
interface MenuBarActions extends AcceleratorActions {
  /** Whether a file is currently active — greys out the per-file items when not. */
  hasActiveFile: () => boolean
  /** Whether the active file has unsaved changes — the Save item is greyed out when not. */
  isActiveDirty: () => boolean
}

/**
 * The app shell: a `Border`-laid `Container` with the menu bar NORTH, a
 * horizontal `Split` (explorer tree beside the editor tabs) CENTER, and the
 * status bar SOUTH — the same shape as
 * `../../sqladmin/frontend/src/shell/SqlAdminShell.ts`.
 */
class EditorShell extends Container {
  private readonly _tree: FileTree
  private readonly _split: Split
  private readonly _controller: EditorController
  private _autosave: SessionAutosave | null = null

  /**
   * @param controller - Owns the tab strip, the status bar, and every editor command.
   * @param session - The stored session; its split entries seed the `Split`.
   */
  constructor(controller: EditorController, session: SessionState) {
    const tree = FileTree({ onOpenFile: (path: string) => { void controller.openFile(path) } })
    const split = new Split({
      orientation: 'horizontal',
      paneSizes: session.paneSizes,
      collapsedPanes: session.collapsedPanes,
    })
    const splitBody = Container({ layoutManager: split })

    splitBody.addComponent(tree, { weight: 0 })
    splitBody.addComponent(controller.tabs, { weight: 1 })

    const actions: MenuBarActions = {
      onOpenFolder: () => { void controller.openProjectFolder() },
      onSave: () => { void controller.saveActive() },
      onSaveAs: () => { void controller.saveActiveAs() },
      onCloseFile: () => controller.closeActive(),
      onFormat: () => { void controller.formatActive() },
      onToggleExplorer: () => split.setPaneCollapsed(EXPLORER_PANE_INDEX, !split.isPaneCollapsed(EXPLORER_PANE_INDEX)),
      onExit: () => { void controller.exitApp() },
      hasActiveFile: () => controller.hasActiveFile(),
      isActiveDirty: () => controller.isActiveDirty(),
    }

    const menuBar = buildMenuBar(actions)

    super({
      layoutManager: new BorderLayout({ spacing: 0 }),
      components: [
        { component: menuBar,             constraints: { placement: Placement.NORTH } },
        { component: splitBody,           constraints: { placement: Placement.CENTER } },
        { component: controller.statusBar, constraints: { placement: Placement.SOUTH } },
      ],
    })

    this._tree = tree
    this._split = split
    this._controller = controller

    controller.setProjectRootListener(root => { void this.openProjectRoot(root) })
    installAccelerators(actions)
  }

  /**
   * Replays `state` into the tree and tabs, then starts autosaving. Installing
   * the autosave listeners **after** the restore is what stops the restore
   * from saving its own half-finished state — there is no suppression flag
   * anywhere in this design, and none should be added.
   *
   * @param state - The session to restore.
   */
  async restoreSession(state: SessionState): Promise<void> {
    const targets = { controller: this._controller, tree: this._tree, split: this._split }

    await applySession(state, targets)

    const autosave = installSessionAutosave(targets)

    this._autosave = autosave
    this._controller.setBeforeExitListener(() => autosave.flush())
  }

  /**
   * `setProjectRootListener`'s callback: flushes the outgoing project's own
   * pending autosave, points the tree at the newly chosen folder, restores
   * that folder's saved tree expansion (if it has any), then schedules a
   * session save. No `catch` around the listing itself — a failed listing
   * keeps exactly the unhandled rejection it has today. Tabs, the active
   * file, and the split are deliberately left untouched by a live switch —
   * only tree expansion restores outside a cold start.
   *
   * @param root - The newly chosen project folder.
   */
  private async openProjectRoot(root: string): Promise<void> {
    await this._autosave?.flush()
    await this._tree.setProjectRoot(root)

    const workspace = await loadWorkspaceState(root)

    if (workspace) {
      await this._tree.expandPaths(workspace.expandedDirs)
    }

    this._autosave?.schedule()
  }
}

/**
 * The File, Edit, and View menus. Each menu's `items` is a provider
 * function, so enablement is recomputed every time the menu opens.
 *
 * @param actions - The menu action callbacks.
 * @returns The composed menu bar.
 */
function buildMenuBar(actions: MenuBarActions): MenuBar {
  return MenuBar({
    menus: [
      { label: 'File', glyph: 'folder', items: () => [
        { text: 'Open Folder…', glyph: 'folder', shortcut: OPEN_FOLDER_SHORTCUT, action: actions.onOpenFolder },
        { separator: true },
        { text: 'Save', glyph: 'floppy-disk', shortcut: SAVE_SHORTCUT, enabled: actions.hasActiveFile() && actions.isActiveDirty(), action: actions.onSave },
        { text: 'Save As…', glyph: 'floppy-disk', shortcut: SAVE_AS_SHORTCUT, enabled: actions.hasActiveFile(), action: actions.onSaveAs },
        { text: 'Close File', glyph: 'times', shortcut: CLOSE_FILE_SHORTCUT, enabled: actions.hasActiveFile(), action: actions.onCloseFile },
        { separator: true },
        { text: 'Exit', glyph: 'right-from-bracket', shortcut: EXIT_SHORTCUT, action: actions.onExit },
      ] },
      { label: 'Edit', glyph: 'code', items: () => [
        { text: 'Format Document', glyph: 'pen-to-square', shortcut: FORMAT_SHORTCUT, enabled: actions.hasActiveFile(), action: actions.onFormat },
      ] },
      { label: 'View', glyph: 'eye', items: () => [
        { text: 'Toggle Explorer', glyph: 'bars', shortcut: TOGGLE_EXPLORER_SHORTCUT, action: actions.onToggleExplorer },
      ] },
    ],
  })
}

const EditorShellCallable = callable(EditorShell)
type EditorShellCallable = EditorShell
export { EditorShellCallable as EditorShell }
