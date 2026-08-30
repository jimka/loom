import { Body } from '@jimka/typescript-ui/core'
import { Fit } from '@jimka/typescript-ui/layout'
import { Glyph } from '@jimka/typescript-ui/component/display'
import { folder } from '@jimka/typescript-ui/glyphs/solid/folder'
import { file_code } from '@jimka/typescript-ui/glyphs/solid/file_code'
import { floppy_disk } from '@jimka/typescript-ui/glyphs/solid/floppy_disk'
import { times } from '@jimka/typescript-ui/glyphs/solid/times'
import { pen_to_square } from '@jimka/typescript-ui/glyphs/solid/pen_to_square'
import { eye } from '@jimka/typescript-ui/glyphs/solid/eye'
import { bars } from '@jimka/typescript-ui/glyphs/solid/bars'
import { code } from '@jimka/typescript-ui/glyphs/solid/code'
import { APP_FAVICON } from './appIdentity'
import { EditorController } from './EditorController'
import { EditorShell } from './shell/EditorShell'

// Every glyph the shell, the tree, and the unsaved-changes prompt reference
// by name, registered once here at the composition root.
Glyph.register(folder, file_code, floppy_disk, times, pen_to_square, eye, bars, code)

Body.init({ layoutManager: Fit(), favicon: APP_FAVICON })

const controller = new EditorController()

Body.getInstance().addComponent(EditorShell(controller))
