import { describe, it, expect } from 'vitest'
import { cursorLabel } from '../src/editor/cursorLabel'

describe('cursorLabel', () => {
    it('formats the first line and column as Ln 1, Col 1', () => {
        expect(cursorLabel({ line: 1, column: 1 })).toBe('Ln 1, Col 1')
    })

    it('formats a mid-document position as Ln 12, Col 5', () => {
        expect(cursorLabel({ line: 12, column: 5 })).toBe('Ln 12, Col 5')
    })

    it('formats a far position with no padding as Ln 340, Col 128', () => {
        expect(cursorLabel({ line: 340, column: 128 })).toBe('Ln 340, Col 128')
    })

    it('shows nothing when no file is open', () => {
        expect(cursorLabel(null)).toBe('')
    })
})
