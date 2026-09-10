import { StatusBar } from '@jimka/typescript-ui/component/container'
import { Text, Link } from '@jimka/typescript-ui/component/input'
import { Dialog, Tooltip, Dock } from '@jimka/typescript-ui/overlay'
import type { DockPanelEvent } from '@jimka/typescript-ui/overlay'
import type { TabCloseController, LayoutState } from '@jimka/typescript-ui/layout'
import type { FormatOptions, CodeEditorCursorPosition } from '@jimka/typescript-ui/component/editor'
import { FileEditor } from './editor/FileEditor'
import { cursorLabel } from './editor/cursorLabel'
import { selectionLabel } from './editor/selectionLabel'
import { promptGoToLine } from './editor/goToLinePrompt'
import { countLines } from './editor/lineNumber'
import { languageForPath, hasFormatter } from './editor/languages'
import type { MatchLocation, SearchMatch, CompiledQuery } from './data/projectSearch'
import { replaceAllInText, replaceOneInText, isProbablyBinary } from './data/projectSearch'
import { glyphNameForPath } from './fileIcons'
import { baseName, joinPath, isUnderRoot, relocatePath } from './data/paths'
import { readFileText, writeFileText, pickProjectFolder, pickSaveTarget, setWindowTitle, closeWindow, onCloseRequested } from './data/workspace'
import { promptUnsavedChanges } from './shell/unsavedPrompt'
import { promptExternalChange } from './shell/externalChangePrompt'
import { APP_NAME } from './appIdentity'
import { withRecent } from './data/session'
import { remapPanelIds } from './data/editorLayout'
import type { Settings } from './data/settings'
import { DEFAULT_SETTINGS, renderTitle } from './data/settings'
import { ensureGlobalSettingsFile, ensureWorkspaceSettingsFile } from './shell/settings'
import { externalChangeOutcome } from './data/watchEvents'
import { messageOf } from './errors'

/** How long a status-bar message stays up, in milliseconds — long enough to notice, short enough not to linger. */
const STATUS_MESSAGE_DURATION_MS = 2000

/**
 * A caret position wide enough to size the status bar's cursor readout once
 * at startup: 5-digit lines covers any file a code editor (rather than a log
 * viewer) is realistically opened on, 3-digit columns covers an unreasonably
 * long single line, and 7-digit offsets covers a 10MB document. Generous
 * rather than exact — overshooting wastes status-bar pixels (mitigated by
 * right-aligning the readout, see the constructor), while undershooting
 * brings back the per-frame reflow the constructor spends this measurement
 * to avoid (see the comment there).
 */
const WIDEST_CURSOR_POSITION: CodeEditorCursorPosition = { line: 99_999, column: 999, offset: 9_999_999 }

/**
 * A selection extent wide enough to size the status bar's selection readout
 * once at startup, sized against the same two worst cases
 * {@link WIDEST_CURSOR_POSITION} already establishes: a selected character
 * count has the same ceiling as the caret's document offset (a 10MB document,
 * selected end to end), and the number of lines a selection spans has the
 * same ceiling as the caret's own line number.
 */
const WIDEST_SELECTION = { characters: WIDEST_CURSOR_POSITION.offset, lines: WIDEST_CURSOR_POSITION.line }

/** How an {@link EditorController.openFile} request should treat the tab it lands in. */
export type OpenMode = 'temporary' | 'permanent'

/**
 * Owns the editor dock, the status bar, the open-file registry, and every
 * editor command (open/save/close/format/replace). Holds no UI arrangement
 * of its own — the tree and the split belong to `EditorShell`, which the
 * shell reaches through {@link setProjectRootListener}.
 */
class EditorController {
    /** The editor workspace: one or more tab groups the user can split, rearrange, and tear off. */
    readonly dock: Dock
    readonly statusBar: StatusBar

    private readonly _openFiles: Map<string, FileEditor> = new Map()
    /** The dock-wide focused panel's id, set from the dock's own `focus` event — `null` when nothing is focused. */
    private _activePanelId: string | null = null
    /** Mints each new panel's id, monotonically — `buf-1`, `buf-2`, … — for the buffer's whole life. */
    private _panelIdSeq = 0
    /**
     * Paths whose disk read is in flight, mapped to the mode their tab will get.
     * A second request for the same path joins the entry instead of starting a
     * second read, and a `'permanent'` request upgrades a `'temporary'` one — so
     * the tree's click-then-double-click pair produces exactly one, pinned, tab
     * however the read and the double-click interleave.
     */
    private readonly _pendingOpens: Map<string, OpenMode> = new Map()
    /**
     * Paths whose external-change resolution is in flight. A second batch naming
     * the same path while its read or its prompt is outstanding is dropped rather
     * than opening a second prompt for one file — the same "join, don't duplicate"
     * role `_pendingOpens` plays for an in-flight open.
     */
    private readonly _resolvingExternal: Set<string> = new Set()
    private readonly _selectionText: Text
    private readonly _cursorText: Link
    private readonly _languageText: Text
    private _recentProjects: string[] = []
    private _recentFiles: string[] = []
    private _projectRoot: string | null = null
    private _untitledCount = 0
    private _projectRootListener: ((root: string) => Promise<void>) | null = null
    private _beforeExitListener: (() => Promise<void>) | null = null
    private _activeFileListener: ((path: string | null) => void) | null = null
    private _fileSavedListener: ((path: string) => void) | null = null
    private _formatOnSave: boolean = DEFAULT_SETTINGS.formatOnSave
    private _formatting: FormatOptions = DEFAULT_SETTINGS.formatting
    private _titleBarTemplate: string = DEFAULT_SETTINGS.titleBarTemplate

