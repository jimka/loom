import { Container, callable } from '@jimka/typescript-ui/core'
import { VBox } from '@jimka/typescript-ui/layout'
import { Text } from '@jimka/typescript-ui/component/input'
import { Button } from '@jimka/typescript-ui/component/button'
import { OPEN_FOLDER_SHORTCUT } from './shortcuts'
import { welcomeCopy } from './welcomeText'

/** The heading `Text`'s font size, in pixels — large enough to read as a page title next to the muted hint line below it. */
const HEADING_FONT_SIZE = 20

/** The vertical gap between the heading, hint, and button, in pixels — tight enough to read as one group, loose enough not to crowd. */
const CONTENT_SPACING = 12

/** The hint `Text`'s colour — a muted grey so it reads as secondary to the heading. */
const HINT_COLOR = 'rgb(140, 140, 140)'

/** Constructor parameters for {@link WelcomeScreen}. */
export interface WelcomeScreenParams {
  /** Invoked when the Open Folder button is pressed. */
  onOpenFolder: () => void
}

/**
 * The editor pane's empty state: shown in place of the tab strip whenever no
 * file is open, covering both "no project folder open" and "project open,
 * no file tabs" with one component — only the heading and hint text differ
 * between them, resolved by {@link welcomeCopy}. Its body is a single
 * centred `VBox` column holding the heading, the hint, and the Open Folder
 * button, in that order; a future Recent Projects list is meant to append
 * below the button, in the same column.
 */
class WelcomeScreen extends Container {
  private readonly _heading: Text
  private readonly _hint: Text

  constructor(params: WelcomeScreenParams) {
    const heading = new Text('', { fontSize: HEADING_FONT_SIZE, fontWeight: '600' })
    const hint = new Text('', { foregroundColor: HINT_COLOR })

    const openFolder = Button({
      text: 'Open Folder…',
      glyph: 'folder',
      description: OPEN_FOLDER_SHORTCUT,
    })

    openFolder.on('action', params.onOpenFolder)

    super({
      layoutManager: new VBox({ justify: 'center', itemAlign: 'center', spacing: CONTENT_SPACING }),
      backgroundColor: 'var(--ts-ui-input-bg, rgb(255, 255, 255))',
      components: [heading, hint, openFolder],
    })

    this._heading = heading
    this._hint = hint
    this.applyCopy(null)
  }

  /**
   * Repoints the page at `root`, swapping its copy to the project-open
   * variant.
   *
   * @param root - The newly opened project folder.
   */
  setProjectRoot(root: string): void {
    this.applyCopy(root)
  }

  /** Applies `welcomeCopy(projectRoot)` to the heading and hint text in place. */
  private applyCopy(projectRoot: string | null): void {
    const copy = welcomeCopy(projectRoot)

    this._heading.setText(copy.heading)
    this._hint.setText(copy.hint)
  }
}

const WelcomeScreenCallable = callable(WelcomeScreen)
type WelcomeScreenCallable = WelcomeScreen
export { WelcomeScreenCallable as WelcomeScreen }
