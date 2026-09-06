import { Container, callable } from '@jimka/typescript-ui/core'
import { Insets } from '@jimka/typescript-ui/primitive'
import { Card } from '@jimka/typescript-ui/layout'
import { Text } from '@jimka/typescript-ui/component/input'
import { LabeledGrid } from '@jimka/typescript-ui/component/container'
import { statEntry } from '../data/workspace'
import type { EntryInfo } from '../data/workspace'
import { PROPERTY_LABELS, entryPropertyRows } from './entryProperties'
import type { SelectedEntry } from './entryProperties'

/** The `Card` deck's two page ids. */
const EMPTY_PAGE_ID = 'properties-empty'
const GRID_PAGE_ID = 'properties-grid'

/** Shown while no tree row is selected. */
const EMPTY_TEXT = 'Select a file or folder in the tree.'

/** The empty line's colour — the muted grey `WelcomeScreen` paints its own hint
 *  line (`src/shell/WelcomeScreen.ts:34`), so the two empty states read alike. */
const EMPTY_COLOR = 'rgb(140, 140, 140)'

/** Padding around the panel's content, in pixels. Mirrors `FileBreadcrumbs`'s
 *  own `BAND_PAD` (`src/editor/FileBreadcrumbs.ts:24`) so Loom's chrome indents
 *  its text by one consistent amount. */
const PANEL_PAD = 6

/** Constructor parameters for {@link PropertiesPanel}. */
export interface PropertiesPanelParams {
    /** The open project folder, or `null` when none is open — the Path row is shown relative to it. */
    projectRoot: string | null
}

/**
 * The explorer sidebar's second section: shows the selected tree row's name,
 * path, type, size, and last-modified time, or a muted hint line while
 * nothing is selected. A `Card` deck switches between the two pages; the
 * grid's five rows are built once and rewritten in place per selection.
 */
class PropertiesPanel extends Container {
    private readonly _card: Card
    private readonly _values: Text[]
    private _projectRoot: string | null
    private _entry: SelectedEntry | null = null

    constructor(params: PropertiesPanelParams) {
        const card = new Card()
        const values = PROPERTY_LABELS.map(() => new Text('', { truncate: true }))
        const grid = LabeledGrid({ columns: 1 })
        const empty = new Text(EMPTY_TEXT, { foregroundColor: EMPTY_COLOR })

        PROPERTY_LABELS.forEach((label, index) => { grid.addField(label, values[index]) })
        grid.setId(GRID_PAGE_ID)
        empty.setId(EMPTY_PAGE_ID)

        super({
            layoutManager: card,
            insets: new Insets(PANEL_PAD, PANEL_PAD, PANEL_PAD, PANEL_PAD),
            components: [empty, grid],
        })

        this._card = card
        this._values = values
        this._projectRoot = params.projectRoot

        card.setVisibleComponentId(EMPTY_PAGE_ID)
    }

    /** Shows `entry`'s properties, or the empty line when `entry` is `null`. */
    setEntry(entry: SelectedEntry | null): void {
        this._entry = entry

        if (entry === null) {
            this._card.setVisibleComponentId(EMPTY_PAGE_ID)

            return
        }

        this.applyRows(entry, null)
        this._card.setVisibleComponentId(GRID_PAGE_ID)
        void this.loadInfo(entry)
    }

    /** Repoints the panel at a new project folder and repaints the current row. */
    setProjectRoot(root: string | null): void {
        this._projectRoot = root

        if (this._entry !== null) {
            void this.loadInfo(this._entry)
        }
    }

    /**
     * Reads `entry`'s metadata and repaints the rows, unless a newer
     * selection has since replaced it.
     *
     * @param entry - The row to describe.
     */
    private async loadInfo(entry: SelectedEntry): Promise<void> {
        const info = await statEntry(entry.path)

        if (this._entry === entry) {
            this.applyRows(entry, info)
        }
    }

    /**
     * Rewrites the grid's five value `Text`s from `entry` and `info`.
     *
     * @param entry - The row to describe.
     * @param info - `entry`'s metadata, or `null` when it hasn't loaded yet or could not be read.
     */
    private applyRows(entry: SelectedEntry, info: EntryInfo | null): void {
        entryPropertyRows(entry, info, this._projectRoot).forEach((row, index) => {
            this._values[index].setText(row.value)
        })
    }
}

const PropertiesPanelCallable = callable(PropertiesPanel)
type PropertiesPanelCallable = PropertiesPanel
export { PropertiesPanelCallable as PropertiesPanel }
