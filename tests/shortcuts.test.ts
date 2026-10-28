import { describe, it, expect } from 'vitest'
import { isFindChord, isFormatChord, isSplitEditorRightChord, dispatchAccelerator } from '../src/shell/shortcuts'
import type { AcceleratorActions } from '../src/shell/shortcuts'

/** Builds a `KeyboardEvent`-shaped input with all modifiers defaulted to off. */
const chord = (over: Partial<KeyboardEvent>): KeyboardEvent =>
    ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: '', ...over }) as KeyboardEvent

describe('isFindChord', () => {
    it('matches Ctrl+F', () => {
        expect(isFindChord(chord({ ctrlKey: true, key: 'f' }))).toBe(true)
    })

    it('matches Cmd+F', () => {
        expect(isFindChord(chord({ metaKey: true, key: 'f' }))).toBe(true)
    })

    it('matches Ctrl+F case-insensitively', () => {
        expect(isFindChord(chord({ ctrlKey: true, key: 'F' }))).toBe(true)
    })

    it('rejects Ctrl+Shift+F', () => {
        expect(isFindChord(chord({ ctrlKey: true, shiftKey: true, key: 'f' }))).toBe(false)
    })

    it('rejects Alt+Shift+F (Format\'s chord)', () => {
        expect(isFindChord(chord({ altKey: true, shiftKey: true, key: 'f' }))).toBe(false)
    })

    it('rejects Ctrl+Alt+F', () => {
        expect(isFindChord(chord({ ctrlKey: true, altKey: true, key: 'f' }))).toBe(false)
    })

    it('rejects a bare F with no modifier', () => {
        expect(isFindChord(chord({ key: 'f' }))).toBe(false)
    })

    it('rejects Ctrl+P', () => {
        expect(isFindChord(chord({ ctrlKey: true, key: 'p' }))).toBe(false)
    })
})

describe('isFormatChord', () => {
    it('rejects Ctrl+F', () => {
        expect(isFormatChord(chord({ ctrlKey: true, key: 'f' }))).toBe(false)
    })

    it('rejects Cmd+F', () => {
        expect(isFormatChord(chord({ metaKey: true, key: 'f' }))).toBe(false)
    })

    it('rejects Ctrl+F case-insensitively', () => {
        expect(isFormatChord(chord({ ctrlKey: true, key: 'F' }))).toBe(false)
    })

    it('rejects Ctrl+Shift+F', () => {
        expect(isFormatChord(chord({ ctrlKey: true, shiftKey: true, key: 'f' }))).toBe(false)
    })

    it('matches Alt+Shift+F', () => {
        expect(isFormatChord(chord({ altKey: true, shiftKey: true, key: 'f' }))).toBe(true)
    })

    it('rejects Ctrl+Alt+F', () => {
        expect(isFormatChord(chord({ ctrlKey: true, altKey: true, key: 'f' }))).toBe(false)
    })

    it('rejects a bare F with no modifier', () => {
        expect(isFormatChord(chord({ key: 'f' }))).toBe(false)
    })

    it('rejects Ctrl+P', () => {
        expect(isFormatChord(chord({ ctrlKey: true, key: 'p' }))).toBe(false)
    })
})

describe('isSplitEditorRightChord', () => {
    it('matches Ctrl+Backslash', () => {
        expect(isSplitEditorRightChord(chord({ ctrlKey: true, code: 'Backslash', key: '\\' }))).toBe(true)
    })

    it('matches Cmd+Backslash', () => {
        expect(isSplitEditorRightChord(chord({ metaKey: true, code: 'Backslash', key: '\\' }))).toBe(true)
    })

    it('matches the physical key on a layout where it types another character', () => {
        expect(isSplitEditorRightChord(chord({ ctrlKey: true, code: 'Backslash', key: "'" }))).toBe(true)
    })

    it('rejects Ctrl+Shift+Backslash (CodeMirror\'s cursorMatchingBracket)', () => {
        expect(isSplitEditorRightChord(chord({ ctrlKey: true, shiftKey: true, code: 'Backslash', key: '|' }))).toBe(false)
    })

    it('rejects Ctrl+Alt+Backslash (CodeMirror\'s indentSelection)', () => {
        expect(isSplitEditorRightChord(chord({ ctrlKey: true, altKey: true, code: 'Backslash', key: '\\' }))).toBe(false)
    })

    it('rejects a bare Backslash with no modifier', () => {
        expect(isSplitEditorRightChord(chord({ code: 'Backslash', key: '\\' }))).toBe(false)
    })

    it('rejects Ctrl on the ISO key beside left Shift', () => {
        expect(isSplitEditorRightChord(chord({ ctrlKey: true, code: 'IntlBackslash', key: '\\' }))).toBe(false)
    })
})

