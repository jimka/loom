import { Container, callable } from '@jimka/typescript-ui/core'
import { Fit } from '@jimka/typescript-ui/layout'
import { CodeEditor } from '@jimka/typescript-ui/component/editor'
import { baseName } from '../data/paths'
import { languageForPath } from './languages'

/** Constructor parameters for {@link FileEditor}. */
export interface FileEditorParams {
  /** The file's absolute path on disk. */
  path: string
  /** The file's text, as read from disk. */
  text: string
  /** Notified whenever this editor's dirty state changes — including a `markClean` after save. */
  onDirtyChange: (file: FileEditor) => void
}

/**
 * One open file: a `CodeEditor` filling its tab via a `Fit` layout, plus the
 * file's path and dirty flag. `EditorController` addresses `Tab` operations
 * (`setTabName`, `closeTab`, `getActiveContent`) through this wrapper, never
 * the bare editor.
 */
class FileEditor extends Container {
  private _path: string
  private _dirty = false
  private readonly _editor: CodeEditor
  private readonly _onDirtyChange: (file: FileEditor) => void

  constructor(params: FileEditorParams) {
    const editor = new CodeEditor(params.text, { language: languageForPath(params.path) ?? undefined })

    super({ layoutManager: new Fit(), components: [editor] })

    this._path = params.path
    this._editor = editor
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

  /** The file's absolute path on disk. */
  getPath(): string {
    return this._path
  }

  /**
   * Repoints this editor at a new path (Save As) and re-resolves its syntax
   * language from the new extension.
   *
   * @param path - The file's new path.
   */
  setPath(path: string): void {
    this._path = path
    this._editor.setLanguage(languageForPath(path))
  }

  /** The wrapped `CodeEditor`. */
  getEditor(): CodeEditor {
    return this._editor
  }

  /** Whether the document has unsaved changes. */
  isDirty(): boolean {
    return this._dirty
  }

  /** Clears the dirty flag (after a successful save) and notifies the owner. */
  markClean(): void {
    this._dirty = false
    this._onDirtyChange(this)
  }

  /** The tab label: the file's base name, with `" •"` appended while dirty. */
  getLabel(): string {
    const name = baseName(this._path)

    return this._dirty ? `${name} •` : name
  }
}

const FileEditorCallable = callable(FileEditor)
type FileEditorCallable = FileEditor
export { FileEditorCallable as FileEditor }
