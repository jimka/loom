import { Container, callable } from '@jimka/typescript-ui/core'
import { Border as BorderLayout, Card } from '@jimka/typescript-ui/layout'
import { Placement } from '@jimka/typescript-ui/primitive'
import { CodeEditor } from '@jimka/typescript-ui/component/editor'
import { ToggleButton } from '@jimka/typescript-ui/component/button'
import { MarkdownViewer } from '@jimka/typescript-ui/component/display'
import { baseName } from '../data/paths'
import type { MatchLocation } from '../data/projectSearch'
import { languageForPath, isMarkdownPath } from './languages'
import { FileBreadcrumbs } from './FileBreadcrumbs'
import { openFindPanel, revealRange } from './editorSearch'

/** How long an edit waits before the preview re-renders, in milliseconds.
 *  Shorter than `session.ts`'s 500ms save debounce: a session write is disk
 *  I/O whose only cost of firing late is a slightly larger loss window,
 *  while this one is an in-page re-render the user is watching happen, so it
 *  is tuned to feel immediate rather than to coalesce aggressively. Still
 *  long enough that a run of typing renders once at the end, not per key. */
const PREVIEW_REFRESH_DEBOUNCE_MS = 250

/** The toggle's icon. `eye` is already registered in `src/main.ts:24` for
 *  the View menu, so no new glyph registration is needed. */
const PREVIEW_GLYPH = 'eye'

/** The toggle's accessible name and hover tooltip. Not painted on the button
 *  face — `showText: false` collapses it to its glyph, which is what keeps it
 *  inside the band's fixed height. */
const PREVIEW_LABEL = 'Preview'

/** Constructor parameters for {@link FileEditor}. */
export interface FileEditorParams {
    /** The dock panel id minted for this buffer, fixed for its whole life. */
    panelId: string
    /** The file's absolute path on disk, or `null` for a buffer never yet saved. */
    path: string | null
    /** The initial display name: `baseName(path)` for a real file, `"Untitled-N"` for a path-less buffer. */
    name: string
    /** The file's text, as read from disk — `""` for a new buffer. */
    text: string
    /** The open project folder, or `null` when none is open. */
    projectRoot: string | null
}

/**
 * One open file: a breadcrumb band NORTH of a `CodeEditor`, stacked via a
 * `Border` layout, plus the file's path. `EditorController` addresses the
 * editor dock's panel-id-keyed operations (`setPanelTitle`, `setPanelItalic`,
 * `setPanelModified`, `removePanel`, `focusPanel`) through this wrapper's
 * {@link getPanelId}, never the bare editor.
 *
 * The dirty flag is the wrapped `CodeEditor`'s own — it is not tracked here.
 * `Component`'s parent-to-child relay folds the editor's flag up through
 * `_body` into this component's inherited `isDirty()`, so `FileEditor` does
 * not declare an `isDirty()` override.
 *
 * A file may also occupy the tab strip's one temp tab, tracked here as
 * `_temporary`. `EditorController` reads it back through {@link isTemporary}
 * to drive the tab's italic styling. `EditorController` is the sole owner of
 * the "at most one" rule — it sets the flag via {@link setTemporary} and
 * never lets more than one open file carry it.
 */
class FileEditor extends Container {
    private readonly _panelId: string
    private _path: string | null
    private _name: string
    private _temporary: boolean = false
    /** Backing field for the file's on-disk text, seeded from `params.text`. */
    private _syncedText: string
    /** Backing field for the pending-external-change flag. */
    private _externalChange: boolean = false
    private readonly _editor: CodeEditor
    private readonly _breadcrumbs: FileBreadcrumbs
    private readonly _body: Container
    private readonly _card: Card
    private readonly _previewToggle: ToggleButton
    private _preview: MarkdownViewer | null = null
    private _previewing = false
    private _refreshTimer: ReturnType<typeof setTimeout> | null = null