    constructor() {
        this.dock = new Dock({
            tabOptions: { widthMode: 'content', maxWidth: DEFAULT_SETTINGS.tabMaxWidthPx, scrollable: true },
        })

        this.statusBar = new StatusBar()
        this._selectionText = new Text('')
        this._cursorText = new Link('', {
            foregroundColor: 'var(--ts-ui-statusbar-color)',
            styleRules: [{ suffix: '', styles: { textDecoration: 'none' } }],
        })
        this._languageText = new Text('')

        // `cursorchange` fires once per caret position, not once per click —
        // dragging out a selection fires it continuously. Left on Text's default
        // auto-measure, every one of those `setText` calls would force a
        // synchronous DOM reflow (an off-screen probe element measured via
        // `getBoundingClientRect`) to grow or shrink the readout by a few
        // pixels. That reflow is a full-document layout flush, so its cost
        // scales with everything else mounted — every open tab's editor in
        // every dock group, including the inactive ones `Tab` keeps
        // `visibility: hidden` rather than unmounted — which is what makes
        // selection drag feel sluggish once more than a couple of files are
        // open. Measuring once
        // against a generous worst case and fixing the width means later
        // `setText` calls only touch the DOM text node.
        //
        // Right-aligned so the reserved width's slack sits between the flex
        // spacer and the readout — merging into the spacer's own empty space —
        // rather than between the readout's digits and the language text next
        // to it, where it would read as a stray gap.
        this._cursorText.setText(cursorLabel(WIDEST_CURSOR_POSITION))
        this._cursorText.measure()

        const cursorTextSize = this._cursorText.getPreferredSize()

        if (cursorTextSize) {
            this._cursorText.setPreferredSize(cursorTextSize)
            this._cursorText.setAutoMeasure(false)
            this._cursorText.setTextAlign('right')
        }

        this._cursorText.setText('')

        // `selectionchange` fires just as continuously during a selection drag
        // as `cursorchange` does (see the comment above), so `_selectionText`
        // gets the identical measure-once treatment against its own widest
        // case, right-aligned so its slack merges into the flex spacer to its
        // left rather than opening a stray gap before `_cursorText`.
        this._selectionText.setText(selectionLabel(WIDEST_SELECTION))
        this._selectionText.measure()

        const selectionTextSize = this._selectionText.getPreferredSize()

        if (selectionTextSize) {
            this._selectionText.setPreferredSize(selectionTextSize)
            this._selectionText.setAutoMeasure(false)
            this._selectionText.setTextAlign('right')
        }

        this._selectionText.setText('')

        this.statusBar.addRight(this._selectionText)
        this.statusBar.addRight(this._cursorText)
        this.statusBar.addRight(this._languageText)

        Tooltip.attach(this._cursorText, 'Go to Line')
        this._cursorText.on('action', () => { void this.goToLineInActive() })

        this.dock.on('beforeclose', this.handleBeforePanelClose)
        this.dock.on('close', this.handlePanelClose)
        this.dock.on('focus', this.handlePanelFocus)
        this.dock.on('dblclick', this.handlePanelDoubleClick)

        onCloseRequested(this.confirmExit)
    }

    /**
     * Injects the shell's tree-refresh callback, invoked from
     * {@link openProjectFolder} once a folder is chosen.
     *
     * @param fn - Called with the chosen project root; resolves once the tree
     *   has loaded the folder.
     */
    setProjectRootListener(fn: (root: string) => Promise<void>): void {
        this._projectRootListener = fn
    }

    /**
     * Injects a hook awaited on the way out, after the unsaved-changes
     * decision — {@link EditorShell.restoreSession} uses it to flush the
     * pending session save before the window actually closes.
     *
     * @param fn - Awaited once {@link confirmExit} has decided the window may close.
     */
    setBeforeExitListener(fn: () => Promise<void>): void {
        this._beforeExitListener = fn
    }

    /**
     * Injects the shell's tree-selection sync, called once immediately with
     * the current state and again on every active-tab change. `null` covers
     * both an empty dock and an active path-less (untitled) buffer.
     *
     * @param fn - Called with the active tab's file path, or `null`.
     */
    setActiveFileListener(fn: (path: string | null) => void): void {
        this._activeFileListener = fn
        fn(this.getActiveFilePath())
    }

    /**
     * Injects the shell's post-save tree-refresh hook, called after a
     * successful {@link saveAs} — including a path-less buffer's first save —
     * with the path it was written to. Not called from a plain {@link save}:
     * that always writes to a path the file already had, so it can never land
     * a new entry under a directory the tree has loaded.
     *
     * @param fn - Called with the path a file was just saved to.
     */
    setFileSavedListener(fn: (path: string) => void): void {
        this._fileSavedListener = fn
    }

    /**
     * Seeds the in-memory recent-projects/recent-files lists from a loaded
     * session. Call once, right after construction, before any command that
     * might record into them.
     *
     * @param projects - The recent-projects list to start from, most-recent first.
     * @param files - The recent-files list to start from, most-recent first.
     */
    seedRecents(projects: string[], files: string[]): void {
        this._recentProjects = projects
        this._recentFiles = files
    }

    /** Whether a file is currently active — read by the File/Edit menu providers. */
    hasActiveFile(): boolean {
        return this.getActiveFile() !== null
    }

    /** Whether the active file needs saving — read by the File menu's Save item. */
    canSaveActive(): boolean {
        return this.getActiveFile()?.needsSave() ?? false
    }

    /**
     * Closes every open tab whose file is `path` itself or lies under it —
     * called after the tree deletes a file or folder. No unsaved-changes
     * prompt: the delete was already confirmed, and the file no longer
     * exists to save back to.
     *
     * @param path - The deleted file or folder's path.
     */
    closeFilesUnder(path: string): void {
        const affected = [...this._openFiles.values()].filter(file => {
            const filePath = file.getPath()

            return filePath !== null && isUnderRoot(path, filePath)
        })

        for (const file of affected) {
            this.dock.removePanel(file.getPanelId())
        }
    }

    /**
     * Repoints every open tab under `oldPath` (inclusive) onto its new
     * location after the tree renames a file or folder. Keeps each buffer's
     * content and dirty state; only the tracked path, tab label, and icon
     * change.
     *
     * @param oldPath - The renamed entry's previous path.
     * @param newPath - The renamed entry's new path.
     */
    relocateOpenFiles(oldPath: string, newPath: string): void {
        for (const file of this._openFiles.values()) {
            const filePath = file.getPath()

            if (filePath !== null && isUnderRoot(oldPath, filePath)) {
                this.repointFile(file, relocatePath(filePath, oldPath, newPath))
                this.dock.setPanelTitle(file.getPanelId(), file.getName())
            }
        }

        this.syncActive()
    }

