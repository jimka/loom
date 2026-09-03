// Builds the command palette's `>`-mode command list from EditorShell's own
// menu-action callbacks — a flat list, filtered rather than greyed out (the
// library's List has no per-row disabled state; see TODO.md).
import {
    NEW_FILE_SHORTCUT, OPEN_FOLDER_SHORTCUT, SAVE_SHORTCUT, SAVE_AS_SHORTCUT, CLOSE_FILE_SHORTCUT,
    FORMAT_SHORTCUT, TOGGLE_EXPLORER_SHORTCUT, EXIT_SHORTCUT,
} from './shortcuts'

/** One entry in the command palette's `>`-mode list. */
export interface PaletteCommand {
    /** Stable identifier — what the palette's `List` keys the row on. */
    id: string
    /** Display text; the shortcut, when the command has one, is appended in parentheses. */
    title: string
    /** Display-only shortcut hint, from `shortcuts.ts`'s exported constants. */
    shortcut?: string
    /** Runs the command. Synchronous — every `MenuBarActions` callback already is. */
    run: () => void
}

/**
 * The subset of `EditorShell`'s `actions: MenuBarActions` object this module
 * reads, declared locally rather than imported: `EditorShell.ts` doesn't
 * export `MenuBarActions`, and this type doesn't need every field that
 * interface has anyway — `actions` already satisfies this narrower type
 * structurally, with no import (and no new `export` on `MenuBarActions`)
 * required.
 */
export interface PaletteCommandActions {
    onNewFile: () => void
    onOpenFolder: () => void
    onToggleExplorer: () => void
    onExit: () => void
    canSaveActive: () => boolean
    onSave: () => void
    hasActiveFile: () => boolean
    onSaveAs: () => void
    onCloseFile: () => void
    onFormat: () => void
    isShowingHidden: () => boolean
    onToggleHidden: (value: boolean) => void
    isShowingIgnored: () => boolean
    onToggleIgnored: (value: boolean) => void
}

/**
 * Builds the current command list from the shell's own menu-action
 * callbacks, leaving out any that would show disabled in the menu bar.
 *
 * @param actions - The subset of the shell's menu-action callbacks the palette needs.
 * @returns The commands available right now, in a fixed display order.
 */
export function buildPaletteCommands(actions: PaletteCommandActions): PaletteCommand[] {
    const commands: PaletteCommand[] = [
        { id: 'new-file',        title: 'New File',        shortcut: NEW_FILE_SHORTCUT,      run: actions.onNewFile },
        { id: 'open-folder',     title: 'Open Folder…',    shortcut: OPEN_FOLDER_SHORTCUT,   run: actions.onOpenFolder },
        { id: 'toggle-explorer', title: 'Toggle Explorer', shortcut: TOGGLE_EXPLORER_SHORTCUT, run: actions.onToggleExplorer },
        { id: 'exit',            title: 'Exit',            shortcut: EXIT_SHORTCUT,          run: actions.onExit },
    ]

    if (actions.canSaveActive()) {
        commands.push({ id: 'save', title: 'Save', shortcut: SAVE_SHORTCUT, run: actions.onSave })
    }

    if (actions.hasActiveFile()) {
        commands.push({ id: 'save-as',        title: 'Save As…',        shortcut: SAVE_AS_SHORTCUT,    run: actions.onSaveAs })
        commands.push({ id: 'close-file',     title: 'Close File',      shortcut: CLOSE_FILE_SHORTCUT, run: actions.onCloseFile })
        commands.push({ id: 'format-document', title: 'Format Document', shortcut: FORMAT_SHORTCUT,     run: actions.onFormat })
    }

    commands.push({
        id: 'toggle-hidden-files',
        title: actions.isShowingHidden() ? 'Hide Hidden Files' : 'Show Hidden Files',
        run: () => actions.onToggleHidden(!actions.isShowingHidden()),
    })
    commands.push({
        id: 'toggle-ignored-files',
        title: actions.isShowingIgnored() ? 'Hide Ignored Files' : 'Show Ignored Files',
        run: () => actions.onToggleIgnored(!actions.isShowingIgnored()),
    })

    return commands
}
