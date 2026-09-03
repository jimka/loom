import type { Component } from '@jimka/typescript-ui/core'
import { TabPanel, StatusBar } from '@jimka/typescript-ui/component/container'
import { Text } from '@jimka/typescript-ui/component/input'
import { Dialog } from '@jimka/typescript-ui/overlay'
import type { TabCloseController } from '@jimka/typescript-ui/layout'
import { FileEditor } from './editor/FileEditor'
import { languageForPath } from './editor/languages'
import { glyphNameForPath } from './fileIcons'
import { baseName, joinPath, isUnderRoot } from './data/paths'
import { readFileText, writeFileText, pickProjectFolder, pickSaveTarget, setWindowTitle, closeWindow, onCloseRequested } from './data/workspace'
import { promptUnsavedChanges } from './shell/unsavedPrompt'
import { APP_NAME } from './appIdentity'
import { withRecent } from './data/session'

/** Turns a caught value into a display-safe message for a `Dialog.error` call. */
function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/** Per-tab width cap for the "content" width mode — long enough for most file names, short enough that several tabs still fit the strip. */
const TAB_MAX_WIDTH = 200

/** How long the "Saved <name>" status message stays up, in milliseconds — long enough to notice, short enough not to linger. */
const SAVE_MESSAGE_DURATION_MS = 2000

/** How an {@link EditorController.openFile} request should treat the tab it lands in. */
export type OpenMode = 'temporary' | 'permanent'

/**
 * Owns the tab strip, the status bar, the open-file registry, and every
 * editor command (open/save/close/format). Holds no UI arrangement of its
 * own — the tree and the split belong to `EditorShell`, which the shell
 * reaches through {@link setProjectRootListener}.
 */
class EditorController {
    readonly tabs: TabPanel
    readonly statusBar: StatusBar

    private readonly _openFiles: FileEditor[] = []
    /**
     * Paths whose disk read is in flight, mapped to the mode their tab will get.
     * A second request for the same path joins the entry instead of starting a
     * second read, and a `'permanent'` request upgrades a `'temporary'` one — so
     * the tree's click-then-double-click pair produces exactly one, pinned, tab
     * however the read and the double-click interleave.
     */
    private readonly _pendingOpens: Map<string, OpenMode> = new Map()
    private readonly _languageText: Text
    private _recentProjects: string[] = []
    private _recentFiles: string[] = []
    private _projectRoot: string | null = null
    private _untitledCount = 0
    private _projectRootListener: ((root: string) => Promise<void>) | null = null
    private _beforeExitListener: (() => Promise<void>) | null = null
    private _emptyStateListener: ((empty: boolean) => void) | null = null
    private _activeFileListener: ((path: string | null) => void) | null = null
    private _fileSavedListener: ((path: string) => void) | null = null