    /**
     * Flags every open file the batch names, and resolves the active one now.
     * A background file's resolution is deferred until {@link handlePanelFocus}
     * makes it active — there is no second code path and no stashed disk text
     * for it in the meantime.
     *
     * @param paths - The batch of changed paths the watcher reported.
     */
    markExternalChanges(paths: string[]): void {
        const active = this.getActiveFile()

        for (const path of new Set(paths)) {
            const file = this.findByPath(path)

            if (!file) {
                continue
            }

            file.markExternalChange()

            if (file === active) {
                void this.resolvePendingExternalChange(file)
            }
        }
    }

    /**
     * The active tab's file path, or `null` when the strip is empty *or* the
     * active tab is a path-less (untitled) buffer.
     */
    getActiveFilePath(): string | null {
        return this.getActiveFile()?.getPath() ?? null
    }

    /** Recently opened project folders, most-recent first. */
    getRecentProjects(): string[] {
        return [...this._recentProjects]
    }

    /** Recently opened files, most-recent first. */
    getRecentFiles(): string[] {
        return [...this._recentFiles]
    }

    /**
     * Shows the native folder picker and points the tree at the chosen folder.
     * A folder the app cannot list shows a `Dialog.error` and leaves the tree
     * as it was.
     */
    async openProjectFolder(): Promise<void> {
        const root = await pickProjectFolder()

        if (root === null) {
            return
        }

        try {
            await this._projectRootListener?.(root)
        } catch (error) {
            await Dialog.error('Could not open folder', messageOf(error))

            return
        }

        this.recordRecentProject(root)
        this._projectRoot = root
        this.pushProjectRoot(root)
    }

    /**
     * Points the tree at `root` without the native picker — the counterpart
     * to {@link openProjectFolder} for a path already known, e.g. a Recent
     * Projects entry. Unlike {@link openProjectFolder}, a failed listing here
     * is not caught: `root` already came from a previous successful open, so
     * this mirrors that method's pre-existing behaviour rather than the new
     * error-reporting path, which the plan scoped to the picker flow only.
     *
     * @param root - The project folder to open.
     */
    openRecentProject(root: string): void {
        this.recordRecentProject(root)
        this._projectRoot = root
        this.pushProjectRoot(root)
        void this._projectRootListener?.(root)
    }

    /**
     * Records `root` as the current project root without picking one or
     * notifying the shell — the counterpart to {@link openProjectFolder} and
     * {@link openRecentProject} for session restore, which points the tree at
     * its saved root directly (`applySession`) rather than through either of
     * those. {@link EditorController} still needs to know the root so
     * {@link saveDialogDefault} defaults an untitled save into it after a
     * restored launch, not just after a live *Open Folder…* or *Open Recent*.
     *
     * @param root - The project folder the tree was just pointed at.
     */
    setProjectRoot(root: string): void {
        this._projectRoot = root
    }

    /** Opens an empty untitled buffer in a new panel and activates it. */
    newFile(): void {
        this._untitledCount += 1
        this._panelIdSeq += 1

        const panelId = `buf-${this._panelIdSeq}`
        const file = FileEditor({
            panelId,
            path: null,
            name: `Untitled-${this._untitledCount}`,
            text: '',
            projectRoot: this._projectRoot,
        })

        file.onDirtyChange(() => this.handleDirtyChange(file))
        file.getEditor().on('cursorchange', () => this.handleCursorChange(file))
        file.getEditor().on('selectionchange', () => this.handleSelectionChange(file))
        this.dock.addPanel({ id: panelId, title: file.getName(), glyph: glyphNameForPath(file.getName()), content: file })
        this._openFiles.set(panelId, file)
        this.dock.focusPanel(panelId)
        this.syncActive()
    }

    /**
     * Opens `path` — activating its existing tab if already open, otherwise
     * reading it from disk and adding a new one. A read that fails (missing
     * file, over the size limit, not valid text) shows a `Dialog.error` and
     * opens nothing. `mode` says which kind of tab the caller wants:
     * `'temporary'` recycles the strip's one temp tab, `'permanent'` gets a
     * tab of its own; defaults to `'permanent'`. A repeat call for a path
     * already being read joins the first call rather than starting a second
     * read, and a `'permanent'` request upgrades a `'temporary'` one already
     * in flight for the same path. A `'permanent'` open also moves keyboard
     * focus into the file's editor, ready to type; `'temporary'` leaves focus
     * wherever it was, since that mode exists for browsing without leaving
     * the caller (the tree, the command palette's query field).
     *
     * @param path - The file to open.
     * @param mode - Which kind of tab to open it in.
     */
    async openFile(path: string, mode: OpenMode = 'permanent'): Promise<void> {
        const existing = this.findByPath(path)

        if (existing) {
            if (mode === 'permanent') {
                this.recordRecentFile(path)
                this.pinTab(existing)
            }

            this.dock.focusPanel(existing.getPanelId())

            if (mode === 'permanent') {
                existing.getEditor().focus()
            }

            return
        }

        const pending = this._pendingOpens.get(path)

        if (pending !== undefined) {
            if (mode === 'permanent') {
                this._pendingOpens.set(path, 'permanent')
            }

            return
        }

        this._pendingOpens.set(path, mode)

        let text: string

        try {
            text = await readFileText(path)
        } catch (error) {
            this._pendingOpens.delete(path)
            await Dialog.error('Could not open file', messageOf(error))

            return
        }

        const settled = this._pendingOpens.get(path) ?? mode

        this._pendingOpens.delete(path)

        if (settled === 'temporary') {
            this.closeTemporaryTab()
        } else {
            this.recordRecentFile(path)
        }

        const file = this.addFileTab(path, text, settled === 'temporary')

        this.dock.focusPanel(file.getPanelId())
        this.syncActive()

        if (settled === 'permanent') {
            file.getEditor().focus()
        }
    }

