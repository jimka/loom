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
// keymap binds none of these, so the window listener sees them even while
// the caret is in the document (see the plan's "Potential Challenges" note
// on Ctrl+S).

/** Display labels shown on the menu items' shortcut hints. */
export const OPEN_FOLDER_SHORTCUT = 'Ctrl/Cmd+O'
export const SAVE_SHORTCUT = 'Ctrl/Cmd+S'
export const SAVE_AS_SHORTCUT = 'Ctrl/Cmd+Shift+S'
export const CLOSE_FILE_SHORTCUT = 'Ctrl/Cmd+W'
export const FORMAT_SHORTCUT = 'Alt+Shift+F'
export const TOGGLE_EXPLORER_SHORTCUT = 'Ctrl/Cmd+B'

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

/** Whether a keydown is the Toggle-Explorer chord (Ctrl/Cmd+B). */
export function isToggleExplorerChord(event: KeyboardEvent): boolean {
  return isCtrlChord(event, 'b')
}

/** The accelerator callbacks `installAccelerators` dispatches each chord to. */
export interface AcceleratorActions {
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
  /** Ctrl/Cmd+B — collapses/expands the explorer pane. */
  onToggleExplorer: () => void
}

/**
 * Installs the app's global accelerators as a single `window` keydown
 * listener. `preventDefault()` is called only for a chord actually handled,
 * so every other key reaching `window` (Tab traversal, browser-default
 * shortcuts the app doesn't bind) keeps its default behaviour.
 *
 * @param actions - The callbacks each chord dispatches to.
 */
export function installAccelerators(actions: AcceleratorActions): void {
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    let matched = true

    if (isOpenFolderChord(event)) {
      actions.onOpenFolder()
    } else if (isSaveAsChord(event)) {
      actions.onSaveAs()
    } else if (isSaveChord(event)) {
      actions.onSave()
    } else if (isCloseFileChord(event)) {
      actions.onCloseFile()
    } else if (isFormatChord(event)) {
      actions.onFormat()
    } else if (isToggleExplorerChord(event)) {
      actions.onToggleExplorer()
    } else {
      matched = false
    }

    if (matched) {
      event.preventDefault()
    }
  })
}
