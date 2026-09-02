import { Container, callable } from '@jimka/typescript-ui/core'
import type { Component } from '@jimka/typescript-ui/core'
import { Placement } from '@jimka/typescript-ui/primitive'
import { Border as BorderLayout, Card, Split } from '@jimka/typescript-ui/layout'
import { MenuBar } from '@jimka/typescript-ui/component/menubar'
import { CheckboxMenuRow } from '@jimka/typescript-ui/component/container'
import type { MenuItemConfig } from '@jimka/typescript-ui/component/container'
import { FileTree } from '../explorer/FileTree'
import { WelcomeScreen } from './WelcomeScreen'
import type { EditorController } from '../EditorController'
import type { SessionState } from '../data/session'
import type { SessionAutosave } from './session'
import { applySession, installSessionAutosave, loadWorkspaceState } from './session'
import { projectName, baseName, isUnderRoot } from '../data/paths'
import { glyphNameForPath } from '../fileIcons'
import { promptRecentDirectoryIntent, confirmOpenSeparateWorkspace } from './recentProjectPrompt'
import {
  NEW_FILE_SHORTCUT, OPEN_FOLDER_SHORTCUT, SAVE_SHORTCUT, SAVE_AS_SHORTCUT, CLOSE_FILE_SHORTCUT,
  FORMAT_SHORTCUT, TOGGLE_EXPLORER_SHORTCUT, EXIT_SHORTCUT, installAccelerators,
} from './shortcuts'
import type { AcceleratorActions } from './shortcuts'

/** The tree pane's index in the shell's `Split` — 0, the other pane being the editor deck (tab strip plus welcome screen). */
const EXPLORER_PANE_INDEX = 0

/** The `Card` deck page ids the editor pane switches between. */
const EDITOR_PAGE_ID = 'editor-tabs'
const WELCOME_PAGE_ID = 'welcome-screen'

/** The menu-bar action callbacks the shell wires to the controller and the split. */
interface MenuBarActions extends AcceleratorActions {
  /** Whether a file is currently active — greys out the per-file items when not. */
  hasActiveFile: () => boolean
  /** Whether the active file needs saving — the Save item is greyed out when not. */
  canSaveActive: () => boolean
  /** Recently opened project folders, most-recent first — read by the Open Recent submenu. */
  getRecentProjects: () => string[]
  /** Recently opened files, most-recent first — read by the Open Recent submenu. */
  getRecentFiles: () => string[]
  /** Reopens a recent project's root, bypassing the native picker. */
  onOpenRecentProject: (path: string) => void
  /** Reopens a recent file — the same action a tree click runs. */
  onOpenRecentFile: (path: string) => void
  /** Whether the tree currently shows hidden (leading-dot) entries — read live each time the View menu opens. */
  isShowingHidden: () => boolean
  /** Toggles whether the tree shows hidden entries. */
  onToggleHidden: (value: boolean) => void
  /** Whether the tree currently shows `.gitignore`-ignored entries — read live each time the View menu opens. */
  isShowingIgnored: () => boolean
  /** Toggles whether the tree shows ignored entries. */
  onToggleIgnored: (value: boolean) => void
}

/**
 * The app shell: a `Border`-laid `Container` with the menu bar NORTH, a
 * horizontal `Split` (explorer tree beside the editor deck — the tab strip
 * and the welcome screen, one visible at a time) CENTER, and the status bar
 * SOUTH — the same shape as
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
    const openFolder = (): void => { void controller.openProjectFolder() }
    const tree = FileTree({ onOpenFile: (path: string) => { void controller.openFile(path) } })
    const welcome = WelcomeScreen({
      onOpenFolder: openFolder,
      recentProjects: controller.getRecentProjects(),
      onOpenRecentProject: (path: string) => { void this.handleOpenRecentProject(path) },
    })
    const deck = buildEditorDeck(controller, welcome)
    const split = new Split({
      orientation: 'horizontal',
      paneSizes: session.paneSizes,
      collapsedPanes: session.collapsedPanes,
    })
    const splitBody = Container({ layoutManager: split })

    splitBody.addComponent(tree, { weight: 0 })
    splitBody.addComponent(deck, { weight: 1 })

    const actions: MenuBarActions = {
      onNewFile: () => controller.newFile(),
      onOpenFolder: openFolder,
      onSave: () => { void controller.saveActive() },
      onSaveAs: () => { void controller.saveActiveAs() },
      onCloseFile: () => controller.closeActive(),
      onFormat: () => { void controller.formatActive() },
      onToggleExplorer: () => split.setPaneCollapsed(EXPLORER_PANE_INDEX, !split.isPaneCollapsed(EXPLORER_PANE_INDEX)),
      onExit: () => { void controller.exitApp() },
      hasActiveFile: () => controller.hasActiveFile(),
      canSaveActive: () => controller.canSaveActive(),
      getRecentProjects: () => controller.getRecentProjects(),
      getRecentFiles: () => controller.getRecentFiles(),
      onOpenRecentProject: (path: string) => { void this.handleOpenRecentProject(path) },
      onOpenRecentFile: (path: string) => { void controller.openFile(path) },
      isShowingHidden: () => tree.isShowingHidden(),
      onToggleHidden: (value: boolean) => tree.setShowHidden(value),
      isShowingIgnored: () => tree.isShowingIgnored(),
      onToggleIgnored: (value: boolean) => tree.setShowIgnored(value),
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

    controller.setProjectRootListener(async root => {
      welcome.setProjectRoot(root)
      welcome.setRecentProjects(controller.getRecentProjects())
      await this.openProjectRoot(root)
    })
    controller.setActiveFileListener(path => { void tree.selectPath(path) })
    controller.setFileSavedListener(path => { void this.handleFileSaved(path) })
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
   * rejects up through the `async` callback registered in the constructor,
   * which `EditorController.openProjectFolder` awaits and reports via
   * `Dialog.error`; `openRecentProject` still leaves it as an unhandled
   * rejection, unchanged from before this method existed. Tabs, the active
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

  /**
   * `setFileSavedListener`'s callback: refreshes the tree when `path` landed
   * under its root, so a directory it already has loaded picks up a file
   * that didn't exist there before this save — a first save of an untitled
   * buffer, or a Save As to a new name. A no-op outside the tree's root, or
   * before any root is set.
   *
   * @param path - The path a file was just saved to.
   */
  private async handleFileSaved(path: string): Promise<void> {
    const root = this._tree.getProjectRoot()

    if (root !== null && isUnderRoot(root, path)) {
      await this._tree.refresh()
    }
  }

  /**
   * A Recent Projects entry's click handler, from either the welcome screen
   * or the File > Open Recent submenu. With no workspace open yet, or the
   * entry naming the one already open, there is nothing to decide — it just
   * opens (or does nothing, respectively). Otherwise the entry either sits
   * inside the open workspace, in which case the user picks between opening
   * it as its own workspace and merely revealing it in the tree that's
   * already open, or it sits outside it entirely, in which case opening it
   * can only mean replacing the current workspace and the prompt says so.
   *
   * @param path - The recent project's root path.
   */
  private async handleOpenRecentProject(path: string): Promise<void> {
    const current = this._tree.getProjectRoot()

    if (current === null || path === current) {
      this._controller.openRecentProject(path)

      return
    }

    if (isUnderRoot(current, path)) {
      const intent = await promptRecentDirectoryIntent(path)

      if (intent === 'workspace') {
        this._controller.openRecentProject(path)
      } else if (intent === 'expose') {
        await this._tree.selectPath(path)
      }

      return
    }

    if (await confirmOpenSeparateWorkspace(path, current)) {
      this._controller.openRecentProject(path)
    }
  }
}

