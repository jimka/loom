// The About dialog: a small, dismiss-only modal reached from the far right of
// the menu bar. It shows the Loom mark, says in one line what the app is, who
// wrote it, and where the app and its UI library live on GitHub. Built on
// `DismissDialog` so it matches the app's other modals; the body stacks the
// centred mark above a Markdown block carrying the rest of the copy.
import { Markdown, Image } from '@jimka/typescript-ui/component/display'
import { Container } from '@jimka/typescript-ui/core'
import { Spacer } from '@jimka/typescript-ui/component/container'
import { Fit, HBox, VBox } from '@jimka/typescript-ui/layout'
import { DismissDialog } from './DismissDialog'
import { APP_NAME, APP_TAGLINE, APP_FAVICON } from '../appIdentity'

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
 * The mark's rendered edge length in the About dialog, in pixels — the same
 * size `WelcomeScreen.ts` uses for its own mark, so Loom's identity mark
 * reads at one consistent size wherever it appears.
 */
const MARK_SIZE_PX = 80

/**
 * The mark's locked display size, passed as `preferredSize`, `minSize` and
 * `maxSize` alike. See `WelcomeScreen.ts`'s identical constant for why all
 * three are required: `Image.getPreferredSize()` reports the artwork's
 * natural 240×240 size and ignores the `preferredSize` constraint, so only
 * the min/max pair actually clamps the rendered size.
 */
const MARK_SIZE = { width: MARK_SIZE_PX, height: MARK_SIZE_PX }

/**
 * The gap between the mark and the text block below it, in pixels — enough
 * to read as two distinct groups without leaving a gap wider than the text's
 * own line spacing.
 */
const MARK_SPACING = 12

/**
 * The dialog's text content, authored as Markdown and built from the
 * `appIdentity` constants so the tagline cannot drift from what the rest of
 * the UI shows. Carries no "Loom" heading: the dialog's own title bar already
 * reads "About Loom" immediately above this body, and the mark above it
 * carries the identity moment, so repeating the name here would be pure
 * redundancy. Blank lines between blocks are required — the renderer lexes
 * them as separate paragraphs, and without them the whole body collapses
 * into one.
 */
const ABOUT_MARKDOWN = `${APP_TAGLINE}

**Author:** Jimmy Karlsson

**Source:** [github.com/jimka/loom](https://github.com/jimka/loom)

**UI library:** [github.com/jimka/typescript-ui](https://github.com/jimka/typescript-ui)`

/**
 * Opens the modal About dialog. Fire-and-forget: the only outcome is
 * dismissal — the Close button, Escape, a backdrop click, or the title-bar
 * close — so the resolved result is deliberately ignored. The body needs no
 * explicit teardown: `Dialog.hide` destroys the dialog and the children
 * registered under it, the mark and Markdown block among them.
 */
export function openAboutDialog(): void {
    const mark = Image(APP_FAVICON, { preferredSize: MARK_SIZE, minSize: MARK_SIZE, maxSize: MARK_SIZE })

    // Forces the `<img>` element into existence right away. `Dialog` measures
    // its content's height synchronously in its own constructor, before the
    // dialog — and this mark along with it — is ever attached to the
    // document, and `Image.getPreferredSize` reads the element's natural size
    // unconditionally, with no fallback for "not rendered yet". Left
    // unrendered, that measurement throws instead of using the `preferredSize`
    // above; rendering it up front here gives that measurement an element to
    // read.
    mark.getElement(true)

    // `Image.getPreferredSize` ignores `mark`'s own `preferredSize` (and its
    // `minSize`/`maxSize` clamp, which only takes effect once the dialog
    // actually lays the mark out) and always reports the artwork's raw
    // 240×240 natural size — confirmed straight from
    // `@jimka/typescript-ui`'s source, and at odds with that option's own
    // documented contract. Wrapping `mark` in a `Fit`-managed slot with an
    // explicit `preferredSize` hides that raw 240 from everything upstream:
    // the slot's own `getPreferredSize` returns the explicit 80×80 directly,
    // without recursing into `Fit` (and so never into `mark`) for a size.
    // Skipping this slot broke in two different ways, both traced back to
    // that same raw 240: `Dialog` measures the whole content tree's preferred
    // size once, synchronously, before the dialog is ever shown — reserving
    // its height as if the mark were 240px tall, not 80 — and the flex row
    // below split its *leftover* width on the assumption the mark needed
    // 240px, not 80, leaving it off-centre with a dead gap on one side.
    const markSlot = Container({ layoutManager: Fit(), components: [mark], preferredSize: MARK_SIZE })

    // Two equal-weight flex spacers, rather than the outer VBox's own
    // `itemAlign: 'center'`: that alignment is shared by every child in the
    // VBox, and the Markdown block below needs the opposite — full width, not
    // centred at its own natural size. Flanking `markSlot` with spacers that
    // absorb the row's leftover space evenly keeps it centred, while the row
    // itself stays free to stretch to the dialog's full width under the outer
    // VBox's `stretch` alignment (a single centred child would report the
    // *row's* own max size as 80×80 too, capping it at 80px before `stretch`
    // ever gets to grow it — flex spacers report an unbounded max of their
    // own, so the row's aggregate stays unbounded no matter how narrow
    // `markSlot` is).
    const markRow = Container({
        layoutManager: new HBox(),
        components: [Spacer.flex(), markSlot, Spacer.flex()],
    })

    const body = Container({
        layoutManager: new VBox({ itemAlign: 'stretch', spacing: MARK_SPACING }),
        components: [markRow, Markdown(ABOUT_MARKDOWN)],
    })

    void DismissDialog({
        title: `About ${APP_NAME}`,
        content: body,
        width: DIALOG_WIDTH,
    }).show()
}
