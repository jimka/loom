import { Body } from '@jimka/typescript-ui/core'
import { Fit } from '@jimka/typescript-ui/layout'
import { Glyph } from '@jimka/typescript-ui/component/display'
import { folder } from '@jimka/typescript-ui/glyphs/solid/folder'
import { folder_plus } from '@jimka/typescript-ui/glyphs/solid/folder_plus'
import { file_circle_plus } from '@jimka/typescript-ui/glyphs/solid/file_circle_plus'
import { floppy_disk } from '@jimka/typescript-ui/glyphs/solid/floppy_disk'
import { times } from '@jimka/typescript-ui/glyphs/solid/times'
import { pen_to_square } from '@jimka/typescript-ui/glyphs/solid/pen_to_square'
import { trash } from '@jimka/typescript-ui/glyphs/solid/trash'
import { copy } from '@jimka/typescript-ui/glyphs/solid/copy'
import { eye } from '@jimka/typescript-ui/glyphs/solid/eye'
import { bars } from '@jimka/typescript-ui/glyphs/solid/bars'
import { code } from '@jimka/typescript-ui/glyphs/solid/code'
import { right_from_bracket } from '@jimka/typescript-ui/glyphs/solid/right_from_bracket'
import { clock_rotate_left } from '@jimka/typescript-ui/glyphs/solid/clock_rotate_left'
import { magnifying_glass } from '@jimka/typescript-ui/glyphs/solid/magnifying_glass'
import { gear } from '@jimka/typescript-ui/glyphs/solid/gear'
import { APP_FAVICON } from './appIdentity'
import { FILE_ICON_GLYPHS } from './fileIcons'
import { EditorController } from './EditorController'
import { EditorShell } from './shell/EditorShell'
import { loadSession, loadWorkspaceState } from './shell/session'
import { loadResolvedSettings } from './shell/settings'
import { applyWorkspaceOverlay } from './data/workspaceState'

// Every glyph the shell, the tree, and the unsaved-changes prompt reference
// by name, plus the per-file-type set from fileIcons.ts, registered once
// here at the composition root.
Glyph.register(
    folder, folder_plus, file_circle_plus, floppy_disk, times, pen_to_square, trash, copy, eye, bars, code,
    right_from_bracket, clock_rotate_left, magnifying_glass, gear, ...FILE_ICON_GLYPHS,
)

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
    const settings = await loadResolvedSettings(session.projectRoot)
    const controller = new EditorController()

    controller.seedRecents(session.recentProjects, session.recentFiles)
    controller.applySettings(settings)

    const shell = EditorShell(controller, session, settings)

    Body.getInstance().addComponent(shell)

    void shell.restoreSession(session)
}

void start()
