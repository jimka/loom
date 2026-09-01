// Pure per-project workspace data shape and parser — no Tauri imports, so it
// runs in vitest's `node` environment. `src/shell/session.ts` owns the
// Tauri-backed read/write this module's shape feeds; `src/data/session.ts`
// holds the app-wide counterpart this module's `WorkspaceState` overlays.
import { isUnderRoot } from './paths'
import type { LayoutSize, LayoutSizeUnit } from '@jimka/typescript-ui/layout'
import type { SessionState } from './session'

/** The workspace schema's only valid `unit`s — mirrors {@link LayoutSizeUnit}. */
const VALID_LAYOUT_SIZE_UNITS: readonly LayoutSizeUnit[] = ['px', 'ratio']

/** One project's own saved state: the slice of `SessionState` that only makes sense for the project it was captured in — every field except `projectRoot`. */
export interface WorkspaceState {
  version: 1
  /** Absolute paths of the directories expanded in this project's tree. */
  expandedDirs: string[]
  /** Absolute paths of this project's open files, in tab order. */
  openFiles: string[]
  /** The active tab's file path, or `null`. */
  activeFile: string | null
  /** The `Split`'s pane sizes, in pane order (explorer first). */
  paneSizes: LayoutSize[]
  /** Indices of the collapsed panes. */
  collapsedPanes: number[]
}

/** A fresh, empty workspace state — what a project with no `.loom/workspace.json` yet gets once one is written. */
export function emptyWorkspaceState(): WorkspaceState {
  return {
    version: 1,
    expandedDirs: [],
    openFiles: [],
    activeFile: null,
    paneSizes: [],
    collapsedPanes: [],
  }
}

/**
 * Parses `text` as a workspace state, degrading an unusable field to its
 * empty default. Returns `null` when `text` is not a usable document at all —
 * not JSON, not an object, or a `version` other than `1` — so the caller can
 * fall back to the app-wide session instead of overlaying a blank record.
 *
 * @param text - The workspace state file's raw text.
 * @returns The parsed workspace state, or `null` when `text` is unusable.
 */
export function parseWorkspaceState(text: string): WorkspaceState | null {
  const doc = parseDocument(text)

  if (doc === null) {
    return null
  }

  const empty = emptyWorkspaceState()

  return {
    version: 1,
    expandedDirs: readStringArray(doc.expandedDirs) ?? empty.expandedDirs,
    openFiles: readStringArray(doc.openFiles) ?? empty.openFiles,
    activeFile: readOptionalString(doc.activeFile) ?? empty.activeFile,
    paneSizes: readLayoutSizeArray(doc.paneSizes) ?? empty.paneSizes,
    collapsedPanes: readNumberArray(doc.collapsedPanes) ?? empty.collapsedPanes,
  }
}

/** Renders `state` as the JSON text written to `.loom/workspace.json`. */
export function serializeWorkspaceState(state: WorkspaceState): string {
  return JSON.stringify(state, null, 2)
}

/**
 * Extracts the workspace-scoped slice of `session` — `expandedDirs`/
 * `openFiles`/`activeFile` filtered to `session.projectRoot`, plus
 * `paneSizes`/`collapsedPanes` copied verbatim. Returns
 * {@link emptyWorkspaceState} when `session.projectRoot` is `null`.
 *
 * @param session - The live app-wide session to extract from.
 * @returns The project's own workspace-scoped state.
 */
export function workspaceStateFromSession(session: SessionState): WorkspaceState {
  if (session.projectRoot === null) {
    return emptyWorkspaceState()
  }

  const { paths, active } = filterToRoot(session.projectRoot, session.openFiles, session.activeFile)

  return {
    version: 1,
    expandedDirs: session.expandedDirs,
    openFiles: paths,
    activeFile: active,
    paneSizes: session.paneSizes,
    collapsedPanes: session.collapsedPanes,
  }
}

/**
 * Replaces `session`'s `expandedDirs`/`openFiles`/`activeFile`/`paneSizes`/
 * `collapsedPanes` with `workspace`'s — the path fields filtered to
 * `session.projectRoot`, the split fields copied verbatim. Returns `session`
 * unchanged when `workspace` is `null` or `session.projectRoot` is `null`.
 *
 * @param session - The app-wide session to overlay onto.
 * @param workspace - The project's own workspace state, or `null` when none
 *   was found.
 * @returns The overlaid session.
 */
export function applyWorkspaceOverlay(session: SessionState, workspace: WorkspaceState | null): SessionState {
  if (workspace === null || session.projectRoot === null) {
    return session
  }

  const { paths, active } = filterToRoot(session.projectRoot, workspace.openFiles, workspace.activeFile)

  return {
    ...session,
    expandedDirs: workspace.expandedDirs,
    openFiles: paths,
    activeFile: active,
    paneSizes: workspace.paneSizes,
    collapsedPanes: workspace.collapsedPanes,
  }
}

/**
 * Keeps only the paths under `root`, dropping `active` too when it is itself
 * outside `root` — the shared filter both {@link workspaceStateFromSession}
 * (the write side) and {@link applyWorkspaceOverlay} (the read side) apply,
 * so a `.loom/workspace.json` never points outside its own project.
 *
 * @param root - The project root paths must fall under.
 * @param paths - The candidate paths to filter.
 * @param active - The candidate active path, or `null`.
 * @returns The filtered paths and active path.
 */
function filterToRoot(root: string, paths: string[], active: string | null): { paths: string[]; active: string | null } {
  return {
    paths: paths.filter(path => isUnderRoot(root, path)),
    active: active !== null && isUnderRoot(root, active) ? active : null,
  }
}

/**
 * Parses `text` as JSON and validates the top-level shape: an object with
 * `version: 1`. Anything else — invalid JSON, a non-object, an array, or a
 * different version — is not a usable workspace document.
 *
 * @param text - The raw text to parse.
 * @returns The parsed document, or `null` when it is not a usable workspace state.
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
 * `LayoutSize`, the same discard rule `../data/session.ts`'s `SessionState`
 * parser applies.
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
