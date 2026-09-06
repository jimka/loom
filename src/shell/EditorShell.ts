import { Container, callable } from '@jimka/typescript-ui/core'
import type { Component } from '@jimka/typescript-ui/core'
import { Placement } from '@jimka/typescript-ui/primitive'
import { Accordion, AccordionConstraints, Border as BorderLayout, Card, Split } from '@jimka/typescript-ui/layout'
import { MenuBar } from '@jimka/typescript-ui/component/menubar'
import { CheckboxMenuRow, Spacer } from '@jimka/typescript-ui/component/container'
import type { MenuItemConfig } from '@jimka/typescript-ui/component/container'
import { Button } from '@jimka/typescript-ui/component/button'
import { FileTree } from '../explorer/FileTree'
import { PropertiesPanel } from '../explorer/PropertiesPanel'
import { WelcomeScreen } from './WelcomeScreen'
import { CommandPalette } from './CommandPalette'
import { buildPaletteCommands } from './commands'
import { openAboutDialog } from './aboutDialog'
import { listFilesRecursive } from '../data/fileIndex'
import type { EditorController } from '../EditorController'
import type { SessionState } from '../data/session'
import type { Settings } from '../data/settings'
import type { SessionAutosave } from './session'
import { applySession, installSessionAutosave, loadWorkspaceState } from './session'
import { loadResolvedSettings } from './settings'
import { treeSectionLabel } from './treeSectionLabel'
import { projectName, baseName, isUnderRoot, parentDir } from '../data/paths'
import { listDirectory, tryReadTextFile, pathExists } from '../data/workspace'
import { glyphNameForPath } from '../fileIcons'
import { promptRecentDirectoryIntent, confirmOpenSeparateWorkspace } from './recentProjectPrompt'
import { installFileDrop } from './fileDrop'
import {
    NEW_FILE_SHORTCUT, OPEN_FOLDER_SHORTCUT, SAVE_SHORTCUT, SAVE_AS_SHORTCUT, CLOSE_FILE_SHORTCUT,
    FORMAT_SHORTCUT, FIND_SHORTCUT, TOGGLE_EXPLORER_SHORTCUT, EXIT_SHORTCUT, COMMAND_PALETTE_SHORTCUT, installAccelerators,
} from './shortcuts'
import type { AcceleratorActions } from './shortcuts'

/** The explorer accordion pane's index in the shell's `Split` — 0, the other pane being the editor deck (tab strip plus welcome screen). */
const EXPLORER_PANE_INDEX = 0

/** The `Card` deck page ids the editor pane switches between. */
const EDITOR_PAGE_ID = 'editor-tabs'
const WELCOME_PAGE_ID = 'welcome-screen'

/** The properties section's header label. */
const PROPERTIES_SECTION_LABEL = 'Properties'

/** The tree section's accordion weight. Any positive weight makes the tree the
 *  sole section that absorbs the sidebar's leftover height; 1 is the library's
 *  own default share. */
const TREE_SECTION_WEIGHT = 1

/** The explorer pane's floor and starting width, in pixels. Carried over
 *  verbatim from the `minSize`/`preferredSize` `FileTree` declares for itself
 *  (`src/explorer/FileTree.ts:80`), so the pane keeps the width it has today
 *  even when both accordion sections are collapsed and the accordion would
 *  otherwise report no width of its own. */
const EXPLORER_MIN_SIZE = { width: 160, height: 0 }
const EXPLORER_PREFERRED_SIZE = { width: 300, height: 0 }

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
    /** Opens the app-wide settings file, creating it first if needed. */
    onOpenSettings: () => void
    /** Opens the open project's own settings file, creating it first if needed. */
    onOpenWorkspaceSettings: () => void
    /** Whether a project folder is currently open — greys out *Open Workspace Settings* when not. */
    hasProjectRoot: () => boolean
    /** Opens the About dialog — the far-right menu-bar button. */
    onAbout: () => void
}

/**
 * The app shell: a `Border`-laid `Container` with the menu bar NORTH, a
 * horizontal `Split` (explorer accordion (file tree over properties panel)
 * beside the editor deck — the tab strip and the welcome screen, one visible
 * at a time) CENTER, and the status bar SOUTH — the same shape as
 * `../../sqladmin/frontend/src/shell/SqlAdminShell.ts`.
 */
class EditorShell extends Container {
    private readonly _tree: FileTree
    private readonly _split: Split
    private readonly _controller: EditorController
    private readonly _palette: CommandPalette
    private readonly _menuBarActions: MenuBarActions
    private readonly _relabelTreeSection: (root: string | null) => void
    private _autosave: SessionAutosave | null = null

