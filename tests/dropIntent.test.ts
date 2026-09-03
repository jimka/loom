import { describe, it, expect } from 'vitest'
import { dropIntent } from '../src/shell/dropIntent'

describe('dropIntent', () => {
    it('reports no intent when nothing was dropped', () => {
        expect(dropIntent([])).toEqual({ kind: 'none' })
    })

    it('opens a single dropped file', () => {
        expect(dropIntent([{ path: '/p/a.ts', isDir: false }])).toEqual({
            kind: 'files',
            paths: ['/p/a.ts'],
        })
    })

    it('opens several dropped files, keeping drop order', () => {
        expect(dropIntent([
            { path: '/p/a.ts', isDir: false },
            { path: '/p/b.ts', isDir: false },
        ])).toEqual({
            kind: 'files',
            paths: ['/p/a.ts', '/p/b.ts'],
        })
    })

    it('opens a single dropped folder as the workspace', () => {
        expect(dropIntent([{ path: '/p/app', isDir: true }])).toEqual({
            kind: 'folder',
            path: '/p/app',
        })
    })

    it('refuses several dropped folders', () => {
        expect(dropIntent([
            { path: '/p/app', isDir: true },
            { path: '/p/lib', isDir: true },
        ])).toEqual({ kind: 'unsupported' })
    })

    it('refuses a mix of a file and a folder', () => {
        expect(dropIntent([
            { path: '/p/a.ts', isDir: false },
            { path: '/p/app', isDir: true },
        ])).toEqual({ kind: 'unsupported' })
    })
})
