import { Container, callable } from '@jimka/typescript-ui/core'
import { Border as BorderLayout } from '@jimka/typescript-ui/layout'
import { Placement } from '@jimka/typescript-ui/primitive'
import { CodeEditor } from '@jimka/typescript-ui/component/editor'
import { baseName } from '../data/paths'
import { languageForPath } from './languages'
import { FileBreadcrumbs } from './FileBreadcrumbs'

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
  private readonly _editor: CodeEditor
  private readonly _breadcrumbs: FileBreadcrumbs
  private readonly _onDirtyChange: (file: FileEditor) => void

  constructor(params: FileEditorParams) {
    const editor = new CodeEditor(params.text, { language: languageForPath(params.path) ?? undefined })
    const breadcrumbs = FileBreadcrumbs({ path: params.path, name: params.name, projectRoot: params.projectRoot })

    super({
      layoutManager: new BorderLayout({ spacing: 0 }),
      components: [
        { component: breadcrumbs, constraints: { placement: Placement.NORTH } },
        { component: editor,      constraints: { placement: Placement.CENTER } },
      ],
    })

    this._path = params.path
    this._name = params.name
    this._editor = editor
    this._breadcrumbs = breadcrumbs
    this._onDirtyChange = params.onDirtyChange

    editor.on('change', this.handleChange)
  }

  /** The wrapped editor's `"change"` handler — dirties the file on its first edit since load/save. */
  private handleChange = (): void => {
    if (this._dirty) {
      return
    }

    this._dirty = true
    this._onDirtyChange(this)
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
    this._dirty = false
    this._onDirtyChange(this)
  }

  /** The tab label: the file's display name, with `" •"` appended while dirty. */
  getLabel(): string {
    return this._dirty ? `${this._name} •` : this._name
  }
}

const FileEditorCallable = callable(FileEditor)
type FileEditorCallable = FileEditor
export { FileEditorCallable as FileEditor }