/**
 * The editor pane's `Card` deck: the tab strip and the welcome screen, one
 * visible at a time. `controller.setEmptyStateListener` reports the current
 * state as it registers, which picks the page the deck opens on — no
 * separate seeding call is needed.
 *
 * @param controller - Supplies the empty-state signal that drives the toggle.
 * @param welcome - The welcome screen page.
 * @returns The deck component to place in the split's editor pane.
 */
function buildEditorDeck(controller: EditorController, welcome: WelcomeScreen): Component {
  const card = new Card()
  const deck = Container({ layoutManager: card })

  controller.tabs.setId(EDITOR_PAGE_ID)
  welcome.setId(WELCOME_PAGE_ID)

  deck.addComponent(controller.tabs)
  deck.addComponent(welcome)

  controller.setEmptyStateListener(empty => {
    card.setVisibleComponentId(empty ? WELCOME_PAGE_ID : EDITOR_PAGE_ID)
  })

  return deck
}

/**
 * Builds the Open Recent submenu's items: every recent project, then a
 * separator (when both lists are non-empty), then every recent file.
 *
 * @param actions - Supplies the recent-projects/recent-files lists and their open handlers.
 * @returns The submenu's item list.
 */
function buildRecentItems(actions: MenuBarActions): MenuItemConfig[] {
  const projects = actions.getRecentProjects()
  const files = actions.getRecentFiles()
  const items: MenuItemConfig[] = projects.map(root => ({
    text: projectName(root),
    glyph: 'folder',
    action: () => actions.onOpenRecentProject(root),
  }))

  if (projects.length > 0 && files.length > 0) {
    items.push({ separator: true })
  }

  items.push(...files.map(path => ({
    text: baseName(path),
    glyph: glyphNameForPath(path),
    action: () => actions.onOpenRecentFile(path),
  })))

  return items
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
        { text: 'New File', glyph: 'file-circle-plus', shortcut: NEW_FILE_SHORTCUT, action: actions.onNewFile },
        { text: 'Open Folder…', glyph: 'folder', shortcut: OPEN_FOLDER_SHORTCUT, action: actions.onOpenFolder },
        {
          text: 'Open Recent',
          glyph: 'clock-rotate-left',
          enabled: actions.getRecentProjects().length > 0 || actions.getRecentFiles().length > 0,
          submenu: { label: 'Open Recent', items: () => buildRecentItems(actions) },
        },
        { separator: true },
        { text: 'Save', glyph: 'floppy-disk', shortcut: SAVE_SHORTCUT, enabled: actions.canSaveActive(), action: actions.onSave },
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
        { separator: true },
        { row: () => {
            const row = CheckboxMenuRow({ text: 'Show Hidden Files', checked: actions.isShowingHidden() })

            row.on('action', () => { actions.onToggleHidden(row.isChecked()) })

            return row
          } },
        { row: () => {
            const row = CheckboxMenuRow({ text: 'Show Ignored Files', checked: actions.isShowingIgnored() })

            row.on('action', () => { actions.onToggleIgnored(row.isChecked()) })

            return row
          } },
      ] },
    ],
  })
}

const EditorShellCallable = callable(EditorShell)
type EditorShellCallable = EditorShell
export { EditorShellCallable as EditorShell }
