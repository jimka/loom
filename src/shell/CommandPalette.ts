import { Event, callable } from '@jimka/typescript-ui/core'
import type { Rect } from '@jimka/typescript-ui/core'
import { DOM } from '@jimka/typescript-ui/core'
import { VBox } from '@jimka/typescript-ui/layout'
import { TextField } from '@jimka/typescript-ui/component/input'
import { List, GlyphListItemRenderer } from '@jimka/typescript-ui/component/list'
import { PopupPanel } from '@jimka/typescript-ui/overlay'
import { filterAndRankFuzzy } from '../data/fuzzyMatch'
import { relativeTo } from '../data/paths'
import { glyphNameForPath } from '../fileIcons'
import type { PaletteCommand } from './commands'

/** The query prefix that switches the palette from file search to command search. */
const COMMAND_MODE_PREFIX = '>'
/** Cap on rendered rows in either mode — bounds scoring/render cost against a large project or command list. */
const MAX_PALETTE_RESULTS = 50
/** The panel's fixed width, in pixels — wide enough that most project-relative paths fit unwrapped. */
const PALETTE_WIDTH_PX = 560
/** The panel's fixed height, in pixels — tall enough to show several results at once. */
const PALETTE_HEIGHT_PX = 400
/** Gap kept between the panel and the top of the viewport, in pixels — clears the menu bar. */
const PALETTE_TOP_OFFSET_PX = 80

/** Constructor parameters for {@link CommandPalette}. */
export interface CommandPaletteParams {
    /** Fires when a file result is activated (Enter or click) in file-search mode. */
    onConfirmFile: (path: string) => void
}

/**
 * The Ctrl/Cmd+P command palette: a floating panel hosting a query field and
 * a results list, fuzzy-matching every file in the open workspace by
 * default, or a fixed list of app commands once the query starts with `>`.
 * Nothing opens or runs while browsing the list — arrow keys only move the
 * highlight — until a result is activated (Enter or click), which fires
 * {@link CommandPaletteParams.onConfirmFile} in file mode or runs the
 * command directly in command mode. Built once and never added as a child
 * component — like every other `Position.FIXED` overlay in the library, it
 * mounts itself directly on `document.documentElement` via the inherited
 * `showAnimated()`.
 */
class CommandPalette extends PopupPanel {
    private readonly _queryField: TextField
    private readonly _resultsList: List
    private readonly _onConfirmFile: (path: string) => void

    private _files: string[] = []
    private _commands: PaletteCommand[] = []
    private _root: string | null = null
    private _mode: 'files' | 'commands' = 'files'

    constructor(params: CommandPaletteParams) {
        const queryField = new TextField({ placeholder: 'Search files, or > for commands' })
        const resultsList = new List({ rendererFactory: () => new GlyphListItemRenderer() })

        resultsList.setSelectFollowsFocus(false)
        resultsList.setFocusOnRowClick(false)

        super({
            layoutManager: new VBox({ spacing: 4, stretching: true }),
            preferredSize: { width: PALETTE_WIDTH_PX, height: PALETTE_HEIGHT_PX },
            // weight: 1 makes the list absorb the panel's leftover height —
            // VBox otherwise sizes each child to its own preferred height,
            // leaving the list only as tall as its rendered rows.
            components: [queryField, { component: resultsList, constraints: { weight: 1 } }],
        })

        this._queryField = queryField
        this._resultsList = resultsList
        this._onConfirmFile = params.onConfirmFile

        Event.addListener(this._queryField, 'input', () => this.renderResults(this._queryField.getValue()))
        Event.addListener(this._queryField, 'keydown', (e: KeyboardEvent) => this.handleKeyDown(e))
        this._resultsList.on('action', () => this.handleCommit())

        this.setCloseHandler(() => this.close())
    }

