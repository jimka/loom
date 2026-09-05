// The About dialog: a small, dismiss-only modal reached from the far right of
// the menu bar. It names the app, says in one line what it is, who wrote it,
// and where the app and its UI library live on GitHub. Built on
// `DismissDialog` so it matches the app's other modals; the body is a single
// authored Markdown string rendered by the library's read-only Markdown
// component.
import { Markdown } from '@jimka/typescript-ui/component/display'
import { DismissDialog } from './DismissDialog'
import { APP_NAME, APP_TAGLINE } from '../appIdentity'

/**
 * The dialog's fixed width, in pixels. `Dialog` sizes its height to the
 * wrapped content, measured at this width, so the body copy can be natural
 * sentences that wrap rather than hand-broken single lines. 460 matches
 * SQLAdmin's own About dialog: clear of `Dialog`'s 320px floor, a little
 * under its 480px default, and wide enough for the two link lines to sit on
 * one line each.
 */
const DIALOG_WIDTH = 460

/**
 * The dialog body, authored as Markdown and built from the `appIdentity`
 * constants so the name and tagline cannot drift from what the rest of the
 * UI shows. Blank lines between blocks are required — the renderer lexes
 * them as separate paragraphs, and without them the whole body collapses
 * into one.
 */
const ABOUT_MARKDOWN = `# ${APP_NAME}

${APP_TAGLINE}

**Author:** Jimmy Karlsson

**Source:** [github.com/jimka/loom](https://github.com/jimka/loom)

**UI library:** [github.com/jimka/typescript-ui](https://github.com/jimka/typescript-ui)`

/**
 * Opens the modal About dialog. Fire-and-forget: the only outcome is
 * dismissal — the Close button, Escape, a backdrop click, or the title-bar
 * close — so the resolved result is deliberately ignored. The Markdown body
 * needs no explicit teardown: `Dialog.hide` destroys the dialog and the
 * children registered under it, the body among them.
 */
export function openAboutDialog(): void {
    void DismissDialog({
        title: `About ${APP_NAME}`,
        content: Markdown(ABOUT_MARKDOWN),
        width: DIALOG_WIDTH,
    }).show()
}
