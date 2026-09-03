// The rule deciding what a set of dropped filesystem paths means, split out
// so it stays unit testable: vitest.config.ts runs in the `node` environment
// with no DOM, and a module that imports @jimka/typescript-ui's components
// touches `document` at load time. See src/shell/welcomeText.ts for the same
// split, for the same reason.

/** One dropped path, already classified as a file or a directory. */
export interface DroppedPath {
    /** The dropped item's filesystem path. */
    path: string
    /** Whether `path` is a directory. */
    isDir: boolean
}

/** What a drop means, as decided by {@link dropIntent}. */
export type DropIntent =
    | { kind: 'files', paths: string[] }
    | { kind: 'folder', path: string }
    | { kind: 'unsupported' }
    | { kind: 'none' }

/**
 * Decides what a drop of `items` means. A drop opens files or a folder,
 * never a mix: several files all open as tabs, a single folder opens as the
 * workspace, and anything else — several folders, or a mix of files and
 * folders — is unsupported.
 *
 * @param items - The dropped paths, each already classified as file or folder.
 * @returns The intent the drop expresses.
 */
export function dropIntent(items: DroppedPath[]): DropIntent {
    if (items.length === 0) {
        return { kind: 'none' }
    }

    const folders = items.filter(item => item.isDir)

    if (folders.length === 0) {
        return { kind: 'files', paths: items.map(item => item.path) }
    }

    if (items.length === 1 && folders.length === 1) {
        return { kind: 'folder', path: folders[0].path }
    }

    return { kind: 'unsupported' }
}
