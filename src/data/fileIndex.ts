// Flattens a project folder into a plain list of file paths for the command
// palette's file-search mode. Mirrors FileTree.loadDirectory's chain-
// extension logic (src/explorer/FileTree.ts), flattened and with the
// show-hidden/show-ignored toggles fixed off, and takes its I/O as injected
// parameters (mirroring buildRootIgnoreChain in ./gitignore) so the walking-
// and-filtering logic gets real vitest coverage.
import type { DirectoryItem } from './workspace'
import {
    GITIGNORE_NAME, isHiddenName, extendIgnoreChain, isIgnoredByChain, buildRootIgnoreChain,
} from './gitignore'
import type { IgnoreChain, TryReadTextFile, PathExists } from './gitignore'
import { joinPath } from './paths'

/** Lists one directory's immediate children — the shape `listDirectory` (src/data/workspace.ts) already has. */
export type ListDirectory = (dir: string) => Promise<DirectoryItem[]>

/**
 * Recursively lists every file (not directory) under `root`, depth-first,
 * skipping dotfiles and any path `.gitignore` excludes — the same rules
 * `FileTree.loadDirectory` applies, flattened, with the show-hidden/
 * show-ignored toggles fixed off.
 *
 * @param root - The project folder to walk.
 * @param listDirectory - Lists one directory's immediate children.
 * @param tryReadTextFile - Reads a `.gitignore`'s text, or `null` when absent/unreadable.
 * @param pathExists - Checks whether a path exists — used to find the repository root.
 * @returns Every file path under `root`, depth-first.
 */
export async function listFilesRecursive(
    root: string,
    listDirectory: ListDirectory,
    tryReadTextFile: TryReadTextFile,
    pathExists: PathExists,
): Promise<string[]> {
    const rootChain = await buildRootIgnoreChain(root, tryReadTextFile, pathExists)
    const files: string[] = []

    async function walk(dir: string, chain: IgnoreChain): Promise<void> {
        const items = await listDirectory(dir)
        const extended = items.some(item => !item.isDir && item.name === GITIGNORE_NAME)
            ? extendIgnoreChain(chain, dir, await tryReadTextFile(joinPath(dir, GITIGNORE_NAME)))
            : chain

        for (const item of items) {
            if (isHiddenName(item.name) || isIgnoredByChain(extended, item.path, item.isDir)) {
                continue
            }

            if (item.isDir) {
                await walk(item.path, extended)
            } else {
                files.push(item.path)
            }
        }
    }

    await walk(root, rootChain)

    return files
}
