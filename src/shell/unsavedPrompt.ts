import { Dialog } from '@jimka/typescript-ui/overlay'

/** The user's answer to the unsaved-changes prompt. */
export type UnsavedChoice = 'save' | 'discard' | 'cancel'

/**
 * Shows the three-way "Unsaved changes" prompt for a dirty file about to
 * close. `DialogResult` has only `'confirm' | 'cancel' | 'close'`, too few
 * values for three buttons, so each button's `onClick` guard assigns the
 * real choice into a closure variable and returns `true` to close normally.
 * Escape, the backdrop, and the dialog's own ✕ all bypass `onClick`, which
 * is exactly why `choice` starts at the safe `'cancel'`.
 *
 * @param label - The file's display label, shown in the prompt message.
 * @returns The user's choice.
 */
export async function promptUnsavedChanges(label: string): Promise<UnsavedChoice> {
  let choice: UnsavedChoice = 'cancel'

  await Dialog.show({
    title: 'Unsaved changes',
    message: `"${label}" has unsaved changes. Save them before closing?`,
    buttons: [
      {
        text: 'Cancel',
        result: 'cancel',
        onClick: () => {
          choice = 'cancel'

          return true
        },
      },
      {
        text: "Don't Save",
        result: 'confirm',
        onClick: () => {
          choice = 'discard'

          return true
        },
      },
      {
        text: 'Save',
        result: 'confirm',
        primary: true,
        onClick: () => {
          choice = 'save'

          return true
        },
      },
    ],
  })

  return choice
}
