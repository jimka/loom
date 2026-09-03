// The only module in the app that imports @tauri-apps/* — every filesystem
// and native-dialog call the app makes goes through here. Not unit-tested:
// it has no logic of its own beyond the size guard below, and every branch
// needs a real Tauri runtime to exercise — see plans/in-progress/
// code-editor-desktop-app.md's "App behaviour" manual-verify checklist.
import { open, save } from '@tauri-apps/plugin-dialog'
import { readDir, readTextFile, writeTextFile, stat, mkdir, exists, watch, rename, remove, BaseDirectory } from '@tauri-apps/plugin-fs'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { CloseRequestedEvent } from '@tauri-apps/api/window'
import { configDir, join } from '@tauri-apps/api/path'
import { platform } from '@tauri-apps/plugin-os'
import { joinPath, sortDirEntries } from './paths'
import { APP_NAME } from '../appIdentity'
import { WORKSPACE_DIR_NAME } from './workspaceState'
import { isContentChangeKind } from './watchEvents'

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

/** How long the native watcher coalesces events before delivering them, in
 *  milliseconds. Long enough that one editor's save — which arrives as a
 *  create, a write, and a rename — crosses the IPC bridge once; short enough
 *  that the tree still feels live. */
const FS_WATCH_DELAY_MS = 250

/**
 * The app's own subfolder name under Tauri's `$CONFIG` directory — lowercased
 * on Linux to match that platform's own convention (`~/.config/nvim`), left as
 * {@link APP_NAME} elsewhere to match those platforms' own
 * (`.../Application Support/Slack`); see the session-persistence plan's
 * `## Architecture Decisions`. Deliberately not the `com.jimka.loom` bundle
 * identifier either way.
 */
const CONFIG_DIR_NAME = platform() === 'linux' ? APP_NAME.toLowerCase() : APP_NAME

/** The session file's name inside {@link CONFIG_DIR_NAME}. */
const SESSION_FILE_NAME = 'session.json'

/** The workspace state file's name inside {@link WORKSPACE_DIR_NAME}. */
const WORKSPACE_STATE_FILE_NAME = 'workspace.json'

/** Ignore-everything marker written into a project's `.loom` folder so it never appears as untracked in the project's own `git status`, without touching the project's own `.gitignore`. */
const WORKSPACE_GITIGNORE_CONTENTS = '*\n'

/**
 * Shows the native directory picker and resolves to the chosen folder, or
 * `null` if the user cancelled. Passes `recursive: true` so Tauri grants
 * filesystem access to the whole subtree under the chosen folder rather than
 * its immediate children only — the runtime grant that lets a folder outside
 * `$HOME` be browsed to any depth.
 *
 * @returns The chosen folder's path, or `null`.
 */
export async function pickProjectFolder(): Promise<string | null> {
    return open({ directory: true, multiple: false, recursive: true })
}

/**
 * Shows the native save dialog, defaulted to `defaultPath` when one is
 * given, and resolves to the chosen target path, or `null` if the user
 * cancelled.
 *
 * @param defaultPath - The path the dialog opens to, or `null` to let the
 *   dialog pick its own starting directory.
 * @returns The chosen path, or `null`.
 */
export async function pickSaveTarget(defaultPath: string | null): Promise<string | null> {
    return save({ defaultPath: defaultPath ?? undefined })
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
 * Reads `path` as UTF-8 text, resolving `null` when it is missing or
 * unreadable. Used for probing a file that may not exist (a `.gitignore`, a
 * `.git/info/exclude`) where absence is the common case rather than an error.
 *
 * @param path - The file to read.
 * @returns The file's text contents, or `null`.
 */
export async function tryReadTextFile(path: string): Promise<string | null> {
    try {
        return await readTextFile(path)
    } catch {
        return null
    }
}

/**
 * Whether `path` exists and is reachable under the app's filesystem scope.
 * Swallows a `stat` rejection — which includes a path outside the app's
 * `$HOME/**` scope — resolving `false` rather than throwing.
 *
 * @param path - The path to check.
 * @returns Whether `path` exists.
 */
export async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path)

        return true
    } catch {
        return false
    }
}

/**
 * Creates an empty directory at `path`. Rejects if a directory already
 * exists at `path` or a parent segment is missing.
 *
 * @param path - The directory to create.
 */
export async function createDirectory(path: string): Promise<void> {
    return mkdir(path)
}

/**
 * Renames or moves `oldPath` to `newPath`.
 *
 * @param oldPath - The file or directory's current path.
 * @param newPath - The file or directory's new path.
 */
export async function renamePath(oldPath: string, newPath: string): Promise<void> {
    return rename(oldPath, newPath)
}

/**
 * Deletes the file or directory at `path`.
 *
 * @param path - The file or directory to delete.
 * @param isDir - Must be `true` for a non-empty directory to be removed.
 */
export async function removePath(path: string, isDir: boolean): Promise<void> {
    return remove(path, isDir ? { recursive: true } : undefined)
}

