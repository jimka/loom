import { Dialog } from '@jimka/typescript-ui/overlay'
import { projectName } from '../data/paths'

/** The user's answer to the {@link promptRecentDirectoryIntent} prompt. */
export type RecentDirectoryIntent = 'workspace' | 'expose' | 'cancel'

/**
 * Shows the "what do you want to do with this recent directory" prompt for
 * a recent-project entry that sits inside the currently open workspace —
 * open it as its own workspace (replacing the current one), or just reveal
 * it in the tree that's already open. Same three-button/`onClick`-closure
 * pattern as {@link promptUnsavedChanges} in `unsavedPrompt.ts`:
 * `DialogResult` only distinguishes confirm/cancel/close, too few values for
 * three buttons.
 *
 * @param path - The recent directory's path.
 * @returns The user's choice.
 */
export async function promptRecentDirectoryIntent(path: string): Promise<RecentDirectoryIntent> {
  let choice: RecentDirectoryIntent = 'cancel'

  await Dialog.show({
    title: 'Open Recent',
    message: `"${projectName(path)}" is inside the current workspace. Open it as its own workspace, or reveal it in the tree?`,
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
        text: 'Expose in Tree',
        result: 'confirm',
        onClick: () => {
          choice = 'expose'

          return true
        },
      },
      {
        text: 'Open as Workspace',
        result: 'confirm',
        primary: true,
        onClick: () => {
          choice = 'workspace'

          return true
        },
      },
    ],
  })

  return choice
}

/**
 * Shows the "this recent directory is a separate workspace" confirm prompt
 * for a recent-project entry outside the current workspace — there is
 * nothing to reveal in the current tree, so opening it can only mean
 * replacing (closing) the current workspace.
 *
 * @param path - The recent directory's path.
 * @param currentRoot - The currently open workspace's path.
 * @returns Whether the user confirmed opening it.
 */
export async function confirmOpenSeparateWorkspace(path: string, currentRoot: string): Promise<boolean> {
  return Dialog.confirm(
    'Open Recent',
    `"${projectName(path)}" is a separate workspace from "${projectName(currentRoot)}". Open it and close the current workspace?`,
  )
}
