import { describe, it, expect } from 'vitest'
import { readLayoutState, remapPanelIds, panelOrder } from '../src/data/editorLayout'
import type { LayoutState, LayoutNode, PanelNode, WindowNode } from '@jimka/typescript-ui/layout'

const PANEL = (id: string): PanelNode => ({ kind: 'panel', panelId: id })
const TABS = (children: LayoutNode[], activeIndex: number): LayoutNode => ({ kind: 'tab', children, activeIndex })
const SPLIT = (children: LayoutNode[], ratios: number[]): LayoutNode => ({
    kind: 'split',
    orientation: 'horizontal',
    children,
    ratios,
    collapsed: children.map(() => false),
})
const STATE = (root: LayoutNode, windows: WindowNode[] = []): LayoutState => ({ version: 1, root, windows })
const R = { x: 10, y: 10, width: 400, height: 300 }
const FLOAT = (content: LayoutNode): WindowNode => ({
    kind: 'window', content, header: 'b.ts', rect: R, state: 'normal', restoreRect: null,
})
const STRIP = (content: LayoutNode): WindowNode => ({
    kind: 'window', windowMode: 'strip', content, header: 'b.ts', rect: R, state: 'normal', restoreRect: null,
})

describe('readLayoutState', () => {
    it('rejects undefined', () => {
        expect(readLayoutState(undefined)).toBeUndefined()
    })

    it('rejects the wrong version', () => {
        expect(readLayoutState({ version: 2, root: PANEL('a'), windows: [] })).toBeUndefined()
    })

    it('rejects a state missing windows', () => {
        expect(readLayoutState({ version: 1, root: PANEL('a') })).toBeUndefined()
    })

    it('rejects a panel node missing panelId', () => {
        expect(readLayoutState({ version: 1, root: { kind: 'panel' }, windows: [] })).toBeUndefined()
    })

    it('rejects an unknown node kind', () => {
        expect(readLayoutState({ version: 1, root: { kind: 'blob' }, windows: [] })).toBeUndefined()
    })

    it('accepts a state with a single-panel tab root', () => {
        const state = STATE(TABS([PANEL('a')], 0))

        expect(readLayoutState(state)).toEqual(state)
    })

    it('accepts a state with a split of two tab groups', () => {
        const state = STATE(SPLIT([TABS([PANEL('a')], 0), PANEL('b')], [0.5, 0.5]))

        expect(readLayoutState(state)).toEqual(state)
    })

    it('accepts a tab-strip window', () => {
        const state = STATE(TABS([PANEL('a')], 0), [STRIP(TABS([PANEL('b'), PANEL('c')], 1))])

        expect(readLayoutState(state)).toEqual(state)
    })

    it('accepts a window whose windowMode is bare', () => {
        const state = STATE(TABS([PANEL('a')], 0), [{ ...STRIP(TABS([PANEL('b'), PANEL('c')], 1)), windowMode: 'bare' }])

        expect(readLayoutState(state)).toEqual(state)
    })

    it('rejects a window whose windowMode is an unknown string', () => {
        const window = { ...STRIP(TABS([PANEL('b'), PANEL('c')], 1)), windowMode: 'tabs' }

        expect(readLayoutState({ version: 1, root: TABS([PANEL('a')], 0), windows: [window] })).toBeUndefined()
    })

    it('rejects a window whose windowMode is not a string', () => {
        const window = { ...STRIP(TABS([PANEL('b'), PANEL('c')], 1)), windowMode: 42 }

        expect(readLayoutState({ version: 1, root: TABS([PANEL('a')], 0), windows: [window] })).toBeUndefined()
    })

    it('accepts a window with no windowMode', () => {
        const state = STATE(TABS([PANEL('a')], 0), [FLOAT(TABS([PANEL('b')], 0))])

        expect(readLayoutState(state)).toEqual(state)
    })
})

