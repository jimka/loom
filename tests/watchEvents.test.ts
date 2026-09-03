import { describe, it, expect } from 'vitest'
import { refreshTargets, minimalRoots, isContentChangeKind } from '../src/data/watchEvents'

describe('minimalRoots', () => {
    it('drops a directory whose parent is also present', () => {
        expect(minimalRoots(['/p', '/p/src'])).toEqual(['/p'])
    })

    it('gives the same result regardless of input order', () => {
        expect(minimalRoots(['/p/src', '/p'])).toEqual(['/p'])
    })

    it('keeps both siblings, neither containing the other', () => {
        expect(minimalRoots(['/p/a', '/p/b'])).toEqual(['/p/a', '/p/b'])
    })

    it('deduplicates a repeated entry', () => {
        expect(minimalRoots(['/p', '/p'])).toEqual(['/p'])
    })

    it('does not treat a shared prefix as containment', () => {
        expect(minimalRoots(['/p', '/px/a'])).toEqual(['/p', '/px/a'])
    })

    it('returns an empty array for an empty input', () => {
        expect(minimalRoots([])).toEqual([])
    })
})

describe('refreshTargets', () => {
    it("targets a changed file's own directory", () => {
        expect(refreshTargets('/p', ['/p/src/a.ts'])).toEqual(['/p/src'])
    })

    it("targets a changed .gitignore's own directory", () => {
        expect(refreshTargets('/p', ['/p/.gitignore'])).toEqual(['/p'])
    })

    it('targets one directory shared by both ends of a rename', () => {
        expect(refreshTargets('/p', ['/p/old', '/p/new'])).toEqual(['/p'])
    })

    it('drops a target already covered by another target', () => {
        expect(refreshTargets('/p', ['/p/a.ts', '/p/src/b.ts'])).toEqual(['/p'])
    })

    it("ignores a change inside the workspace's own .loom folder", () => {
        expect(refreshTargets('/p', ['/p/.loom/workspace.json'])).toEqual([])
    })

    it('ignores a change to the .loom folder itself, not only its contents', () => {
        expect(refreshTargets('/p', ['/p/.loom'])).toEqual([])
    })

    it('ignores a path outside the project root', () => {
        expect(refreshTargets('/p', ['/other/x.ts'])).toEqual([])
    })

    it("ignores the root itself, whose parent is outside the project", () => {
        expect(refreshTargets('/p', ['/p'])).toEqual([])
    })

    it('returns an empty array for an empty batch', () => {
        expect(refreshTargets('/p', [])).toEqual([])
    })

    it('resolves a Windows-shaped batch the same way', () => {
        expect(refreshTargets('C:\\p', ['C:\\p\\src\\a.ts'])).toEqual(['C:\\p\\src'])
    })
})

describe('isContentChangeKind', () => {
    it('rejects an open event', () => {
        expect(isContentChangeKind({ access: { kind: 'open', mode: 'any' } })).toBe(false)
    })

    it('rejects a read-only close event', () => {
        expect(isContentChangeKind({ access: { kind: 'close', mode: 'read' } })).toBe(false)
    })

    it('accepts a create event', () => {
        expect(isContentChangeKind({ create: { kind: 'file' } })).toBe(true)
    })

    it('accepts a modify event', () => {
        expect(isContentChangeKind({ modify: { kind: 'data', mode: 'any' } })).toBe(true)
    })

    it('accepts a remove event', () => {
        expect(isContentChangeKind({ remove: { kind: 'file' } })).toBe(true)
    })

    it('accepts the "any" string kind', () => {
        expect(isContentChangeKind('any')).toBe(true)
    })

    it('accepts the "other" string kind', () => {
        expect(isContentChangeKind('other')).toBe(true)
    })
})