    /**
     * Opens `path`, then reveals `at` in it — the project-search results
     * panel's selection and dblclick handlers. `mode` defaults to
     * `'permanent'`, but a selection (as opposed to a dblclick) passes
     * `'temporary'`: `Tree`'s `"selection"` event fires on an arrow-key move
     * exactly as it does on a click, so a fixed `'permanent'` here would pin
     * one tab per match reached while arrow-browsing — recycling one temp
     * tab instead is what mirrors `FileTree`'s own `onSelectFile` convention
     * (also `'temporary'`) for a selection, as opposed to `onOpenFile`'s
     * dblclick-only `'permanent'`. The reveal itself only takes keyboard
     * focus for a `'permanent'` open — a `'temporary'` preview leaves focus
     * wherever it was (typically the results tree), so arrow-browsing keeps
     * advancing through the tree's own selection instead of the very next
     * key landing in the editor it just revealed; without this, `openFile`'s
     * own `'temporary'`-leaves-focus-alone contract would be silently
     * violated by this method's own reveal step. The open file is re-read
     * from the registry rather than trusting the tab that was active a
     * moment ago, so a read that failed (`openFile` has already shown its
     * `Dialog.error` and opened nothing) reveals nothing instead of
     * scrolling whichever tab happened to stay active.
     *
     * @param path - The file to open.
     * @param at - The match's location to reveal once the file is open.
     * @param mode - Which kind of tab to open it in. Defaults to `'permanent'`.
     */
    async openFileAt(path: string, at: MatchLocation, mode: OpenMode = 'permanent'): Promise<void> {
        await this.openFile(path, mode)

        this.findByPath(path)?.revealMatch(at, mode === 'permanent')
    }

    /**
     * Builds a `FileEditor` for `path`/`text`, mints its panel id, and docks
     * it into the group the user last worked in. Paints the new tab italic
     * when it is the strip's temp tab, upright otherwise. `Dock.addPanel`
     * activates the panel it adds as a side effect of the library's own
     * behaviour, so the caller still focuses its own intended panel
     * afterward — {@link restoreFiles} adds several panels before rearranging
     * and activating any of them.
     *
     * @param path - The file's path.
     * @param text - The file's already-read contents.
     * @param temporary - Whether the new tab is the strip's temp tab.
     * @returns The new tab's `FileEditor`.
     */
    private addFileTab(path: string, text: string, temporary: boolean = false): FileEditor {
        this._panelIdSeq += 1

        const panelId = `buf-${this._panelIdSeq}`
        const file = FileEditor({ panelId, path, name: baseName(path), text, projectRoot: this._projectRoot })

        file.setTemporary(temporary)
        file.onDirtyChange(() => this.handleDirtyChange(file))
        file.getEditor().on('cursorchange', () => this.handleCursorChange(file))
        file.getEditor().on('selectionchange', () => this.handleSelectionChange(file))
        this.dock.addPanel({ id: panelId, title: file.getName(), glyph: glyphNameForPath(path), content: file })
        this.dock.setPanelItalic(panelId, temporary)
        this._openFiles.set(panelId, file)

        return file
    }

    /**
     * Repoints every already-open file's breadcrumb band at `root`, so a live
     * project-folder switch re-shortens paths that were showing relative to
     * the previous one (or the previous one's full path, if they fell outside
     * it).
     *
     * @param root - The newly chosen project folder.
     */
    private pushProjectRoot(root: string): void {
        for (const file of this._openFiles.values()) {
            file.setProjectRoot(root)
        }
    }

    /** Records `root` at the front of the recent-projects list. */
    private recordRecentProject(root: string): void {
        this._recentProjects = withRecent(this._recentProjects, root)
    }

    /** Records `path` at the front of the recent-files list. */
    private recordRecentFile(path: string): void {
        this._recentFiles = withRecent(this._recentFiles, path)
    }

    /**
     * Reopens `paths` in order, skipping any that no longer read, rebuilds
     * `editorLayout`'s arrangement over them, then activates `activePath`.
     * Silent by design — a stale path is the expected shape of a restore, not
     * an error, so unlike {@link openFile} this never shows a dialog.
     *
     * @param paths - The files to reopen, in {@link captureEditorLayout}'s document order.
     * @param activePath - The path to activate once open, or `null`.
     * @param editorLayout - The dock arrangement to rebuild over the reopened
     *   files, or `null` when none was captured (or it didn't survive
     *   validation) — every file then lands in the dock's one default group.
     */
    async restoreFiles(paths: string[], activePath: string | null, editorLayout: LayoutState | null): Promise<void> {
        const panelIds = new Map<string, string>()
        let firstOpened: FileEditor | null = null

        for (const path of paths) {
            if (this.findByPath(path) !== null) {
                continue
            }

            let text: string

            try {
                text = await readFileText(path)
            } catch {
                // A restored path that no longer reads (moved, deleted, permissions)
                // is expected, not an error — it is simply skipped, and its panel
                // drops out of the remapped layout below along with it.
                continue
            }

            const file = this.addFileTab(path, text)

            panelIds.set(path, file.getPanelId())
            firstOpened ??= file
        }

        // Every panel must already be registered before the arrangement is
        // rebuilt — `Dock.setLayoutState` sources each leaf from the registry
        // by id and silently skips one it does not know.
        const arrangement = editorLayout === null ? null : remapPanelIds(editorLayout, panelIds)

        if (arrangement !== null) {
            this.dock.setLayoutState(arrangement)
        }

        // Focused after the restore, not during: `setLayoutState` activates
        // one panel per group itself, so the remembered active file has to
        // win the focus back afterward.
        const activeFile = activePath !== null ? this.findByPath(activePath) : null
        const toActivate = activeFile ?? firstOpened

        if (toActivate) {
            this.dock.focusPanel(toActivate.getPanelId())
        }

        this.syncActive()
    }

    /**
     * The dock's arrangement with panel ids rewritten to file paths, or
     * `null` when no saved file is open.
     */
    captureEditorLayout(): LayoutState | null {
        if (this.dock.isEmpty()) {
            return null
        }

        const byPath = new Map<string, string>()

        for (const [panelId, file] of this._openFiles) {
            const path = file.getPath()

            if (path !== null) {
                byPath.set(panelId, path)
            }
        }

        return remapPanelIds(this.dock.getLayoutState(), byPath)
    }

    /** Saves the active file, if it needs saving. A no-op on a clean, already-saved file. */
    async saveActive(): Promise<void> {
        const file = this.getActiveFile()

        if (file?.needsSave()) {
            await this.save(file)
        }
    }

    /** Runs {@link saveAs} against the active file, if any — the zero-argument entry point the menu and Ctrl/Cmd+Shift+S need. */
    async saveActiveAs(): Promise<void> {
        const file = this.getActiveFile()

        if (file) {
            await this.saveAs(file)
        }
    }

