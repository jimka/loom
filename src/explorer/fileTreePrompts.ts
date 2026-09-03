import { Container } from '@jimka/typescript-ui/core'
import { Fit } from '@jimka/typescript-ui/layout'
import { TextField } from '@jimka/typescript-ui/component/input'
import { Dialog } from '@jimka/typescript-ui/overlay'
import { FieldDecorator } from '@jimka/typescript-ui/validation'
import { pathExists } from '../data/workspace'
import { joinPath, baseName, parentDir, isValidEntryName } from '../data/paths'

/**
 * Prompts for a name via a text field inside a modal dialog, re-showing an
 * inline validation error (via `FieldDecorator`) instead of closing when
 * `validate` rejects the trimmed value.
 *
 * @param title - The dialog's title.
 * @param confirmLabel - The primary button's label.
 * @param initialValue - The field's starting text, pre-selected.
 * @param validate - Checked on confirm; returns an error message, or `null` when the name is acceptable.
 * @returns The trimmed, accepted name, or `null` if the user cancels.
 */
async function promptName(
    title: string, confirmLabel: string, initialValue: string,
    validate: (name: string) => Promise<string | null>,
): Promise<string | null> {
    const field = TextField({ text: initialValue })
    const body = Container({ layoutManager: Fit(), components: [field] })
    const decorator = FieldDecorator(field, body)

    field.select()
    field.on('change', () => decorator.clearError())

    let confirmed: string | null = null

    await Dialog.show({
        title,
        contentComponent: body,
        initialFocus: field,
        buttons: [
            { text: 'Cancel', result: 'cancel' },
            {
                text: confirmLabel,
                result: 'confirm',
                primary: true,
                onClick: async () => {
                    const name = field.getValue().trim()
                    const problem = await validate(name)

                    if (problem !== null) {
                        decorator.showError(problem)

                        return false
                    }

                    confirmed = name

                    return true
                },
            },
        ],
    })

    return confirmed
}

/**
 * Prompts for a new file or folder's name inside `dir`, re-showing an inline
 * error (empty name, a `/`/`\` in the name, or an existing entry with the
 * same name) instead of closing. Resolves the new entry's absolute path, or
 * `null` if the user cancels.
 *
 * @param dir - The directory the new entry is created inside.
 * @param kind - Whether the prompt is for a new file or a new folder.
 * @returns The new entry's absolute path, or `null` if cancelled.
 */
export async function promptNewEntryName(dir: string, kind: 'file' | 'folder'): Promise<string | null> {
    const validate = async (name: string): Promise<string | null> => {
        if (!isValidEntryName(name)) {
            return 'Enter a name with no "/" or "\\".'
        }

        if (await pathExists(joinPath(dir, name))) {
            return `"${name}" already exists here.`
        }

        return null
    }

    const title = kind === 'file' ? 'New File' : 'New Folder'
    const name = await promptName(title, 'Create', '', validate)

    return name === null ? null : joinPath(dir, name)
}

/**
 * Prompts for `path`'s new name, seeded with its current base name selected.
 * Resolves the new absolute path, `null` if the user cancels, and `null`
 * (a no-op, not an error) if they submit the unchanged name.
 *
 * @param path - The file or folder being renamed.
 * @param isDir - Whether `path` is a directory.
 * @returns The new absolute path, `null` on cancel, or `null` for a no-op rename.
 */
export async function promptRenameName(path: string, isDir: boolean): Promise<string | null> {
    const dir = parentDir(path)
    const currentName = baseName(path)

    const validate = async (name: string): Promise<string | null> => {
        if (!isValidEntryName(name)) {
            return 'Enter a name with no "/" or "\\".'
        }

        const target = joinPath(dir, name)

        if (target !== path && await pathExists(target)) {
            return `"${name}" already exists here.`
        }

        return null
    }

    const name = await promptName(`Rename "${currentName}"`, 'Rename', currentName, validate)

    if (name === null) {
        return null
    }

    const newPath = joinPath(dir, name)

    return newPath === path ? null : newPath
}

/**
 * Confirms deleting `path`, naming it and — for a directory — warning that
 * its contents go with it.
 *
 * @param path - The file or folder to delete.
 * @param isDir - Whether `path` is a directory.
 * @returns Whether the user confirmed the delete.
 */
export async function confirmDelete(path: string, isDir: boolean): Promise<boolean> {
    const name = baseName(path)
    const message = isDir
        ? `"${name}" and everything inside it will be permanently deleted. This can't be undone.`
        : `"${name}" will be permanently deleted. This can't be undone.`

    const result = await Dialog.show({
        title: `Delete "${name}"?`,
        message,
        buttons: [
            { text: 'Cancel', result: 'cancel' },
            { text: 'Delete', result: 'confirm', primary: true },
        ],
    })

    return result === 'confirm'
}
