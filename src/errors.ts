/** Turns a caught value into a display-safe message for a `Dialog.error` call. */
export function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
