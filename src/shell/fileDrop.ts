import { Dialog } from '@jimka/typescript-ui/overlay'
import { onFilesDropped, isDirectory } from '../data/workspace'
import { dropIntent } from './dropIntent'
import type { DroppedPath } from './dropIntent'

/** The callbacks {@link installFileDrop} dispatches a drop's intent into. */
export interface FileDropActions {
    /** A single dropped file, or one of several. */
    onDropFile: (path: string) => Promise<void>
    /** A single dropped folder. */
    onDropFolder: (path: string) => Promise<void>
}

/**
 * Installs the app's file/folder drag-and-drop handler as a window-level
 * subscription. Mirrors `installAccelerators` in `shortcuts.ts`: a
 * `src/shell/` module that subscribes to a global input source and
 * dispatches into an actions interface, installed once from the shell's
 * constructor.
 *
 * @param actions - The callbacks a dropped file or folder dispatches to.
 */
export function installFileDrop(actions: FileDropActions): void {
    onFilesDropped(paths => { void handleDrop(paths, actions) })
}

/** Classifies `paths`, then applies the intent they add up to. */
async function handleDrop(paths: string[], actions: FileDropActions): Promise<void> {
    const intent = dropIntent(await classifyDropped(paths))

    if (intent.kind === 'files') {
        for (const path of intent.paths) {
            await actions.onDropFile(path)
        }

        return
    }

    if (intent.kind === 'folder') {
        await actions.onDropFolder(intent.path)

        return
    }

    if (intent.kind === 'unsupported') {
        await Dialog.error(
            'Cannot open these items',
            'Loom opens one project folder at a time. Drop a single folder to open it as the project, or drop files to open them in tabs.',
        )
    }
}

/** Resolves each dropped path's file-or-folder kind, preserving drop order. */
async function classifyDropped(paths: string[]): Promise<DroppedPath[]> {
    return Promise.all(paths.map(async path => ({ path, isDir: await isDirectory(path) })))
}
