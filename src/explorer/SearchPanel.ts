import { Container, Event, callable } from '@jimka/typescript-ui/core'
import { Insets } from '@jimka/typescript-ui/primitive'
import { VBox } from '@jimka/typescript-ui/layout'
import { TextField, Text } from '@jimka/typescript-ui/component/input'
import { Tree, IconLabelTreeNodeRenderer } from '@jimka/typescript-ui/component/tree'
import type { TreeNode } from '@jimka/typescript-ui/component/tree'
import { searchFiles } from '../data/projectSearch'
import type { SearchMatch, SearchLimits, ReadFileText } from '../data/projectSearch'
import { glyphNameForPath } from '../fileIcons'
import { searchResultNodes, searchSummaryText } from './searchResults'
import type { SearchTreeNodeData, SearchStatus } from './searchResults'

/** The ceilings a run stops at. `maxMatches` is four times
 *  `CommandPalette.MAX_PALETTE_RESULTS` (50): `Tree` is virtualised, so this
 *  ceiling no longer exists to bound rendered row components the way it did
 *  against the old flat `List` — it is kept at its current value regardless
 *  (see the plan's `## Architecture Decisions`). `maxFiles` is the read
 *  ceiling: `readFileText` costs two IPC round trips per file, so a folder
 *  larger than this stops being a search and starts feeling like a hang. */
const SEARCH_LIMITS: SearchLimits = { maxMatches: 200, maxFiles: 2000 }

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
    /** Fires when a match leaf is selected (click or arrow-key move) — previews it in a temporary tab. */
    onOpenMatch: (match: SearchMatch) => void
    /** Fires when a match leaf is double-clicked — opens and reveals it for keeps, in a permanent tab. */
    onCommitMatch: (match: SearchMatch) => void
    /** Fires when a file branch row is double-clicked, with no specific match location — opens it for keeps, in a permanent tab. */
    onCommitFile: (path: string) => void
    /** The open project folder, or `null` when none is open — result labels are shown relative to it. */
    projectRoot: string | null
}

/**
 * The explorer sidebar's Search view: a query field over a results `Tree`
 * over a status line. Enter runs a case-insensitive substring search over
 * every file {@link SearchPanelParams.listFiles} returns, streaming matches
 * into the tree as each file is read.
 *
 * A match leaf mirrors `FileTree`'s own two-tier convention: selecting it
 * (click or arrow-key move) previews it via {@link SearchPanelParams.onOpenMatch}
 * (a temporary tab), double-clicking it commits via
 * {@link SearchPanelParams.onCommitMatch} (a permanent tab). A file branch row
 * does *not* preview on select — only {@link SearchPanelParams.onCommitFile}
 * (double-click) opens it. `expandTrigger: 'click'` makes a file row's own
 * matches expand/collapse on the same plain click that would otherwise
 * preview it, and a file not yet open pays a real disk read to do that; firing
 * a preview open on every expand/collapse made browsing a file's matches feel
 * like it hung. A folder row has no such conflict (nothing to preview) and
 * keeps click-to-toggle as its only behaviour.
 *
 * A run is cancelled by the run that replaces it, by {@link setProjectRoot},
 * or by this component being torn down — never by an explicit Stop control.
 */
class SearchPanel extends Container {
    private readonly _queryField: TextField
    private readonly _resultsTree: Tree
    private readonly _statusText: Text
    private readonly _listFiles: () => Promise<string[]>
    private readonly _readText: ReadFileText
    private readonly _onOpenMatch: (match: SearchMatch) => void
    private readonly _onCommitMatch: (match: SearchMatch) => void
    private readonly _onCommitFile: (path: string) => void

    private _matches: SearchMatch[] = []
    private _root: string | null
    /** Bumped on every new search and on a project-root change; a run's
     *  callbacks compare against the value they captured at their own start
     *  to tell whether a later run has since superseded them. */
    private _runId = 0
    /** Set while a coalesced tree rebuild is scheduled for the next frame —
     *  see {@link appendMatches}. `null` when no rebuild is pending. */
    private _pendingFlush: number | null = null

