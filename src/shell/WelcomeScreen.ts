import { Container, callable } from '@jimka/typescript-ui/core'
import { VBox } from '@jimka/typescript-ui/layout'
import { Text } from '@jimka/typescript-ui/component/input'
import { Button } from '@jimka/typescript-ui/component/button'
import { OPEN_FOLDER_SHORTCUT } from './shortcuts'
import { welcomeCopy } from './welcomeText'
import { projectName } from '../data/paths'

/** The heading `Text`'s font size, in pixels — large enough to read as a page title next to the muted hint line below it. */
const HEADING_FONT_SIZE = 20

/** The vertical gap between the heading, hint, and button, in pixels — tight enough to read as one group, loose enough not to crowd. */
const CONTENT_SPACING = 12

/** The hint `Text`'s colour — a muted grey so it reads as secondary to the heading. */
const HINT_COLOR = 'rgb(140, 140, 140)'

/**
 * Spacing between the recent-projects heading and each button, in pixels —
 * tighter than `CONTENT_SPACING` since these rows are one repeated group,
 * not distinct page sections.
 */
const RECENT_LIST_SPACING = 6

/** Constructor parameters for {@link WelcomeScreen}. */
export interface WelcomeScreenParams {
  /** Invoked when the Open Folder button is pressed. */
  onOpenFolder: () => void
  /** The recent-projects list to show initially, most-recent first — kept current afterwards via {@link WelcomeScreen.setRecentProjects}. */
  recentProjects: string[]
  /** Invoked with a recent project's root path when its button is pressed. */
  onOpenRecentProject: (path: string) => void
}

/**
 * The editor pane's empty state: shown in place of the tab strip whenever no
 * file is open, covering both "no project folder open" and "project open,
 * no file tabs" with one component — only the heading and hint text differ
 * between them, resolved by {@link welcomeCopy}. Its body is a single
 * centred `VBox` column holding the heading, the hint, the Open Folder
 * button, and (when there is any recent-projects history) a Recent Projects
 * section, in that order.
 */
class WelcomeScreen extends Container {
  private readonly _heading: Text
  private readonly _hint: Text
  private readonly _recentList: Container
  private readonly _onOpenRecentProject: (path: string) => void

  constructor(params: WelcomeScreenParams) {
    const heading = new Text('', { fontSize: HEADING_FONT_SIZE, fontWeight: '600' })
    const hint = new Text('', { foregroundColor: HINT_COLOR })

    const openFolder = Button({
      text: 'Open Folder…',
      glyph: 'folder',
      description: OPEN_FOLDER_SHORTCUT,
    })

    openFolder.on('action', params.onOpenFolder)

    const recentList = Container({ layoutManager: new VBox({ itemAlign: 'center', spacing: RECENT_LIST_SPACING }) })

    super({
      layoutManager: new VBox({ justify: 'center', itemAlign: 'center', spacing: CONTENT_SPACING }),
      backgroundColor: 'var(--ts-ui-input-bg, rgb(255, 255, 255))',
      components: [heading, hint, openFolder, recentList],
    })

    this._heading = heading
    this._hint = hint
    this._recentList = recentList
    this._onOpenRecentProject = params.onOpenRecentProject
    this.applyCopy(null)
    this.setRecentProjects(params.recentProjects)
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

  /**
   * Rebuilds the Recent Projects section from `projects`, most-recent
   * first. The section is omitted entirely when `projects` is empty.
   *
   * @param projects - The recent-projects list, most-recent first.
   */
  setRecentProjects(projects: string[]): void {
    for (const component of this._recentList.getComponents()) {
      component.dispose()
    }

    this._recentList.removeAllComponents()

    if (projects.length > 0) {
      this._recentList.addComponent(new Text('Recent Projects', { foregroundColor: HINT_COLOR }))

      for (const root of projects) {
        const button = Button({ text: projectName(root), glyph: 'folder', compact: true })

        button.on('action', () => this._onOpenRecentProject(root))
        this._recentList.addComponent(button)
      }
    }

    this._recentList.doLayout()
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
