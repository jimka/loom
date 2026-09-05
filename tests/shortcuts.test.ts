import { describe, it, expect } from 'vitest'
import { isFindChord, isFormatChord } from '../src/shell/shortcuts'

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
