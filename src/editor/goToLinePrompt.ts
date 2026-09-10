// The Go to Line prompt. Same four pieces as `promptName` in
// ../explorer/fileTreePrompts.ts — a TextField in a Fit-laid Container, a
// FieldDecorator for the inline error, and a confirm button whose onClick
// returns false to keep the dialog open on a rejected value.
import { Container } from '@jimka/typescript-ui/core'
import { Fit } from '@jimka/typescript-ui/layout'
import { TextField } from '@jimka/typescript-ui/component/input'
import { Dialog } from '@jimka/typescript-ui/overlay'
import { FieldDecorator } from '@jimka/typescript-ui/validation'
import { parseLineNumber } from './lineNumber'

/**
 * Prompts for a line number to jump to, re-showing an inline error instead of
 * closing when the field does not name one. The field starts empty; the
 * document's line range is shown as the placeholder rather than pre-filled, so
 * the user types the destination straight in.
 *
 * @param lineCount - The document's line count, shown in the placeholder.
 * @returns The line number to jump to, or `null` if the user cancels.
 */
export async function promptGoToLine(lineCount: number): Promise<number | null> {
    const field = TextField({ placeholder: `Line number (1-${lineCount})` })
    const body = Container({ layoutManager: Fit(), components: [field] })
    const decorator = FieldDecorator(field, body)

    field.on('change', () => decorator.clearError())

    let confirmed: number | null = null

    await Dialog.show({
        title: 'Go to Line',
        contentComponent: body,
        initialFocus: field,
        buttons: [
            { text: 'Cancel', result: 'cancel' },
            {
                text: 'Go',
                result: 'confirm',
                primary: true,
                onClick: () => {
                    const line = parseLineNumber(field.getValue())

                    if (line === null) {
                        decorator.showError('Enter a line number.')

                        return false
                    }

                    confirmed = line

                    return true
                },
            },
        ],
    })

    return confirmed
}
