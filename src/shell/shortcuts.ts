// The app's keyboard accelerators, single-sourced so the menu shortcut hints
// and the real key bindings never drift apart. The library's
// MenuItemConfig.shortcut is a DISPLAY hint only — it does not bind the key
// (see packages/lib/docs/recipes/keyboard-shortcuts.md) — so the app installs
// the real accelerators as a single window keydown listener matched by the
// isXChord helpers below, mirroring
// ../../sqladmin/frontend/src/shell/queryShortcuts.ts and
// ../../sqladmin/frontend/src/shell/SqlAdminShell.ts's installAccelerators.
//
// Every chord but Format rides Ctrl/Cmd, matching the OS-conventional
// Open/Save/Close family; Format uses Alt+Shift so it can't collide with a
// browser or OS binding on the Ctrl/Cmd+S family. CodeMirror's default
// keymap binds none of these — `Mod-\` is free there, while `Mod-Alt-\` and
// `Shift-Mod-\` are CodeMirror's own — so the window listener sees them even
// while the caret is in the document (see the plan's "Potential Challenges"
// note on Ctrl+S). Every chord does nothing while a modal dialog is open (see
// dispatchAccelerator), as SqlAdminShell.ts's installAccelerators does.

import { LayerManager } from '@jimka/typescript-ui/core'

/** Display labels shown on the menu items' shortcut hints. */
export const NEW_FILE_SHORTCUT = 'Ctrl/Cmd+N'
export const OPEN_FOLDER_SHORTCUT = 'Ctrl/Cmd+O'
export const SAVE_SHORTCUT = 'Ctrl/Cmd+S'
export const SAVE_AS_SHORTCUT = 'Ctrl/Cmd+Shift+S'
export const CLOSE_FILE_SHORTCUT = 'Ctrl/Cmd+W'
export const FORMAT_SHORTCUT = 'Alt+Shift+F'
export const TOGGLE_EXPLORER_SHORTCUT = 'Ctrl/Cmd+B'
export const EXIT_SHORTCUT = 'Ctrl/Cmd+Q'
export const COMMAND_PALETTE_SHORTCUT = 'Ctrl/Cmd+P'
export const FIND_SHORTCUT = 'Ctrl/Cmd+F'
export const FIND_IN_FILES_SHORTCUT = 'Ctrl/Cmd+Shift+F'
export const SPLIT_EDITOR_RIGHT_SHORTCUT = 'Ctrl/Cmd+\\'

/**
 * Whether a keydown is a `Ctrl/Cmd(+Shift)+<key>` chord with no other
 * modifier.
 *
 * @param event - The keydown event.
 * @param key - The lowercase letter the chord binds.
 * @param shift - Whether Shift must also be held. Defaults to `false`.
 * @returns `true` when the event matches exactly.
 */
function isCtrlChord(event: KeyboardEvent, key: string, shift = false): boolean {
    return (event.ctrlKey || event.metaKey)
        && !event.altKey
        && event.shiftKey === shift
        && event.key.toLowerCase() === key
}

/** Whether a keydown is the New-File chord (Ctrl/Cmd+N). */
export function isNewFileChord(event: KeyboardEvent): boolean {
    return isCtrlChord(event, 'n')
}

/** Whether a keydown is the Open-Folder chord (Ctrl/Cmd+O). */
export function isOpenFolderChord(event: KeyboardEvent): boolean {
    return isCtrlChord(event, 'o')
}

/** Whether a keydown is the Save chord (Ctrl/Cmd+S). */
export function isSaveChord(event: KeyboardEvent): boolean {
    return isCtrlChord(event, 's')
}

/** Whether a keydown is the Save-As chord (Ctrl/Cmd+Shift+S). */
export function isSaveAsChord(event: KeyboardEvent): boolean {
    return isCtrlChord(event, 's', true)
}

/** Whether a keydown is the Close-File chord (Ctrl/Cmd+W). */
export function isCloseFileChord(event: KeyboardEvent): boolean {
    return isCtrlChord(event, 'w')
}

/** Whether a keydown is the Format chord (Alt+Shift+F). */
export function isFormatChord(event: KeyboardEvent): boolean {
    return event.altKey
        && event.shiftKey
        && !event.ctrlKey
        && !event.metaKey
        && event.key.toLowerCase() === 'f'
}

/** Whether a keydown is the Find chord (Ctrl/Cmd+F). */
export function isFindChord(event: KeyboardEvent): boolean {
    return isCtrlChord(event, 'f')
}

/** Whether a keydown is the Find-in-Files chord (Ctrl/Cmd+Shift+F). */
export function isFindInFilesChord(event: KeyboardEvent): boolean {
    return isCtrlChord(event, 'f', true)
}

/** Whether a keydown is the Toggle-Explorer chord (Ctrl/Cmd+B). */
export function isToggleExplorerChord(event: KeyboardEvent): boolean {
    return isCtrlChord(event, 'b')
}

