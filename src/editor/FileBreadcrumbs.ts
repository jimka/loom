import { Container, callable } from '@jimka/typescript-ui/core'
import type { Component } from '@jimka/typescript-ui/core'
import { Insets } from '@jimka/typescript-ui/primitive'
import { HBox } from '@jimka/typescript-ui/layout'
import { IconText } from '@jimka/typescript-ui/component/display'
import { STATUS_BAR_HEIGHT } from '@jimka/typescript-ui/component/container'
import { pathSegments, relativeTo } from '../data/paths'

/** Written between segments. U+203A, matching the `•`/`—` chrome characters the
 *  window title and tab labels already use, so no new glyph registration is
 *  needed in `src/main.ts`. */
const SEGMENT_SEPARATOR = ' › '

/** The glyph leading the trail — fixed, not resolved per file type (see the
 *  plan's Non-Goals). `file-code` is already registered: `src/fileIcons.ts`
 *  maps the `json`/`xml` extensions to it, so it rides into `main.ts`'s
 *  `Glyph.register(...FILE_ICON_GLYPHS)` call without a registration of its
 *  own here. */
const TRAIL_GLYPH = 'file-code'

/** Horizontal inset, in pixels. Mirrors the library `StatusBar`'s own
 *  `Insets(0, 6, 0, 6)` so Loom's two chrome strips indent their text
 *  identically. */
const BAND_PAD = 6

/** Band fill. The `StatusBar` token, whose fallback is the shipped themes'
 *  own value and the same grey `FileTree` paints. */
const BAND_BACKGROUND = 'var(--ts-ui-statusbar-bg, rgb(245, 245, 245))'

/** Trail text and glyph colour — the `StatusBar` token, fallback as shipped. */
const BAND_FOREGROUND = 'var(--ts-ui-statusbar-color, rgb(60, 60, 60))'

/** Constructor parameters for {@link FileBreadcrumbs}. */
export interface FileBreadcrumbsParams {
    /** The file's absolute path on disk, or `null` for a buffer never yet saved. */
    path: string | null
    /** The buffer's display name (e.g. `"Untitled-1"`), shown in place of a
     *  path trail while {@link path} is `null`. */
    name: string
    /** The open project folder, or `null` when none is open. */
    projectRoot: string | null
}

/**
 * The path band mounted above a `FileEditor`'s `CodeEditor`: a file glyph
 * followed by the open file's path, shortened against the open project
 * folder and joined with `SEGMENT_SEPARATOR`. Non-interactive — clicking a
 * segment does nothing.
 */
class FileBreadcrumbs extends Container {
    private _path: string | null
    private _name: string
    private _projectRoot: string | null
    private readonly _trail: IconText
    private _action: Component | null = null

    constructor(params: FileBreadcrumbsParams) {
        const trail = new IconText(TRAIL_GLYPH, '')

        super({
            layoutManager: new HBox({ itemAlign: 'center' }),
            components: [{ component: trail, constraints: { weight: 1 } }],
            insets: new Insets(0, BAND_PAD, 0, BAND_PAD),
            minSize: { width: 0, height: STATUS_BAR_HEIGHT },
            preferredSize: { width: 0, height: STATUS_BAR_HEIGHT },
            backgroundColor: BAND_BACKGROUND,
            foregroundColor: BAND_FOREGROUND,
        })

        this._path = params.path
        this._name = params.name
        this._projectRoot = params.projectRoot
        this._trail = trail

        this.updateTrail()
    }

    /** Repoints the band at a new path and redraws the trail. */
    setPath(path: string): void {
        this._path = path

        this.updateTrail()
    }

    /** Repoints the band at a new project folder and redraws the trail. */
    setProjectRoot(root: string | null): void {
        this._projectRoot = root

        this.updateTrail()
    }

    /**
     * Puts `component` at the right end of the band, replacing whatever was
     * there, or clears the slot when passed `null`.
     *
     * @param component - The trailing widget, or `null` to leave the slot empty.
     */
    setAction(component: Component | null): void {
        if (this._action !== null) {
            this.removeComponent(this._action)
        }

        this._action = component

        if (this._action !== null) {
            this.addComponent(this._action)
        }
    }

    /**
     * Redraws the trail from the current path/root — the file's display name
     * while it has never been saved ({@link _path} is `null`), otherwise its
     * path shortened against {@link _projectRoot} when it sits below it, and
     * shown in full when it doesn't. Named `updateTrail`, not `render`, since
     * `Component` already reserves `render()` for its own DOM-materialisation
     * lifecycle method.
     */
    private updateTrail(): void {
        if (this._path === null) {
            this._trail.setText(this._name)

            return
        }

        const shown = relativeTo(this._projectRoot, this._path) ?? this._path

        this._trail.setText(pathSegments(shown).join(SEGMENT_SEPARATOR))
    }
}

const FileBreadcrumbsCallable = callable(FileBreadcrumbs)
type FileBreadcrumbsCallable = FileBreadcrumbs
export { FileBreadcrumbsCallable as FileBreadcrumbs }
