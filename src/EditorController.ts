import type { Component } from '@jimka/typescript-ui/core'
import { TabPanel, StatusBar } from '@jimka/typescript-ui/component/container'
import { Text } from '@jimka/typescript-ui/component/input'
import { Dialog } from '@jimka/typescript-ui/overlay'
import type { TabCloseController } from '@jimka/typescript-ui/layout'
import { FileEditor } from './editor/FileEditor'
import { languageForPath } from './editor/languages'
import { baseName } from './data/paths'
import { readFileText, writeFileText, pickProjectFolder, pickSaveTarget, setWindowTitle, closeWindow, onCloseRequested } from './data/workspace'
import { promptUnsavedChanges } from './shell/unsavedPrompt'
import { APP_NAME } from './appIdentity'

/** Turns a caught value into a display-safe message for a `Dialog.error` call. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Per-tab width cap for the "content" width mode — long enough for most file names, short enough that several tabs still fit the strip. */
const TAB_MAX_WIDTH = 200

/** How long the "Saved <name>" status message stays up, in milliseconds — long enough to notice, short enough not to linger. */
const SAVE_MESSAGE_DURATION_MS = 2000

/**
 * Owns the tab strip, the status bar, the open-file registry, and every
 * editor command (open/save/close/format). Holds no UI arrangement of its
 * own — the tree and the split belong to `EditorShell`, which the shell
 * reaches through {@link setProjectRootListener}.
 */
class EditorController {
  readonly tabs: TabPanel
  readonly statusBar: StatusBar

  private readonly _openFiles = new Map<string, FileEditor>()
  private readonly _languageText: Text
  private _projectRootListener: ((root: string) => void) | null = null

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
   * @param fn - Called with the chosen project root.
   */
  setProjectRootListener(fn: (root: string) => void): void {
    this._projectRootListener = fn
  }

  /** Whether a file is currently active — read by the File/Edit menu providers. */
  hasActiveFile(): boolean {
    return this.getActiveFile() !== null
  }

  /** Whether the active file has unsaved changes — read by the File menu's Save item. */
  isActiveDirty(): boolean {
    return this.getActiveFile()?.isDirty() ?? false
  }

  /** Shows the native folder picker and points the tree at the chosen folder. */
  async openProjectFolder(): Promise<void> {
    const root = await pickProjectFolder()

    if (root !== null) {
      this._projectRootListener?.(root)
    }
  }

  /**
   * Opens `path` — activating its existing tab if already open, otherwise
   * reading it from disk and adding a new one. A read that fails (missing
   * file, over the size limit, not valid text) shows a `Dialog.error` and
   * opens nothing.
   *
   * @param path - The file to open.
   */
  async openFile(path: string): Promise<void> {
    const existing = this._openFiles.get(path)

    if (existing) {
      this.tabs.getTab().setActiveContent(existing)

      return
    }

    let text: string

    try {
      text = await readFileText(path)
    } catch (error) {
      await Dialog.error('Could not open file', messageOf(error))

      return
    }

    const file = FileEditor({ path, text, onDirtyChange: this.handleDirtyChange })

    this.tabs.addTab(file, file.getLabel(), { closeable: true })
    this._openFiles.set(path, file)
    this.tabs.getTab().setActiveContent(file)
    this.syncActive()
  }

  /** Saves the active file, if it has unsaved changes. A no-op on a clean file. */
  async saveActive(): Promise<void> {
    const file = this.getActiveFile()

    if (file && file.isDirty()) {
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
   * the chosen path and re-tracks it there. Refuses a target that is
   * already open under a different tab. Cancelling writes nothing and
   * leaves `file` dirty.
   *
   * @param file - The file to save to a new path.
   */
  async saveAs(file: FileEditor): Promise<void> {
    const target = await pickSaveTarget(file.getPath())

    if (target === null) {
      return
    }

    if (target !== file.getPath() && this._openFiles.has(target)) {
      await Dialog.error('Cannot save here', 'That file is already open in another tab. Close it first.')

      return
    }

    const oldPath = file.getPath()

    try {
      await writeFileText(target, file.getEditor().getValue())
    } catch (error) {
      await Dialog.error('Could not save file', messageOf(error))

      return
    }

    this._openFiles.delete(oldPath)
    file.setPath(target)
    this._openFiles.set(target, file)
    file.markClean()
    this.tabs.getTab().setTabName(file, file.getLabel())
    this.syncActive()
  }

  /**
   * Writes `file` to its own path. A failed write shows a `Dialog.error`
   * and leaves the file dirty.
   *
   * @param file - The file to save.
   * @returns Whether the write succeeded.
   */
  async save(file: FileEditor): Promise<boolean> {
    try {
      await writeFileText(file.getPath(), file.getEditor().getValue())
    } catch (error) {
      await Dialog.error('Could not save file', messageOf(error))

      return false
    }

    file.markClean()
    this.statusBar.setMessage(`Saved ${file.getLabel()}`, SAVE_MESSAGE_DURATION_MS)

    return true
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

  /** `FileEditor.onDirtyChange`: relabels the tab and resyncs the title/status bar. */
  private handleDirtyChange = (file: FileEditor): void => {
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
    const choice = await promptUnsavedChanges(file.getLabel())

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

    this._openFiles.delete(file.getPath())
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
    const anyDirty = Array.from(this._openFiles.values()).some(file => file.isDirty())

    if (!anyDirty) {
      return true
    }

    return Dialog.confirm('Unsaved changes', 'You have unsaved changes. Exit without saving?')
  }

  /** Sets the window title and the status bar's language text from the active file. */
  private syncActive(): void {
    const file = this.getActiveFile()

    if (!file) {
      void setWindowTitle(APP_NAME)
      this._languageText.setText('')

      return
    }

    const name = baseName(file.getPath())
    const title = file.isDirty() ? `• ${name} — ${APP_NAME}` : `${name} — ${APP_NAME}`

    void setWindowTitle(title)
    this._languageText.setText(languageForPath(file.getPath()) ?? '')
  }
}

export { EditorController }