/**
 * Whether a keydown is the Split-and-Move-Editor-Right chord (Ctrl/Cmd + the
 * physical Backslash key). Matched on `event.code`, not `event.key`, so
 * layouts that type `\` only through AltGr (Swedish, German) can still press
 * it; Shift and Alt are excluded because CodeMirror binds `Shift-Mod-\` and
 * `Mod-Alt-\`.
 */
export function isSplitEditorRightChord(event: KeyboardEvent): boolean {
    return (event.ctrlKey || event.metaKey)
        && !event.altKey
        && !event.shiftKey
        && event.code === 'Backslash'
}

/** Whether a keydown is the Exit chord (Ctrl/Cmd+Q). */
export function isExitChord(event: KeyboardEvent): boolean {
    return isCtrlChord(event, 'q')
}

/** Whether a keydown is the Command-Palette chord (Ctrl/Cmd+P). */
export function isCommandPaletteChord(event: KeyboardEvent): boolean {
    return isCtrlChord(event, 'p')
}

/** The accelerator callbacks `installAccelerators` dispatches each chord to. */
export interface AcceleratorActions {
    /** Ctrl/Cmd+N — opens a new untitled buffer. */
    onNewFile: () => void
    /** Ctrl/Cmd+O — shows the native folder picker. */
    onOpenFolder: () => void
    /** Ctrl/Cmd+S — saves the active file. */
    onSave: () => void
    /** Ctrl/Cmd+Shift+S — shows the native save-as dialog for the active file. */
    onSaveAs: () => void
    /** Ctrl/Cmd+W — closes the active file's tab. */
    onCloseFile: () => void
    /** Alt+Shift+F — reformats the active document. */
    onFormat: () => void
    /** Ctrl/Cmd+F — opens the find/replace bar over the active editor. */
    onFind: () => void
    /** Ctrl/Cmd+Shift+F — switches to and focuses the explorer's Search view. */
    onFindInFiles: () => void
    /** Ctrl/Cmd+B — collapses/expands the explorer pane. */
    onToggleExplorer: () => void
    /** Ctrl/Cmd+Q — requests the window close. */
    onExit: () => void
    /** Ctrl/Cmd+P — opens the command palette. */
    onOpenCommandPalette: () => void
    /** Ctrl/Cmd+\ — moves the active file into a new group on the right. */
    onSplitEditorRight: () => void
}

/**
 * The callback `event`'s chord dispatches to. Checked in the order listed,
 * the same order the listener used before this table existed.
 *
 * @param event - The keydown event.
 * @param actions - The callbacks each chord dispatches to.
 * @returns The matching callback, or `null` when `event` is not one of the app's chords.
 */
function acceleratorFor(event: KeyboardEvent, actions: AcceleratorActions): (() => void) | null {
    const bindings: ReadonlyArray<readonly [(event: KeyboardEvent) => boolean, () => void]> = [
        [isNewFileChord, actions.onNewFile],
        [isOpenFolderChord, actions.onOpenFolder],
        [isSaveAsChord, actions.onSaveAs],
        [isSaveChord, actions.onSave],
        [isCloseFileChord, actions.onCloseFile],
        [isFormatChord, actions.onFormat],
        [isFindInFilesChord, actions.onFindInFiles],
        [isFindChord, actions.onFind],
        [isToggleExplorerChord, actions.onToggleExplorer],
        [isSplitEditorRightChord, actions.onSplitEditorRight],
        [isCommandPaletteChord, actions.onOpenCommandPalette],
        [isExitChord, actions.onExit],
    ]
    const binding = bindings.find(([matches]) => matches(event))

    return binding ? binding[1] : null
}

/**
 * Runs the callback `event`'s chord dispatches to, unless a modal layer is
 * open. Behind a modal the app is inert, so whatever a chord opened or
 * focused there would be out of reach, and Ctrl/Cmd+W or Ctrl/Cmd+Q would
 * stack a second unsaved-changes prompt over the first.
 *
 * @param event - The keydown event.
 * @param actions - The callbacks each chord dispatches to.
 * @param modalOpen - Whether a modal layer is open, as `LayerManager.hasModalLayer()` reports it.
 * @returns Whether `event` is one of the app's chords, whether or not it ran.
 */
export function dispatchAccelerator(event: KeyboardEvent, actions: AcceleratorActions, modalOpen: boolean): boolean {
    const action = acceleratorFor(event, actions)

    if (action === null) {
        return false
    }

    if (!modalOpen) {
        action()
    }

    return true
}

/**
 * Installs the app's global accelerators as a single `window` keydown
 * listener. `preventDefault()` is called for every chord of the app's,
 * including one a modal suppressed, so a webview's own binding for the same
 * key (print on Ctrl/Cmd+P, find on Ctrl/Cmd+F) never opens over the modal;
 * every other key reaching `window` (Tab traversal, browser shortcuts the
 * app doesn't bind) keeps its default behaviour.
 *
 * @param actions - The callbacks each chord dispatches to.
 */
export function installAccelerators(actions: AcceleratorActions): void {
    window.addEventListener('keydown', (event: KeyboardEvent) => {
        if (dispatchAccelerator(event, actions, LayerManager.hasModalLayer())) {
            event.preventDefault()
        }
    })
}
