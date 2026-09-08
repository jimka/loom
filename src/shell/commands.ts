// Builds the command palette's `>`-mode command list from EditorShell's own
// menu-action callbacks — every command is always listed, each carrying the
// same `enabled` flag the matching menu-bar item computes.
import {
    NEW_FILE_SHORTCUT, OPEN_FOLDER_SHORTCUT, SAVE_SHORTCUT, SAVE_AS_SHORTCUT, CLOSE_FILE_SHORTCUT,
    FORMAT_SHORTCUT, FIND_SHORTCUT, TOGGLE_EXPLORER_SHORTCUT, EXIT_SHORTCUT,
} from './shortcuts'

/** One entry in the command palette's `>`-mode list. */
export interface PaletteCommand {
    /** Stable identifier — what the palette's `List` keys the row on. */
    id: string
    /** Display text; the shortcut, when the command has one, is appended in parentheses. */
    title: string
    /** Display-only shortcut hint, from `shortcuts.ts`'s exported constants. */
    shortcut?: string
    /**
     * Whether the command can run right now. `false` renders the palette row
     * dim and refuses a click or an Enter/Space commit — the same treatment
     * the matching menu-bar item gets when its own `enabled` expression is
     * false.
     */
    enabled: boolean
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
    onFind: () => void
    isShowingHidden: () => boolean
    onToggleHidden: (value: boolean) => void
    isShowingIgnored: () => boolean
    onToggleIgnored: (value: boolean) => void
}

/**
 * Builds the current command list from the shell's own menu-action
 * callbacks. Every command is always returned; each carries the same
 * `enabled` flag its matching menu-bar item computes, so the palette and the
 * menu bar never disagree about what can run right now.
 *
 * @param actions - The subset of the shell's menu-action callbacks the palette needs.
 * @returns All eleven commands, in a fixed display order.
 */
export function buildPaletteCommands(actions: PaletteCommandActions): PaletteCommand[] {
    // Read once so every command below is built against one consistent
    // snapshot of the shell's state.
    const hasActiveFile = actions.hasActiveFile()
    const canSaveActive = actions.canSaveActive()

    return [
        { id: 'new-file',        title: 'New File',        shortcut: NEW_FILE_SHORTCUT,        enabled: true,          run: actions.onNewFile },
        { id: 'open-folder',     title: 'Open Folder…',    shortcut: OPEN_FOLDER_SHORTCUT,     enabled: true,          run: actions.onOpenFolder },
        { id: 'toggle-explorer', title: 'Toggle Explorer', shortcut: TOGGLE_EXPLORER_SHORTCUT, enabled: true,          run: actions.onToggleExplorer },
        { id: 'exit',            title: 'Exit',            shortcut: EXIT_SHORTCUT,            enabled: true,          run: actions.onExit },
        { id: 'save',            title: 'Save',            shortcut: SAVE_SHORTCUT,            enabled: canSaveActive, run: actions.onSave },
        { id: 'save-as',         title: 'Save As…',        shortcut: SAVE_AS_SHORTCUT,         enabled: hasActiveFile, run: actions.onSaveAs },
        { id: 'close-file',      title: 'Close File',      shortcut: CLOSE_FILE_SHORTCUT,      enabled: hasActiveFile, run: actions.onCloseFile },
        { id: 'find',            title: 'Find…',           shortcut: FIND_SHORTCUT,            enabled: hasActiveFile, run: actions.onFind },
        { id: 'format-document', title: 'Format Document', shortcut: FORMAT_SHORTCUT,          enabled: hasActiveFile, run: actions.onFormat },
        {
            id: 'toggle-hidden-files',
            title: actions.isShowingHidden() ? 'Hide Hidden Files' : 'Show Hidden Files',
            enabled: true,
            run: () => actions.onToggleHidden(!actions.isShowingHidden()),
        },
        {
            id: 'toggle-ignored-files',
            title: actions.isShowingIgnored() ? 'Hide Ignored Files' : 'Show Ignored Files',
            enabled: true,
            run: () => actions.onToggleIgnored(!actions.isShowingIgnored()),
        },
    ]
}
