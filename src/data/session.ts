// Pure session data shape and parser — no Tauri imports, so it runs in
// vitest's `node` environment. `src/shell/session.ts` owns the Tauri-backed
// read/write and the live-state capture/restore this module's shape feeds.
import type { LayoutSize, LayoutSizeUnit } from '@jimka/typescript-ui/layout'

/** The session schema's only valid `unit`s — mirrors {@link LayoutSizeUnit}. */
const VALID_LAYOUT_SIZE_UNITS: readonly LayoutSizeUnit[] = ['px', 'ratio']

/** One saved session: what the app should look like on the next launch. */
export interface SessionState {
  version: 1
  /** The last opened project folder, or `null` when none was open. */
  projectRoot: string | null
  /** Absolute paths of the directories expanded in the tree. */
  expandedDirs: string[]
  /** Absolute paths of the open files, in tab order. */
  openFiles: string[]
  /** The active tab's file path, or `null` when no file was open. */
  activeFile: string | null
  /** The `Split`'s pane sizes, in pane order (explorer first). */
  paneSizes: LayoutSize[]
  /** Indices of the collapsed panes. */
  collapsedPanes: number[]
  /** Recently opened project folders, most-recent first. */
  recentProjects: string[]
  /** Recently opened files, most-recent first, independent of which project (if any) they were opened from. */
  recentFiles: string[]
}

/**
 * The most recent-projects or recent-files entries kept, oldest dropped
 * first — long enough to be useful, short enough that the File-menu
 * submenu never needs to scroll (matching the length most editors cap an
 * in-menu recent list at).
 */
export const MAX_RECENT_ENTRIES = 10

/**
 * Returns a new list with `path` moved to the front, any earlier occurrence
 * removed, capped at {@link MAX_RECENT_ENTRIES}. Leaves `list` unmutated.
 *
 * @param list - The current most-recent-first list.
 * @param path - The path to move (or add) to the front.
 * @returns The new list.
 */
export function withRecent(list: string[], path: string): string[] {
  return [path, ...list.filter(entry => entry !== path)].slice(0, MAX_RECENT_ENTRIES)
}

/** A fresh, empty session — what a first launch (or an unusable file) gets. */
export function emptySession(): SessionState {
  return {
    version: 1,
    projectRoot: null,
    expandedDirs: [],
    openFiles: [],
    activeFile: null,
    paneSizes: [],
    collapsedPanes: [],
    recentProjects: [],
    recentFiles: [],
  }
}

/**
 * Reads a session out of a file's text, degrading to {@link emptySession} on
 * anything unusable.
 *
 * A parse failure, a non-object, or any `version` other than `1` discards the
 * whole document. Past that, each field is read independently: a field that
 * is absent or the wrong shape takes its empty default, and the rest of the
 * session survives.
 *
 * @param text - The session file's raw text.
 * @returns The parsed session, or {@link emptySession} when `text` is unusable.
 */
export function parseSession(text: string): SessionState {
  const doc = parseDocument(text)

  if (doc === null) {
    return emptySession()
  }

  const empty = emptySession()

  return {
    version: 1,
    projectRoot: readOptionalString(doc.projectRoot) ?? empty.projectRoot,
    expandedDirs: readStringArray(doc.expandedDirs) ?? empty.expandedDirs,
    openFiles: readStringArray(doc.openFiles) ?? empty.openFiles,
    activeFile: readOptionalString(doc.activeFile) ?? empty.activeFile,
    paneSizes: readLayoutSizeArray(doc.paneSizes) ?? empty.paneSizes,
    collapsedPanes: readNumberArray(doc.collapsedPanes) ?? empty.collapsedPanes,
    recentProjects: (readStringArray(doc.recentProjects) ?? empty.recentProjects).slice(0, MAX_RECENT_ENTRIES),
    recentFiles: (readStringArray(doc.recentFiles) ?? empty.recentFiles).slice(0, MAX_RECENT_ENTRIES),
  }
}

/** Renders a session as the JSON text written to disk. */
export function serializeSession(state: SessionState): string {
  return JSON.stringify(state, null, 2)
}

/**
 * Orders directory paths so an ancestor always precedes its descendants.
 *
 * A parent directory's path is always a strict prefix of a directory inside
 * it, so it is always shorter — sorting by length ascending is enough to put
 * every ancestor before its descendants. Two paths of equal length can never
 * be ancestor and descendant of each other, so their relative order doesn't
 * matter.
 *
 * @param paths - The directory paths to order.
 * @returns A new array, shortest path first.
 */
export function expansionOrder(paths: string[]): string[] {
  return [...paths].sort((a, b) => a.length - b.length)
}

/**
 * Parses `text` as JSON and validates the top-level shape: an object with
 * `version: 1`. Anything else — invalid JSON, a non-object, an array, or a
 * different version — is not a usable session document.
 *
 * @param text - The raw text to parse.
 * @returns The parsed document, or `null` when it is not a usable session.
 */
function parseDocument(text: string): Record<string, unknown> | null {
  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }

  const doc = parsed as Record<string, unknown>

  if (doc.version !== 1) {
    return null
  }

  return doc
}

/**
 * Reads a field expected to be a string, or `null` when it is absent.
 *
 * @param value - The field's raw value.
 * @returns The string, `null` when the field was `null`/absent, or `undefined`
 *   when present but the wrong type (so the caller falls back to its default).
 */
function readOptionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return null
  }

  return typeof value === 'string' ? value : undefined
}

/**
 * Reads a field expected to be a string array. The whole array is dropped —
 * not repaired entry by entry — if any entry is not a string.
 *
 * @param value - The field's raw value.
 * @returns The string array, or `undefined` when the field is missing or any
 *   entry is invalid.
 */
function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  return value.every(entry => typeof entry === 'string') ? (value as string[]) : undefined
}

/**
 * Reads a field expected to be a number array. The whole array is dropped —
 * not repaired entry by entry — if any entry is not a number.
 *
 * @param value - The field's raw value.
 * @returns The number array, or `undefined` when the field is missing or any
 *   entry is invalid.
 */
function readNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  return value.every(entry => typeof entry === 'number') ? (value as number[]) : undefined
}

/**
 * Reads a field expected to be a {@link LayoutSize} array. The whole array is
 * dropped — not repaired entry by entry — if any entry isn't a well-shaped
 * `LayoutSize`, matching the discard rule the library applies to a stale
 * `LayoutSize[]` in its own `LayoutSizes.isRestorableSizes`.
 *
 * @param value - The field's raw value.
 * @returns The `LayoutSize` array, or `undefined` when the field is missing or
 *   any entry is invalid.
 */
function readLayoutSizeArray(value: unknown): LayoutSize[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  return value.every(isLayoutSize) ? (value as LayoutSize[]) : undefined
}

/**
 * Whether `value` is a well-shaped {@link LayoutSize}: a `unit` of `"px"` or
 * `"ratio"` and a numeric `value`.
 *
 * @param value - The candidate entry.
 * @returns Whether `value` is a valid `LayoutSize`.
 */
function isLayoutSize(value: unknown): value is LayoutSize {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Record<string, unknown>

  return VALID_LAYOUT_SIZE_UNITS.includes(candidate.unit as LayoutSizeUnit)
    && typeof candidate.value === 'number'
}
