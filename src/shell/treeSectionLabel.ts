// The tree section's header-label rule, split out of EditorShell.ts so it
// stays unit testable: vitest.config.ts runs in the `node` environment with
// no DOM, and a module that imports @jimka/typescript-ui's components
// touches `document` at load time.
import { projectName } from '../data/paths'

/** The tree section's header label before any project is open — {@link treeSectionLabel} shows the project's own name once one is. */
export const FILES_SECTION_FALLBACK_LABEL = 'Files'

/**
 * The tree section's header label: the open project's own display name, or
 * {@link FILES_SECTION_FALLBACK_LABEL} before any project is open.
 *
 * @param root - The open project folder, or `null` when none is open.
 * @returns The label to show in the tree section's header.
 */
export function treeSectionLabel(root: string | null): string {
    return root === null ? FILES_SECTION_FALLBACK_LABEL : projectName(root)
}