    /**
     * Opens the palette: resets its query to empty and its mode to file
     * search, records `root` (for relative-path labels), shows the panel
     * centered near the top of the viewport, and focuses the query field.
     *
     * @param files - Every file path in the open workspace, unfiltered.
     * @param commands - The current command list for `>` mode.
     * @param root - The open workspace's root, for relative-path labels, or `null` when none is open.
     */
    open(files: string[], commands: PaletteCommand[], root: string | null): void {
        this._files = files
        this._commands = commands
        this._root = root

        this._queryField.setValue('')
        this.renderResults('')

        const viewport = DOM.source.getViewportSize()
        const x = Math.max(0, (viewport.width - PALETTE_WIDTH_PX) / 2)
        const anchor: Rect = {
            x, y: PALETTE_TOP_OFFSET_PX, width: 0, height: 0,
            top: PALETTE_TOP_OFFSET_PX, bottom: PALETTE_TOP_OFFSET_PX, left: x, right: x,
        }

        this.showAt(anchor)
        this._queryField.focus()
    }

    /**
     * Re-derives the mode from a leading `>` and re-filters/ranks against the
     * matching data source. Never opens a file or runs a command itself —
     * that only happens on explicit activation (see {@link handleCommit}).
     *
     * @param rawQuery - The query field's current raw text, `>` prefix included.
     */
    private renderResults(rawQuery: string): void {
        const isCommandMode = rawQuery.startsWith(COMMAND_MODE_PREFIX)

        this._mode = isCommandMode ? 'commands' : 'files'

        const query = isCommandMode ? rawQuery.slice(COMMAND_MODE_PREFIX.length) : rawQuery

        if (this._mode === 'commands') {
            const matches = query === '' ? this._commands : filterAndRankFuzzy(query, this._commands, c => c.title, MAX_PALETTE_RESULTS)

            this._resultsList.setEmptyText('No matching commands')
            this._resultsList.setItemsArray(matches.map(command => ({
                key: command.id,
                label: command.shortcut ? `${command.title} (${command.shortcut})` : command.title,
            })))

            return
        }

        if (query === '') {
            this._resultsList.setEmptyText('Type to search files')
            this._resultsList.setItemsArray([])

            return
        }

        // Matched against the project-relative label, not the raw absolute
        // path: every file under the same project shares the absolute path's
        // directory prefix (the user's home directory, the project folder's
        // own name), so matching the absolute path lets a short query match
        // almost every file through that shared prefix instead of the file's
        // own name — confirmed live against a real project during manual
        // verification (see the plan's Implementation Notes).
        const matches = filterAndRankFuzzy(query, this._files, path => this.displayLabel(path), MAX_PALETTE_RESULTS)

        this._resultsList.setEmptyText('No matching files')
        this._resultsList.setItemsArray(matches.map(path => ({
            key: path,
            label: this.displayLabel(path),
            glyph: glyphNameForPath(path),
        })))
    }

    /**
     * `path` rewritten relative to the open workspace, for both display and
     * fuzzy matching — falls back to the full path when no workspace is open
     * (never the case in practice: file mode's `_files` is only ever
     * populated when a workspace is open) or `path` somehow sits outside it.
     *
     * @param path - An absolute file path from {@link _files}.
     * @returns The label to show and match against.
     */
    private displayLabel(path: string): string {
        return this._root !== null ? (relativeTo(this._root, path) ?? path) : path
    }

    /**
     * Forwards ArrowUp/ArrowDown/Enter into the list's keyboard reducer —
     * navigation only moves the highlight; Enter commits through the list's
     * `"action"` event (see {@link handleCommit}).
     *
     * @param e - The query field's keydown event.
     */
    private handleKeyDown(e: KeyboardEvent): void {
        const isNavKey = e.key === 'ArrowDown' || e.key === 'ArrowUp'
        const isCommitKey = e.key === 'Enter'

        if (!isNavKey && !isCommitKey) {
            return
        }

        if (this._resultsList.handleKey(e)) {
            e.preventDefault()
        }
    }

    /** The list's `"action"` event — Enter or a row click. Activates a file or runs a command, then closes. */
    private handleCommit(): void {
        const key = this._resultsList.getValue()

        if (key === '') {
            return
        }

        if (this._mode === 'files') {
            this._onConfirmFile(key)
        } else {
            this._commands.find(command => command.id === key)?.run()
        }

        this.close()
    }

    /** Hides the panel. Nothing else was ever opened or run while it was showing, so there is nothing to undo. */
    private close(): void {
        this.hideAnimated()
    }
}

const CommandPaletteCallable = callable(CommandPalette)
type CommandPaletteCallable = CommandPalette
export { CommandPaletteCallable as CommandPalette }
