import { Container, Event, callable } from '@jimka/typescript-ui/core'
import { Insets } from '@jimka/typescript-ui/primitive'
import { VBox, HBox } from '@jimka/typescript-ui/layout'
import { TextField, Text, Checkbox } from '@jimka/typescript-ui/component/input'
import { Button } from '@jimka/typescript-ui/component/button'
import { Tree, IconLabelTreeNodeRenderer } from '@jimka/typescript-ui/component/tree'
import type { TreeNode } from '@jimka/typescript-ui/component/tree'
import { Menu, Notification } from '@jimka/typescript-ui/overlay'
import { searchFiles, compileQuery } from '../data/projectSearch'
import type { SearchMatch, SearchLimits, ReadFileText, SearchQuery, CompiledQuery } from '../data/projectSearch'
import { glyphNameForPath } from '../fileIcons'
import { searchResultNodes, searchSummaryText, pluralize } from './searchResults'
import type { SearchTreeNodeData, SearchStatus } from './searchResults'
import { confirmReplaceAll } from './searchReplacePrompt'

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

/** The *match case* toggle's label — `@codemirror/search`'s own in-file find
 *  panel names its checkbox this, copied verbatim so the two panels name the
 *  same toggle the same way. */
const MATCH_CASE_LABEL = 'match case'

/** The *regexp* toggle's label — `@codemirror/search`'s own in-file find panel's name for it. */
const REGEXP_LABEL = 'regexp'

/** The gap between the *match case* and *regexp* checkboxes, in pixels —
 *  wider than the panel's own 4px `VBox` spacing so the two labels read as
 *  two controls rather than one run of text. */
const TOGGLE_SPACING = 8

/** The Replace field's placeholder — `@codemirror/search`'s own in-file
 *  replace-field placeholder, copied verbatim. */
const REPLACE_PLACEHOLDER = 'Replace'

/** The panel's own Replace All button's label. */
const REPLACE_ALL_LABEL = 'Replace All'

/** The glyph shared by the Replace All button and the results tree's
 *  per-match/per-file Replace context-menu items. */
const REPLACE_GLYPH = 'right-left'

/** An idle run's status, shared by construction and {@link SearchPanel.setProjectRoot}. */
const IDLE_STATUS: SearchStatus = { phase: 'idle', matchCount: 0, fileCount: 0, filesSearched: 0 }

/** The status a malformed regular expression paints — shared by nothing else. */
const INVALID_REGEX_STATUS: SearchStatus = { phase: 'invalid-regex', matchCount: 0, fileCount: 0, filesSearched: 0 }

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
    /** Replaces the single occurrence `match` names; resolves whether it actually replaced anything. */
    onReplaceMatch: (match: SearchMatch, compiled: CompiledQuery, replacement: string) => Promise<boolean>
    /** Replaces every occurrence `compiled` finds in one file; resolves how many. */
    onReplaceInFile: (path: string, compiled: CompiledQuery, replacement: string) => Promise<number>
    /** Replaces every occurrence `compiled` finds across every one of `paths`; resolves the totals. */
    onReplaceEverywhere: (
        paths: readonly string[], compiled: CompiledQuery, replacement: string,
    ) => Promise<{ matchesReplaced: number; filesChanged: number }>
    /** The open project folder, or `null` when none is open — result labels are shown relative to it. */
    projectRoot: string | null
}

/**
 * The explorer sidebar's Search view: a query field, a *match case* /
 * *regexp* toggle row, a results `Tree`, and a status line. Enter runs a
 * search over every file {@link SearchPanelParams.listFiles} returns,
 * matching a plain substring or a regular expression, case-insensitively
 * unless *match case* is set, streaming matches into the tree as each file
 * is read. Flipping either toggle re-runs the search for whatever is
 * currently in the query field. A malformed regular expression reports
 * itself in the status line and reads no files.
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
 *
 * A Replace field sits below the toggles, and the results tree gains a
 * `"contextmenu"` listener: right-clicking a match leaf offers **Replace**,
 * a file branch offers **Replace All in File** — each applies immediately
 * against the *current* content (a live buffer when the file is open, disk
 * otherwise), then re-runs the search. The panel's own **Replace All**
 * button confirms the count first, then applies the same replacement to
 * every match currently listed.
 */
class SearchPanel extends Container {
    private readonly _queryField: TextField
    private readonly _matchCaseToggle: Checkbox
    private readonly _regexpToggle: Checkbox
    private readonly _replaceField: TextField
    private readonly _replaceAllButton: Button
    private readonly _resultsTree: Tree
    private readonly _statusText: Text
    private readonly _listFiles: () => Promise<string[]>
    private readonly _readText: ReadFileText
    private readonly _onOpenMatch: (match: SearchMatch) => void
    private readonly _onCommitMatch: (match: SearchMatch) => void
    private readonly _onCommitFile: (path: string) => void
    private readonly _onReplaceMatch: (match: SearchMatch, compiled: CompiledQuery, replacement: string) => Promise<boolean>
    private readonly _onReplaceInFile: (path: string, compiled: CompiledQuery, replacement: string) => Promise<number>
    private readonly _onReplaceEverywhere: (
        paths: readonly string[], compiled: CompiledQuery, replacement: string,
    ) => Promise<{ matchesReplaced: number; filesChanged: number }>
    private readonly _menu = Menu()