    constructor(params: FileEditorParams) {
        const editor = new CodeEditor(params.text, { language: languageForPath(params.path) ?? undefined })
        const breadcrumbs = FileBreadcrumbs({ path: params.path, name: params.name, projectRoot: params.projectRoot })
        const previewToggle = new ToggleButton(PREVIEW_LABEL, {
            glyph: PREVIEW_GLYPH,
            showText: false,
            flat: true,
            compact: true,
        })
        const card = new Card()
        const body = Container({ layoutManager: card })

        body.addComponent(editor)

        super({
            layoutManager: new BorderLayout({ spacing: 0 }),
            components: [
                { component: breadcrumbs, constraints: { placement: Placement.NORTH } },
                { component: body,        constraints: { placement: Placement.CENTER } },
            ],
        })

        this._panelId = params.panelId
        this._path = params.path
        this._name = params.name
        this._syncedText = params.text
        this._editor = editor
        this._breadcrumbs = breadcrumbs
        this._body = body
        this._card = card
        this._previewToggle = previewToggle

        editor.on('change', this.handleChange)
        previewToggle.on('action', this.handlePreviewToggle)
        this.syncPreviewAvailability()
    }

    /** The wrapped editor's `"change"` handler — arms a debounced preview refresh
     *  if the preview page is showing. The dirty flag is the editor's own now, so
     *  nothing here touches it. */
    private handleChange = (): void => {
        this.schedulePreviewRefresh()
    }

    // An arrow-function field, not a method: passed as a bare `this.handler`
    // reference to `on("action", ...)`, matching the existing `handleChange`.
    private readonly handlePreviewToggle = (): void => {
        this.setPreviewing(this._previewToggle.isSelected())
    }

    /**
     * Shows the source or the preview page, cancelling any pending refresh
     * first. Entering preview mode always pushes the editor's current text, so
     * the rendered view is never a stale snapshot from an earlier visit.
     *
     * @param previewing - `true` to show the preview, `false` to show the source.
     */
    private setPreviewing(previewing: boolean): void {
        this.cancelPreviewRefresh()
        this._previewing = previewing

        if (!previewing) {
            this._card.setVisibleComponentId(this._editor.getId())

            return
        }

        const preview = this.ensurePreview()

        this.refreshPreview()
        this._card.setVisibleComponentId(preview.getId())
    }

    /** Builds the preview page on first use and adds it to the deck. */
    private ensurePreview(): MarkdownViewer {
        if (this._preview !== null) {
            return this._preview
        }

        const preview = MarkdownViewer({ markdown: this._editor.getValue() })

        this._body.addComponent(preview)
        this._preview = preview

        return preview
    }

    /** Pushes the editor's current text into the preview, if one exists. */
    private refreshPreview(): void {
        this._preview?.setMarkdown(this._editor.getValue())
    }

    /** Re-arms the refresh timer. A no-op while the source page is showing. */
    private schedulePreviewRefresh(): void {
        if (!this._previewing) {
            return
        }

        this.cancelPreviewRefresh()

        this._refreshTimer = setTimeout(() => {
            this._refreshTimer = null
            this.refreshPreview()
        }, PREVIEW_REFRESH_DEBOUNCE_MS)
    }

    /** Drops any pending refresh. */
    private cancelPreviewRefresh(): void {
        if (this._refreshTimer !== null) {
            clearTimeout(this._refreshTimer)
            this._refreshTimer = null
        }
    }

    /**
     * Adds or removes the preview toggle for the current path, and drops out of
     * preview mode when the file has stopped being Markdown. `setSelected` does
     * not fire the toggle's `"action"` event, so clearing it here cannot
     * re-enter `handlePreviewToggle`.
     */
    private syncPreviewAvailability(): void {
        const available = isMarkdownPath(this._path)

        if (!available && this._previewing) {
            this._previewToggle.setSelected(false)
            this.setPreviewing(false)
        }

        this._breadcrumbs.setAction(available ? this._previewToggle : null)
    }

    /** The dock panel id this buffer's tab is addressed by. */
    getPanelId(): string {
        return this._panelId
    }

    /** The file's absolute path on disk, or `null` while it has never been saved. */
    getPath(): string | null {
        return this._path
    }

