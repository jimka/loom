import { Container, Event, callable } from '@jimka/typescript-ui/core'
import { Insets } from '@jimka/typescript-ui/primitive'
import { VBox } from '@jimka/typescript-ui/layout'
import { TextField, Text } from '@jimka/typescript-ui/component/input'
import { List, GlyphListItemRenderer } from '@jimka/typescript-ui/component/list'
import { searchFiles } from '../data/projectSearch'
import type { SearchMatch, SearchLimits, ReadFileText } from '../data/projectSearch'
import { searchResultRow, searchSummaryText } from './searchResults'
import type { SearchResultRow, SearchStatus } from './searchResults'

/** The ceilings a run stops at. `maxMatches` is four times
 *  `CommandPalette.MAX_PALETTE_RESULTS` (50): `List` renders every row (it is
 *  not virtualised the way `Tree` is), so this is what stops a broad query
 *  from building thousands of row components in a sidebar, while a popup is
 *  scanned by eye rather than scrolled and can afford fewer. `maxFiles` is
 *  the read ceiling: `readFileText` costs two IPC round trips per file, so a
 *  folder larger than this stops being a search and starts feeling like a
 *  hang. */
const SEARCH_LIMITS: SearchLimits = { maxMatches: 200, maxFiles: 2000 }

/** The panel's fixed height, in pixels — the query field, ten 22px `List`
 *  rows, and the status line. The section carries no accordion weight, so
 *  this is the height it keeps while the tree absorbs the sidebar's leftover
 *  space. */
const PANEL_HEIGHT_PX = 280

/** Padding around the panel's content, in pixels. Matches `PropertiesPanel`'s
 *  own `PANEL_PAD` so the sidebar's sections indent their content by one
 *  consistent amount. */
const PANEL_PAD = 6

/** The status line's colour — the same muted grey `PropertiesPanel` and
 *  `WelcomeScreen` paint their own hint lines. */
const STATUS_COLOR = 'rgb(140, 140, 140)'

/** The query field's placeholder text — names the Enter-to-run gesture, since there is no search-as-you-type. */
const QUERY_PLACEHOLDER = 'Search project (Enter)'

/** An idle run's status, shared by construction and {@link SearchPanel.setProjectRoot}. */
const IDLE_STATUS: SearchStatus = { phase: 'idle', matchCount: 0, fileCount: 0, filesSearched: 0 }

/** Constructor parameters for {@link SearchPanel}. */
export interface SearchPanelParams {
    /** Every searchable file path in the open workspace, in walk order; resolves empty when no project is open. */
    listFiles: () => Promise<string[]>
    /** Reads one file as text; rejects for an unreadable or over-sized file. */
    readText: ReadFileText
    /** Fires when a result row is activated (Enter or a click). */
    onOpenMatch: (match: SearchMatch) => void
    /** The open project folder, or `null` when none is open — result labels are shown relative to it. */
    projectRoot: string | null
}

/**
 * The explorer sidebar's third section: a query field over a results `List`
 * over a status line. Enter runs a case-insensitive substring search over
 * every file {@link SearchPanelParams.listFiles} returns, streaming matches
 * into the list as each file is read; activating a result (Enter or a
 * click) hands the match to {@link SearchPanelParams.onOpenMatch}. A run is
 * cancelled by the run that replaces it, by {@link setProjectRoot}, or by
 * this component being torn down — never by an explicit Stop control.
 */
class SearchPanel extends Container {
    private readonly _queryField: TextField
    private readonly _resultsList: List
    private readonly _statusText: Text
    private readonly _listFiles: () => Promise<string[]>
    private readonly _readText: ReadFileText
    private readonly _onOpenMatch: (match: SearchMatch) => void

    private _matches: SearchMatch[] = []
    /** Index-aligned with {@link _matches}. */
    private _rows: SearchResultRow[] = []
    private _root: string | null
    /** Bumped on every new search and on a project-root change; a run's
     *  callbacks compare against the value they captured at their own start
     *  to tell whether a later run has since superseded them. */
    private _runId = 0

    constructor(params: SearchPanelParams) {
        const queryField = new TextField({ placeholder: QUERY_PLACEHOLDER })
        const resultsList = new List({ rendererFactory: () => new GlyphListItemRenderer() })
        const statusText = new Text('', { truncate: true, foregroundColor: STATUS_COLOR })

        resultsList.setSelectFollowsFocus(false)

        super({
            layoutManager: new VBox({ spacing: 4, stretching: true }),
            insets: new Insets(PANEL_PAD, PANEL_PAD, PANEL_PAD, PANEL_PAD),
            preferredSize: { width: 0, height: PANEL_HEIGHT_PX },
            // weight: 1 makes the list absorb the panel's leftover height,
            // the same role it plays in CommandPalette's own VBox.
            components: [queryField, { component: resultsList, constraints: { weight: 1 } }, statusText],
        })

        this._queryField = queryField
        this._resultsList = resultsList
        this._statusText = statusText
        this._listFiles = params.listFiles
        this._readText = params.readText
        this._onOpenMatch = params.onOpenMatch
        this._root = params.projectRoot

        this.paintStatus(IDLE_STATUS)

        Event.addListener(this._queryField, 'keydown', (e: KeyboardEvent) => this.handleKeyDown(e))
        this._resultsList.on('action', () => this.handleActivateRow())
    }

