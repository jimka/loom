import { describe, it, expect } from 'vitest'
import { parseLineNumber, countLines } from '../src/editor/lineNumber'

describe('parseLineNumber', () => {
    it('parses a bare digit string as itself', () => {
        expect(parseLineNumber('1')).toBe(1)
    })

    it('parses a multi-digit string', () => {
        expect(parseLineNumber('42')).toBe(42)
    })

    it('trims surrounding whitespace', () => {
        expect(parseLineNumber('  42  ')).toBe(42)
    })

    it('accepts leading zeros', () => {
        expect(parseLineNumber('042')).toBe(42)
    })

    it('rejects an empty string', () => {
        expect(parseLineNumber('')).toBe(null)
    })

    it('rejects a whitespace-only string', () => {
        expect(parseLineNumber('   ')).toBe(null)
    })

    it('rejects zero', () => {
        expect(parseLineNumber('0')).toBe(null)
    })

    it('rejects a negative number', () => {
        expect(parseLineNumber('-3')).toBe(null)
    })

    it('rejects a decimal number', () => {
        expect(parseLineNumber('12.5')).toBe(null)
    })

    it('rejects trailing non-digit characters', () => {
        expect(parseLineNumber('12abc')).toBe(null)
    })

    it('rejects exponential notation', () => {
        expect(parseLineNumber('1e3')).toBe(null)
    })
})

describe('countLines', () => {
    it('counts an empty document as one line', () => {
        expect(countLines('')).toBe(1)
    })

    it('counts a single line with no newline as one line', () => {
        expect(countLines('a')).toBe(1)
    })

    it('counts one newline as two lines', () => {
        expect(countLines('a\nb')).toBe(2)
    })

    it('counts a trailing newline as opening a final empty line', () => {
        expect(countLines('a\n')).toBe(2)
    })

    it('counts a \\r\\n pair once', () => {
        expect(countLines('a\r\nb')).toBe(2)
    })

    it('counts a lone \\r as a line break, matching CodeMirror\'s default splitter', () => {
        expect(countLines('a\rb')).toBe(2)
    })

    it('counts consecutive blank lines', () => {
        expect(countLines('a\n\n\nb')).toBe(4)
    })
})
