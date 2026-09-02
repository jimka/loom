import { Body } from '@jimka/typescript-ui/core'
import { Fit } from '@jimka/typescript-ui/layout'
import { Glyph } from '@jimka/typescript-ui/component/display'
import { folder } from '@jimka/typescript-ui/glyphs/solid/folder'
import { file_circle_plus } from '@jimka/typescript-ui/glyphs/solid/file_circle_plus'
import { file_code } from '@jimka/typescript-ui/glyphs/solid/file_code'
import { floppy_disk } from '@jimka/typescript-ui/glyphs/solid/floppy_disk'
import { times } from '@jimka/typescript-ui/glyphs/solid/times'
import { pen_to_square } from '@jimka/typescript-ui/glyphs/solid/pen_to_square'
import { eye } from '@jimka/typescript-ui/glyphs/solid/eye'
import { bars } from '@jimka/typescript-ui/glyphs/solid/bars'
import { code } from '@jimka/typescript-ui/glyphs/solid/code'
import { right_from_bracket } from '@jimka/typescript-ui/glyphs/solid/right_from_bracket'
import { clock_rotate_left } from '@jimka/typescript-ui/glyphs/solid/clock_rotate_left'
import { APP_FAVICON } from './appIdentity'
import { EditorController } from './EditorController'
import { EditorShell } from './shell/EditorShell'
import { loadSession, loadWorkspaceState } from './shell/session'
import { applyWorkspaceOverlay } from './data/workspaceState'

// Every glyph the shell, the tree, and the unsaved-changes prompt reference
// by name, registered once here at the composition root.
Glyph.register(folder, file_circle_plus, file_code, floppy_disk, times, pen_to_square, eye, bars, code, right_from_bracket, clock_rotate_left)

Body.init({ layoutManager: Fit(), favicon: APP_FAVICON })

/**
 * Composes the shell and restores the last session. A wrapper function
 * rather than a top-level `await` — the shell is added to the page before
 * the restore's file reads begin, so the window paints immediately.
 */
async function start(): Promise<void> {
  const appSession = await loadSession()
  const workspace = appSession.projectRoot !== null ? await loadWorkspaceState(appSession.projectRoot) : null
  const session = applyWorkspaceOverlay(appSession, workspace)
  const controller = new EditorController()

  controller.seedRecents(session.recentProjects, session.recentFiles)

  const shell = EditorShell(controller, session)

  Body.getInstance().addComponent(shell)

  void shell.restoreSession(session)
}

void start()
