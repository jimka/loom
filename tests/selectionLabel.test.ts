import { describe, it, expect } from 'vitest'
import { selectionLabel } from '../src/editor/selectionLabel'

describe('selectionLabel', () => {
    it('shows nothing when no file is open', () => {
        expect(selectionLabel(null)).toBe('')
    })

    it('shows nothing for an empty (collapsed) selection', () => {
        expect(selectionLabel({ characters: 0, lines: 1 })).toBe('')
    })

    it('formats a single-line selection as "N selected"', () => {
        expect(selectionLabel({ characters: 8, lines: 1 })).toBe('8 selected')
    })

    it('formats a multi-line selection as "N selected, M lines"', () => {
        expect(selectionLabel({ characters: 142, lines: 6 })).toBe('142 selected, 6 lines')
    })
})