    /**
     * Shows the native save dialog for `file` and, on confirm, writes it to
     * the chosen path, re-tracks it there, and records it in the recent-files
     * list. Refuses a target that is already open under a different tab.
     * Cancelling writes nothing and leaves `file` dirty. Once a target is
     * confirmed, the document is reformatted first when format-on-save is
     * enabled and the language has a formatter.
     *
     * @param file - The file to save to a new path.
     * @returns Whether the write succeeded.
     */
    async saveAs(file: FileEditor): Promise<boolean> {
        const target = await pickSaveTarget(this.saveDialogDefault(file))

        if (target === null) {
            return false
        }

        if ([...this._openFiles.values()].some(other => other !== file && other.getPath() === target)) {
            await Dialog.error('Cannot save here', 'That file is already open in another tab. Close it first.')

            return false
        }

        const formatFailed = await this.formatBeforeSave(file)
        const text = file.getEditor().getValue()

        try {
            await writeFileText(target, text)
        } catch (error) {
            await Dialog.error('Could not save file', messageOf(error))

            return false
        }

        this.repointFile(file, target)
        file.markSynced(text)
        this.pinTab(file)
        this.recordRecentFile(target)
        this.dock.setPanelTitle(file.getPanelId(), file.getName())
        this.statusBar.setMessage(this.savedMessage(file, formatFailed), STATUS_MESSAGE_DURATION_MS)
        this.syncActive()
        this._fileSavedListener?.(target)

        return true
    }

    /**
     * Writes `file` to its own path, or runs {@link saveAs} when it has none.
     * A failed write shows a `Dialog.error` and leaves the file dirty. The
     * document is reformatted first when format-on-save is enabled and the
     * language has a formatter.
     *
     * @param file - The file to save.
     * @returns Whether the write succeeded.
     */
    async save(file: FileEditor): Promise<boolean> {
        const path = file.getPath()

        if (path === null) {
            return this.saveAs(file)
        }

        const formatFailed = await this.formatBeforeSave(file)
        const text = file.getEditor().getValue()

        try {
            await writeFileText(path, text)
        } catch (error) {
            await Dialog.error('Could not save file', messageOf(error))

            return false
        }

        file.markSynced(text)
        this.statusBar.setMessage(this.savedMessage(file, formatFailed), STATUS_MESSAGE_DURATION_MS)

        return true
    }

    /**
     * Shared write for {@link replaceInFile} and {@link replaceEverywhere}: reads
     * `path`'s current content — the live buffer when it's open, disk otherwise —
     * replaces every occurrence `compiled` finds, and writes the result back the
     * same way it was read. Skipped entirely when nothing matched, so a file with
     * no remaining occurrences is never touched. A read failure (deleted, now
     * over the size limit) is swallowed and reports `0`; a write failure
     * propagates, for the two public callers to handle differently.
     *
     * @param path - The file to replace in.
     * @param compiled - The query to scan for, as a substring or a regular expression.
     * @param replacement - The replacement text (a substring query) or template (a regexp query).
     * @returns How many occurrences were replaced.
     */
    private async performReplaceInFile(path: string, compiled: CompiledQuery, replacement: string): Promise<number> {
        const open = this.findByPath(path)

        if (open) {
            const { text, count } = replaceAllInText(open.getEditor().getValue(), compiled, replacement)

            if (count > 0) {
                open.getEditor().setValue(text)
            }

            return count
        }

        let diskText: string

        try {
            diskText = await readFileText(path)
        } catch {
            return 0
        }

        if (isProbablyBinary(diskText)) {
            return 0
        }

        const { text, count } = replaceAllInText(diskText, compiled, replacement)

        if (count > 0) {
            await writeFileText(path, text)
        }

        return count
    }

    /**
     * Replaces every occurrence `compiled` currently finds in `path` — through
     * the live buffer when it's open, straight to disk otherwise. A failed
     * disk write shows a `Dialog.error` like {@link save}'s own and resolves
     * `0`.
     *
     * @param path - The file to replace in.
     * @param compiled - The query to scan for, as a substring or a regular expression.
     * @param replacement - The replacement text (a substring query) or template (a regexp query).
     * @returns How many occurrences were replaced.
     */
    async replaceInFile(path: string, compiled: CompiledQuery, replacement: string): Promise<number> {
        try {
            return await this.performReplaceInFile(path, compiled, replacement)
        } catch (error) {
            await Dialog.error('Could not save file', messageOf(error))

            return 0
        }
    }

    /**
     * Runs {@link replaceInFile}'s own write over every one of `paths` in
     * turn, without its per-file dialog — a write failure is collected
     * instead, and reported in one combined `Dialog.error` once every file
     * has been attempted.
     *
     * @param paths - The files to replace in.
     * @param compiled - The query to scan for, as a substring or a regular expression.
     * @param replacement - The replacement text (a substring query) or template (a regexp query).
     * @returns How many occurrences were replaced in total, and in how many files.
     */
    async replaceEverywhere(
        paths: readonly string[], compiled: CompiledQuery, replacement: string,
    ): Promise<{ matchesReplaced: number; filesChanged: number }> {
        let matchesReplaced = 0
        let filesChanged = 0
        const failedPaths: string[] = []

        for (const path of paths) {
            try {
                const count = await this.performReplaceInFile(path, compiled, replacement)

                if (count > 0) {
                    matchesReplaced += count
                    filesChanged += 1
                }
            } catch {
                failedPaths.push(path)
            }
        }

        if (failedPaths.length > 0) {
            // Comma-joined, not one path per line: `Dialog`'s message renders with
            // `white-space: normal` (src/typescript/lib/overlay/Dialog.ts:742),
            // which collapses a `\n` into a single space anyway.
            await Dialog.error('Could not save every file', `These files could not be written: ${failedPaths.join(', ')}`)
        }

        return { matchesReplaced, filesChanged }
    }