    /** Repoints the panel at a new project folder, cancelling any run and clearing the results. */
    setProjectRoot(root: string | null): void {
        this._runId += 1
        this._root = root
        this._queryField.setValue('')
        this.clearResults()
        this.paintStatus(IDLE_STATUS)
    }

    /** Moves focus into the query field and selects whatever is in it — so
     *  re-invoking the command replaces the previous query. Deferred to
     *  `onFirstLayout`: the section's content may not be laid out yet on the
     *  tick it is opened. */
    focusQuery(): void {
        this._queryField.onFirstLayout(() => {
            this._queryField.focus()
            this._queryField.select()
        })
    }

    /**
     * Forwards ArrowUp/ArrowDown into the list's keyboard reducer, and runs a
     * new search on Enter — CommandPalette.handleKeyDown's shape, with Enter
     * re-pointed at the search instead of at a commit.
     *
     * @param e - The query field's keydown event.
     */
    private handleKeyDown(e: KeyboardEvent): void {
        if (e.key === 'Enter') {
            e.preventDefault()
            void this.runSearch()

            return
        }

        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
            return
        }

        if (this._resultsList.handleKey(e)) {
            e.preventDefault()
        }
    }

    /**
     * Runs a fresh search for the query field's current text, superseding
     * any run already in flight. An empty query clears the results and goes
     * back to idle without touching disk. A run whose outcome comes back
     * `'cancelled'`, or that finishes after a later run has already started,
     * paints nothing — the run that superseded it owns the panel now.
     */
    private async runSearch(): Promise<void> {
        const query = this._queryField.getValue()

        this._runId += 1

        const runId = this._runId

        this.clearResults()

        if (query === '') {
            this.paintStatus(IDLE_STATUS)

            return
        }

        this.paintStatus({ phase: 'running', matchCount: 0, fileCount: 0, filesSearched: 0 })

        let files: string[]

        try {
            files = await this._listFiles()
        } catch {
            if (this._runId === runId) {
                this.paintStatus({ phase: 'failed', matchCount: 0, fileCount: 0, filesSearched: 0 })
            }

            return
        }

        const outcome = await searchFiles(
            files, query, this._readText,
            batch => this.appendMatches(batch),
            () => this._runId !== runId,
            SEARCH_LIMITS,
        )

        if (outcome.completion === 'cancelled' || this._runId !== runId) {
            return
        }

        this.paintStatus({
            phase: outcome.completion, matchCount: outcome.matchCount,
            fileCount: outcome.fileCount, filesSearched: outcome.filesSearched,
        })
    }

    /**
     * Appends one file's matches to the results list, highlighting the first
     * row only when the list was previously empty — so a later streamed
     * batch never yanks the highlight back while the user is arrowing
     * through results.
     *
     * @param batch - One file's matches, never empty.
     */
    private appendMatches(batch: SearchMatch[]): void {
        const wasEmpty = this._matches.length === 0

        this._matches = [...this._matches, ...batch]
        this._rows = [...this._rows, ...batch.map(match => searchResultRow(match, this._root))]
        this._resultsList.setItemsArray(this._rows)

        if (wasEmpty) {
            this._resultsList.setFocusedIndex(0)
        }
    }

    /** Empties the matches, the rows, and the list — shared by {@link runSearch} and {@link setProjectRoot}. */
    private clearResults(): void {
        this._matches = []
        this._rows = []
        this._resultsList.setItemsArray(this._rows)
    }

    /** The list's `"action"` event — Enter or a row click. Resolves the activated row back to its match and hands it to {@link _onOpenMatch}. */
    private handleActivateRow(): void {
        const key = this._resultsList.getValue()
        const index = this._rows.findIndex(row => row.key === key)

        if (index !== -1) {
            this._onOpenMatch(this._matches[index])
        }
    }

    /**
     * Writes `status`'s text into the status line — the only place that ever
     * calls `setText` on it.
     *
     * @param status - What the status line should now describe.
     */
    private paintStatus(status: SearchStatus): void {
        this._statusText.setText(searchSummaryText(status))
    }

    /** Bumps {@link _runId} before tearing down, so a walk in flight stops
     *  reporting into a torn-down panel — the shape `FileEditor.destructor`
     *  uses for its own pending preview refresh. */
    protected destructor(): void {
        this._runId += 1
        super.destructor()
    }
}

const SearchPanelCallable = callable(SearchPanel)
type SearchPanelCallable = SearchPanel
export { SearchPanelCallable as SearchPanel }
