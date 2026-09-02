import { Container, callable } from '@jimka/typescript-ui/core'
import { Border as BorderLayout, Card } from '@jimka/typescript-ui/layout'
import { Placement } from '@jimka/typescript-ui/primitive'
import { CodeEditor } from '@jimka/typescript-ui/component/editor'
import { ToggleButton } from '@jimka/typescript-ui/component/button'
import { MarkdownViewer } from '@jimka/typescript-ui/component/display'
import { baseName } from '../data/paths'
import { languageForPath, isMarkdownPath } from './languages'
import { FileBreadcrumbs } from './FileBreadcrumbs'

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
    /** The file's absolute path on disk, or `null` for a buffer never yet saved. */
    path: string | null
    /** The initial display name: `baseName(path)` for a real file, `"Untitled-N"` for a path-less buffer. */
    name: string
    /** The file's text, as read from disk — `""` for a new buffer. */
    text: string
    /** The open project folder, or `null` when none is open. */
    projectRoot: string | null
    /** Notified whenever this editor's dirty state changes — including a `markClean` after save. */
    onDirtyChange: (file: FileEditor) => void
}

/**
 * One open file: a breadcrumb band NORTH of a `CodeEditor`, stacked via a
 * `Border` layout, plus the file's path and dirty flag. `EditorController`
 * addresses `Tab` operations (`setTabName`, `closeTab`, `getActiveContent`)
 * through this wrapper, never the bare editor.
 */
class FileEditor extends Container {
    private _path: string | null
    private _name: string
    private _dirty = false
    private _cleanText: string
    private readonly _editor: CodeEditor
    private readonly _breadcrumbs: FileBreadcrumbs
    private readonly _onDirtyChange: (file: FileEditor) => void
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

        this._path = params.path
        this._name = params.name
        this._cleanText = params.text
        this._editor = editor
        this._breadcrumbs = breadcrumbs
        this._onDirtyChange = params.onDirtyChange
        this._body = body
        this._card = card
        this._previewToggle = previewToggle

        editor.on('change', this.handleChange)
        previewToggle.on('action', this.handlePreviewToggle)
        this.syncPreviewAvailability()
    }

    /**
     * The wrapped editor's `"change"` handler — re-syncs the dirty flag, then
     * arms a debounced preview refresh if the preview page is showing.
     */
    private handleChange = (): void => {
        this.syncDirty()
        this.schedulePreviewRefresh()
    }

    /**
     * Dirties the file whenever its text no longer matches the
     * last-loaded-or-saved snapshot, and clears the flag again if an edit
     * brings it back to exactly that snapshot (e.g. an undo, or manually
     * retyping what was removed).
     */
    private syncDirty(): void {
        const dirty = this._editor.getValue() !== this._cleanText

        if (dirty === this._dirty) {
            return
        }

        this._dirty = dirty
        this._onDirtyChange(this)
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

    /** Whether the document has unsaved changes. */
    isDirty(): boolean {
        return this._dirty
    }

    /** Whether Save would do anything: the document is dirty, or has no path yet. */
    needsSave(): boolean {
        return this._dirty || this._path === null
    }

    /** Clears the dirty flag (after a successful save) and notifies the owner. */
    markClean(): void {
        this._cleanText = this._editor.getValue()
        this._dirty = false
        this._onDirtyChange(this)
    }

    /** The tab label: the file's display name, with `" •"` appended while dirty. */
    getLabel(): string {
        return this._dirty ? `${this._name} •` : this._name
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