    /**
     * Replaces the single occurrence `match` names — through the live buffer
     * when its file is open, straight to disk otherwise — verifying it is
     * still there first. A stale match (the file's content moved since the
     * search that found it ran) makes no change and resolves `false`
     * silently; a failed disk write shows a `Dialog.error` like {@link save}'s
     * own and resolves `false`.
     *
     * @param match - The match to replace.
     * @param compiled - The query `match` was found with.
     * @param replacement - The replacement text (a substring query) or template (a regexp query).
     * @returns Whether the occurrence was actually replaced.
     */
    async replaceMatch(match: SearchMatch, compiled: CompiledQuery, replacement: string): Promise<boolean> {
        const open = this.findByPath(match.path)

        if (open) {
            const text = replaceOneInText(open.getEditor().getValue(), match, compiled, replacement)

            if (text === null) {
                return false
            }

            open.getEditor().setValue(text)

            return true
        }

        let diskText: string

        try {
            diskText = await readFileText(match.path)
        } catch {
            return false
        }

        if (isProbablyBinary(diskText)) {
            return false
        }

        const replaced = replaceOneInText(diskText, match, compiled, replacement)

        if (replaced === null) {
            return false
        }

        try {
            await writeFileText(match.path, replaced)
        } catch (error) {
            await Dialog.error('Could not save file', messageOf(error))

            return false
        }

        return true
    }

    /**
     * The path the save dialog should open to for `file`: its own path when
     * that already sits inside the open workspace, otherwise the workspace
     * root itself — so the dialog never defaults to a directory outside the
     * current workspace, whether `file` has never been saved or was saved
     * somewhere else entirely (a different project, before the workspace
     * changed).
     *
     * @param file - The file about to be saved.
     * @returns The default save path, or `null` when no workspace is open,
     *   leaving the dialog to choose its own directory.
     */
    private saveDialogDefault(file: FileEditor): string | null {
        const path = file.getPath()

        if (path !== null && this._projectRoot !== null && isUnderRoot(this._projectRoot, path)) {
            return path
        }

        return this._projectRoot === null ? null : joinPath(this._projectRoot, file.getName())
    }

    /**
     * Reformats `file`'s document in place, immediately before its bytes are
     * written. A no-op while {@link _formatOnSave} is off, and for a language
     * with no registered formatter — that second guard is what keeps a save
     * away from `CodeEditor.format()`'s whole-document re-indent fallback,
     * which is reserved for the manual *Format Document* action. Runs with
     * the resolved formatting options.
     *
     * @param file - The file about to be written.
     * @returns `true` when a formatter ran and threw, leaving the document
     *   unformatted; `false` when formatting succeeded or was skipped.
     */
    private async formatBeforeSave(file: FileEditor): Promise<boolean> {
        if (!this._formatOnSave || !hasFormatter(file.getEditor().getLanguage())) {
            return false
        }

        try {
            await file.getEditor().format(this._formatting)
        } catch {
            // A formatter throws on syntactically invalid source, which is the
            // normal state of a file mid-edit. The save is what the user asked
            // for, so it goes ahead with the text as it stands.
            return true
        }

        return false
    }

    /**
     * The status-bar text for a completed save.
     *
     * @param file - The file that was written; its name supplies the name.
     * @param formatFailed - Whether format-on-save ran a formatter that threw.
     * @returns The message to show for `STATUS_MESSAGE_DURATION_MS`.
     */
    private savedMessage(file: FileEditor, formatFailed: boolean): string {
        return formatFailed ? `Saved ${file.getName()} (not formatted)` : `Saved ${file.getName()}`
    }

    /**
     * Closes the active file's tab. A clean file closes immediately;
     * `removePanel` is the unguarded programmatic path, so a dirty file is
     * routed through the same unsaved-changes prompt the ✕ uses instead of
     * calling it directly.
     */
    closeActive(): void {
        const file = this.getActiveFile()

        if (!file) {
            return
        }

        if (file.isDirty()) {
            void this.confirmThenClose(file)
        } else {
            this.dock.removePanel(file.getPanelId())
        }
    }

    /** Reformats the active file's document. */
    async formatActive(): Promise<void> {
        const file = this.getActiveFile()

        if (file) {
            await file.getEditor().format(this._formatting)
        }
    }

    /** Opens the find/replace bar over the active file's editor. */
    findInActive(): void {
        this.getActiveFile()?.openFind()
    }

    /**
     * Prompts for a line number and jumps the active file's caret to the start of
     * that line, centred in the viewport. A no-op with no file open — which is
     * also what makes the status bar's caret readout safe to click while the bar
     * is blank.
     */
    async goToLineInActive(): Promise<void> {
        const file = this.getActiveFile()

        if (!file) {
            return
        }

        const line = await promptGoToLine(countLines(file.getEditor().getValue()))

        if (line !== null) {
            file.revealMatch({ line, column: 0, length: 0 })
        }
    }

    /**
     * Applies a resolved settings snapshot: format-on-save, the formatting
     * options, the title template, and the tab width cap. Callable more than
     * once — again on every project switch, each time with that project's
     * own resolved settings.
     *
     * @param settings - The resolved settings to apply.
     */
    applySettings(settings: Settings): void {
        this._formatOnSave = settings.formatOnSave
        this._formatting = settings.formatting
        this._titleBarTemplate = settings.titleBarTemplate
        this.dock.setTabOptions({ maxWidth: settings.tabMaxWidthPx })
        this.syncActive()
    }

    /** Opens the app-wide settings file, creating it first if needed. */
    async openGlobalSettings(): Promise<void> {
        try {
            const path = await ensureGlobalSettingsFile()

            await this.openFile(path)
        } catch (error) {
            await Dialog.error('Could not open settings', messageOf(error))
        }
    }

    /**
     * Opens `root`'s own settings file, creating it first if needed.
     *
     * @param root - The project folder whose settings file to open.
     */
    async openWorkspaceSettings(root: string): Promise<void> {
        try {
            const path = await ensureWorkspaceSettingsFile(root)

            await this.openFile(path)
        } catch (error) {
            await Dialog.error('Could not open settings', messageOf(error))
        }
    }

    /**
     * Requests the window close. Routed through {@link closeWindow}, which
     * raises the same close-request event the title-bar ✕ does — so this and
     * a direct ✕ click both land on {@link confirmExit}, and neither can
     * bypass it.
     */
    async exitApp(): Promise<void> {
        await closeWindow()
    }

