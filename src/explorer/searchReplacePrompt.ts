// The Search view's Replace All confirmation, mirroring fileTreePrompts.ts's
// confirmDelete — the codebase's own precedent for a confirm-before-acting
// dialog whose blast radius (here: every currently-listed match) isn't
// visible at a glance.
import { Dialog } from '@jimka/typescript-ui/overlay'
import { pluralize } from './searchResults'

/**
 * Confirms a project-wide Replace All, naming how many occurrences and files
 * it is about to touch, and that a closed file's write can't be undone.
 *
 * @param matchCount - How many matches the run is about to replace.
 * @param fileCount - How many files those matches span.
 * @returns Whether the user confirmed.
 */
export async function confirmReplaceAll(matchCount: number, fileCount: number): Promise<boolean> {
    const result = await Dialog.show({
        title: 'Replace All?',
        message: `Replace ${pluralize(matchCount, 'match', 'matches')} in `
            + `${pluralize(fileCount, 'file', 'files')}? Files open in a tab are edited there — `
            + `undo with Ctrl/Cmd+Z and save when ready. Files not open are written to disk `
            + `immediately and can't be undone.`,
        buttons: [
            { text: 'Cancel', result: 'cancel' },
            { text: 'Replace All', result: 'confirm', primary: true },
        ],
    })

    return result === 'confirm'
}
