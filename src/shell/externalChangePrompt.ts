import { Dialog } from '@jimka/typescript-ui/overlay'

/** The user's answer to the file-changed-on-disk prompt. */
export type ExternalChangeChoice = 'reload' | 'keep'

/**
 * Shows the two-way "File changed on disk" prompt for an open file whose
 * buffer has unsaved changes and whose disk content just moved underneath
 * it. `DialogResult` has only `'confirm' | 'cancel' | 'close'`, too few
 * values to carry two named outcomes, so each button's `onClick` guard
 * assigns the real choice into a closure variable and returns `true` to
 * close normally. Escape, the backdrop, and the dialog's own ✕ all bypass
 * `onClick`, which is exactly why `choice` starts at `'keep'` — a stray
 * dismissal must never destroy unsaved changes.
 *
 * @param name - The file's display name, shown in the prompt message.
 * @returns The user's choice.
 */
export async function promptExternalChange(name: string): Promise<ExternalChangeChoice> {
    let choice: ExternalChangeChoice = 'keep'

    await Dialog.show({
        title: 'File changed on disk',
        message: `"${name}" changed on disk while you have unsaved changes here. Reload it from disk and lose your changes, or keep yours?`,
        buttons: [
            {
                text: 'Reload from Disk',
                result: 'confirm',
                onClick: () => {
                    choice = 'reload'

                    return true
                },
            },
            {
                text: 'Keep My Changes',
                result: 'cancel',
                primary: true,
                onClick: () => {
                    choice = 'keep'

                    return true
                },
            },
        ],
    })

    return choice
}