    constructor(params: SearchPanelParams) {
        const queryField = new TextField({ placeholder: QUERY_PLACEHOLDER })
        // expandTrigger: 'click' matches FileTree's own convention — the
        // library default is 'dblclick', which would leave a single click on
        // a folder branch doing nothing (selecting it, not expanding it).
        // backgroundColor is transparent, not FileTree's grey: the panel's own
        // background (below) now covers the whole view — query field and
        // status text included — so the tree doesn't paint a second,
        // independently-edged surface over just its own rows.
        const resultsTree = new Tree({ rowOverflow: 'scroll', expandTrigger: 'click', backgroundColor: 'transparent' })
        const statusText = new Text('', { truncate: true, foregroundColor: STATUS_COLOR })

        resultsTree.setRendererFactory(() => new IconLabelTreeNodeRenderer(node => {
            const data = node.data as SearchTreeNodeData

            return data.kind === 'folder' ? 'folder' : glyphNameForPath(data.kind === 'file' ? data.path : data.match.path)
        }))

        super({
            layoutManager: new VBox({ spacing: 4, stretching: true }),
            insets: new Insets(PANEL_PAD, PANEL_PAD, PANEL_PAD, PANEL_PAD),
            // statusText sits directly under the query field rather than
            // under the tree: pinned there it never rides next to the tree's
            // own scrollbar, which crowded it when results overflowed.
            // weight: 1 makes the tree absorb the panel's leftover height,
            // the same role it plays in CommandPalette's own VBox.
            components: [queryField, statusText, { component: resultsTree, constraints: { weight: 1 } }],
            // backgroundColor matches FileTree's own tree — both rail views
            // should read as the same surface — applied to the whole panel
            // rather than just resultsTree so the query field and status
            // text share it too, instead of sitting on a visible seam.
            // The border isn't drawn by FileTree itself either — it's
            // Accordion's own themed all-around container border. This is the
            // same token (and fallback), applied here directly, so the two
            // rail views frame themselves identically.
            backgroundColor: 'rgb(245, 245, 245)',
            border: 'var(--ts-ui-accordion-border, 1px solid rgb(214,217,222))',
        })

        this._queryField = queryField
        this._resultsTree = resultsTree
        this._statusText = statusText
        this._listFiles = params.listFiles
        this._readText = params.readText
        this._onOpenMatch = params.onOpenMatch
        this._onCommitMatch = params.onCommitMatch
        this._onCommitFile = params.onCommitFile
        this._root = params.projectRoot

        this.paintStatus(IDLE_STATUS)

        Event.addListener(this._queryField, 'keydown', (e: KeyboardEvent) => this.handleKeyDown(e))
        this._resultsTree.on('selection', this.handleSelection)
        this._resultsTree.on('dblclick', this.handleDblClick)
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
     * Runs a new search on Enter. `Tree` wires its own keyboard handling
     * directly with no public hook to forward arrow keys into the way
     * `List.handleKey` allowed (see the plan's `## Architecture Decisions`),
     * so this no longer has an ArrowUp/ArrowDown branch.
     *
     * @param e - The query field's keydown event.
     */
    private handleKeyDown(e: KeyboardEvent): void {
        if (e.key === 'Enter') {
            e.preventDefault()
            void this.runSearch()
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

        // Forces the last frame's coalesced batches onto the tree now, rather
        // than leaving them for whatever frame the pending rAF lands on — the
        // status line below must not report a match count the tree hasn't
        // caught up to yet.
        this.flushResults()

        this.paintStatus({
            phase: outcome.completion, matchCount: outcome.matchCount,
            fileCount: outcome.fileCount, filesSearched: outcome.filesSearched,
        })
    }

    /**
     * Appends one file's matches to {@link _matches} and schedules a tree
     * rebuild, coalesced to at most once per frame via {@link flushResults} —
     * see the plan's `## Architecture Decisions` for why a full rebuild plus
     * `expandAll()` replaces the old list's incremental append. Rebuilding on
     * every single batch made a broad query that touches many distinct files
     * visibly stall: `searchResultNodes` re-groups and re-sorts the whole
     * accumulated match set from scratch each time, so per-batch cost grows
     * with every match already appended, and the total cost across a run
     * grows quadratically with the number of matching files. Coalescing
     * batches that land within the same frame keeps the rebuild count tied to
     * elapsed time instead of file count, without losing the progressive
     * streamed-in feel — most frames still get at least one rebuild.
     *
     * @param batch - One file's matches, never empty.
     */
    private appendMatches(batch: SearchMatch[]): void {
        this._matches = [...this._matches, ...batch]

        if (this._pendingFlush === null) {
            this._pendingFlush = requestAnimationFrame(() => {
                this._pendingFlush = null
                this.flushResults()
            })
        }
    }

    /** Rebuilds the results tree from {@link _matches} right now, cancelling
     *  any frame-coalesced rebuild {@link appendMatches} still had pending. */
    private flushResults(): void {
        this.cancelPendingFlush()
        this._resultsTree.setNodes(searchResultNodes(this._matches, this._root))
        this._resultsTree.expandAll()
    }

    /** Cancels a rebuild {@link appendMatches} scheduled for the next frame, if any. */
    private cancelPendingFlush(): void {
        if (this._pendingFlush !== null) {
            cancelAnimationFrame(this._pendingFlush)
            this._pendingFlush = null
        }
    }

    /** Empties the matches and the tree — shared by {@link runSearch} and {@link setProjectRoot}. */
    private clearResults(): void {
        this.cancelPendingFlush()
        this._matches = []
        this._resultsTree.setNodes([])
    }

    /**
     * The tree's `"selection"` event — a click or an arrow-key move. Only a
     * match leaf opens and reveals anything; a file or folder branch (or an
     * empty selection) does nothing — selecting a file branch just moves the
     * tree's own highlight, deliberately not previewing it (see the class
     * doc comment: that click already toggles the file's matches open or
     * closed, and firing a preview open on the same click made expand/collapse
     * feel like it hung on a file not yet open).
     *
     * @param nodes - The tree's current selection, empty when cleared.
     */
    private readonly handleSelection = (nodes: TreeNode[]): void => {
        const data = nodes[0]?.data as SearchTreeNodeData | undefined

        if (data?.kind === 'match') {
            this._onOpenMatch(data.match)
        }
    }

    /**
     * The tree's `"dblclick"` event — commits a match or a file branch to a
     * permanent tab; a file branch has no other way to open at all now that
     * {@link handleSelection} no longer previews it on a plain select. A
     * folder branch double-click does nothing beyond whatever `Tree` itself
     * already did with `expandTrigger: 'click'` (nothing, since that trigger
     * is `'click'` here, not `'dblclick'`).
     *
     * @param node - The double-clicked node.
     */
    private readonly handleDblClick = (node: TreeNode): void => {
        const data = node.data as SearchTreeNodeData | undefined

        if (data?.kind === 'match') {
            this._onCommitMatch(data.match)
        } else if (data?.kind === 'file') {
            this._onCommitFile(data.path)
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

    /** Bumps {@link _runId} and cancels a pending frame-coalesced rebuild
     *  before tearing down, so a walk (or a scheduled {@link flushResults})
     *  in flight stops reporting into a torn-down panel — the shape
     *  `FileEditor.destructor` uses for its own pending preview refresh. */
    protected destructor(): void {
        this._runId += 1
        this.cancelPendingFlush()
        super.destructor()
    }
}

const SearchPanelCallable = callable(SearchPanel)
type SearchPanelCallable = SearchPanel
export { SearchPanelCallable as SearchPanel }
