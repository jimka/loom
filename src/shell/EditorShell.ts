import { Container, callable } from '@jimka/typescript-ui/core'
import { Placement } from '@jimka/typescript-ui/primitive'
import { Border as BorderLayout, Split } from '@jimka/typescript-ui/layout'
import { MenuBar } from '@jimka/typescript-ui/component/menubar'
import { FileTree } from '../explorer/FileTree'
import type { EditorController } from '../EditorController'
import {
  OPEN_FOLDER_SHORTCUT, SAVE_SHORTCUT, SAVE_AS_SHORTCUT, CLOSE_FILE_SHORTCUT,
  FORMAT_SHORTCUT, TOGGLE_EXPLORER_SHORTCUT, EXIT_SHORTCUT, installAccelerators,
} from './shortcuts'
import type { AcceleratorActions } from './shortcuts'

/** The tree pane's index in the shell's `Split` — 0, the only other pane being the editor tabs. */
const EXPLORER_PANE_INDEX = 0

/**
 * Minimum width the explorer pane keeps when the gutter is dragged, in
 * pixels — narrow enough to stay out of the editor's way, wide enough that
 * a typical file/folder name doesn't truncate immediately.
 */
const EXPLORER_MIN_WIDTH = 160

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
  constructor(controller: EditorController) {
    const tree = FileTree({ onOpenFile: (path: string) => { void controller.openFile(path) } })
    const split = new Split({ orientation: 'horizontal' })
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

    tree.setMinSize({ width: EXPLORER_MIN_WIDTH, height: 0 })

    controller.setProjectRootListener(root => { void tree.setProjectRoot(root) })
    installAccelerators(actions)
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
