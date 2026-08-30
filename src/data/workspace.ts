// The only module in the app that imports @tauri-apps/* — every filesystem
// and native-dialog call the app makes goes through here. Not unit-tested:
// it has no logic of its own beyond the size guard below, and every branch
// needs a real Tauri runtime to exercise — see plans/in-progress/
// code-editor-desktop-app.md's "App behaviour" manual-verify checklist.
import { open, save } from '@tauri-apps/plugin-dialog'
import { readDir, readTextFile, writeTextFile, stat } from '@tauri-apps/plugin-fs'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { joinPath, sortDirEntries } from './paths'

/** One entry in a directory listing, as `FileTree` and `EditorController` consume it. */
export interface DirectoryItem {
  name: string
  path: string
  isDir: boolean
}

/**
 * The largest file `readFileText` will open, in bytes (5 MiB). CodeEditor
 * wraps a single live CodeMirror document with no virtualisation, so an
 * unbounded read risks locking up the editor on an accidentally-selected
 * binary or log file.
 */
const MAX_OPEN_BYTES = 5 * 1024 * 1024

/**
 * Shows the native directory picker and resolves to the chosen folder, or
 * `null` if the user cancelled.
 *
 * @returns The chosen folder's path, or `null`.
 */
export async function pickProjectFolder(): Promise<string | null> {
  return open({ directory: true, multiple: false })
}

/**
 * Shows the native save dialog, defaulted to `defaultPath`, and resolves to
 * the chosen target path, or `null` if the user cancelled.
 *
 * @param defaultPath - The path the dialog opens to.
 * @returns The chosen path, or `null`.
 */
export async function pickSaveTarget(defaultPath: string): Promise<string | null> {
  return save({ defaultPath })
}

/**
 * Lists `dir`'s immediate children, directories first, each ordered
 * case-insensitively by name. `readDir` returns entry names rather than
 * paths, so each child's path is built with {@link joinPath}.
 *
 * @param dir - The directory to list.
 * @returns The directory's immediate children, sorted.
 */
export async function listDirectory(dir: string): Promise<DirectoryItem[]> {
  const entries = await readDir(dir)

  const items = entries.map(entry => ({
    name: entry.name,
    path: joinPath(dir, entry.name),
    isDir: entry.isDirectory,
  }))

  return sortDirEntries(items)
}

/**
 * Reads `path` as UTF-8 text. Refuses a file larger than
 * {@link MAX_OPEN_BYTES}.
 *
 * @param path - The file to read.
 * @returns The file's text contents.
 * @throws Error - When the file exceeds {@link MAX_OPEN_BYTES}.
 */
export async function readFileText(path: string): Promise<string> {
  const info = await stat(path)

  if (info.size > MAX_OPEN_BYTES) {
    throw new Error(`"${path}" is larger than ${MAX_OPEN_BYTES} bytes and was not opened.`)
  }

  return readTextFile(path)
}

/**
 * Writes `text` to `path` as UTF-8, overwriting any existing content.
 *
 * @param path - The file to write.
 * @param text - The new file contents.
 */
export async function writeFileText(path: string, text: string): Promise<void> {
  return writeTextFile(path, text)
}

/**
 * Sets the native window's title bar text.
 *
 * @param title - The new title.
 */
export async function setWindowTitle(title: string): Promise<void> {
  return getCurrentWindow().setTitle(title)
}
