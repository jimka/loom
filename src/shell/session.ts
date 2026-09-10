// Capture/restore/autosave wiring for session persistence. Pure data shape
// and parsing live in `../data/session`; this module is where that shape
// meets the live tree, tab strip, and split.
import type { Split } from '@jimka/typescript-ui/layout'
import type { EditorController } from '../EditorController'
import type { FileTree } from '../explorer/FileTree'
import type { SessionState, ExplorerView } from '../data/session'
import { parseSession, serializeSession } from '../data/session'
import type { WorkspaceState } from '../data/workspaceState'
import { parseWorkspaceState, serializeWorkspaceState, workspaceStateFromSession } from '../data/workspaceState'
import { panelOrder } from '../data/editorLayout'
import { readSessionText, writeSessionText, readWorkspaceStateText, writeWorkspaceStateText } from '../data/workspace'
import { isUnderRoot } from '../data/paths'

/**
 * How long a session change waits before it is written, in milliseconds.
 * Long enough to coalesce the several events one user action emits (opening
 * a file from the tree fires a tree "expand" and a tab "activate"), short
 * enough that an abrupt kill loses at most the last action.
 */
const SESSION_SAVE_DEBOUNCE_MS = 500

/** The explorer's own persisted UI state, read live off the shell at capture time. */
export interface ExplorerStateSource {
    /** Which rail view the explorer currently shows. */
    getExplorerView: () => ExplorerView
    /** The Files view's section open flags, in child order. */
    getExplorerSectionsOpen: () => boolean[]
}

/** The state owners a session snapshot is captured from and restored into. */
export interface SessionTargets {
    controller: EditorController
    tree: FileTree
    split: Split
    explorer: ExplorerStateSource
}

/** Queues and forces session writes. */
export interface SessionAutosave {
    /** Queues a save of the current snapshot, coalescing calls within the debounce window. */
    schedule: () => void
    /** Writes the current snapshot immediately, pending save or not. */
    flush: () => Promise<void>
}

/** Reads and parses the stored session. */
export async function loadSession(): Promise<SessionState> {
    return parseSession((await readSessionText()) ?? '')
}

/**
 * Reads and parses `root`'s workspace state file.
 *
 * @param root - The project folder to read the workspace state from.
 * @returns The parsed workspace state, or `null` when it is absent or unusable.
 */
export async function loadWorkspaceState(root: string): Promise<WorkspaceState | null> {
    const text = await readWorkspaceStateText(root)

    return text === null ? null : parseWorkspaceState(text)
}

/** The current state of the tree, editor dock, split, and explorer rail/sections. */
export function captureSession(targets: SessionTargets): SessionState {
    const paneSizes = targets.split.getPaneSizes()
    const editorLayout = targets.controller.captureEditorLayout()

    return {
        version: 1,
        projectRoot: targets.tree.getProjectRoot(),
        expandedDirs: targets.tree.getExpandedPaths(),
        openFiles: editorLayout === null ? [] : panelOrder(editorLayout),
        activeFile: targets.controller.getActiveFilePath(),
        paneSizes,
        collapsedPanes: paneSizes.map((_, index) => index).filter(index => targets.split.isPaneCollapsed(index)),
        editorLayout,
        recentProjects: targets.controller.getRecentProjects(),
        recentFiles: targets.controller.getRecentFiles(),
        explorerView: targets.explorer.getExplorerView(),
        explorerSectionsOpen: targets.explorer.getExplorerSectionsOpen(),
    }
}

/**
 * Replays `state` into the live tree and tab strip. The split, the rail
 * view, and the Files view's accordion sections are restored by
 * `EditorShell`'s constructor instead, through `Split`'s own
 * `paneSizes`/`collapsedPanes` options and each `AccordionConstraints`'
 * `initiallyOpen` — none of them can be re-applied here after the fact (see
 * `session-persistence.md`'s *The split restores through `Split`'s
 * constructor, not a post-layout re-apply*).
 *
 * @param state - The session to restore.
 * @param targets - The live tree and controller to restore into.
 */
export async function applySession(state: SessionState, targets: SessionTargets): Promise<void> {
    if (state.projectRoot !== null) {
        try {
            await targets.tree.setProjectRoot(state.projectRoot)
            await targets.tree.expandPaths(state.expandedDirs)
            targets.controller.setProjectRoot(state.projectRoot)
        } catch {
            // A moved or deleted project folder leaves the tree empty; the rest of
            // the restore (the open files below) still proceeds. The controller's
            // own project root is left unset in that case too, matching the tree.
        }
    }

    await targets.controller.restoreFiles(state.openFiles, state.activeFile, state.editorLayout)
}

/**
 * Subscribes to every event that changes the session and returns the save
 * controls. Each subscribed event is an *additional* listener on an event
 * `EditorController`/`FileTree`/`Split` may already listen to — the
 * library's listener bags allow that.
 *
 * @param targets - The live tree, controller, and split to watch.
 * @returns The `schedule`/`flush` controls installed on `targets`.
 */
export function installSessionAutosave(targets: SessionTargets): SessionAutosave {
    let timer: ReturnType<typeof setTimeout> | null = null

    const writeSnapshot = async (): Promise<void> => {
        try {
            const session = captureSession(targets)

            await writeSessionText(serializeSession(session))

            if (session.projectRoot !== null && openFilesBelongToRoot(session.projectRoot, session.openFiles)) {
                await writeWorkspaceStateText(session.projectRoot, serializeWorkspaceState(workspaceStateFromSession(session)))
            }
        } catch {
            // A failed session write must never interrupt editing.
        }
    }

    const schedule = (): void => {
        if (timer !== null) {
            clearTimeout(timer)
        }

        timer = setTimeout(() => { void writeSnapshot() }, SESSION_SAVE_DEBOUNCE_MS)
    }

    const flush = async (): Promise<void> => {
        if (timer !== null) {
            clearTimeout(timer)
            timer = null
        }

        await writeSnapshot()
    }

    targets.tree.on('expand', schedule)
    targets.tree.on('collapse', schedule)
    targets.controller.dock.on('attach', schedule)
    targets.controller.dock.on('detach', schedule)
    targets.controller.dock.on('move', schedule)
    targets.controller.dock.on('focus', schedule)
    targets.controller.dock.on('close', schedule)
    targets.split.on('paneresize', schedule)
    targets.split.on('panecollapse', schedule)

    return { schedule, flush }
}

/**
 * Whether every one of `openFiles` sits under `root` — the signal that the
 * live tab strip genuinely belongs to the current project, safe to write
 * into its own `.loom/workspace.json`.
 *
 * A live *Open Folder…* switch changes the tree's root without touching the
 * open tabs (`EditorShell.openProjectRoot` deliberately leaves them alone),
 * so immediately after a switch the tabs still belong to the *previous*
 * project. Restoring the new root's saved tree expansion still fires the
 * `tree`'s `"expand"` events this module listens on, which would otherwise
 * write the previous project's stale tabs and pane sizes into the new
 * root's own workspace file, silently overwriting whatever it had already
 * saved. Skipping the write while any tab is foreign leaves that file
 * untouched until the mismatch resolves on its own — the user closes the
 * leftover tabs, or opens a file under the new root — at which point the
 * write resumes and captures the new root's own, genuine state.
 *
 * @param root - The project root to check against.
 * @param openFiles - The live tab strip's open file paths.
 * @returns Whether every open file is under `root`.
 */
function openFilesBelongToRoot(root: string, openFiles: string[]): boolean {
    return openFiles.every(path => isUnderRoot(root, path))
}