    /**
     * @param controller - Owns the tab strip, the status bar, and every editor command.
     * @param session - The stored session; its split entries seed the `Split`.
     * @param settings - The resolved settings; seed the tree's Show Hidden/Show Ignored defaults.
     */
    constructor(controller: EditorController, session: SessionState, settings: Settings) {
        const openFolder = (): void => { void controller.openProjectFolder() }
        const properties = PropertiesPanel({ projectRoot: session.projectRoot })
        const tree = FileTree({
            onSelectFile:  (path: string) => { void controller.openFile(path, 'temporary') },
            onSelectEntry: entry => properties.setEntry(entry),
            onOpenFile:    (path: string) => { void controller.openFile(path, 'permanent') },
            onPathDeleted: (path: string) => controller.closeFilesUnder(path),
            onPathRenamed: (oldPath: string, newPath: string) => controller.relocateOpenFiles(oldPath, newPath),
            onPathsChanged: (paths: string[]) => controller.markExternalChanges(paths),
        })

        void tree.setShowHidden(settings.showHiddenFiles)
        void tree.setShowIgnored(settings.showIgnoredFiles)

        const welcome = WelcomeScreen({
            onOpenFolder: openFolder,
            recentProjects: controller.getRecentProjects(),
            onOpenRecentProject: (path: string) => { void this.confirmAndOpenProject(path) },
        })
        const deck = buildEditorDeck(controller, welcome)
        const split = new Split({
            orientation: 'horizontal',
            paneSizes: session.paneSizes,
            collapsedPanes: session.collapsedPanes,
        })
        const splitBody = Container({ layoutManager: split })

        const initialSections = buildExplorerSections(session.projectRoot)

        const explorer = Container({
            layoutManager: initialSections.accordion,
            minSize: EXPLORER_MIN_SIZE,
            preferredSize: EXPLORER_PREFERRED_SIZE,
        })

        explorer.addComponent(tree, initialSections.treeSection)
        explorer.addComponent(properties, initialSections.propertiesSection)
        splitBody.addComponent(explorer, { weight: 0 })
        splitBody.addComponent(deck, { weight: 1 })

        /**
         * Retitles the tree section from `root` by rebuilding the whole
         * accordion. `Accordion.createSection` reads a section's `label`
         * constraint exactly once, the first time it discovers that child, so
         * there is no API to relabel an already-built header in place;
         * `Container.setLayoutManager` tears down and recreates every
         * section's header instead, which is the one documented, public way
         * to force that rebuild. `tree` and `properties` themselves are
         * never removed, so their own state (tree data, watchers, the
         * properties panel's current row) survives untouched — only the
         * accordion's header chrome and each section's open/closed state
         * reset to `initiallyOpen`, which is `true` for both sections
         * regardless, so this has no visible effect beyond the label.
         *
         * @param root - The open project folder, or `null` when none is open.
         */
        const relabelTreeSection = (root: string | null): void => {
            const sections = buildExplorerSections(root)

            explorer.setLayoutManager(sections.accordion)
            explorer.setLayoutConstraints(tree, sections.treeSection)
            explorer.setLayoutConstraints(properties, sections.propertiesSection)
            explorer.scheduleLayout()
        }

        const palette = CommandPalette({
            onConfirmFile: (path: string) => { void controller.openFile(path) },
        })

        const actions: MenuBarActions = {
            onNewFile: () => controller.newFile(),
            onOpenFolder: openFolder,
            onSave: () => { void controller.saveActive() },
            onSaveAs: () => { void controller.saveActiveAs() },
            onCloseFile: () => controller.closeActive(),
            onFormat: () => { void controller.formatActive() },
            onFind: () => controller.findInActive(),
            onToggleExplorer: () => split.setPaneCollapsed(EXPLORER_PANE_INDEX, !split.isPaneCollapsed(EXPLORER_PANE_INDEX)),
            onExit: () => { void controller.exitApp() },
            onOpenCommandPalette: () => { void this.openCommandPalette() },
            hasActiveFile: () => controller.hasActiveFile(),
            canSaveActive: () => controller.canSaveActive(),
            getRecentProjects: () => controller.getRecentProjects(),
            getRecentFiles: () => controller.getRecentFiles(),
            onOpenRecentProject: (path: string) => { void this.confirmAndOpenProject(path) },
            onOpenRecentFile: (path: string) => { void controller.openFile(path) },
            isShowingHidden: () => tree.isShowingHidden(),
            onToggleHidden: (value: boolean) => { void tree.setShowHidden(value) },
            isShowingIgnored: () => tree.isShowingIgnored(),
            onToggleIgnored: (value: boolean) => { void tree.setShowIgnored(value) },
            hasProjectRoot: () => tree.getProjectRoot() !== null,
            onOpenSettings: () => { void controller.openGlobalSettings() },
            onOpenWorkspaceSettings: () => {
                const root = tree.getProjectRoot()

                if (root !== null) {
                    void controller.openWorkspaceSettings(root)
                }
            },
            onAbout: () => openAboutDialog(),
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
        this._palette = palette
        this._menuBarActions = actions
        this._relabelTreeSection = relabelTreeSection

        controller.setProjectRootListener(async root => {
            welcome.setProjectRoot(root)
            welcome.setRecentProjects(controller.getRecentProjects())

            // The header and the properties panel are reconciled from the
            // tree's own post-attempt root in `finally`, not from `root`
            // directly — `openProjectRoot` rejects on an unlistable folder
            // (a deleted Recent Projects entry), and `this._tree`'s own root
            // stays at whatever it was before the attempt in that case. The
            // exception itself is left to propagate afterward, unswallowed,
            // so `EditorController.openProjectFolder`'s own catch still
            // reports it via `Dialog.error`.
            try {
                await this.openProjectRoot(root)
            } finally {
                const openedRoot = this._tree.getProjectRoot()

                properties.setProjectRoot(openedRoot)
                relabelTreeSection(openedRoot)
            }
        })
        controller.setActiveFileListener(path => { void tree.selectPath(path) })
        controller.setFileSavedListener(path => { void this.handleFileSaved(path) })
        installAccelerators(actions)
        installFileDrop({
            onDropFile: (path: string) => controller.openFile(path),
            onDropFolder: (path: string) => this.confirmAndOpenProject(path),
        })
    }

    /**
     * Replays `state` into the tree and tabs, then starts autosaving. Installing
     * the autosave listeners **after** the restore is what stops the restore
     * from saving its own half-finished state — there is no suppression flag
     * anywhere in this design, and none should be added. The tree section's
     * header is reconciled against the tree's own post-restore root, not
     * `state.projectRoot` itself, because `applySession` swallows a failed
     * `tree.setProjectRoot` (a restored project folder that was since moved
     * or deleted) and leaves the tree rootless — reading the tree's own root
     * back is what stops the header from naming a project that never
     * actually opened.
     *
     * @param state - The session to restore.
     */
    async restoreSession(state: SessionState): Promise<void> {
        const targets = { controller: this._controller, tree: this._tree, split: this._split }

        await applySession(state, targets)
        this._relabelTreeSection(this._tree.getProjectRoot())

        const autosave = installSessionAutosave(targets)

        this._autosave = autosave
        this._controller.setBeforeExitListener(() => autosave.flush())
    }

    /**
     * `setProjectRootListener`'s callback: flushes the outgoing project's own
     * pending autosave, points the tree at the newly chosen folder, reloads
     * and reapplies that folder's own resolved settings (the tree's Show
     * Hidden/Show Ignored defaults and the controller's format-on-save/title
     * template/tab width), restores that folder's saved tree expansion (if
     * it has any), then schedules a session save. Settings reapplication is
     * `await`ed and finishes *before* the expansion restore starts, not just
     * ordered before it in source: `FileTree.setShowHidden`/`setShowIgnored`
     * each reload the tree from its root — which collapses every expansion —
     * and both now return the reload's own promise (mirroring
     * `FileTree.setProjectRoot`) precisely so this method can await that
     * completion rather than racing it; restoring expansion first, or
     * firing the settings reload without awaiting it, would each let a
     * still-in-flight reload land after the expansion restore and collapse
     * it right back. No `catch` around the listing itself — a failed
     * listing rejects up through the `async` callback registered in the
     * constructor, which `EditorController.openProjectFolder` awaits and
     * reports via `Dialog.error`; `openRecentProject` still leaves it as an
     * unhandled rejection, unchanged from before this method existed. Tabs,
     * the active file, and the split are deliberately left untouched by a
     * live switch — only tree expansion and settings resolution restore
     * outside a cold start.
     *
     * @param root - The newly chosen project folder.
     */
    private async openProjectRoot(root: string): Promise<void> {
        await this._autosave?.flush()
        await this._tree.setProjectRoot(root)

        const resolved = await loadResolvedSettings(root)

        await this._tree.setShowHidden(resolved.showHiddenFiles)
        await this._tree.setShowIgnored(resolved.showIgnoredFiles)
        this._controller.applySettings(resolved)

        const workspace = await loadWorkspaceState(root)

        if (workspace) {
            await this._tree.expandPaths(workspace.expandedDirs)
        }

        this._autosave?.schedule()
    }

    /**
     * `setFileSavedListener`'s callback: refreshes the saved file's own
     * directory when `path` landed under the tree's root, so a directory it
     * already has loaded picks up a file that didn't exist there before this
     * save — a first save of an untitled buffer, or a Save As to a new name.
     * A no-op outside the tree's root, or before any root is set.
     *
     * @param path - The path a file was just saved to.
     */
    private async handleFileSaved(path: string): Promise<void> {
        const root = this._tree.getProjectRoot()

        if (root !== null && isUnderRoot(root, path)) {
            await this._tree.refreshSubtree(parentDir(path))
        }
    }

    /**
     * Opens a project folder whose path is already known, rather than picked
     * via the native dialog — from a Recent Projects entry on the welcome
     * screen, the File > Open Recent submenu, or a folder dropped onto the
     * window. With no workspace open yet, or the path naming the one already
     * open, there is nothing to decide — it just opens (or does nothing,
     * respectively). Otherwise the path either sits inside the open
     * workspace, in which case the user picks between opening it as its own
     * workspace and merely revealing it in the tree that's already open, or
     * it sits outside it entirely, in which case opening it can only mean
     * replacing the current workspace and the prompt says so.
     *
     * @param path - The project folder's root path.
     */
    private async confirmAndOpenProject(path: string): Promise<void> {
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

    /**
     * Ctrl/Cmd+P and the View menu's *Command Palette…* item: walks the open
     * workspace into a flat file list (empty when no workspace is open),
     * rebuilds the command list from the shell's own menu actions, and opens
     * the palette over both.
     */
    private async openCommandPalette(): Promise<void> {
        const root = this._tree.getProjectRoot()
        const files = root !== null
            ? await listFilesRecursive(root, listDirectory, tryReadTextFile, pathExists)
            : []

        this._palette.open(files, buildPaletteCommands(this._menuBarActions), root)
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

/** A freshly-built accordion plus its two sections' constraints, in child order — see {@link buildExplorerSections}. */
interface ExplorerSections {
    accordion: Accordion
    treeSection: AccordionConstraints
    propertiesSection: AccordionConstraints
}

/**
 * Builds a new accordion and its two sections' constraints, the tree
 * section labelled from `root`. Called once at construction and again by
 * `relabelTreeSection` every time the project root changes, since rebuilding
 * the accordion is the only way to change an already-built header's label
 * (see `relabelTreeSection`'s own doc comment).
 *
 * @param root - The open project folder, or `null` when none is open.
 * @returns The new accordion and its two sections' constraints.
 */
function buildExplorerSections(root: string | null): ExplorerSections {
    const accordion = new Accordion({ compact: true })
    const treeSection = new AccordionConstraints(treeSectionLabel(root), true, 'folder')

    treeSection.weight = TREE_SECTION_WEIGHT

    return { accordion, treeSection, propertiesSection: new AccordionConstraints(PROPERTIES_SECTION_LABEL, true, 'circle-info') }
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
 * The File, Edit, and View menus, plus the far-right About button. Each
 * menu's `items` is a provider function, so enablement is recomputed every
 * time the menu opens.
 *
 * @param actions - The menu action callbacks.
 * @returns The composed menu bar.
 */
function buildMenuBar(actions: MenuBarActions): MenuBar {
    const menuBar = MenuBar({
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
                { text: 'Open Settings', glyph: 'gear', action: actions.onOpenSettings },
                { text: 'Open Workspace Settings', glyph: 'gear', enabled: actions.hasProjectRoot(), action: actions.onOpenWorkspaceSettings },
                { separator: true },
                { text: 'Exit', glyph: 'right-from-bracket', shortcut: EXIT_SHORTCUT, action: actions.onExit },
            ] },
            { label: 'Edit', glyph: 'code', items: () => [
                { text: 'Find…', glyph: 'magnifying-glass', shortcut: FIND_SHORTCUT, enabled: actions.hasActiveFile(), action: actions.onFind },
                { separator: true },
                { text: 'Format Document', glyph: 'pen-to-square', shortcut: FORMAT_SHORTCUT, enabled: actions.hasActiveFile(), action: actions.onFormat },
            ] },
            { label: 'View', glyph: 'eye', items: () => [
                { text: 'Command Palette…', glyph: 'magnifying-glass', shortcut: COMMAND_PALETTE_SHORTCUT, action: actions.onOpenCommandPalette },
                { separator: true },
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

    // Pin an About button to the far right of the bar: a flex spacer eats the
    // width between the left-aligned menus and the button, so the button sits
    // at the trailing edge. Appended after the factory rather than through
    // `menus` (whose entries are dropdown openers) — safe because the shell
    // builds its menus once and never resets the bar's children afterwards,
    // which would wipe these appended children.
    const about = Button({ glyph: 'circle-info', text: 'About', showText: true, showDescription: false, compact: true, flat: true })

    about.on('action', actions.onAbout)
    menuBar.addComponent(Spacer.flex())
    menuBar.addComponent(about)

    return menuBar
}

const EditorShellCallable = callable(EditorShell)
type EditorShellCallable = EditorShell
export { EditorShellCallable as EditorShell }