describe('remapPanelIds', () => {
    const M = new Map([['buf-1', '/p/a.ts'], ['buf-2', '/p/b.ts']])
    const TREE = SPLIT(
        [TABS([PANEL('buf-1'), PANEL('buf-3')], 1), TABS([PANEL('buf-2')], 0)],
        [0.6, 0.4],
    )

    it('remaps every panel id, dropping an unmapped panel and adjusting activeIndex', () => {
        const result = remapPanelIds(STATE(TREE), M)

        expect(result).toEqual(STATE(SPLIT(
            [TABS([PANEL('/p/a.ts')], 0), TABS([PANEL('/p/b.ts')], 0)],
            [0.6, 0.4],
        )))
    })

    it('collapses a one-pane split into its surviving pane', () => {
        const result = remapPanelIds(STATE(TREE), new Map([['buf-2', '/p/b.ts']]))

        expect(result).toEqual(STATE(TABS([PANEL('/p/b.ts')], 0)))
    })

    it('returns null when nothing in the mapping survives', () => {
        expect(remapPanelIds(STATE(TREE), new Map())).toBeNull()
    })

    it('keeps activeIndex when the active child survives', () => {
        const result = remapPanelIds(STATE(TABS([PANEL('buf-1'), PANEL('buf-2')], 1)), M)

        expect(result).toEqual(STATE(TABS([PANEL('/p/a.ts'), PANEL('/p/b.ts')], 1)))
    })

    it('renormalizes ratios over the surviving panes', () => {
        const result = remapPanelIds(
            STATE(SPLIT([PANEL('buf-1'), PANEL('buf-2'), PANEL('buf-3')], [0.5, 0.25, 0.25])),
            M,
        )

        expect(result).toEqual(STATE(SPLIT([PANEL('/p/a.ts'), PANEL('/p/b.ts')], [2 / 3, 1 / 3])))
    })

    it('remaps a float window, keeping it when its content survives', () => {
        const result = remapPanelIds(STATE(PANEL('buf-1'), [FLOAT(TABS([PANEL('buf-2')], 0))]), M)

        expect(result).toEqual(STATE(PANEL('/p/a.ts'), [FLOAT(TABS([PANEL('/p/b.ts')], 0))]))
    })

    it('drops a float whose content does not survive', () => {
        const result = remapPanelIds(STATE(PANEL('buf-1'), [FLOAT(TABS([PANEL('buf-2')], 0))]), new Map([['buf-1', '/p/a.ts']]))

        expect(result).toEqual(STATE(PANEL('/p/a.ts'), []))
    })

    it('remaps a bare panel root', () => {
        expect(remapPanelIds(STATE(PANEL('buf-1')), M)).toEqual(STATE(PANEL('/p/a.ts')))
    })

    it('keeps a tab-strip window strip-mode, remapping its tabs and active index', () => {
        const result = remapPanelIds(
            STATE(TABS([PANEL('buf-1')], 0), [STRIP(TABS([PANEL('buf-1'), PANEL('buf-3'), PANEL('buf-2')], 2))]),
            M,
        )

        expect(result?.windows).toHaveLength(1)
        expect(result?.windows[0].windowMode).toBe('strip')
        expect(result?.windows[0].content).toEqual(TABS([PANEL('/p/a.ts'), PANEL('/p/b.ts')], 1))
    })

    it('drops a tab-strip window none of whose tabs maps', () => {
        const result = remapPanelIds(STATE(TABS([PANEL('buf-1')], 0), [STRIP(TABS([PANEL('buf-3')], 0))]), M)

        expect(result?.windows).toEqual([])
    })

    it('adds no windowMode key to a window saved without one', () => {
        const result = remapPanelIds(STATE(TABS([PANEL('buf-1')], 0), [FLOAT(TABS([PANEL('buf-2')], 0))]), M)

        expect(result?.windows).toHaveLength(1)
        expect('windowMode' in result!.windows[0]).toBe(false)
    })

    it('keeps nested split ratios and orientations unchanged', () => {
        const inner: LayoutNode = {
            kind: 'split',
            orientation: 'vertical',
            children: [TABS([PANEL('buf-2')], 0), TABS([PANEL('buf-4')], 0)],
            ratios: [0.3, 0.7],
            collapsed: [false, false],
        }
        const mapping = new Map([...M, ['buf-4', '/p/d.ts']])
        const result = remapPanelIds(STATE(SPLIT([TABS([PANEL('buf-1')], 0), inner], [0.4, 0.6])), mapping)
        const root = result?.root
        const remappedInner = root?.kind === 'split' ? root.children[1] : undefined

        expect(root?.kind === 'split' ? root.ratios : undefined).toEqual([0.4, 0.6])
        expect(remappedInner?.kind === 'split' ? remappedInner.ratios : undefined).toEqual([0.3, 0.7])
        expect(remappedInner?.kind === 'split' ? remappedInner.orientation : undefined).toBe('vertical')
    })
})

describe('panelOrder', () => {
    it('walks the tiled tree depth-first', () => {
        const TREE = SPLIT(
            [TABS([PANEL('buf-1'), PANEL('buf-3')], 1), TABS([PANEL('buf-2')], 0)],
            [0.6, 0.4],
        )

        expect(panelOrder(STATE(TREE))).toEqual(['buf-1', 'buf-3', 'buf-2'])
    })

    it('lists the tiled tree before any floats', () => {
        expect(panelOrder(STATE(PANEL('buf-1'), [FLOAT(TABS([PANEL('buf-2')], 0))]))).toEqual(['buf-1', 'buf-2'])
    })

    it('returns an empty array for an empty tab group', () => {
        expect(panelOrder(STATE(TABS([], 0)))).toEqual([])
    })

    it('lists every tab of a tab-strip window, in strip order', () => {
        const state = STATE(TABS([PANEL('buf-1')], 0), [STRIP(TABS([PANEL('buf-2'), PANEL('buf-3')], 0))])

        expect(panelOrder(state)).toEqual(['buf-1', 'buf-2', 'buf-3'])
    })
})