    /**
     * Repoints this editor at a new path (first save or Save As), renaming it
     * and re-resolving its syntax language from the new extension.
     *
     * @param path - The file's new path.
     */
    setPath(path: string): void {
        this._path = path
        this._name = baseName(path)
        this._editor.setLanguage(languageForPath(path))
        this._breadcrumbs.setPath(path)
        this.syncPreviewAvailability()
    }

    /** Repoints the breadcrumb band at a new project folder. */
    setProjectRoot(root: string | null): void {
        this._breadcrumbs.setProjectRoot(root)
    }

    /** The file's display name: its base name once saved, its untitled name before that. */
    getName(): string {
        return this._name
    }

    /** The wrapped `CodeEditor`. */
    getEditor(): CodeEditor {
        return this._editor
    }

    /** Opens the find/replace bar over this file's editor. A no-op while the
     *  Markdown preview is showing: `Card` hides the editor with
     *  `setVisible(false)`, which leaves it laid out but invisible, so the
     *  panel and its focused find field would open where the user can't see
     *  them. */
    openFind(): void {
        if (this._previewing) {
            return
        }

        openFindPanel(this._editor)
    }

    /** Selects and scrolls to `at` in this file's editor, dropping out of the
     *  Markdown preview first if it is showing — unlike {@link openFind}'s
     *  early return, the caller asked for a specific position in the
     *  *source*, so showing the rendered preview would not answer the
     *  request. The two-line drop-out is the one {@link syncPreviewAvailability}
     *  already uses; `setSelected` does not re-fire the toggle's `"action"` event.
     *
     * @param at - The match's location to reveal.
     * @param focus - Whether to also move keyboard focus into the editor. Defaults to `true`.
     */
    revealMatch(at: MatchLocation, focus: boolean = true): void {
        if (this._previewing) {
            this._previewToggle.setSelected(false)
            this.setPreviewing(false)
        }

        revealRange(this._editor, at, focus)
    }

    /** Whether Save would do anything: the document is dirty, or has no path yet. */
    needsSave(): boolean {
        return this.isDirty() || this._path === null
    }

    /** The file's content as Loom last read it from, or wrote it to, disk. */
    getSyncedText(): string {
        return this._syncedText
    }

    /** Records `text` as the file's on-disk content, leaving the document and the dirty flag alone.
     *
     * @param text - The text to record as the file's on-disk content.
     */
    setSyncedText(text: string): void {
        this._syncedText = text
    }

    /** Records `text` as the file's on-disk content, drops the external-change flag, and accepts the document as clean.
     *
     * @param text - The text to record as the file's on-disk content.
     */
    markSynced(text: string): void {
        this._syncedText = text
        this._externalChange = false
        this._editor.markClean()
    }

    /** Replaces the document with `text` and marks it synced.
     *
     * @param text - The disk text to adopt as the document's new content.
     */
    adoptDiskText(text: string): void {
        this._editor.setValue(text)
        this.markSynced(text)
    }

    /** Whether the watcher has reported a change to this file that is not resolved yet. */
    hasExternalChange(): boolean {
        return this._externalChange
    }

    /** Records that the watcher reported a change to this file. */
    markExternalChange(): void {
        this._externalChange = true
    }

    /** Drops the external-change flag. */
    clearExternalChange(): void {
        this._externalChange = false
    }

    /** Whether this file occupies the strip's temp tab — the one a temporary open recycles. */
    isTemporary(): boolean {
        return this._temporary
    }

    /**
     * Marks this file as the temp tab's content, or pins it. Changing the flag
     * changes {@link getName}, so the owner relabels the tab afterwards.
     *
     * @param value - Whether this file is the temp tab's content.
     */
    setTemporary(value: boolean): void {
        this._temporary = value
    }

    /**
     * Drops any pending refresh before the base class tears the subtree down.
     * `Tab` disposes a closed tab's content by default, so without this a timer
     * armed within the last 250ms would fire against a disposed viewer.
     */
    protected destructor(): void {
        this.cancelPreviewRefresh()
        super.destructor()
    }
}

const FileEditorCallable = callable(FileEditor)
type FileEditorCallable = FileEditor
export { FileEditorCallable as FileEditor }