    /** The dock-wide focused panel's file, typed — `null` when nothing is focused. */
    private getActiveFile(): FileEditor | null {
        return this._activePanelId === null ? null : this._openFiles.get(this._activePanelId) ?? null
    }

    /** The open file registered at `path`, or `null` when it has no open tab. */
    private findByPath(path: string): FileEditor | null {
        for (const file of this._openFiles.values()) {
            if (file.getPath() === path) {
                return file
            }
        }

        return null
    }

    /**
     * Pins `file`'s tab, so a later temporary open leaves it alone, and records it
     * in the recent-files list — reaching this point means the user did something
     * deliberate with the file. Turns the tab upright. A no-op on an
     * already-pinned tab.
     *
     * @param file - The open file whose tab to pin.
     */
    private pinTab(file: FileEditor): void {
        if (!file.isTemporary()) {
            return
        }

        const path = file.getPath()

        file.setTemporary(false)

        if (path !== null) {
            this.recordRecentFile(path)
        }

        this.dock.setPanelTitle(file.getPanelId(), file.getName())
        this.dock.setPanelItalic(file.getPanelId(), false)
    }

    /**
     * Repoints `file` at `path` and re-icons its tab when the new path resolves
     * to a different file-type icon than the old one did. Owns the read-before,
     * read-after ordering so no caller has to get it right, and is the only
     * place an open file's path changes.
     *
     * The icon is left alone when it would not change — `Button.setGlyph` has no
     * same-name early-out, so an unconditional call would tear down and rebuild
     * a tab's icon for nothing, once per open tab on a folder rename.
     *
     * @param file - The open file to repoint.
     * @param path - The file's new path.
     */
    private repointFile(file: FileEditor, path: string): void {
        const previousGlyph = glyphNameForPath(file.getName())

        file.setPath(path)

        const glyph = glyphNameForPath(file.getName())

        if (glyph !== previousGlyph) {
            this.dock.setPanelGlyph(file.getPanelId(), glyph)
        }
    }

    /**
     * Resolves `file`'s pending external-change flag: reads it from disk and
     * applies the outcome {@link externalChangeOutcome} decides. The flag is
     * cleared on entry, not at the end, so a change landing while the prompt
     * is open re-arms it — picked up the next time this file's tab is
     * activated. A no-op when the file has no pending change, has no path, or
     * is already being resolved (`_resolvingExternal` joins a second batch
     * naming the same path rather than opening a second prompt for it).
     *
     * @param file - The open file whose pending external change to resolve.
     */
    private async resolvePendingExternalChange(file: FileEditor): Promise<void> {
        const path = file.getPath()

        if (path === null || !file.hasExternalChange() || this._resolvingExternal.has(path)) {
            return
        }

        this._resolvingExternal.add(path)
        file.clearExternalChange()

        try {
            let diskText: string

            try {
                diskText = await readFileText(path)
            } catch {
                // Externally deleted, unreadable, or grown past readFileText's size
                // limit: the buffer is the only surviving copy, so it is left exactly
                // as it is — and no dialog is raised, since the user did not ask for
                // anything here.
                return
            }

            const outcome = externalChangeOutcome(diskText, file.getSyncedText(), file.isDirty())

            if (outcome === 'reload') {
                this.reloadFromDisk(file, diskText)
            } else if (outcome === 'conflict') {
                await this.resolveExternalConflict(file, diskText)
            }
        } finally {
            this._resolvingExternal.delete(path)
        }
    }

    /**
     * Handles the conflict case: prompts to reload or keep, and either way
     * records `diskText` as the file's on-disk text so the same disk content
     * cannot raise a second prompt. `'keep'` leaves the buffer and its dirty
     * flag untouched — the next save overwrites the outside change, which is
     * what keeping the local changes means.
     *
     * @param file - The open file in conflict.
     * @param diskText - The file's freshly read disk content.
     */
    private async resolveExternalConflict(file: FileEditor, diskText: string): Promise<void> {
        if (await promptExternalChange(file.getName()) === 'reload') {
            this.reloadFromDisk(file, diskText)

            return
        }

        file.setSyncedText(diskText)
    }

    /**
     * Replaces `file`'s document with `diskText` and announces the reload in
     * the status bar. Clears and restores the temporary flag around the swap:
     * `CodeEditor.setValue()` reports the document dirty before `markClean()`
     * settles it, and that transient flip reaches `handleDirtyChange`
     * synchronously, which would otherwise pin the strip's temp tab and record
     * the file as recently used for a change the user did not make — clearing
     * the flag first makes `pinTab`'s own already-pinned early-out fire
     * instead, so restoring it afterwards fully restores the tab's state,
     * including its italic styling, before either is repainted.
     *
     * @param file - The open file to reload.
     * @param diskText - The file's freshly read disk content.
     */
    private reloadFromDisk(file: FileEditor, diskText: string): void {
        const wasTemporary = file.isTemporary()

        file.setTemporary(false)
        file.adoptDiskText(diskText)
        file.setTemporary(wasTemporary)
        this.dock.setPanelTitle(file.getPanelId(), file.getName())
        this.dock.setPanelItalic(file.getPanelId(), file.isTemporary())
        this.statusBar.setMessage(`Reloaded ${file.getName()}`, STATUS_MESSAGE_DURATION_MS)
    }

    /**
     * Closes the strip's temp tab, if it has one. Public so a preview surface
     * outside this class — the command palette's cancel path is the first —
     * can undo an unconfirmed `'temporary'` open without knowing which file, if
     * any, is currently temporary. A no-op when nothing is temporary, including
     * when the previewed path was already open as a permanent tab (`openFile`'s
     * existing-file branch never marks a file temporary, so there is nothing
     * here to close).
     */
    closeTemporaryTab(): void {
        const temporary = [...this._openFiles.values()].find(file => file.isTemporary())

        if (temporary) {
            this.dock.removePanel(temporary.getPanelId())
        }
    }

    /**
     * Registered as a `Component` dirty-state listener on each open file: pins
     * the file's tab on its first edit, then relabels the tab, paints its
     * modified indicator, and resyncs the title/status bar.
     */
    private handleDirtyChange = (file: FileEditor): void => {
        if (file.isDirty()) {
            this.pinTab(file)
        }

        this.dock.setPanelTitle(file.getPanelId(), file.getName())
        this.dock.setPanelModified(file.getPanelId(), file.isDirty())
        this.syncActive()
    }

