import { describe, it, expect } from 'vitest'
import { cursorLabel } from '../src/editor/cursorLabel'

describe('cursorLabel', () => {
    it('formats the document start as Ln 1, Col 1 · Pos 1', () => {
        expect(cursorLabel({ line: 1, column: 1, offset: 0 })).toBe('Ln 1, Col 1 · Pos 1')
    })

    it('formats a mid-document position as Ln 12, Col 5 · Pos 245', () => {
        expect(cursorLabel({ line: 12, column: 5, offset: 244 })).toBe('Ln 12, Col 5 · Pos 245')
    })

    it('formats a far position with no padding as Ln 340, Col 128 · Pos 10000', () => {
        expect(cursorLabel({ line: 340, column: 128, offset: 9999 })).toBe('Ln 340, Col 128 · Pos 10000')
    })

    it('shows nothing when no file is open', () => {
        expect(cursorLabel(null)).toBe('')
    })
})