/** Accelerator callbacks that each record their own name into `calls` when run. */
function recordingActions(): { actions: AcceleratorActions; calls: string[] } {
    const calls: string[] = []
    const record = (name: string): (() => void) => (): void => { calls.push(name) }
    const actions: AcceleratorActions = {
        onNewFile: record('onNewFile'),
        onOpenFolder: record('onOpenFolder'),
        onSave: record('onSave'),
        onSaveAs: record('onSaveAs'),
        onCloseFile: record('onCloseFile'),
        onFormat: record('onFormat'),
        onFind: record('onFind'),
        onFindInFiles: record('onFindInFiles'),
        onToggleExplorer: record('onToggleExplorer'),
        onExit: record('onExit'),
        onOpenCommandPalette: record('onOpenCommandPalette'),
        onSplitEditorRight: record('onSplitEditorRight'),
    }

    return { actions, calls }
}

/** One keydown for each of the app's twelve chords. */
const ALL_CHORDS: KeyboardEvent[] = [
    chord({ ctrlKey: true, key: 'n' }),
    chord({ ctrlKey: true, key: 'o' }),
    chord({ ctrlKey: true, key: 's' }),
    chord({ ctrlKey: true, shiftKey: true, key: 's' }),
    chord({ ctrlKey: true, key: 'w' }),
    chord({ altKey: true, shiftKey: true, key: 'f' }),
    chord({ ctrlKey: true, key: 'f' }),
    chord({ ctrlKey: true, shiftKey: true, key: 'f' }),
    chord({ ctrlKey: true, key: 'b' }),
    chord({ ctrlKey: true, key: 'q' }),
    chord({ ctrlKey: true, key: 'p' }),
    chord({ ctrlKey: true, code: 'Backslash', key: '\\' }),
]

describe('dispatchAccelerator', () => {
    it('runs the palette for Ctrl+P with no modal open', () => {
        const { actions, calls } = recordingActions()

        expect(dispatchAccelerator(chord({ ctrlKey: true, key: 'p' }), actions, false)).toBe(true)
        expect(calls).toEqual(['onOpenCommandPalette'])
    })

    it('runs nothing for Ctrl+P while a modal is open', () => {
        const { actions, calls } = recordingActions()

        expect(dispatchAccelerator(chord({ ctrlKey: true, key: 'p' }), actions, true)).toBe(true)
        expect(calls).toEqual([])
    })

    it('ignores a key that is not a chord, modal or not', () => {
        const { actions, calls } = recordingActions()

        expect(dispatchAccelerator(chord({ key: 'p' }), actions, false)).toBe(false)
        expect(dispatchAccelerator(chord({ key: 'p' }), actions, true)).toBe(false)
        expect(calls).toEqual([])
    })

    it('runs Save As, not Save, for Ctrl+Shift+S', () => {
        const { actions, calls } = recordingActions()

        dispatchAccelerator(chord({ ctrlKey: true, shiftKey: true, key: 's' }), actions, false)

        expect(calls).toEqual(['onSaveAs'])
    })

    it('runs Find in Files, not Find, for Ctrl+Shift+F', () => {
        const { actions, calls } = recordingActions()

        dispatchAccelerator(chord({ ctrlKey: true, shiftKey: true, key: 'f' }), actions, false)

        expect(calls).toEqual(['onFindInFiles'])
    })

    it('runs Split and Move Editor Right for Ctrl+Backslash with no modal open', () => {
        const { actions, calls } = recordingActions()

        expect(dispatchAccelerator(chord({ ctrlKey: true, code: 'Backslash', key: '\\' }), actions, false)).toBe(true)
        expect(calls).toEqual(['onSplitEditorRight'])
    })

    it('runs nothing for Ctrl+Backslash while a modal is open', () => {
        const { actions, calls } = recordingActions()

        expect(dispatchAccelerator(chord({ ctrlKey: true, code: 'Backslash', key: '\\' }), actions, true)).toBe(true)
        expect(calls).toEqual([])
    })

    it('runs no chord at all while a modal is open', () => {
        const { actions, calls } = recordingActions()

        for (const event of ALL_CHORDS) {
            expect(dispatchAccelerator(event, actions, true)).toBe(true)
        }

        expect(calls).toEqual([])
    })
})