    /**
     * Registered as a `"cursorchange"` listener on each open file's editor:
     * repaints the status bar's caret readout, and its selection readout —
     * a caret move collapses or replaces the selection as often as it leaves
     * it alone, so both are kept in sync from the same event. A file that is
     * not the active one is ignored — only the active file's caret and
     * selection are on show.
     */
    private handleCursorChange = (file: FileEditor): void => {
        if (file !== this.getActiveFile()) {
            return
        }

        this.syncCursorPosition(file)
        this.syncSelectionMetrics(file)
    }

    /**
     * Registered as a `"selectionchange"` listener on each open file's editor:
     * repaints the status bar's selection readout. Needed alongside
     * {@link handleCursorChange} because the two events dedupe independently —
     * `"cursorchange"` on the caret's own position (`selection.main.head`),
     * `"selectionchange"` on the selection's normalized span
     * (`main.from`/`main.to`). A change that widens or collapses the span
     * without moving the head fires `"selectionchange"` alone: `Ctrl/Cmd+A`
     * with the caret already at the document's end is one case (the head stays
     * put; only `from` moves), so a caret-only wiring would leave the readout
     * blank. A file that is not the active one is ignored, mirroring
     * {@link handleCursorChange}.
     */
    private handleSelectionChange = (file: FileEditor): void => {
        if (file !== this.getActiveFile()) {
            return
        }

        this.syncSelectionMetrics(file)
    }

    /**
     * `"beforeclose"`: a clean file closes immediately. A dirty file vetoes
     * the close and starts the unsaved-changes prompt instead. Fires for
     * every user-initiated destroy — a tab ✕ and a float window's chrome
     * ✕ — while `removePanel` stays the unguarded programmatic path.
     */
    private handleBeforePanelClose = (event: DockPanelEvent, controller: TabCloseController): void => {
        const file = this._openFiles.get(event.id)

        if (!file || !file.isDirty()) {
            return
        }

        controller.preventDefault()
        void this.confirmThenClose(file)
    }

    /** Awaits the unsaved-changes prompt, then finishes (or abandons) the close. */
    private async confirmThenClose(file: FileEditor): Promise<void> {
        const choice = await promptUnsavedChanges(file.getName())

        if (choice === 'cancel') {
            return
        }

        if (choice === 'discard') {
            this.dock.removePanel(file.getPanelId())

            return
        }

        if (await this.save(file)) {
            this.dock.removePanel(file.getPanelId())
        }
    }

    /**
     * `"close"`: drops the file from the registry, then resyncs the
     * active-state on a microtask — the dock re-selects a surviving panel and
     * emits its own `"focus"` after this handler returns, so reading the
     * active panel synchronously here would still see the one being closed.
     */
    private handlePanelClose = (event: DockPanelEvent): void => {
        this._openFiles.delete(event.id)

        queueMicrotask(() => this.syncActive())
    }

    /**
     * `"focus"`: fires dock-wide, across every tiled group and every float,
     * with a `null` payload when nothing is focused. Resyncs the title/status
     * bar from the newly focused panel, then resolves its pending external
     * change, if any. {@link resolvePendingExternalChange} returns
     * immediately when the flag is unset, so an ordinary focus change costs
     * one boolean read.
     */
    private handlePanelFocus = (event: DockPanelEvent | null): void => {
        this._activePanelId = event?.id ?? null
        this.syncActive()

        const file = this.getActiveFile()

        if (file) {
            void this.resolvePendingExternalChange(file)
        }
    }

    /**
     * `"dblclick"`: pins the double-clicked tab, matching VS Code's
     * preview-tab behaviour. A no-op on an already-pinned tab — `pinTab` owns
     * that check.
     */
    private handlePanelDoubleClick = (event: DockPanelEvent): void => {
        const file = this._openFiles.get(event.id)

        if (file) {
            this.pinTab(file)
        }
    }

    /**
     * `onCloseRequested`: whether the window may actually close right now.
     * With no dirty files this resolves `true` immediately; otherwise it asks
     * once, covering every open file at once rather than the per-file prompt
     * an individual tab close uses — sequencing a save across several files
     * on exit is the same deferred bulk-close case `"beforeclose"`'s own
     * veto already leaves for later.
     */
    private confirmExit = async (): Promise<boolean> => {
        const anyDirty = [...this._openFiles.values()].some(file => file.isDirty())

        if (anyDirty && !(await Dialog.confirm('Unsaved changes', 'You have unsaved changes. Exit without saving?'))) {
            return false
        }

        await this._beforeExitListener?.()

        return true
    }

    /** Sets the window title and the status bar's language text and caret readout from the active file. */
    private syncActive(): void {
        const file = this.getActiveFile()

        this._activeFileListener?.(file?.getPath() ?? null)
        this.syncCursorPosition(file)
        this.syncSelectionMetrics(file)

        if (!file) {
            void setWindowTitle(APP_NAME)
            this._languageText.setText('')

            return
        }

        const name = file.getName()
        const title = renderTitle(this._titleBarTemplate, { name, app: APP_NAME, dirty: file.isDirty() })

        void setWindowTitle(title)
        this._languageText.setText(languageForPath(file.getPath()) ?? '')
    }

    /**
     * Sets the status bar's caret readout from `file`'s editor, read live rather
     * than from a `"cursorchange"` payload — the same call serves an activation,
     * where no event fires at all.
     *
     * @param file - The active file, or `null` when no file is open.
     */
    private syncCursorPosition(file: FileEditor | null): void {
        const position = file === null ? null : file.getEditor().getCursorPosition()

        this._cursorText.setText(cursorLabel(position))
    }

    /**
     * Sets the status bar's selection readout from `file`'s editor, read live
     * rather than from an event payload — mirrors {@link syncCursorPosition},
     * including serving an activation, where no event fires at all.
     *
     * @param file - The active file, or `null` when no file is open.
     */
    private syncSelectionMetrics(file: FileEditor | null): void {
        const selection = file === null ? null : file.getEditor().getSelection()
        const metrics = selection === null ? null : { characters: selection.characterCount, lines: selection.lineCount }

        this._selectionText.setText(selectionLabel(metrics))
    }
}

export { EditorController }