    private _matches: SearchMatch[] = []
    private _root: string | null
    /** Bumped on every new search and on a project-root change; a run's
     *  callbacks compare against the value they captured at their own start
     *  to tell whether a later run has since superseded them. */
    private _runId = 0
    /** Set while a coalesced tree rebuild is scheduled for the next frame —
     *  see {@link appendMatches}. `null` when no rebuild is pending. */
    private _pendingFlush: number | null = null
    /** The `CompiledQuery` the *currently displayed* results came from — set
     *  in {@link runSearch} at the same point `compiled` is computed there, so
     *  it always matches what's on screen even if the query field has since
     *  been edited without pressing Enter again. `null` while idle or
     *  showing an invalid-regex status, when there is nothing to replace. */
    private _activeQuery: CompiledQuery | null = null

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
        const matchCaseToggle = new Checkbox({ label: MATCH_CASE_LABEL })
        const regexpToggle = new Checkbox({ label: REGEXP_LABEL })
        const toggleRow = Container({
            layoutManager: new HBox({ spacing: TOGGLE_SPACING }),
            components: [matchCaseToggle, regexpToggle],
        })
        const replaceField = new TextField({ placeholder: REPLACE_PLACEHOLDER })
        const replaceAllButton = Button({ text: REPLACE_ALL_LABEL, glyph: REPLACE_GLYPH, showText: true, compact: true, flat: true })
        const replaceRow = Container({
            layoutManager: new HBox({ spacing: TOGGLE_SPACING, itemAlign: 'center' }),
            components: [{ component: replaceField, constraints: { weight: 1 } }, replaceAllButton],
        })

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
            components: [
                queryField, toggleRow, replaceRow, statusText, { component: resultsTree, constraints: { weight: 1 } },
            ],
            // backgroundColor matches FileTree's own tree — both rail views
            // should read as the same surface — applied to the whole panel
            // rather than just resultsTree so the query field and status
            // text share it too, instead of sitting on a visible seam. The
            // token is the sidebar rail's own toolbar surface (see
            // FileTree.ts), so this panel follows a theme switch too.
            // The border isn't drawn by FileTree itself either — it's
            // Accordion's own themed all-around container border. This is the
            // same token (and fallback), applied here directly, so the two
            // rail views frame themselves identically.
            backgroundColor: 'var(--ts-ui-toolbar-bg, rgb(245, 245, 245))',
            border: 'var(--ts-ui-accordion-border, 1px solid rgb(214,217,222))',
        })

        this._queryField = queryField
        this._matchCaseToggle = matchCaseToggle
        this._regexpToggle = regexpToggle
        this._replaceField = replaceField
        this._replaceAllButton = replaceAllButton
        this._resultsTree = resultsTree
        this._statusText = statusText
        this._listFiles = params.listFiles
        this._readText = params.readText
        this._onOpenMatch = params.onOpenMatch
        this._onCommitMatch = params.onCommitMatch
        this._onCommitFile = params.onCommitFile
        this._onReplaceMatch = params.onReplaceMatch
        this._onReplaceInFile = params.onReplaceInFile
        this._onReplaceEverywhere = params.onReplaceEverywhere
        this._root = params.projectRoot

        this.paintStatus(IDLE_STATUS)
        this._replaceAllButton.setEnabled(false)

        Event.addListener(this._queryField, 'keydown', (e: KeyboardEvent) => this.handleKeyDown(e))
        this._matchCaseToggle.on('change', () => { void this.runSearch() })
        this._regexpToggle.on('change', () => { void this.runSearch() })
        this._replaceAllButton.on('action', () => { void this.applyReplaceAll() })
        this._resultsTree.on('selection', this.handleSelection)
        this._resultsTree.on('dblclick', this.handleDblClick)
        this._resultsTree.on('contextmenu', this.handleContextMenu)
    }

    /** Repoints the panel at a new project folder, cancelling any run and clearing the results. */
    setProjectRoot(root: string | null): void {
        this._runId += 1
        this._root = root
        this._queryField.setValue('')
        this._replaceField.setValue('')
        this._activeQuery = null
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

    /** The Search view's controls, read into one {@link SearchQuery}. */
    private currentQuery(): SearchQuery {
        return {
            text: this._queryField.getValue(),
            caseSensitive: this._matchCaseToggle.isSelected(),
            regexp: this._regexpToggle.isSelected(),
        }
    }

    /**
     * Runs a fresh search for the query field's current text and the two
     * toggles' current state, superseding any run already in flight. An
     * empty query clears the results and goes back to idle without touching
     * disk; a pattern that fails to compile — an invalid regular expression —
     * reports itself in the status line and also reads nothing. A run whose
     * outcome comes back `'cancelled'`, or that finishes after a later run
     * has already started, paints nothing — the run that superseded it owns
     * the panel now.
     */
    private async runSearch(): Promise<void> {
        const query = this.currentQuery()

        this._runId += 1

        const runId = this._runId

        this.clearResults()

        if (query.text === '') {
            this._activeQuery = null
            this.paintStatus(IDLE_STATUS)

            return
        }

        const compiled = compileQuery(query)

        if (compiled === null) {
            this._activeQuery = null
            this.paintStatus(INVALID_REGEX_STATUS)

            return
        }

        this._activeQuery = compiled
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
            files, compiled, this._readText,
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
        this.syncReplaceAllEnabled()
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
        this.syncReplaceAllEnabled()
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
     * The tree's `"contextmenu"` event: a match leaf offers **Replace**, a
     * file branch offers **Replace All in File**. A folder branch gets no
     * menu (see the plan's `## Non-Goals`).
     *
     * @param node - The right-clicked node.
     * @param event - The originating mouse event, for the menu's anchor point.
     */
    private readonly handleContextMenu = (node: TreeNode, event: MouseEvent): void => {
        const data = node.data as SearchTreeNodeData

        if (data.kind === 'match') {
            this._menu.show(event.clientX, event.clientY, [
                { text: 'Replace', glyph: REPLACE_GLYPH, action: () => { void this.applyMatchReplace(data.match) } },
            ])
        } else if (data.kind === 'file') {
            this._menu.show(event.clientX, event.clientY, [
                { text: 'Replace All in File', glyph: REPLACE_GLYPH, action: () => { void this.applyFileReplace(data.path) } },
            ])
        }
    }

    /**
     * Replaces one match via {@link SearchPanelParams.onReplaceMatch}, then
     * re-runs the search. A no-op while there is no {@link _activeQuery} — the
     * context menu that reaches this only exists while results (and
     * therefore a compiled query) are on screen, but the check is kept for
     * the same reason {@link applyReplaceAll} keeps its own.
     *
     * @param match - The match to replace.
     */
    private async applyMatchReplace(match: SearchMatch): Promise<void> {
        if (this._activeQuery === null) {
            return
        }

        const compiled = this._activeQuery

        await this._onReplaceMatch(match, compiled, this._replaceField.getValue())
        await this.runSearch()
    }

    /**
     * Replaces every occurrence in one file via
     * {@link SearchPanelParams.onReplaceInFile}, then re-runs the search.
     *
     * @param path - The file to replace in.
     */
    private async applyFileReplace(path: string): Promise<void> {
        if (this._activeQuery === null) {
            return
        }

        const compiled = this._activeQuery

        await this._onReplaceInFile(path, compiled, this._replaceField.getValue())
        await this.runSearch()
    }

    /**
     * The panel's own Replace All button: confirms the match/file counts via
     * {@link confirmReplaceAll}, then replaces every currently-listed match
     * via {@link SearchPanelParams.onReplaceEverywhere}, reports the result in
     * a toast, and re-runs the search whether or not the run succeeded.
     */
    private async applyReplaceAll(): Promise<void> {
        if (this._activeQuery === null || this._matches.length === 0) {
            return
        }

        // Captured now, not after the `await` below: TypeScript can't carry a
        // `this._activeQuery !== null` narrowing across an `await`, so `compiled`
        // is a local `const` instead — its own narrowed type survives the wait
        // for the confirmation dialog.
        const compiled = this._activeQuery
        const paths = [...new Set(this._matches.map(match => match.path))]

        if (!(await confirmReplaceAll(this._matches.length, paths.length))) {
            return
        }

        const replacement = this._replaceField.getValue()

        this.paintStatus({ phase: 'replacing', matchCount: 0, fileCount: 0, filesSearched: 0 })

        try {
            const { matchesReplaced, filesChanged } = await this._onReplaceEverywhere(paths, compiled, replacement)

            Notification.show(
                `Replaced ${pluralize(matchesReplaced, 'match', 'matches')} in ${pluralize(filesChanged, 'file', 'files')}.`,
                'success',
            )
        } finally {
            await this.runSearch()
        }
    }

    /** Enables the Replace All button exactly when the tree currently lists at
     *  least one match. Called wherever {@link _matches} changes. */
    private syncReplaceAllEnabled(): void {
        this._replaceAllButton.setEnabled(this._matches.length > 0)
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
