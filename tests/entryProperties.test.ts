import { describe, it, expect } from 'vitest'
import {
    formatSize, formatTimestamp, entryPropertyRows, PROPERTY_LABELS, NO_VALUE,
} from '../src/explorer/entryProperties'

describe('formatSize', () => {
    it('shows a size below one step in plain bytes', () => {
        expect(formatSize(0)).toBe('0 B')
    })

    it('shows the largest byte value still below one step in plain bytes', () => {
        expect(formatSize(1023)).toBe('1023 B')
    })

    it('shows exactly one step as a whole KiB with one decimal', () => {
        expect(formatSize(1024)).toBe('1.0 KiB')
    })

    it('carries a half-step value into the decimal', () => {
        expect(formatSize(1536)).toBe('1.5 KiB')
    })

    it('climbs two steps to MiB', () => {
        expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MiB')
    })

    it('clamps at the largest unit rather than inventing a further one', () => {
        expect(formatSize(1024 ** 5)).toBe('1024.0 TiB')
    })
})

describe('formatTimestamp', () => {
    it('zero-pads a single-digit month, day, hour, and minute', () => {
        expect(formatTimestamp(new Date(2026, 0, 15, 9, 5))).toBe('2026-01-15 09:05')
    })

    it('leaves an already two-digit field alone', () => {
        expect(formatTimestamp(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31 23:59')
    })
})

describe('entryPropertyRows', () => {
    it('returns one row per PROPERTY_LABELS entry, in order', () => {
        const rows = entryPropertyRows({ path: '/home/j/loom/src/main.ts', isDir: false }, null, null)

        expect(rows.map(row => row.label)).toEqual([...PROPERTY_LABELS])
    })

    it('shows a project-relative path and formatted size/modified for a file under the root', () => {
        const info = { size: 1536, modified: new Date(2026, 0, 15, 9, 5) }
        const rows = entryPropertyRows({ path: '/home/j/loom/src/main.ts', isDir: false }, info, '/home/j/loom')

        expect(rows).toEqual([
            { label: 'Name', value: 'main.ts' },
            { label: 'Path', value: 'src/main.ts' },
            { label: 'Type', value: 'File' },
            { label: 'Size', value: '1.5 KiB' },
            { label: 'Modified', value: '2026-01-15 09:05' },
        ])
    })

    it('shows Folder and a dashed size for a directory even when info reports a non-zero size', () => {
        const info = { size: 4096, modified: new Date(2026, 0, 15, 9, 5) }
        const rows = entryPropertyRows({ path: '/home/j/loom/src', isDir: true }, info, '/home/j/loom')

        expect(rows).toEqual([
            { label: 'Name', value: 'src' },
            { label: 'Path', value: 'src' },
            { label: 'Type', value: 'Folder' },
            { label: 'Size', value: NO_VALUE },
            { label: 'Modified', value: '2026-01-15 09:05' },
        ])
    })

    it('dashes both size and modified when info could not be read, but still names the row', () => {
        const rows = entryPropertyRows({ path: '/home/j/loom/gone.ts', isDir: false }, null, '/home/j/loom')

        expect(rows).toEqual([
            { label: 'Name', value: 'gone.ts' },
            { label: 'Path', value: 'gone.ts' },
            { label: 'Type', value: 'File' },
            { label: 'Size', value: NO_VALUE },
            { label: 'Modified', value: NO_VALUE },
        ])
    })

    it('keeps the absolute path for a file outside the project root', () => {
        const info = { size: 220, modified: new Date(2026, 0, 15, 9, 5) }
        const rows = entryPropertyRows({ path: '/etc/hosts', isDir: false }, info, '/home/j/loom')

        expect(rows).toEqual([
            { label: 'Name', value: 'hosts' },
            { label: 'Path', value: '/etc/hosts' },
            { label: 'Type', value: 'File' },
            { label: 'Size', value: '220 B' },
            { label: 'Modified', value: '2026-01-15 09:05' },
        ])
    })

    it('keeps the absolute path when no project root is open, and dashes a null modified time', () => {
        const info = { size: 0, modified: null }
        const rows = entryPropertyRows({ path: '/home/j/loom/src/main.ts', isDir: false }, info, null)

        expect(rows).toEqual([
            { label: 'Name', value: 'main.ts' },
            { label: 'Path', value: '/home/j/loom/src/main.ts' },
            { label: 'Type', value: 'File' },
            { label: 'Size', value: '0 B' },
            { label: 'Modified', value: NO_VALUE },
        ])
    })
})
