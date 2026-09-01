// Capture/restore/autosave wiring for session persistence. Pure data shape
// and parsing live in `../data/session`; this module is where that shape
// meets the live tree, tab strip, and split.
import type { Split } from '@jimka/typescript-ui/layout'
import type { EditorController } from '../EditorController'
import type { FileTree } from '../explorer/FileTree'
import type { SessionState } from '../data/session'
import { parseSession, serializeSession } from '../data/session'
import { readSessionText, writeSessionText } from '../data/workspace'

/**
 * How long a session change waits before it is written, in milliseconds.
 * Long enough to coalesce the several events one user action emits (opening
 * a file from the tree fires a tree "expand" and a tab "activate"), short
 * enough that an abrupt kill loses at most the last action.
 */
const SESSION_SAVE_DEBOUNCE_MS = 500

/** The three state owners a session snapshot is captured from and restored into. */
export interface SessionTargets {
  controller: EditorController
  tree: FileTree
  split: Split
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

/** The current state of the tree, tabs, and split. */
export function captureSession(targets: SessionTargets): SessionState {
  const paneSizes = targets.split.getPaneSizes()

  return {
    version: 1,
    projectRoot: targets.tree.getProjectRoot(),
    expandedDirs: targets.tree.getExpandedPaths(),
    openFiles: targets.controller.getOpenFilePaths(),
    activeFile: targets.controller.getActiveFilePath(),
    paneSizes,
    collapsedPanes: paneSizes.map((_, index) => index).filter(index => targets.split.isPaneCollapsed(index)),
  }
}

/**
 * Replays `state` into the live tree and tab strip. The split is restored by
 * `EditorShell`'s constructor instead, through `Split`'s own
 * `paneSizes`/`collapsedPanes` options.
 *
 * @param state - The session to restore.
 * @param targets - The live tree and controller to restore into.
 */
export async function applySession(state: SessionState, targets: SessionTargets): Promise<void> {
  if (state.projectRoot !== null) {
    try {
      await targets.tree.setProjectRoot(state.projectRoot)
      await targets.tree.expandPaths(state.expandedDirs)
    } catch {
      // A moved or deleted project folder leaves the tree empty; the rest of
      // the restore (the open files below) still proceeds.
    }
  }

  await targets.controller.restoreFiles(state.openFiles, state.activeFile)
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
      await writeSessionText(serializeSession(captureSession(targets)))
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
  targets.controller.tabs.getTab().on('activate', schedule)
  targets.controller.tabs.getTab().on('tabclose', schedule)
  targets.split.on('paneresize', schedule)
  targets.split.on('panecollapse', schedule)

  return { schedule, flush }
}