    constructor() {
        this.tabs = new TabPanel({
            tabOptions: { widthMode: 'content', maxWidth: TAB_MAX_WIDTH, scrollable: true, reorderable: true },
        })

        this.statusBar = new StatusBar()
        this._languageText = new Text('')
        this.statusBar.addRight(this._languageText)

        this.tabs.getTab().on('beforetabclose', this.handleBeforeTabClose)
        this.tabs.getTab().on('tabclose', this.handleTabClose)
        this.tabs.getTab().on('activate', this.handleActivate)

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
     * Injects the shell's editor/welcome deck toggle, called once immediately
     * with the current state and again on every change — mirrors
     * {@link setProjectRootListener}. The argument is whether `_openFiles` is
     * empty, not whether a tab happens to be active.
     *
     * @param fn - Called with `true` whenever no file is open.
     */
    setEmptyStateListener(fn: (empty: boolean) => void): void {
        this._emptyStateListener = fn
        fn(this._openFiles.length === 0)
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
     * the current state and again on every active-tab change — mirrors
     * {@link setEmptyStateListener}. `null` covers both an empty tab strip and
     * an active path-less (untitled) buffer.
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
     * The open, saved files' paths, in tab order. A path-less (untitled)
     * buffer is omitted — it has nothing to reopen from, and persisting
     * untitled buffers across restarts is out of scope (see the plan's
     * Non-Goals). Sorted by `indexOfContent` rather than `_openFiles`' own
     * insertion order — insertion order is the order files were *opened*, not
     * the order a drag-reordered strip shows them in.
     */
    getOpenFilePaths(): string[] {
        const tab = this.tabs.getTab()

        return [...this._openFiles]
            .sort((a, b) => tab.indexOfContent(a) - tab.indexOfContent(b))
            .map(file => file.getPath())
            .filter((path): path is string => path !== null)
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

    /** Opens an empty untitled buffer in a new tab and activates it. */
    newFile(): void {
        this._untitledCount += 1

        const file = FileEditor({
            path: null,
            name: `Untitled-${this._untitledCount}`,
            text: '',
            projectRoot: this._projectRoot,
        })

        file.onDirtyChange(() => this.handleDirtyChange(file))
        this.tabs.addTab(file, file.getLabel(), { closeable: true, glyph: glyphNameForPath(file.getName()) })
        this._openFiles.push(file)
        this.tabs.getTab().setActiveContent(file)
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
        const existing = this._openFiles.find(candidate => candidate.getPath() === path)

        if (existing) {
            if (mode === 'permanent') {
                this.recordRecentFile(path)
                this.pinTab(existing)
            }

            this.tabs.getTab().setActiveContent(existing)

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

        this.tabs.getTab().setActiveContent(file)
        this.syncActive()

        if (settled === 'permanent') {
            file.getEditor().focus()
        }
    }

    /**
     * Builds a `FileEditor` for `path`/`text`, adds its tab, and records it in
     * the open-file registry. Does **not** activate the new tab — the caller
     * decides that, since {@link restoreFiles} adds several tabs before
     * activating any of them.
     *
     * @param path - The file's path.
     * @param text - The file's already-read contents.
     * @param temporary - Whether the new tab is the strip's temp tab.
     * @returns The new tab's `FileEditor`.
     */
    private addFileTab(path: string, text: string, temporary: boolean = false): FileEditor {
        const file = FileEditor({ path, name: baseName(path), text, projectRoot: this._projectRoot })

        file.setTemporary(temporary)
        file.onDirtyChange(() => this.handleDirtyChange(file))
        this.tabs.addTab(file, file.getLabel(), { closeable: true, glyph: glyphNameForPath(path) })
        this._openFiles.push(file)

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
        for (const file of this._openFiles) {
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
     * Reopens `paths` in order, skipping any that no longer read, then
     * activates `activePath`. Silent by design — a stale path is the expected
     * shape of a restore, not an error, so unlike {@link openFile} this never
     * shows a dialog.
     *
     * @param paths - The files to reopen, in tab order.
     * @param activePath - The path to activate once open, or `null`.
     */
    async restoreFiles(paths: string[], activePath: string | null): Promise<void> {
        let firstOpened: FileEditor | null = null

        for (const path of paths) {
            if (this._openFiles.some(candidate => candidate.getPath() === path)) {
                continue
            }

            let text: string

            try {
                text = await readFileText(path)
            } catch {
                // A restored path that no longer reads (moved, deleted, permissions)
                // is expected, not an error — it is simply skipped.
                continue
            }

            const file = this.addFileTab(path, text)

            firstOpened ??= file
        }

        const activeFile = activePath !== null ? this._openFiles.find(candidate => candidate.getPath() === activePath) : undefined
        const toActivate = activeFile ?? firstOpened

        if (toActivate) {
            this.tabs.getTab().setActiveContent(toActivate)
        }

        this.syncActive()
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
     * Cancelling writes nothing and leaves `file` dirty.
     *
     * @param file - The file to save to a new path.
     * @returns Whether the write succeeded.
     */
    async saveAs(file: FileEditor): Promise<boolean> {
        const target = await pickSaveTarget(this.saveDialogDefault(file))

        if (target === null) {
            return false
        }

        if (this._openFiles.some(other => other !== file && other.getPath() === target)) {
            await Dialog.error('Cannot save here', 'That file is already open in another tab. Close it first.')

            return false
        }

        try {
            await writeFileText(target, file.getEditor().getValue())
        } catch (error) {
            await Dialog.error('Could not save file', messageOf(error))

            return false
        }

        file.setPath(target)
        file.markClean()
        this.pinTab(file)
        this.recordRecentFile(target)
        this.tabs.getTab().setTabName(file, file.getLabel())
        this.statusBar.setMessage(`Saved ${file.getLabel()}`, SAVE_MESSAGE_DURATION_MS)
        this.syncActive()
        this._fileSavedListener?.(target)

        return true
    }

    /**
     * Writes `file` to its own path, or runs {@link saveAs} when it has none.
     * A failed write shows a `Dialog.error` and leaves the file dirty.
     *
     * @param file - The file to save.
     * @returns Whether the write succeeded.
     */
    async save(file: FileEditor): Promise<boolean> {
        const path = file.getPath()

        if (path === null) {
            return this.saveAs(file)
        }

        try {
            await writeFileText(path, file.getEditor().getValue())
        } catch (error) {
            await Dialog.error('Could not save file', messageOf(error))

            return false
        }

        file.markClean()
        this.statusBar.setMessage(`Saved ${file.getLabel()}`, SAVE_MESSAGE_DURATION_MS)

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
     * Closes the active file's tab. A clean file closes immediately;
     * `closeTab` is the unguarded programmatic path, so a dirty file is
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
            this.tabs.getTab().closeTab(file)
        }
    }

    /** Reformats the active file's document. */
    async formatActive(): Promise<void> {
        const file = this.getActiveFile()

        if (file) {
            await file.getEditor().format()
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

    /** The active tab's content, typed — `null` when the strip is empty. */
    private getActiveFile(): FileEditor | null {
        const content = this.tabs.getTab().getActiveContent()

        return content ? (content as FileEditor) : null
    }

    /**
     * Pins `file`'s tab, so a later temporary open leaves it alone, and records it
     * in the recent-files list — reaching this point means the user did something
     * deliberate with the file. A no-op on an already-pinned tab.
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

        this.tabs.getTab().setTabName(file, file.getLabel())
    }

    /**
     * Closes the temp tab, if the strip has one. `Tab.closeTab` is the unguarded
     * programmatic path, which is safe here precisely because a temp tab is always
     * clean — the first edit pins it — so there is never anything to prompt about.
     */
    private closeTemporaryTab(): void {
        const temporary = this._openFiles.find(file => file.isTemporary())

        if (temporary) {
            this.tabs.getTab().closeTab(temporary)
        }
    }

    /**
     * Registered as a `Component` dirty-state listener on each open file:
     * pins the file's tab on its first edit, then relabels the tab and
     * resyncs the title/status bar.
     */
    private handleDirtyChange = (file: FileEditor): void => {
        if (file.isDirty()) {
            this.pinTab(file)
        }

        this.tabs.getTab().setTabName(file, file.getLabel())
        this.syncActive()
    }

    /**
     * `"beforetabclose"`: a clean file closes immediately. A dirty file vetoes
     * the close and starts the unsaved-changes prompt instead.
     */
    private handleBeforeTabClose = (content: Component, controller: TabCloseController): void => {
        const file = content as FileEditor

        if (!file.isDirty()) {
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
            this.tabs.getTab().closeTab(file)

            return
        }

        if (await this.save(file)) {
            this.tabs.getTab().closeTab(file)
        }
    }

    /**
     * `"tabclose"`: drops the file from the registry, then resyncs the
     * active-state on a microtask — `Tab` emits `"tabclose"` before it selects
     * the next tab, so reading the active content synchronously here would
     * still see the tab being closed.
     */
    private handleTabClose = (content: Component): void => {
        const file = content as FileEditor
        const index = this._openFiles.indexOf(file)

        if (index !== -1) {
            this._openFiles.splice(index, 1)
        }

        queueMicrotask(() => this.syncActive())
    }

    /** `"activate"`: a genuine tab switch resyncs the title/status bar. */
    private handleActivate = (): void => {
        this.syncActive()
    }

    /**
     * `onCloseRequested`: whether the window may actually close right now.
     * With no dirty files this resolves `true` immediately; otherwise it asks
     * once, covering every open file at once rather than the per-file prompt
     * an individual tab close uses — sequencing a save across several files
     * on exit is the same deferred bulk-close case `"beforetabclose"`'s own
     * veto already leaves for later.
     */
    private confirmExit = async (): Promise<boolean> => {
        const anyDirty = this._openFiles.some(file => file.isDirty())

        if (anyDirty && !(await Dialog.confirm('Unsaved changes', 'You have unsaved changes. Exit without saving?'))) {
            return false
        }

        await this._beforeExitListener?.()

        return true
    }

    /** Sets the window title and the status bar's language text from the active file. */
    private syncActive(): void {
        this._emptyStateListener?.(this._openFiles.length === 0)

        const file = this.getActiveFile()

        this._activeFileListener?.(file?.getPath() ?? null)

        if (!file) {
            void setWindowTitle(APP_NAME)
            this._languageText.setText('')

            return
        }

        const name = file.getName()
        const title = file.isDirty() ? `• ${name} — ${APP_NAME}` : `${name} — ${APP_NAME}`

        void setWindowTitle(title)
        this._languageText.setText(languageForPath(file.getPath()) ?? '')
    }
}

export { EditorController }
