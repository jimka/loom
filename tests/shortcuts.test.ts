import { describe, it, expect } from 'vitest'
import { isFindChord, isFormatChord, dispatchAccelerator } from '../src/shell/shortcuts'
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
    }

    return { actions, calls }
}

/** One keydown for each of the app's eleven chords. */
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

    it('runs no chord at all while a modal is open', () => {
        const { actions, calls } = recordingActions()

        for (const event of ALL_CHORDS) {
            expect(dispatchAccelerator(event, actions, true)).toBe(true)
        }

        expect(calls).toEqual([])
    })
})
