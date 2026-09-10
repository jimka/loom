// Pure translation and validation for the editor dock's persisted arrangement
// — no Tauri imports, so it runs in vitest's `node` environment, the same
// split `session.ts` and `workspaceState.ts` already draw between pure data
// shape and Tauri-backed read/write. `Dock.getLayoutState()`/`setLayoutState`
// key every panel by a minted, per-launch id; this module rewrites those ids
// to file paths for persistence and back to fresh ids on restore.
import type { LayoutState, LayoutNode, PanelNode, SplitNode, TabNode, WindowNode } from '@jimka/typescript-ui/layout'

/** The schema's only valid `LayoutState.version`. */
const LAYOUT_STATE_VERSION = 1

/**
 * Validates `value` as a {@link LayoutState}, discarding the whole value on
 * any defect — the same all-or-nothing rule `session.ts`'s
 * `readLayoutSizeArray` applies to a stale `paneSizes` array.
 *
 * @param value - The candidate value, typically parsed from stored JSON.
 * @returns `value` typed as a `LayoutState`, or `undefined` when it is not one.
 */
export function readLayoutState(value: unknown): LayoutState | undefined {
    if (typeof value !== 'object' || value === null) {
        return undefined
    }

    const candidate = value as Record<string, unknown>

    if (candidate.version !== LAYOUT_STATE_VERSION || !Array.isArray(candidate.windows)) {
        return undefined
    }

    if (!isLayoutNode(candidate.root) || !candidate.windows.every(isWindowNode)) {
        return undefined
    }

    return value as LayoutState
}

/**
 * Rewrites every panel id in `state` through `mapping`, dropping what no
 * longer resolves: an unmapped panel, a tab group left with no panels, a
 * split pane left empty (its `ratios`/`collapsed` entry going with it), and a
 * float window left with no content. A split left with one pane collapses
 * into that pane. Returns `null` when nothing survives.
 *
 * @param state - The layout to remap.
 * @param mapping - Old panel id to new panel id.
 * @returns The remapped layout, or `null` when every panel dropped out.
 */
export function remapPanelIds(state: LayoutState, mapping: ReadonlyMap<string, string>): LayoutState | null {
    const root = remapNode(state.root, mapping)

    if (root === null) {
        return null
    }

    const windows = state.windows
        .map(window => remapWindow(window, mapping))
        .filter((window): window is WindowNode => window !== null)

    return { version: LAYOUT_STATE_VERSION, root, windows }
}

/**
 * Every panel id in `state`, in document order: the tiled tree depth-first,
 * then each float in `windows` order.
 *
 * @param state - The layout to walk.
 * @returns The panel ids in document order.
 */
export function panelOrder(state: LayoutState): string[] {
    const order: string[] = []

    collectPanelIds(state.root, order)

    for (const window of state.windows) {
        if (window.content !== undefined) {
            collectPanelIds(window.content, order)
        } else if (window.panelId !== undefined) {
            order.push(window.panelId)
        }
    }

    return order
}

/** Appends every panel id under `node`, depth-first, to `order`. */
function collectPanelIds(node: LayoutNode, order: string[]): void {
    if (node.kind === 'panel') {
        order.push(node.panelId)

        return
    }

    for (const child of node.children) {
        collectPanelIds(child, order)
    }
}

/**
 * Remaps one node, returning `null` when nothing under it survives — the
 * signal each parent uses to filter its own children.
 */
function remapNode(node: LayoutNode, mapping: ReadonlyMap<string, string>): LayoutNode | null {
    if (node.kind === 'panel') {
        const mapped = mapping.get(node.panelId)

        return mapped === undefined ? null : { ...node, panelId: mapped }
    }

    if (node.kind === 'tab') {
        return remapTab(node, mapping)
    }

    return remapSplit(node, mapping)
}

