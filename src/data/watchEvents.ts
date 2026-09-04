// Pure watch-event decision logic — no Tauri imports, so it runs in
// vitest's `node` environment. Three callers, each asking a different
// question: `src/explorer/FileTree.ts`'s watcher asks *which* directories a
// batch of already-relevant changed paths means the tree must re-list
// (`refreshTargets`/`minimalRoots`); `src/data/workspace.ts`'s
// `watchDirectory` asks *whether* one native event is relevant at all
// (`isContentChangeKind`), since that is the only other place a
// `WatchEvent` is ever seen; `EditorController`'s external-change
// resolution asks what a change to an already-open file means for its
// buffer (`externalChangeOutcome`).
import { joinPath, parentDir, isUnderRoot } from './paths'
import { WORKSPACE_DIR_NAME } from './workspaceState'

/**
 * The directories the tree must refresh for a batch of changed filesystem
 * paths: each path's own directory, dropping paths outside `root`, paths
 * inside `root`'s `.loom` folder, and any directory another target already
 * covers.
 *
 * @param root - The project folder the tree is watching.
 * @param changedPaths - The batch of paths the watcher reported as changed.
 * @returns The minimal set of directories to re-list.
 */
export function refreshTargets(root: string, changedPaths: string[]): string[] {
    const stateDir = joinPath(root, WORKSPACE_DIR_NAME)
    const dirs: string[] = []

    for (const path of changedPaths) {
        if (!isUnderRoot(root, path) || isUnderRoot(stateDir, path)) {
            continue
        }

        const dir = parentDir(path)

        if (isUnderRoot(root, dir)) {
            dirs.push(dir)
        }
    }

    return minimalRoots(dirs)
}

/**
 * `dirs` with any entry that has a strict ancestor in `dirs` removed,
 * deduplicated.
 *
 * @param dirs - The candidate directories.
 * @returns The subset with no entry contained in another.
 */
export function minimalRoots(dirs: string[]): string[] {
    const unique = [...new Set(dirs)]

    return unique.filter(dir => !unique.some(other => other !== dir && isUnderRoot(other, dir)))
}

/**
 * Whether a native watch event's reported kind reflects an actual
 * filesystem change — create, modify, remove, or rename — rather than a
 * mere read. Linux's `inotify` backend (this app's live test platform)
 * reports a directory *open* and *read-only close* as part of its ordinary
 * event stream whenever any process, including this app's own directory
 * listing, reads a watched directory; treating those as changes would
 * refresh the tree in an endless loop the moment it re-lists whatever it
 * just watched. Takes the event's kind as `unknown` rather than
 * `@tauri-apps/plugin-fs`'s `WatchEvent['type']` so this module stays
 * Tauri-free; `workspace.ts`'s `watchDirectory` is the only caller and is
 * where that type is checked against this shape.
 *
 * @param kind - The event's own reported kind.
 * @returns Whether `kind` warrants a tree refresh.
 */
export function isContentChangeKind(kind: unknown): boolean {
    if (typeof kind !== 'object' || kind === null) {
        return true
    }

    return !('access' in kind)
}

/** What a watcher-reported change to an open file means for its buffer. */
export type ExternalChangeOutcome = 'unchanged' | 'reload' | 'conflict'

/**
 * Decides what a fresh disk read of an open file means for its buffer.
 * `diskText` equal to `syncedText` means the file on disk has not moved
 * since Loom last read or wrote it — indistinguishable from Loom's own save
 * — so the buffer needs nothing regardless of its dirty flag. Otherwise the
 * disk genuinely changed, and the outcome turns on whether there are unsaved
 * changes to lose.
 *
 * @param diskText - The file's content, just read from disk.
 * @param syncedText - The file's content as Loom last read it from, or wrote it to, disk.
 * @param dirty - Whether the open buffer has unsaved changes.
 * @returns `'unchanged'` when disk matches what Loom last saw, `'reload'`
 *   when disk moved and there is nothing local to lose, `'conflict'` when
 *   disk moved and there are unsaved changes.
 */
export function externalChangeOutcome(diskText: string, syncedText: string, dirty: boolean): ExternalChangeOutcome {
    if (diskText === syncedText) {
        return 'unchanged'
    }

    return dirty ? 'conflict' : 'reload'
}