/**
 * Whether `path` names a directory. Swallows a `stat` rejection — a missing
 * path, or one outside the app's filesystem scope — resolving `false`
 * rather than throwing, so a caller classifying a dropped path treats an
 * unreadable one as a file and reports it through the normal open-file
 * error path.
 *
 * @param path - The path to check.
 * @returns Whether `path` is a directory.
 */
export async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory
    } catch {
        return false
    }
}

/** Stops a watch started by {@link watchDirectory}. */
export type StopWatching = () => void

/**
 * Watches `dir` and everything under it, calling `onChange` with the changed
 * paths. Rejects when the platform or the app's filesystem scope refuses the
 * watch.
 *
 * @param dir - The directory to watch, recursively.
 * @param onChange - Called with the batch of changed paths the native
 *   watcher's own debounce coalesced.
 * @returns A function that stops the watch.
 */
export async function watchDirectory(dir: string, onChange: (paths: string[]) => void): Promise<StopWatching> {
    return watch(dir, event => {
        if (isContentChangeKind(event.type)) {
            onChange(event.paths)
        }
    }, { recursive: true, delayMs: FS_WATCH_DELAY_MS })
}

/**
 * Reads the app-config session file's text, or `null` when it is absent or
 * unreadable. An absent file is the common case (first launch, or a session
 * never yet saved) rather than an error, so any read failure degrades to
 * `null` instead of throwing.
 *
 * @returns The session file's text, or `null`.
 */
export async function readSessionText(): Promise<string | null> {
    try {
        return await readTextFile(`${CONFIG_DIR_NAME}/${SESSION_FILE_NAME}`, { baseDir: BaseDirectory.Config })
    } catch {
        return null
    }
}

/**
 * Writes `text` to the app-config session file, creating the directory if
 * needed.
 *
 * @param text - The session file's new contents.
 */
export async function writeSessionText(text: string): Promise<void> {
    const dir = await join(await configDir(), CONFIG_DIR_NAME)

    await mkdir(dir, { recursive: true })

    return writeTextFile(`${CONFIG_DIR_NAME}/${SESSION_FILE_NAME}`, text, { baseDir: BaseDirectory.Config })
}

/**
 * Reads `root`'s workspace state file's text, or `null` when it (or its
 * `.loom` folder) is absent or unreadable. A project with no `.loom` folder
 * yet is the common case rather than an error, so any read failure degrades
 * to `null` instead of throwing.
 *
 * @param root - The project folder to read the workspace state from.
 * @returns The workspace state file's text, or `null`.
 */
export async function readWorkspaceStateText(root: string): Promise<string | null> {
    try {
        return await readTextFile(joinPath(joinPath(root, WORKSPACE_DIR_NAME), WORKSPACE_STATE_FILE_NAME))
    } catch {
        return null
    }
}

/**
 * Writes `text` to `root`'s workspace state file, creating its `.loom`
 * folder — and a matching `.gitignore` inside it, the first time — if needed.
 *
 * @param root - The project folder to write the workspace state into.
 * @param text - The workspace state file's new contents.
 */
export async function writeWorkspaceStateText(root: string, text: string): Promise<void> {
    const dir = joinPath(root, WORKSPACE_DIR_NAME)

    await mkdir(dir, { recursive: true })

    const gitignorePath = joinPath(dir, '.gitignore')

    if (!(await exists(gitignorePath))) {
        await writeTextFile(gitignorePath, WORKSPACE_GITIGNORE_CONTENTS)
    }

    return writeTextFile(joinPath(dir, WORKSPACE_STATE_FILE_NAME), text)
}

/**
 * Sets the native window's title bar text.
 *
 * @param title - The new title.
 */
export async function setWindowTitle(title: string): Promise<void> {
    return getCurrentWindow().setTitle(title)
}

/**
 * Requests the app's single window close. Routed through the same
 * close-request lifecycle as the title-bar ✕, so a listener registered via
 * {@link onCloseRequested} sees this call too — there is exactly one place
 * that decides whether a close actually proceeds.
 */
export async function closeWindow(): Promise<void> {
    return getCurrentWindow().close()
}

/**
 * Registers `handler` to run whenever the window is asked to close — the
 * title-bar ✕, an OS-level quit, or {@link closeWindow} itself, all of
 * which raise the same event. Returning `false` vetoes the close.
 *
 * @param handler - Called before the window closes; return `false` to veto it.
 */
export function onCloseRequested(handler: () => Promise<boolean>): void {
    void getCurrentWindow().onCloseRequested(async (event: CloseRequestedEvent) => {
        if (!(await handler())) {
            event.preventDefault()
        }
    })
}

/**
 * Registers `handler` to run whenever files or folders are dropped onto the
 * window from the OS. This is a window-level native event, not a DOM `drop`
 * event: the payload carries real filesystem paths, and it fires wherever in
 * the window the drop lands. Hover and cancel payloads are ignored — only a
 * completed drop reaches `handler`.
 *
 * @param handler - Called with the dropped paths, in the order the OS listed them.
 */
export function onFilesDropped(handler: (paths: string[]) => void): void {
    void getCurrentWindow().onDragDropEvent(event => {
        if (event.payload.type === 'drop') {
            handler(event.payload.paths)
        }
    })
}