/** Remaps a `tab` node's children, adjusting `activeIndex` to keep tracking the same child if it survives. */
function remapTab(node: TabNode, mapping: ReadonlyMap<string, string>): LayoutNode | null {
    const active = node.children[node.activeIndex]
    const kept: LayoutNode[] = []
    let activeIndex = 0

    for (const child of node.children) {
        const mappedChild = remapNode(child, mapping)

        if (mappedChild !== null) {
            if (child === active) {
                activeIndex = kept.length
            }

            kept.push(mappedChild)
        }
    }

    return kept.length === 0 ? null : { kind: 'tab', children: kept, activeIndex }
}

/**
 * Remaps a `split` node's children, dropping each pane that drops out along
 * with its `ratios`/`collapsed` entry, renormalizing the surviving ratios,
 * and collapsing a one-pane result into that pane — the same collapse
 * `Dock.collapseSinglePaneSplit` performs on a live tree when a region is
 * pruned, applied here so a restore never rebuilds a one-pane split.
 */
function remapSplit(node: SplitNode, mapping: ReadonlyMap<string, string>): LayoutNode | null {
    const kept: LayoutNode[] = []
    const ratios: number[] = []
    const collapsed: boolean[] = []

    node.children.forEach((child, index) => {
        const mappedChild = remapNode(child, mapping)

        if (mappedChild !== null) {
            kept.push(mappedChild)
            ratios.push(node.ratios[index] ?? 0)
            collapsed.push(node.collapsed[index] ?? false)
        }
    })

    if (kept.length === 0) {
        return null
    }

    if (kept.length === 1) {
        return kept[0]
    }

    return { kind: 'split', orientation: node.orientation, children: kept, ratios: normalizeRatios(ratios), collapsed }
}

/**
 * Divides each ratio by their sum so the array still sums to 1. A sum of 0
 * (every surviving ratio was itself 0) distributes evenly across the
 * survivors instead of dividing by zero.
 *
 * @param ratios - The surviving panes' ratios, in order.
 * @returns The same-length array, normalized to sum to 1.
 */
function normalizeRatios(ratios: number[]): number[] {
    const sum = ratios.reduce((total, ratio) => total + ratio, 0)

    return sum === 0 ? ratios.map(() => 1 / ratios.length) : ratios.map(ratio => ratio / sum)
}

/**
 * Remaps a window node: a node with `content` keeps it when the content
 * survives remapping, a legacy `panelId`-only node survives only when its id
 * maps, and a node that survives neither way drops. `serializeLayout`
 * captures every open `Window`, not only the dock's own floats, so a
 * `LayoutState` could in principle carry a window whose content tree
 * contains no panel id the mapping knows — such a window drops here too.
 */
function remapWindow(window: WindowNode, mapping: ReadonlyMap<string, string>): WindowNode | null {
    if (window.content !== undefined) {
        const content = remapNode(window.content, mapping)

        return content === null ? null : { ...window, content }
    }

    if (window.panelId !== undefined) {
        const mapped = mapping.get(window.panelId)

        return mapped === undefined ? null : { ...window, panelId: mapped }
    }

    return null
}

/** Whether `value` is a well-shaped {@link LayoutNode} — a `panel`, `tab`, or `split` node, validated recursively. */
function isLayoutNode(value: unknown): value is LayoutNode {
    if (typeof value !== 'object' || value === null) {
        return false
    }

    const node = value as Record<string, unknown>

    if (node.kind === 'panel') {
        return typeof (node as Partial<PanelNode>).panelId === 'string'
    }

    if (node.kind === 'tab') {
        return Array.isArray(node.children) && typeof node.activeIndex === 'number' && node.children.every(isLayoutNode)
    }

    if (node.kind === 'split') {
        return Array.isArray(node.children) && Array.isArray(node.ratios) && Array.isArray(node.collapsed)
            && node.children.every(isLayoutNode)
    }

    return false
}

/** Whether `value` is a well-shaped {@link WindowNode} — either a `content` subtree or a legacy `panelId`, both optional but validated when present. */
function isWindowNode(value: unknown): value is WindowNode {
    if (typeof value !== 'object' || value === null) {
        return false
    }

    const node = value as Record<string, unknown>

    if (node.content !== undefined && !isLayoutNode(node.content)) {
        return false
    }

    if (node.panelId !== undefined && typeof node.panelId !== 'string') {
        return false
    }

    return true
}
