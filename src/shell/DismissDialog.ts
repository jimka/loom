// A dismiss-only information modal: a padded content wrapper around the
// caller's body, a title bar, and a footer that ends in Close. The base owns
// the padded wrapper (a single 16px inset on all four sides) so every caller
// gets identical padding without declaring its own.
//
// The content must never set its own `autoScroll`: `Dialog`'s own content
// container already wraps whatever `contentComponent` it is handed in a Panel
// with `autoScroll: 'y'`, so a second one nests one scroll region inside
// another and the dialog shows two scrollbars.
import { Dialog, DialogButtons } from '@jimka/typescript-ui/overlay'
import { Panel, callable } from '@jimka/typescript-ui/core'
import type { Component } from '@jimka/typescript-ui/core'
import { VBox } from '@jimka/typescript-ui/layout'
import { Insets } from '@jimka/typescript-ui/primitive'

/**
 * The content's padding inset, in pixels — the same value on all four sides,
 * declared once here so no caller writes its own and dismiss-only dialogs
 * cannot drift apart in padding.
 */
const CONTENT_PAD = 16

/** Construction inputs for {@link DismissDialog}. */
export interface DismissDialogOptions {
    /** Title-bar text. */
    title: string
    /** The dialog body. Mounted inside the padded content wrapper this class owns. */
    content: Component
    /** Dialog panel width in pixels. */
    width: number
}

/**
 * A dismiss-only information modal. Wraps `options.content` in a padded
 * `Panel` before handing it to `Dialog` as `contentComponent`, so callers
 * never build that wrapper themselves.
 */
class DismissDialog extends Dialog {
    /**
     * @param options - The dialog's title, body, and width.
     */
    constructor(options: DismissDialogOptions) {
        const body = Panel({
            // Stretch the content to the dialog's content width so it has a
            // concrete width to wrap and self-measure within.
            layoutManager: new VBox({ itemAlign: 'stretch' }),
            insets: new Insets(CONTENT_PAD, CONTENT_PAD, CONTENT_PAD, CONTENT_PAD),
            components: [options.content],
        })

        super({
            title: options.title,
            contentComponent: body,
            buttons: [DialogButtons.Close],
            width: options.width,
            closeOnBackdrop: true,
        })
    }
}

const DismissDialogCallable = callable(DismissDialog)
type DismissDialogCallable = DismissDialog
export { DismissDialogCallable as DismissDialog }
