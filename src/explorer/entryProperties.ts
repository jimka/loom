// The properties panel's row-formatting rules, split out of PropertiesPanel.ts
// so it stays unit testable: vitest.config.ts runs in the `node` environment
// with no DOM, and a module that imports @jimka/typescript-ui's components
// touches `document` at load time.
import { baseName, relativeTo } from '../data/paths'
import type { EntryInfo } from '../data/workspace'

/** Size units, ascending, each {@link SIZE_STEP}× the previous. Binary units
 *  (KiB, not KB) because the step is 1024, matching how
 *  `src/data/workspace.ts`'s own `MAX_OPEN_BYTES` comment reads
 *  `5 * 1024 * 1024` as "5 MiB". */
const SIZE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const

/** The factor between two adjacent {@link SIZE_UNITS} entries. */
const SIZE_STEP = 1024

/** Decimal places shown for every unit above bytes — one separates 1.4 from
 *  1.5 MiB without implying byte-level precision the unit no longer carries. */
const SIZE_DECIMALS = 1

/** Width every date and time field is zero-padded to, in characters — two, the
 *  fixed width of every `YYYY-MM-DD HH:MM` field but the year. */
const DATE_FIELD_WIDTH = 2

/** A file-tree row the properties panel can describe. */
export interface SelectedEntry {
    /** The entry's absolute path on disk. */
    path: string
    /** Whether the entry is a directory. */
    isDir: boolean
}

/** One label/value line in the properties panel. */
export interface PropertyRow {
    label: string
    value: string
}

/** Written wherever a value is unavailable — an em-dash, not an empty cell, so a blank row still reads as deliberate. */
export const NO_VALUE = '—'

/** The panel's row labels, in display order. {@link entryPropertyRows} returns one row per label, in this order. */
export const PROPERTY_LABELS = ['Name', 'Path', 'Type', 'Size', 'Modified'] as const

/** `value` left-padded with `'0'` to {@link DATE_FIELD_WIDTH} characters. */
function pad2(value: number): string {
    return String(value).padStart(DATE_FIELD_WIDTH, '0')
}

/**
 * `bytes` written in binary units: plain bytes below 1 KiB, otherwise the
 * largest unit that leaves a value under 1024, to one decimal place.
 *
 * @param bytes - The size to format.
 * @returns The formatted size, e.g. `"1.5 KiB"`.
 */
export function formatSize(bytes: number): string {
    let value = bytes
    let unit = 0

    while (value >= SIZE_STEP && unit < SIZE_UNITS.length - 1) {
        value /= SIZE_STEP
        unit += 1
    }

    return unit === 0 ? `${value} ${SIZE_UNITS[0]}` : `${value.toFixed(SIZE_DECIMALS)} ${SIZE_UNITS[unit]}`
}

/**
 * `when` written as `YYYY-MM-DD HH:MM` in local time.
 *
 * @param when - The timestamp to format.
 * @returns The formatted timestamp.
 */
export function formatTimestamp(when: Date): string {
    return `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}`
        + ` ${pad2(when.getHours())}:${pad2(when.getMinutes())}`
}

/**
 * The five lines describing `entry`.
 *
 * @param entry - The selected tree row.
 * @param info - `entry`'s metadata, or `null` when it could not be read.
 * @param projectRoot - The open project folder, or `null` when none is open.
 * @returns One row per {@link PROPERTY_LABELS} entry, in that order.
 */
export function entryPropertyRows(
    entry: SelectedEntry,
    info: EntryInfo | null,
    projectRoot: string | null,
): PropertyRow[] {
    return [
        { label: 'Name', value: baseName(entry.path) },
        { label: 'Path', value: relativeTo(projectRoot, entry.path) ?? entry.path },
        { label: 'Type', value: entry.isDir ? 'Folder' : 'File' },
        { label: 'Size', value: entry.isDir || info === null ? NO_VALUE : formatSize(info.size) },
        { label: 'Modified', value: info === null || info.modified === null ? NO_VALUE : formatTimestamp(info.modified) },
    ]
}
