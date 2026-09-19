// QA-only harness — injected into index.html by `qa/vite.config.qa.ts` (run via
// `runqa.sh`; see README.md). No-op unless the page URL carries `?qa=<name>`.
// Drives one gutter-drag scenario in the real app and POSTs the measurements to
// /__qa/report.
//
// Query params:
//   qa=<name>          run + report under this name
//   mode=filetree | search-empty | search-populated | noproject
//   q=<query>          search text for search-populated (default "function")
//   css=<css>          extra stylesheet injected before measuring (experiments)
//   abl=<a,b,...>      JS ablations applied before measuring (see ABLATIONS)
//   deepwrites=1       also count direct camelCase style writes (needs count=1).
//                      Off by default: wrapping ~hundreds of accessors shifts
//                      frame timings, so use it for counters, not for timing.
//   frames=<n>         drag frames (default 150)
//   step=<px>          gutter px per frame (default 3), triangle wave

export {}

/** The project folder the harness opens, supplied by `vite.config.qa.ts`'s `define`. */
declare const __QA_PROJECT_ROOT__: string

const params = new URLSearchParams(location.search)
const scenario = params.get('qa')

// Must be the same module instance the app imports: identical URL → identical
// module → shared prototypes, which every ablation and counter relies on. By
// default that is the bare specifier, resolved exactly as the app resolves it.
// `lib=<dist dir>` overrides it so a worktree build can be measured; `runqa.sh`
// passes it for the `wt` arm and points Loom's package symlink at the same
// build, so the app and the harness still agree.
const LIB_DIST = params.get('lib')
const { Body } = LIB_DIST
    ? await import(/* @vite-ignore */ `${LIB_DIST}/core.es.js`)
    : await import('@jimka/typescript-ui/core')

type AnyObj = Record<string, unknown>

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor<T>(probe: () => T | null | undefined | false, timeoutMs: number, label: string): Promise<T> {
    const start = performance.now()

    while (performance.now() - start < timeoutMs) {
        const value = probe()

        if (value) {
            return value
        }

        await sleep(50)
    }

    throw new Error(`timeout waiting for ${label}`)
}

function isPainted(el: Element): boolean {
    const rect = el.getBoundingClientRect()

    if (rect.width === 0 || rect.height === 0) {
        return false
    }

    if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) {
        return false
    }

    let node: Element | null = el

    while (node) {
        const style = getComputedStyle(node)

        if (style.visibility === 'hidden' || style.display === 'none') {
            return false
        }

        node = node.parentElement
    }

    return true
}

function countPainted(selector: string): number {
    return Array.from(document.querySelectorAll(selector)).filter(isPainted).length
}

function findButtonByText(text: string): HTMLElement {
    const all = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))
    const hit = all.find(b => (b.textContent ?? '').includes(text) || (b.getAttribute('aria-label') ?? '').includes(text))

    if (!hit) {
        throw new Error(`no button with text ${text}`)
    }

    return hit
}

function fireMouse(type: string, target: EventTarget, x: number, y: number): void {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' ? 0 : 1 }))
}

async function measureRaf(frames: number): Promise<number[]> {
    const gaps: number[] = []
    let last = performance.now()

    await new Promise<void>(resolve => {
        let i = 0

        function step(now: number): void {
            gaps.push(now - last)
            last = now
            i++

            if (i < frames) {
                requestAnimationFrame(step)
            } else {
                resolve()
            }
        }

        requestAnimationFrame(step)
    })

    return gaps.slice(1)
}

/**
 * Picks the gutter to drag. `explorer` (default) is the leftmost gutter — the
 * shell's explorer split. `dock-v` is a vertical bar inside the Dock (drag
 * along x, resizes widths); `dock-h` a horizontal bar inside the Dock (drag
 * along y, resizes heights). The axis follows the bar's shape.
 */
function pickGutter(which: string): { gutter: HTMLElement, axis: 'x' | 'y', label: string } {
    const gutters = Array.from(document.querySelectorAll<HTMLElement>('.SplitGutter'))
        .map(g => ({ g, r: g.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && r.height > 0)
        .sort((a, b) => a.r.left - b.r.left)

    if (gutters.length === 0) {
        throw new Error('no .SplitGutter')
    }

    if (which === 'explorer' || gutters.length === 1) {
        return { gutter: gutters[0].g, axis: 'x', label: `explorer gutter (${gutters.length} gutters total)` }
    }

    const dock = gutters.slice(1)
    const pick = which === 'dock-h'
        ? dock.find(({ r }) => r.width > r.height)
        : dock.find(({ r }) => r.height > r.width)

    if (!pick) {
        throw new Error(`no ${which} gutter among ${dock.length} dock gutters`)
    }

    return {
        gutter: pick.g,
        axis: which === 'dock-h' ? 'y' : 'x',
        label: `${which} ${Math.round(pick.r.width)}x${Math.round(pick.r.height)} at ${Math.round(pick.r.left)},${Math.round(pick.r.top)} (${gutters.length} gutters total)`,
    }
}

/**
 * Mid-drag pane-width sampling (`widthprobe=1`).
 *
 * `runDrag` drives a triangle wave — out for half the frames, back for the
 * rest — so a before/after width comparison is necessarily zero and proves
 * nothing. To see whether a pane actually tracks the gutter, the width has to
 * be sampled at the extremes *during* the drag.
 *
 * Off by default: each sample is a `getBoundingClientRect` inside the drag
 * loop, i.e. a forced layout per frame. Timings from a `widthprobe=1` run are
 * not comparable with any other run.
 */
let widthProbe = false
const widthRange: Record<string, { min: number, max: number }> = {}

const widthSeries: Record<string, number[]> = { fileTree: [], codeEditor: [] }

function sampleWidths(): void {
    const w = paneWidths()

    // Full series for the two panes the gutter is supposed to move, so a pane
    // that only catches up at the end of the drag is distinguishable from one
    // that tracks it frame by frame. min/max cannot tell those apart.
    widthSeries.fileTree.push(w.fileTree)
    widthSeries.codeEditor.push(w.codeEditor)

    for (const [key, value] of Object.entries(w)) {
        const seen = widthRange[key]

        if (!seen) {
            widthRange[key] = { min: value, max: value }
        } else {
            seen.min = Math.min(seen.min, value)
            seen.max = Math.max(seen.max, value)
        }
    }
}

/**
 * Monotonic frame index during a driven drag/resize. Per-pass memo ablations
 * (`border.region-memo`) key on it so a memo lives exactly one frame, which is
 * what "per pass" means for a layout that runs once per frame.
 */
let currentFrame = 0

async function runDrag(frames: number, stepPx: number, which: string = 'explorer'): Promise<number[]> {
    const { gutter, axis } = pickGutter(which)
    const rect = gutter.getBoundingClientRect()
    let x = rect.left + rect.width / 2
    let y = rect.top + rect.height / 2

    fireMouse('mousedown', gutter, x, y)

    const gaps: number[] = []
    let last = performance.now()

    await new Promise<void>(resolve => {
        let i = 0

        function step(now: number): void {
            gaps.push(now - last)
            last = now
            currentFrame++

            const delta = i < frames / 2 ? stepPx : -stepPx

            if (axis === 'x') {
                x += delta
            } else {
                y += delta
            }

            fireMouse('mousemove', document, x, y)

            if (widthProbe) {
                sampleWidths()
            }

            i++

            if (i < frames) {
                requestAnimationFrame(step)
            } else {
                resolve()
            }
        }

        requestAnimationFrame(step)
    })

    fireMouse('mouseup', document, x, y)

    return gaps.slice(1)
}

/** Wheel-scrolls the tree one tick per frame (down, then back up) and returns rAF gaps. */
async function runWheelScroll(frames: number): Promise<number[]> {
    const row = document.querySelector<HTMLElement>('.TreeRow')
    const target = row ?? document.querySelector<HTMLElement>('.FileTree')

    if (!target || frames <= 0) {
        return []
    }

    const rect = target.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const gaps: number[] = []
    let last = performance.now()

    await new Promise<void>(resolve => {
        let i = 0

        function step(now: number): void {
            gaps.push(now - last)
            last = now
            target!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY: i < frames / 2 ? 40 : -40, deltaMode: 0 }))
            i++

            if (i < frames) {
                requestAnimationFrame(step)
            } else {
                resolve()
            }
        }

        requestAnimationFrame(step)
    })

    return gaps.slice(1)
}

/**
 * The shell's explorer Split: the container whose layout manager is a Split
 * and whose element contains the FileTree (Dock-internal splits do not).
 */
function findExplorerSplit(): { container: AnyObj, split: AnyObj } | null {
    const tree = document.querySelector('.FileTree')

    for (const c of walkComponents()) {
        const lm = typeof (c as AnyObj).getLayoutManager === 'function' ? ((c as AnyObj).getLayoutManager as () => AnyObj | null)() : null
        // getElement() returns the library's DOM handle, not an Element; the
        // element id is the component id.
        const id = typeof (c as AnyObj).getId === 'function' ? ((c as AnyObj).getId as () => string)() : ''
        const el = id ? document.getElementById(id) : null

        if (lm && isA(lm, 'Split') && el && tree && el.contains(tree)) {
            return { container: c, split: lm }
        }
    }

    return null
}

/**
 * Window-resize stand-in: re-lays out the explorer Split's container at a new
 * width every frame (triangle wave, ±stepPx per frame) and returns rAF gaps.
 * Exercises the same "ancestor resizes, every pane relayouts" path a window
 * resize does, and works with the explorer pane collapsed (where a gutter
 * drag would not).
 */
async function runResize(frames: number, stepPx: number): Promise<number[]> {
    const found = findExplorerSplit()

    if (!found || frames <= 0) {
        return []
    }

    const container = found.container
    const setWidth = container.setWidth as (w: number) => void
    const doLayout = container.doLayout as () => void
    const w0 = (container.getWidth as () => number)()
    const gaps: number[] = []
    let last = performance.now()
    let w = w0

    await new Promise<void>(resolve => {
        let i = 0

        function step(now: number): void {
            gaps.push(now - last)
            last = now
            w += i < frames / 2 ? -stepPx : stepPx
            setWidth.call(container, w)
            doLayout.call(container)
            i++

            if (i < frames) {
                requestAnimationFrame(step)
            } else {
                resolve()
            }
        }

        requestAnimationFrame(step)
    })

    setWidth.call(container, w0)
    doLayout.call(container)

    return gaps.slice(1)
}

function summarize(gaps: number[]): Record<string, number> {
    const sorted = [...gaps].sort((a, b) => a - b)
    const pick = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
    const total = gaps.reduce((a, b) => a + b, 0)

    return {
        n: gaps.length,
        avgMs: +(total / Math.max(1, gaps.length)).toFixed(2),
        p50Ms: +pick(0.5).toFixed(2),
        p90Ms: +pick(0.9).toFixed(2),
        maxMs: +(sorted[sorted.length - 1] ?? 0).toFixed(2),
        over16: gaps.filter(g => g > 16.7).length,
    }
}

async function report(data: unknown): Promise<void> {
    await fetch(`/__qa/report?name=${encodeURIComponent(scenario ?? 'unnamed')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
    })
}

// ---- component-tree walking + prototype ablations ----------------------

function walkComponents(): AnyObj[] {
    const out: AnyObj[] = []
    const seen = new Set<unknown>()
    const stack: AnyObj[] = [(Body as unknown as { getInstance: () => AnyObj }).getInstance()]

    while (stack.length) {
        const c = stack.pop() as AnyObj

        if (!c || seen.has(c)) {
            continue
        }

        seen.add(c)
        out.push(c)

        const getComponents = c.getComponents as (() => AnyObj[]) | undefined

        if (typeof getComponents === 'function') {
            for (const child of getComponents.call(c) ?? []) {
                stack.push(child)
            }
        }
    }

    return out
}

function className(obj: AnyObj): string {
    return (obj?.constructor as { name?: string } | undefined)?.name ?? ''
}

function protoChainNames(obj: AnyObj): string[] {
    const names: string[] = []
    let p = Object.getPrototypeOf(obj)

    while (p && p !== Object.prototype) {
        names.push((p.constructor as { name?: string })?.name ?? '?')
        p = Object.getPrototypeOf(p)
    }

    return names
}

function isA(obj: AnyObj, name: string): boolean {
    return protoChainNames(obj).includes(name)
}

/** Replaces `method` on the prototype that owns it (walking up from `obj`), so every instance is affected. */
function noopOnOwningProto(obj: AnyObj, method: string): string {
    let p = Object.getPrototypeOf(obj)

    while (p && p !== Object.prototype) {
        if (Object.prototype.hasOwnProperty.call(p, method)) {
            p[method] = function (this: unknown) { return this }

            return `patched ${(p.constructor as { name?: string })?.name}.${method}`
        }

        p = Object.getPrototypeOf(p)
    }

    return `NOT FOUND ${method} on ${className(obj)}`
}

// ---------------------------------------------------------------------------
// DOM/CSSOM write counters (count=1). Wraps the prototype write paths the
// library uses and tallies calls while `counting` is true, split by whether
// the target is a stylesheet rule (`parentRule` set) or an inline style, and
// by whether the write actually changes anything.
// ---------------------------------------------------------------------------
let counting = false
let writeCounts: Record<string, number> = {}

function bump(kind: string): void {
    if (counting) {
        writeCounts[kind] = (writeCounts[kind] ?? 0) + 1

        // Any write that changes the DOM leaves layout dirty until the next
        // layout-reading call (see noteForcedRead).
        if (/\.changed(@|$)|^sheet\.|^mut\.|cssText\.changed/.test(kind)) {
            layoutDirty = true
        }
    }
}

function resetWriteCounts(): void {
    writeCounts = {}
    layoutDirty = false

    for (const key of Object.keys(forcedStacks)) {
        delete forcedStacks[key]
    }
}

function perFrameWriteCounts(frames: number): Record<string, number> {
    const out: Record<string, number> = {}

    for (const [k, v] of Object.entries(writeCounts).sort((a, b) => b[1] - a[1])) {
        out[k] = +(v / frames).toFixed(2)
    }

    return out
}

// Forced-layout detection: any counted DOM write marks layout dirty; the next
// layout-reading API call then forces a synchronous style+layout. The first
// few distinct JS stacks per read API are kept so the forcing call chain is
// named in the report.
let layoutDirty = false
const forcedStacks: Record<string, string[]> = {}

function markDirty(): void {
    if (counting) {
        layoutDirty = true
    }
}

function noteForcedRead(api: string): void {
    if (!counting || !layoutDirty) {
        return
    }

    layoutDirty = false
    bump(`forced.${api}`)

    const stacks = (forcedStacks[api] ??= [])

    if (stacks.length < 4) {
        const stack = (new Error().stack ?? '').split('\n').slice(2, 12)
            .map(l => l.trim().replace(/^at /, '').replace(/https?:\/\/localhost:1420\/@fs\/[^ ]*\/dist\/lib\//g, '').replace(/\?t=\d+/g, ''))
            .join(' <- ')

        if (!stacks.includes(stack)) {
            stacks.push(stack)
        }
    }
}

function installForcedLayoutDetector(): void {
    const elProto = Element.prototype
    const gbcr = elProto.getBoundingClientRect

    elProto.getBoundingClientRect = function (this: Element): DOMRect {
        noteForcedRead('getBoundingClientRect')

        return gbcr.call(this)
    }

    const gcs = window.getComputedStyle

    window.getComputedStyle = function (el: Element, pseudo?: string | null): CSSStyleDeclaration {
        noteForcedRead('getComputedStyle')

        return gcs.call(window, el, pseudo)
    }

    for (const [proto, props] of [
        [HTMLElement.prototype, ['offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft']],
        [Element.prototype, ['clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight', 'scrollTop', 'scrollLeft']],
    ] as Array<[object, string[]]>) {
        for (const prop of props) {
            const desc = Object.getOwnPropertyDescriptor(proto, prop)

            if (!desc?.get) {
                continue
            }

            const get = desc.get
            const set = desc.set

            Object.defineProperty(proto, prop, {
                configurable: true,
                enumerable: desc.enumerable,
                get(this: Element) {
                    noteForcedRead(prop)

                    return get.call(this)
                },
                set: set ? function (this: Element, v: unknown) {
                    // A scroll write clamps against layout, forcing it too.
                    noteForcedRead(`${prop}.set`)
                    set.call(this, v)
                } : undefined,
            })
        }
    }
}

function installWriteCounters(): void {
    installForcedLayoutDetector()

    // DOM structure churn: nodes added/removed under a target, keyed by the
    // target's first class (CodeMirror's `.cm-content` line churn shows here).
    const mutations = new MutationObserver(records => {
        if (!counting) {
            return
        }

        for (const record of records) {
            const target = record.target as Element
            const cls = (target.classList && target.classList[0]) || target.nodeName.toLowerCase()

            if (record.addedNodes.length) {
                bump(`mut.${cls}.added`)
                writeCounts[`mut.${cls}.addedNodes`] = (writeCounts[`mut.${cls}.addedNodes`] ?? 0) + record.addedNodes.length
            }

            if (record.removedNodes.length) {
                bump(`mut.${cls}.removed`)
                writeCounts[`mut.${cls}.removedNodes`] = (writeCounts[`mut.${cls}.removedNodes`] ?? 0) + record.removedNodes.length
            }
        }
    })

    mutations.observe(document.documentElement, { childList: true, subtree: true })

    const declProto = CSSStyleDeclaration.prototype
    const setProperty = declProto.setProperty
    const removeProperty = declProto.removeProperty
    const cssTextDesc = Object.getOwnPropertyDescriptor(declProto, 'cssText')

    declProto.setProperty = function (this: CSSStyleDeclaration, key: string, value: string | null, priority?: string): void {
        if (counting) {
            const same = this.getPropertyValue(key) === (value ?? '')

            bump(`${this.parentRule ? 'rule' : 'inline'}.setProperty.${same ? 'same' : 'changed'}`)
        }

        setProperty.call(this, key, value, priority)
    }

    declProto.removeProperty = function (this: CSSStyleDeclaration, key: string): string {
        if (counting) {
            const had = this.getPropertyValue(key) !== ''

            bump(`${this.parentRule ? 'rule' : 'inline'}.removeProperty.${had ? 'changed' : 'same'}`)
        }

        return removeProperty.call(this, key)
    }

    if (cssTextDesc?.set && cssTextDesc.get) {
        const setCssText = cssTextDesc.set
        const getCssText = cssTextDesc.get

        Object.defineProperty(declProto, 'cssText', {
            configurable: true,
            enumerable: cssTextDesc.enumerable,
            get: getCssText,
            set(this: CSSStyleDeclaration, value: string) {
                if (counting) {
                    bump(`${this.parentRule ? 'rule' : 'inline'}.cssText.${getCssText.call(this) === value ? 'same' : 'changed'}`)
                }

                setCssText.call(this, value)
            },
        })
    }

    const sheetProto = CSSStyleSheet.prototype
    const insertRule = sheetProto.insertRule
    const deleteRule = sheetProto.deleteRule

    sheetProto.insertRule = function (this: CSSStyleSheet, rule: string, index?: number): number {
        bump('sheet.insertRule')

        return insertRule.call(this, rule, index)
    }

    sheetProto.deleteRule = function (this: CSSStyleSheet, index: number): void {
        bump('sheet.deleteRule')
        deleteRule.call(this, index)
    }

    const elProto = Element.prototype
    const setAttribute = elProto.setAttribute
    const removeAttribute = elProto.removeAttribute

    elProto.setAttribute = function (this: Element, name: string, value: string): void {
        if (counting) {
            const same = this.getAttribute(name) === value

            bump(same ? `attr.${name}.same` : `attr.${name}.changed@${(this.classList && this.classList[0]) || this.nodeName.toLowerCase()}`)
        }

        setAttribute.call(this, name, value)
    }

    elProto.removeAttribute = function (this: Element, name: string): void {
        if (counting) {
            bump(`attr.${name}.remove.${this.hasAttribute(name) ? 'changed' : 'same'}`)
        }

        removeAttribute.call(this, name)
    }

    const tokenProto = DOMTokenList.prototype
    const tokenAdd = tokenProto.add
    const tokenRemove = tokenProto.remove
    const tokenToggle = tokenProto.toggle

    // The token list's own value names the element (its first class is the
    // component's constructor name), so a changed toggle is attributed.
    const owner = (list: DOMTokenList): string => (list.value || '').split(' ')[0] || '?'

    tokenProto.add = function (this: DOMTokenList, ...tokens: string[]): void {
        if (counting) {
            const same = tokens.every(t => this.contains(t))

            bump(same ? 'classList.add.same' : `classList.add.changed@${owner(this)}:${tokens.join('+')}`)

            // Who toggles a component's `.invisible` class mid-drag: keep the
            // first few distinct stacks (reported under forcedStacks).
            if (!same && tokens.includes('invisible')) {
                const stacks = (forcedStacks['classList.add.invisible'] ??= [])

                if (stacks.length < 3) {
                    const stack = (new Error().stack ?? '').split('\n').slice(2, 14)
                        .map(l => l.trim().replace(/^at /, '').replace(/https?:\/\/localhost:1420\/@fs\/[^ ]*\/dist\/lib\//g, '').replace(/\?t=\d+/g, ''))
                        .join(' <- ')

                    if (!stacks.includes(stack)) {
                        stacks.push(stack)
                    }
                }
            }
        }

        tokenAdd.apply(this, tokens)
    }

    tokenProto.remove = function (this: DOMTokenList, ...tokens: string[]): void {
        if (counting) {
            const changed = tokens.some(t => this.contains(t))

            bump(changed ? `classList.remove.changed@${owner(this)}:${tokens.join('+')}` : 'classList.remove.same')
        }

        tokenRemove.apply(this, tokens)
    }

    tokenProto.toggle = function (this: DOMTokenList, token: string, force?: boolean): boolean {
        if (counting) {
            const has = this.contains(token)
            const want = force ?? !has

            bump(`classList.toggle.${has === want ? 'same' : 'changed'}`)
        }

        return tokenToggle.call(this, token, force)
    }
}

// Drops every stylesheet-rule write (rule declarations, insert/delete rule)
// while leaving inline-style writes intact. Applied on top of the counters
// when both are requested, so counted rule writes fall to zero as proof.
/**
 * The camelCase CSS-property accessors on `CSSStyleDeclaration.prototype`.
 *
 * `DOM.writeDeclaration` sends a key containing `-` through `setProperty`, but
 * every other key through direct assignment (`style[key] = value`). The library
 * writes camelCase keys throughout (`clipPath`, `backgroundColor`, `transform`,
 * `contain`), so those writes bypass the `setProperty` / `cssText` hooks
 * entirely — they were invisible to the counters and survived `norules` until
 * this was found on 2026-09-17. Both paths below wrap these accessors to close
 * that hole.
 */
function cssAccessorHost(): { host: AnyObj, names: string[] } {
    const skip = new Set(['cssText', 'length', 'parentRule', 'cssFloat'])
    const probe = document.createElement('div').style as unknown as AnyObj

    // Engines disagree about where CSS-property accessors live: some put them
    // on `CSSStyleDeclaration.prototype`, some on an intermediate
    // (`CSS2Properties`), some on the instance. WebKitGTK reports zero on
    // `CSSStyleDeclaration.prototype`, so find the owner by walking the real
    // chain from an element's own style object and taking the first level that
    // actually owns a known property accessor.
    for (let obj: AnyObj | null = probe; obj; obj = Object.getPrototypeOf(obj) as AnyObj | null) {
        const desc = Object.getOwnPropertyDescriptor(obj, 'clipPath')

        if (!desc?.set || !desc.get || !desc.configurable) {
            continue
        }

        const names: string[] = []

        for (const name of Object.getOwnPropertyNames(obj)) {
            if (skip.has(name) || name.includes('-')) {
                continue
            }

            const d = Object.getOwnPropertyDescriptor(obj, name)

            if (d?.set && d.get && d.configurable) {
                names.push(name)
            }
        }

        return { host: obj, names }
    }

    return { host: CSSStyleDeclaration.prototype as unknown as AnyObj, names: [] }
}

/**
 * Counts direct camelCase style writes, which the `setProperty` / `cssText`
 * hooks in `installWriteCounters` cannot see.
 *
 * **Opt-in** (`deepwrites=1`), deliberately: this wraps several hundred
 * accessors, and the added call overhead lands on every style write in the
 * page. Leaving it always-on would shift every frame timing and break
 * comparability with every measurement taken before 2026-09-17. Turn it on to
 * read counters; leave it off to read timings.
 */
function installDeepStyleCounters(): string {
    const { host, names } = cssAccessorHost()

    for (const name of names) {
        const desc = Object.getOwnPropertyDescriptor(host, name)!
        const get = desc.get!
        const set = desc.set!

        Object.defineProperty(host, name, {
            configurable: true,
            enumerable: desc.enumerable,
            get,
            set(this: CSSStyleDeclaration, value: string) {
                const same = get.call(this) === value

                bump(`${this.parentRule ? 'rule' : 'inline'}.prop.${same ? 'same' : 'changed'}`)
                bump(`prop@${name}.${same ? 'same' : 'changed'}`)
                set.call(this, value)
            },
        })
    }

    return `deep style counters on ${names.length} accessors`
}

function dropRuleWrites(): string {
    const declProto = CSSStyleDeclaration.prototype
    const setProperty = declProto.setProperty
    const removeProperty = declProto.removeProperty
    const cssTextDesc = Object.getOwnPropertyDescriptor(declProto, 'cssText')

    declProto.setProperty = function (this: CSSStyleDeclaration, key: string, value: string | null, priority?: string): void {
        if (!this.parentRule) {
            setProperty.call(this, key, value, priority)
        }
    }

    declProto.removeProperty = function (this: CSSStyleDeclaration, key: string): string {
        return this.parentRule ? '' : removeProperty.call(this, key)
    }

    if (cssTextDesc?.set && cssTextDesc.get) {
        const setCssText = cssTextDesc.set

        Object.defineProperty(declProto, 'cssText', {
            configurable: true,
            enumerable: cssTextDesc.enumerable,
            get: cssTextDesc.get,
            set(this: CSSStyleDeclaration, value: string) {
                if (!this.parentRule) {
                    setCssText.call(this, value)
                }
            },
        })
    }

    // Direct camelCase assignment — the path `writeDeclaration` takes for every
    // key without a hyphen, and the one `setClipPath` uses. Without this the
    // ablation leaves the very writes G04 and G12 target in place, which is
    // what made the 2026-09-17 G04 measurement invalid.
    const { host: accessorHost, names: accessors } = cssAccessorHost()

    for (const name of accessors) {
        const desc = Object.getOwnPropertyDescriptor(accessorHost, name)!
        const get = desc.get!
        const set = desc.set!

        Object.defineProperty(accessorHost, name, {
            configurable: true,
            enumerable: desc.enumerable,
            get,
            set(this: CSSStyleDeclaration, value: string) {
                if (!this.parentRule) {
                    set.call(this, value)
                }
            },
        })
    }

    CSSStyleSheet.prototype.insertRule = function (): number { return 0 }
    CSSStyleSheet.prototype.deleteRule = function (): void { /* dropped */ }

    return `rule writes dropped (incl. ${accessors.length} camelCase accessors)`
}

/** The live CodeMirror EditorView instances behind every mounted CodeEditor. */
function codeMirrorViews(): AnyObj[] {
    const views: AnyObj[] = []

    for (const c of walkComponents()) {
        if (isA(c, 'CodeEditor')) {
            const view = (c as AnyObj)._view as AnyObj | null | undefined

            if (view && typeof view.requestMeasure === 'function') {
                views.push(view)
            }
        }
    }

    return views
}

// ---------------------------------------------------------------------------
// Wave-2 pre-measurement (W2.0) — see plans/research/render-review-2026-09-15/
// 98-wave2-rejustification.md, part C4. Each ablation below applies one group's
// *proposed change at runtime*, so its same-session A/B delta is that group's
// honest upper bound, with no library edit and no plan written first. The work
// counters answer the side-effect-denominated questions a write counter cannot
// (wave 1's win came from calls avoided, not bytes not written).
// ---------------------------------------------------------------------------

/** The nearest prototype in `obj`'s chain that owns `method`, or null. */
function ownerProto(obj: AnyObj, method: string): AnyObj | null {
    let p = Object.getPrototypeOf(obj)

    while (p && p !== Object.prototype) {
        if (Object.prototype.hasOwnProperty.call(p, method)) {
            return p as AnyObj
        }

        p = Object.getPrototypeOf(p)
    }

    return null
}

/**
 * The *furthest* prototype that owns `method` — the base declaration rather
 * than a subclass override. Patching `Component.prototype.doLayout` needs this:
 * walking up from a live component finds whichever subclass overrode it first.
 */
function rootOwnerProto(obj: AnyObj, method: string): AnyObj | null {
    let p = Object.getPrototypeOf(obj)
    let found: AnyObj | null = null

    while (p && p !== Object.prototype) {
        if (Object.prototype.hasOwnProperty.call(p, method)) {
            found = p as AnyObj
        }

        p = Object.getPrototypeOf(p)
    }

    return found
}

/** First live component whose prototype chain includes `name`. */
function findComponent(name: string): AnyObj | null {
    return walkComponents().find(c => isA(c, name)) ?? null
}

/** First live layout manager whose prototype chain includes `name`. */
function findLayoutManager(name: string): AnyObj | null {
    for (const c of walkComponents()) {
        const get = c.getLayoutManager as (() => AnyObj | null) | undefined
        const lm = typeof get === 'function' ? get.call(c) : null

        if (lm && isA(lm, name)) {
            return lm
        }
    }

    return null
}

let workCounting = false
let workCounts: Record<string, number> = {}

function bumpWork(kind: string): void {
    if (workCounting) {
        workCounts[kind] = (workCounts[kind] ?? 0) + 1
    }
}

function perFrameWorkCounts(frames: number): Record<string, number> {
    const out: Record<string, number> = {}

    for (const [k, v] of Object.entries(workCounts).sort((a, b) => b[1] - a[1])) {
        out[k] = +(v / frames).toFixed(2)
    }

    return out
}

/**
 * Wraps `method` so every call is tallied as `<label>@<receiver class>`, then
 * delegates to the original. Grouping by the receiver (not the owning
 * prototype) is what makes `doLayout@TabBar` separable from `doLayout@Split`,
 * which is the distinction G09's proof target turns on.
 */
function countMethod(obj: AnyObj, method: string, label?: string, root = false): string {
    const proto = root ? rootOwnerProto(obj, method) : ownerProto(obj, method)

    if (!proto) {
        return `NOT FOUND ${method} on ${className(obj)}`
    }

    const original = proto[method] as (...args: unknown[]) => unknown
    const tag = label ?? method

    proto[method] = function (this: AnyObj, ...args: unknown[]): unknown {
        bumpWork(`${tag}@${className(this)}`)

        return original.apply(this, args)
    }

    return `counting ${(proto.constructor as { name?: string })?.name}.${method}`
}

/**
 * Installs the `count=work` counters the re-justification's open questions 1,
 * 2, 6 and 7 need. Runs *after* the ablations, so a count taken under an
 * ablation reflects the ablated code — which is the point: it says whether the
 * ablation actually removed the work it claims to.
 */
function installWorkCounters(): string[] {
    const notes: string[] = []
    const any = walkComponents()[0]

    if (!any) {
        return ['no components to count']
    }

    for (const method of ['doLayout', 'scheduleLayout', 'getMinSize', 'getMaxSize', 'getPreferredSize', 'setClipPath']) {
        notes.push(countMethod(any, method, method, true))
    }

    const split = findLayoutManager('Split')

    if (split) {
        notes.push(countMethod(split, 'doLayout', 'split.doLayout'))
        notes.push(countMethod(split, 'recalculateSizes', 'split.recalculateSizes'))
    } else {
        notes.push('no Split layout manager')
    }

    const accordion = findLayoutManager('Accordion')

    if (accordion) {
        notes.push(countMethod(accordion, 'openContentHeight', 'accordion.openContentHeight'))
    }

    const tabBar = findComponent('TabBar')

    notes.push(tabBar ? countMethod(tabBar, 'prepareStrip', 'tabbar.prepareStrip') : 'no TabBar component')

    const collapseButton = findComponent('CollapseButton')

    notes.push(collapseButton ? countMethod(collapseButton, 'applyRotation', 'collapse.applyRotation') : 'no CollapseButton component')

    const border = findLayoutManager('Border')

    notes.push(border ? countMethod(border, 'getPreferredSize', 'border.getPreferredSize') : 'no Border layout manager')

    return notes
}

/**
 * Tallies `clampsToContentSize()` by class across the live tree — the
 * re-justification's open question 7, which asks for G10's real opt-in list
 * instead of the synthesis's guessed one. Read from the `before` block, so it
 * costs nothing during the drag.
 */
function clampTally(): Record<string, number> {
    const out: Record<string, number> = {}

    for (const c of walkComponents()) {
        const fn = c.clampsToContentSize as (() => boolean) | undefined

        if (typeof fn !== 'function') {
            continue
        }

        let clamps = false

        try {
            clamps = fn.call(c)
        } catch {
            continue
        }

        if (clamps) {
            const key = className(c)

            out[key] = (out[key] ?? 0) + 1
        }
    }

    return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]))
}

const ABLATIONS: Record<string, () => string> = {
    // ---- W2.0 bounding ablations (G09, G10, G12, G13) --------------------
    // The lever the re-justification's five groups all miss. `clampTally` shows
    // no `TreeRow` component exists (tree rows are renderer-produced DOM), and
    // the work counters show ~340 `getPreferredSize` calls per S1 frame, led by
    // `ButtonIconGlyph` and `ButtonLabelText` — the never-memoised size hints
    // the synthesis listed as a recurring defect but no group bounds. This
    // memoises all three size hints per frame.
    //
    // Sound as an ablation because a layout pass is one frame: within it
    // nothing changes that a size hint depends on, so serving a repeat call
    // from the memo returns the value the real call would have computed. The
    // geometry assertion in the A/B is what proves that claim rather than
    // assuming it.
    'size.memo': () => {
        const any = walkComponents()[0]

        if (!any) {
            return 'no component'
        }

        const patched: string[] = []
        let served = 0

        for (const method of ['getPreferredSize', 'getMinSize', 'getMaxSize']) {
            const proto = rootOwnerProto(any, method)

            if (!proto) {
                continue
            }

            const original = proto[method] as (...args: unknown[]) => unknown
            const memo = new WeakMap<object, { frame: number, value: unknown }>()

            proto[method] = function (this: AnyObj, ...args: unknown[]): unknown {
                const hit = memo.get(this)

                if (hit && hit.frame === currentFrame) {
                    served++
                    bumpWork(`memo.${method}@${className(this)}`)

                    return hit.value
                }

                const value = original.apply(this, args)

                memo.set(this, { frame: currentFrame, value })

                return value
            }

            patched.push(method)
        }

        Object.defineProperty(window as unknown as AnyObj, '__sizeMemoServed', { configurable: true, get: () => served })

        return patched.length ? `size hints memoised per frame (${patched.join(', ')})` : 'size methods not found'
    },
    // G09 upper bound. `LayoutManager.commitBounds` ends in an unconditional
    // `component.doLayout()`; this skips it when the committed rect matches
    // what the component already has and nothing marked it dirty. No opt-in
    // list, so this is the *ceiling* of G09's staged version, not its value.
    'skip.unchanged': () => {
        const lm = findLayoutManager('Split') ?? findLayoutManager('Border') ?? findLayoutManager('Fit')

        if (!lm) {
            return 'no layout manager'
        }

        const proto = rootOwnerProto(lm, 'commitBounds')

        if (!proto) {
            return 'commitBounds not found'
        }

        const original = proto.commitBounds as (...args: unknown[]) => unknown
        let skipped = 0

        proto.commitBounds = function (this: AnyObj, component: AnyObj, x: number, y: number, width: number, height: number): unknown {
            const sizeUnchanged = (component.getWidth as () => number).call(component) === width
                && (component.getHeight as () => number).call(component) === height
            const positionUnchanged = x === (component.getX as () => number).call(component) + (component.getTranslateX as () => number).call(component)
                && y === (component.getY as () => number).call(component) + (component.getTranslateY as () => number).call(component)
            const isDirty = component.isLayoutDirty as (() => boolean) | undefined
            const dirty = typeof isDirty === 'function' ? isDirty.call(component) : true

            if (sizeUnchanged && positionUnchanged && !dirty) {
                skipped++
                bumpWork(`skipped.commit@${className(component)}`)

                return undefined
            }

            return original.call(this, component, x, y, width, height)
        }

        Object.defineProperty(window as unknown as AnyObj, '__skipUnchanged', { configurable: true, get: () => skipped })

        return 'commitBounds skips unchanged commits'
    },
    // G10 half a: every live TreeRow / SelectableListRow stops clamping to
    // content size, which is what removes the recursive preferred-size
    // aggregation per row per width-changing frame.
    'clamp.rows': () => {
        const patched: string[] = []

        for (const name of ['TreeRow', 'SelectableListRow']) {
            const row = findComponent(name)

            if (!row) {
                continue
            }

            const proto = ownerProto(row, 'clampsToContentSize')

            if (proto) {
                proto.clampsToContentSize = function (): boolean { return false }
                patched.push(`${(proto.constructor as { name?: string })?.name}`)
            }
        }

        return patched.length ? `clampsToContentSize()=false on ${patched.join(', ')}` : 'no TreeRow/SelectableListRow found'
    },
    // G10 half b: `setSize` resolves the min/max pair once and clamps both
    // axes from it, instead of re-resolving per axis.
    'clamp.once': () => {
        const any = walkComponents()[0]

        if (!any) {
            return 'no component'
        }

        const proto = rootOwnerProto(any, 'setSize')

        if (!proto) {
            return 'setSize not found'
        }

        const original = proto.setSize as (...args: unknown[]) => unknown

        proto.setSize = function (this: AnyObj, width: number, height: number): unknown {
            const getMin = this.getMinSize as (() => AnyObj) | undefined
            const getMax = this.getMaxSize as (() => AnyObj) | undefined

            if (typeof getMin !== 'function' || typeof getMax !== 'function') {
                return original.call(this, width, height)
            }

            const min = getMin.call(this)
            const max = getMax.call(this)
            const cached = { min, max }
            const restoreMin = this.getMinSize
            const restoreMax = this.getMaxSize

            // Serve both axes from the single pair resolved above.
            this.getMinSize = function (): AnyObj { return cached.min }
            this.getMaxSize = function (): AnyObj { return cached.max }

            try {
                return original.call(this, width, height)
            } finally {
                this.getMinSize = restoreMin
                this.getMaxSize = restoreMax
            }
        }

        return 'setSize resolves min/max once per call'
    },
    // G12 / F06.3: a Split drag that computes a zero delta (the pane is at its
    // clamp) still runs the whole re-layout. Early-return instead.
    'split.noop-drag': () => {
        const split = findLayoutManager('Split')

        if (!split) {
            return 'no Split layout manager'
        }

        const proto = ownerProto(split, 'onDrag')

        if (!proto) {
            return 'onDrag not found'
        }

        const original = proto.onDrag as (...args: unknown[]) => unknown
        let skipped = 0
        const lastAmount = new WeakMap<object, number>()

        proto.onDrag = function (this: AnyObj, ...args: unknown[]): unknown {
            const amount = args.find(a => typeof a === 'number') as number | undefined

            if (amount === 0 || (amount !== undefined && lastAmount.get(this) === amount)) {
                skipped++
                bumpWork('skipped.split.onDrag')

                return undefined
            }

            if (amount !== undefined) {
                lastAmount.set(this, amount)
            }

            return original.apply(this, args)
        }

        Object.defineProperty(window as unknown as AnyObj, '__splitNoopDrags', { configurable: true, get: () => skipped })

        return 'Split.onDrag early-returns on a zero/repeat delta'
    },
    // G12 / F06.4 upper bound: `recalculateSizes` runs once per
    // (container, available) pair instead of every pass.
    'split.recalc-gate': () => {
        const split = findLayoutManager('Split')

        if (!split) {
            return 'no Split layout manager'
        }

        const proto = ownerProto(split, 'recalculateSizes')

        if (!proto) {
            return 'recalculateSizes not found'
        }

        const original = proto.recalculateSizes as (...args: unknown[]) => unknown
        const seen = new WeakMap<object, string>()
        let skipped = 0

        proto.recalculateSizes = function (this: AnyObj, ...args: unknown[]): unknown {
            const signature = JSON.stringify(args.filter(a => typeof a === 'number' || typeof a === 'string'))

            if (seen.get(this) === signature) {
                skipped++
                bumpWork('skipped.split.recalculateSizes')

                return undefined
            }

            seen.set(this, signature)

            return original.apply(this, args)
        }

        Object.defineProperty(window as unknown as AnyObj, '__splitRecalcSkipped', { configurable: true, get: () => skipped })

        return 'Split.recalculateSizes gated on its argument signature'
    },
    // G12 / F06.5 upper bound: Border serves per-pass memoised region sizes,
    // so each avoided report skips a recursive descent into that region's
    // subtree (for FileEditor's CENTER, the whole CodeMirror wrapper).
    'border.region-memo': () => {
        const border = findLayoutManager('Border')

        if (!border) {
            return 'no Border layout manager'
        }

        const patched: string[] = []
        let served = 0

        for (const method of ['getPreferredSize', 'getMinSize']) {
            const proto = ownerProto(border, method)

            if (!proto) {
                continue
            }

            const original = proto[method] as (...args: unknown[]) => unknown
            const memo = new WeakMap<object, { frame: number, value: unknown }>()

            proto[method] = function (this: AnyObj, ...args: unknown[]): unknown {
                const hit = memo.get(this)

                if (hit && hit.frame === currentFrame) {
                    served++
                    bumpWork(`memo.border.${method}`)

                    return hit.value
                }

                const value = original.apply(this, args)

                memo.set(this, { frame: currentFrame, value })

                return value
            }

            patched.push(method)
        }

        Object.defineProperty(window as unknown as AnyObj, '__borderMemoServed', { configurable: true, get: () => served })

        return patched.length ? `Border ${patched.join('/')} memoised per pass` : 'Border size methods not found'
    },
    // G13 / F08.2 upper bound: Accordion's shrink/fill seeding passes are
    // stubbed after the second pass, exactly as slice 08 probe E1 did — which
    // already proved every section's rectangle stays byte-identical.
    'accordion.seed': () => {
        const accordion = findLayoutManager('Accordion')

        if (!accordion) {
            return 'no Accordion layout manager'
        }

        const shrinkProto = ownerProto(accordion, 'computeShrinkRatio')
        const fillProto = ownerProto(accordion, 'computeFill')

        if (!shrinkProto || !fillProto) {
            return 'Accordion seeding methods not found'
        }

        let passes = 0
        const originalShrink = shrinkProto.computeShrinkRatio as (...args: unknown[]) => unknown
        const originalFill = fillProto.computeFill as (...args: unknown[]) => unknown

        shrinkProto.computeShrinkRatio = function (this: AnyObj, ...args: unknown[]): unknown {
            passes++

            if (passes > 2) {
                bumpWork('stubbed.accordion.shrink')

                return 0
            }

            return originalShrink.apply(this, args)
        }

        fillProto.computeFill = function (this: AnyObj, ...args: unknown[]): unknown {
            if (passes > 2) {
                bumpWork('stubbed.accordion.fill')

                return new Map()
            }

            return originalFill.apply(this, args)
        }

        return 'Accordion shrink/fill seeding stubbed after pass 2'
    },
    // Component.syncScrollOffsets becomes a no-op: no live scrollLeft/scrollTop
    // read anywhere during layout (the caches stay as last written).
    'sync.scroll': () => {
        const any = walkComponents()[0]

        return any ? noopOnOwningProto(any, 'syncScrollOffsets') : 'no component'
    },
    // CodeMirror's per-frame measure cycle becomes a no-op for every editor
    // (EditorView.prototype.measure). Editors keep their DOM as-is.
    'cm.measure': () => {
        const views = codeMirrorViews()

        if (views.length === 0) {
            return 'no CodeMirror views'
        }

        const proto = Object.getPrototypeOf(views[0]) as AnyObj

        proto.measure = function (): void { /* ablated */ }

        return `EditorView.measure no-op'd (${views.length} views)`
    },
    // CodeMirror's Resize/Intersection observers disconnected for every editor,
    // so a size change no longer schedules its measure.
    'cm.observers': () => {
        const views = codeMirrorViews()
        let disconnected = 0

        for (const view of views) {
            const observer = view.observer as AnyObj | undefined

            for (const key of Object.keys(observer ?? {})) {
                const value = (observer as AnyObj)[key] as AnyObj

                if (value && typeof value.disconnect === 'function' && (value instanceof ResizeObserver || value instanceof IntersectionObserver)) {
                    value.disconnect()
                    disconnected++
                }
            }
        }

        return `disconnected ${disconnected} CodeMirror observers across ${views.length} views`
    },
    // CodeEditor stops laying itself out (its element keeps its size; the pane resizes around it).
    'editor.doLayout': () => {
        const editor = walkComponents().find(c => isA(c, 'CodeEditor'))

        return editor ? noopOnOwningProto(editor, 'doLayout') : 'no CodeEditor instance'
    },
    // No stylesheet-rule mutations at all during the run (inline writes kept).
    'norules': dropRuleWrites,
    // Ceiling for extending the seam's same-value filter to attribute writes.
    // `ProductionDOMSink.apply` calls `setAttribute` unconditionally; the
    // counters show 12 same-value `data-insets` writes per frame on the 2x2
    // grid. Unlike a stylesheet-rule write this does not force a *document*
    // restyle, so the count does not predict the cost — hence measuring before
    // planning.
    'nosameattr': () => {
        const proto = Element.prototype
        const setAttribute = proto.setAttribute
        let skipped = 0

        proto.setAttribute = function (this: Element, name: string, value: string): void {
            if (this.getAttribute(name) === value) {
                skipped++
                bump(`skipattr@${name}`)

                return
            }

            setAttribute.call(this, name, value)
        }

        Object.defineProperty(window as unknown as AnyObj, '__sameAttrSkipped', {
            configurable: true,
            get: () => skipped,
        })

        return 'same-value attribute writes dropped'
    },
    // Upper bound for a same-value filter in `DOM.writeDeclaration`: every
    // direct camelCase style write whose value already matches is skipped.
    // Measures the ceiling of that fix without touching the library — on S3
    // post-wave-1 the deep counters show ~99 same-value inline property writes
    // per drag frame, 76 of them `left`.
    'nosamewrites': () => {
        const { host, names } = cssAccessorHost()

        if (names.length === 0) {
            return 'no CSS accessors found'
        }

        let skipped = 0

        for (const name of names) {
            const desc = Object.getOwnPropertyDescriptor(host, name)!
            const get = desc.get!
            const set = desc.set!

            Object.defineProperty(host, name, {
                configurable: true,
                enumerable: desc.enumerable,
                get,
                set(this: CSSStyleDeclaration, value: string) {
                    if (get.call(this) === value) {
                        skipped++
                        // Attribute the skip, so the ablation can say *what* it
                        // dropped rather than only how much it saved. The
                        // library's own same-value writes are already removed
                        // by the `writeDeclaration` filter, so whatever shows
                        // up here on a filtered build is coming from somewhere
                        // else — CodeMirror, or a path that bypasses the seam.
                        bump(`skip@${name}`)
                        bump(this.parentRule ? 'skip.rule' : 'skip.inline')

                        return
                    }

                    set.call(this, value)
                },
            })
        }

        // Read back through a getter so the count lands in the note at report
        // time rather than at install time, when it is still zero.
        Object.defineProperty(window as unknown as AnyObj, '__sameWritesSkipped', {
            configurable: true,
            get: () => skipped,
        })

        return `same-value style writes dropped (${names.length} accessors wrapped)`
    },
    // aria-hidden attribute writes dropped.
    'noaria': () => {
        const setAttribute = Element.prototype.setAttribute

        Element.prototype.setAttribute = function (this: Element, name: string, value: string): void {
            if (name !== 'aria-hidden') {
                setAttribute.call(this, name, value)
            }
        }

        return 'aria-hidden writes dropped'
    },
    // Component.setVisible becomes a no-op (Tab.doLayout's per-pass hide/show round trip disappears).
    'novisible': () => {
        const any = walkComponents()[0]

        return any ? noopOnOwningProto(any, 'setVisible') : 'no component'
    },
    // The Dock's Tab layout stops laying out (visible editor no longer resizes with the pane).
    'tab.doLayout': () => {
        for (const c of walkComponents()) {
            const lm = typeof (c as AnyObj).getLayoutManager === 'function' ? ((c as AnyObj).getLayoutManager as () => AnyObj | null)() : null

            if (lm && isA(lm, 'Tab')) {
                return noopOnOwningProto(lm, 'doLayout')
            }
        }

        return 'no Tab layout manager'
    },
    // Tree stops re-rendering its row window (no per-frame row width writes).
    'tree.renderWindow': () => {
        const tree = walkComponents().find(c => isA(c, 'Tree'))

        return tree ? noopOnOwningProto(tree, 'renderWindow') : 'no Tree instance'
    },
    // Tree ignores layout entirely (neither resizes itself nor its rows).
    'tree.doLayout': () => {
        const tree = walkComponents().find(c => isA(c, 'Tree'))

        return tree ? noopOnOwningProto(tree, 'doLayout') : 'no Tree instance'
    },
    // The VirtualScroller stops updating scrollbar metrics per frame.
    'scroller.layoutScrollbars': () => {
        const tree = walkComponents().find(c => isA(c, 'Tree'))

        if (!tree) {
            return 'no Tree instance'
        }

        for (const key of Object.keys(tree)) {
            const v = (tree as AnyObj)[key] as AnyObj

            if (v && typeof v === 'object' && typeof (v as AnyObj).layoutScrollbars === 'function') {
                return noopOnOwningProto(v, 'layoutScrollbars')
            }
        }

        return 'no scroller field on Tree'
    },
    // The Files view's Accordion stops laying out its sections.
    'accordion.doLayout': () => {
        for (const c of walkComponents()) {
            const lm = (c.getLayoutManager as (() => AnyObj) | undefined)?.call(c)

            if (lm && isA(lm, 'Accordion')) {
                return noopOnOwningProto(lm, 'doLayout')
            }
        }

        return 'no Accordion layout manager'
    },
    // The explorer content Card stops laying out its visible page.
    'card.doLayout': () => {
        for (const c of walkComponents()) {
            const lm = (c.getLayoutManager as (() => AnyObj) | undefined)?.call(c)

            if (lm && isA(lm, 'Card')) {
                return noopOnOwningProto(lm, 'doLayout')
            }
        }

        return 'no Card layout manager'
    },
}

// ---- paint-feature scan ---------------------------------------------------

const EXPENSIVE: Array<[string, (v: string, cs: CSSStyleDeclaration) => boolean]> = [
    ['boxShadow', v => v !== 'none'],
    ['textShadow', v => v !== 'none'],
    ['filter', v => v !== 'none'],
    ['backdropFilter', v => v !== 'none' && v !== ''],
    ['opacity', v => parseFloat(v) < 1],
    ['mixBlendMode', v => v !== 'normal'],
    ['backgroundImage', v => v !== 'none'],
    ['willChange', v => v !== 'auto'],
    ['transform', v => v !== 'none'],
    ['animationName', v => v !== 'none'],
    ['transitionDuration', v => v.split(',').some(d => parseFloat(d) > 0)],
    ['maskImage', v => v !== 'none' && v !== ''],
    ['clipPath', v => v !== 'none'],
    ['borderRadius', (v, cs) => v !== '0px' && cs.overflow !== 'visible'],
    ['overflow', v => v !== 'visible'],
    ['position', v => v === 'fixed' || v === 'sticky'],
]

/**
 * Widths of the panes a gutter drag is supposed to move, for proving the drag
 * actually resized them.
 *
 * Added 2026-09-17: the user observed that dragging the explorer gutter
 * resizes the editor but apparently not the file tree. The harness captured
 * the tree's height once, before the drag, and no widths at all — so it could
 * not have seen that. A drag that moves one pane and not the other is either a
 * library regression or a scenario that never exercised what we thought, and
 * either way every S3 number depends on which.
 */
function paneWidths(): Record<string, number> {
    const width = (sel: string): number =>
        Math.round(document.querySelector(sel)?.getBoundingClientRect().width ?? -1)

    const height = (sel: string): number =>
        Math.round(document.querySelector(sel)?.getBoundingClientRect().height ?? -1)

    return {
        fileTree:   width('.FileTree'),
        treeRow:    width('.TreeRow'),
        codeEditor: width('.CodeEditor'),
        cmContent:  width('.cm-content'),
        // Heights too: a horizontal gutter (`gutter=dock-h`, the S1 scenario)
        // resizes panes vertically, so a width-only probe reports travel 0 for
        // a drag that is working perfectly and proves nothing about one that is
        // not.
        editorH:    height('.CodeEditor'),
        cmContentH: height('.cm-content'),
        cmScrollerH: height('.cm-scroller'),
    }
}

function scanPaintFeatures(): Record<string, unknown> {
    const byProp: Record<string, number> = {}
    const byClassProp: Record<string, Record<string, number>> = {}
    const classCounts: Record<string, number> = {}
    let painted = 0

    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        if (!isPainted(el)) {
            continue
        }

        painted++

        const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(c => c && c !== 'ts-ui-component').slice(0, 2).join('.') || el.tagName.toLowerCase()

        classCounts[cls] = (classCounts[cls] ?? 0) + 1

        const cs = getComputedStyle(el)

        for (const [prop, test] of EXPENSIVE) {
            const value = cs[prop as keyof CSSStyleDeclaration] as string

            if (typeof value === 'string' && test(value, cs)) {
                byProp[prop] = (byProp[prop] ?? 0) + 1
                byClassProp[cls] ??= {}
                byClassProp[cls][prop] = (byClassProp[cls][prop] ?? 0) + 1
            }
        }
    }

    const allClassCounts: Record<string, number> = {}
    const scrollContainers: Array<Record<string, unknown>> = []

    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(c => c && c !== 'ts-ui-component').slice(0, 2).join('.') || el.tagName.toLowerCase()

        allClassCounts[cls] = (allClassCounts[cls] ?? 0) + 1

        const cs = getComputedStyle(el)
        const ox = cs.overflowX
        const oy = cs.overflowY
        const scrollable = ['auto', 'scroll'].includes(ox) || ['auto', 'scroll'].includes(oy)
        const overflowing = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1

        if ((scrollable && overflowing) || el.offsetWidth - el.clientWidth > 2 || el.offsetHeight - el.clientHeight > 2) {
            scrollContainers.push({
                cls, ox, oy,
                client: [el.clientWidth, el.clientHeight],
                scroll: [el.scrollWidth, el.scrollHeight],
                gutter: [el.offsetWidth - el.clientWidth, el.offsetHeight - el.clientHeight],
            })
        }
    }

    return { painted, byProp, byClassProp, classCounts, allClassCounts, scrollContainers, treeDump: dumpTree() }
}

const DUMP_PROPS = ['position', 'display', 'overflow', 'transform', 'willChange', 'contain', 'backgroundColor', 'backgroundImage', 'opacity', 'clipPath', 'isolation', 'zIndex', 'mixBlendMode', 'backfaceVisibility', 'perspective', 'transformStyle']

function describe(el: HTMLElement): Record<string, unknown> {
    const cs = getComputedStyle(el)
    const styles: Record<string, string> = {}

    for (const p of DUMP_PROPS) {
        const v = cs[p as keyof CSSStyleDeclaration] as string

        if (v && !['static', 'block', 'visible', 'none', 'auto', 'normal', '1', 'rgba(0, 0, 0, 0)', 'flat'].includes(v)) {
            styles[p] = v.length > 60 ? v.slice(0, 60) + '…' : v
        }
    }

    const r = el.getBoundingClientRect()

    return {
        tag: el.tagName.toLowerCase(),
        cls: (el.getAttribute('class') ?? '').replace('ts-ui-component', '').trim(),
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        scroll: [el.scrollWidth, el.scrollHeight],
        inline: (el.getAttribute('style') ?? '').slice(0, 160),
        styles,
        children: el.children.length,
    }
}

/** The `.FileTree` subtree: every non-row element in full, plus the first row and its subtree as a sample. */
function dumpTree(): unknown[] {
    const root = document.querySelector<HTMLElement>('.FileTree')

    if (!root) {
        return []
    }

    const out: unknown[] = []
    let sampledRow = false

    const visit = (el: HTMLElement, depth: number): void => {
        const isRow = el.classList.contains('TreeRow')

        if (isRow && sampledRow) {
            return
        }

        out.push({ depth, ...describe(el) })

        if (isRow) {
            sampledRow = true
        }

        for (const child of Array.from(el.children) as HTMLElement[]) {
            visit(child, depth + 1)
        }
    }

    visit(root, 0)

    return out
}

// ---- candidate scroll-cue implementations, injected into the live tree ------

const EDGE_PX = 12
const CUE_COLOR = 'rgba(0, 0, 0, 0.28)'

/** Rewires the FileTree's scroll-cue rendering to `kind`; all four edges lit so variants compare worst-case to worst-case. */
function applyInjection(kind: string): string {
    const tree = document.querySelector<HTMLElement>('.FileTree')
    const overlay = tree?.querySelector<HTMLElement>('div[style*="box-shadow"]')

    if (!tree || !overlay || !overlay.parentElement) {
        return `inject ${kind}: shadow overlay not found`
    }

    const clipBox = overlay.parentElement

    if (kind === 'overlay-lit') {
        for (const edge of ['top', 'bottom', 'left', 'right']) {
            overlay.style.setProperty(`--ts-ss-${edge}`, CUE_COLOR)
        }

        return `inject ${kind}: stock overlay, all four edges lit`
    }

    if (kind === 'overlay-noblur') {
        overlay.style.boxShadow = `inset 0 ${EDGE_PX}px 0 0 ${CUE_COLOR}, inset 0 -${EDGE_PX}px 0 0 ${CUE_COLOR}, inset ${EDGE_PX}px 0 0 0 ${CUE_COLOR}, inset -${EDGE_PX}px 0 0 0 ${CUE_COLOR}`

        return `inject ${kind}: stock overlay geometry, unblurred hard bands, all four edges`
    }

    const litRecipe = `inset 0 ${EDGE_PX}px ${EDGE_PX}px -${EDGE_PX}px ${CUE_COLOR}, inset 0 -${EDGE_PX}px ${EDGE_PX}px -${EDGE_PX}px ${CUE_COLOR}, inset ${EDGE_PX}px 0 ${EDGE_PX}px -${EDGE_PX}px ${CUE_COLOR}, inset -${EDGE_PX}px 0 ${EDGE_PX}px -${EDGE_PX}px ${CUE_COLOR}`

    // Stock overlay, all edges lit, but painted BELOW the rows (first child) so
    // it no longer overlaps-above the composited rows container.
    if (kind === 'overlay-below') {
        overlay.style.boxShadow = litRecipe
        clipBox.insertBefore(overlay, clipBox.firstChild)

        return `inject ${kind}: overlay moved before rowsContainer, all edges lit`
    }

    // No overlay; the inset recipe on the clip box itself (paints under its children).
    if (kind === 'clipbox-shadow') {
        overlay.style.boxShadow = 'none'
        clipBox.style.boxShadow = litRecipe

        return `inject ${kind}: overlay off, lit recipe on clipBox`
    }

    // Stock overlay lit, but the rows container de-composited (2D transform, no will-change).
    if (kind === 'rowscontainer-2d') {
        overlay.style.boxShadow = litRecipe

        const rows = Array.from(clipBox.children).find(el => el !== overlay && (el as HTMLElement).style.transform) as HTMLElement | undefined

        if (!rows) {
            return `inject ${kind}: rowsContainer not found`
        }

        rows.style.willChange = 'auto'
        rows.style.transform = 'translate(0px, 0px)'

        return `inject ${kind}: overlay lit, rowsContainer will-change:auto + 2D transform`
    }

    // Overlay moved OUT of the clip box into the tree element, geometry copied
    // from the clip box: 'below' = before the clip box (paints under rows),
    // 'above' = last child (paints over rows and scrollbars).
    if (kind === 'overlay-outside-below' || kind === 'overlay-outside-above') {
        overlay.style.boxShadow = litRecipe

        for (const prop of ['left', 'top', 'width', 'height'] as const) {
            overlay.style[prop] = clipBox.style[prop] || overlay.style[prop]
        }

        if (kind === 'overlay-outside-below') {
            tree.insertBefore(overlay, clipBox)
        } else {
            tree.appendChild(overlay)
        }

        return `inject ${kind}: overlay moved to tree element (${kind.endsWith('below') ? 'before clipBox' : 'last child'}), geometry ${overlay.style.left}/${overlay.style.top}/${overlay.style.width}/${overlay.style.height}, all edges lit`
    }

    // Stock overlay lit, with every composited layer inside the tree removed:
    // rows container and every row lose will-change and 3D transforms.
    if (kind === 'tree-uncomposited') {
        overlay.style.boxShadow = litRecipe

        let touched = 0

        for (const el of Array.from(tree.querySelectorAll<HTMLElement>('*'))) {
            if (el.style.willChange || /translate3d/.test(el.style.transform)) {
                el.style.willChange = 'auto'
                el.style.transform = el.style.transform.replace(/translate3d\(([^,]+),([^,]+),[^)]+\)/, 'translate($1,$2)')
                touched++
            }
        }

        return `inject ${kind}: overlay lit, ${touched} elements de-composited`
    }

    // Stock overlay lit, frozen at its current pixel size (does not resize with the pane).
    if (kind === 'overlay-fixed') {
        overlay.style.boxShadow = litRecipe

        const r = overlay.getBoundingClientRect()

        overlay.style.width = `${Math.round(r.width)}px`
        overlay.style.height = `${Math.round(r.height)}px`

        return `inject ${kind}: overlay lit, size frozen at ${Math.round(r.width)}x${Math.round(r.height)}`
    }

    overlay.style.boxShadow = 'none'

    const edges: Array<[Record<string, string>, string, string]> = [
        [{ top: '0', left: '0', right: '0', height: `${EDGE_PX}px` }, 'to bottom', `inset 0 ${EDGE_PX}px ${EDGE_PX}px -${EDGE_PX}px ${CUE_COLOR}`],
        [{ bottom: '0', left: '0', right: '0', height: `${EDGE_PX}px` }, 'to top', `inset 0 -${EDGE_PX}px ${EDGE_PX}px -${EDGE_PX}px ${CUE_COLOR}`],
        [{ top: '0', bottom: '0', left: '0', width: `${EDGE_PX}px` }, 'to right', `inset ${EDGE_PX}px 0 ${EDGE_PX}px -${EDGE_PX}px ${CUE_COLOR}`],
        [{ top: '0', bottom: '0', right: '0', width: `${EDGE_PX}px` }, 'to left', `inset -${EDGE_PX}px 0 ${EDGE_PX}px -${EDGE_PX}px ${CUE_COLOR}`],
    ]

    for (const [pos, direction, shadow] of edges) {
        const strip = document.createElement('div')

        Object.assign(strip.style, { position: 'absolute', pointerEvents: 'none' }, pos)

        if (kind === 'strips-gradient') {
            strip.style.background = `linear-gradient(${direction}, ${CUE_COLOR}, rgba(0, 0, 0, 0))`
        } else if (kind === 'strips-shadow') {
            strip.style.boxShadow = shadow
        } else if (kind === 'strips-solid') {
            strip.style.background = 'rgba(0, 0, 0, 0.12)'
        } else if (kind === 'strips-opaque') {
            strip.style.background = 'rgb(210, 210, 210)'
        } else if (kind === 'lines-1px') {
            strip.style.background = 'rgb(160, 160, 160)'

            if (pos.height) {
                strip.style.height = '1px'
            } else {
                strip.style.width = '1px'
            }
        } else {
            return `inject ${kind}: unknown kind`
        }

        clipBox.appendChild(strip)
    }

    return `inject ${kind}: overlay shadow off, four ${EDGE_PX}px strips appended, all edges lit`
}

async function run(): Promise<void> {
    const mode = params.get('mode') ?? 'filetree'
    const css = params.get('css')
    const abl = (params.get('abl') ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const frames = parseInt(params.get('frames') ?? '150', 10)
    const stepPx = parseInt(params.get('step') ?? '3', 10)
    const notes: string[] = []

    try {
        await waitFor(() => document.querySelector('.SplitGutter'), 20000, 'shell')
        await sleep(500)

        if (mode !== 'noproject') {
            ;(window as unknown as { __FAKE_PROJECT_ROOT__: string }).__FAKE_PROJECT_ROOT__ = __QA_PROJECT_ROOT__
            findButtonByText('Open Folder').click()
            await waitFor(() => document.querySelectorAll('.TreeRow').length >= 50, 20000, 'tree rows')
            await sleep(1500)
        }

        for (const label of (params.get('expand') ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
            const row = Array.from(document.querySelectorAll<HTMLElement>('.TreeRow')).find(r => (r.textContent ?? '').trim() === label)

            if (row) {
                row.click()
                await sleep(700)
                notes.push(`expanded ${label}`)
            } else {
                notes.push(`no row ${label}`)
            }
        }

        // tabs=N: open N files from the tree by double-clicking file rows, so the
        // Dock holds N FileEditor panels (one visible, N-1 hidden).
        const tabs = parseInt(params.get('tabs') ?? '0', 10)

        if (tabs > 0) {
            // Source-like files only: no lockfiles or multi-megabyte timeline JSONs.
            const fileRows = Array.from(document.querySelectorAll<HTMLElement>('.TreeRow')).filter(r => {
                const label = (r.textContent ?? '').trim()

                return /\.(ts|md|html|toml|rs|css)$/i.test(label) && !/lock/i.test(label)
            })
            let opened = 0

            for (const row of fileRows) {
                if (opened >= tabs) {
                    break
                }

                row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }))
                opened += 1
                await sleep(400)
            }

            try {
                await waitFor(() => document.querySelectorAll('.CodeEditor').length >= tabs, 20000, 'editors')
            } catch (error) {
                notes.push(String(error))
            }

            await sleep(1500)
            notes.push(`opened ${opened} tabs (${document.querySelectorAll('.CodeEditor').length} editors)`)
        }

        // grid=2x2: arrange the first four open panels as two rows of two via
        // the Dock's own layout-state restore (what a saved session does).
        if (params.get('grid') === '2x2') {
            const dock = walkComponents().find(c => typeof (c as AnyObj).getLayoutState === 'function' && typeof (c as AnyObj).setLayoutState === 'function')

            if (!dock) {
                notes.push('no Dock found')
            } else {
                const state = ((dock as AnyObj).getLayoutState as () => AnyObj)()
                const panels: AnyObj[] = []
                const collect = (node: AnyObj): void => {
                    if (node.kind === 'panel') {
                        panels.push(node)
                    }

                    for (const child of (node.children as AnyObj[] | undefined) ?? []) {
                        collect(child)
                    }
                }

                collect(state.root as AnyObj)

                if (panels.length < 4) {
                    notes.push(`grid needs 4 panels, found ${panels.length}`)
                } else {
                    const tab = (panel: AnyObj): AnyObj => ({ kind: 'tab', children: [panel], activeIndex: 0 })
                    const row = (a: AnyObj, b: AnyObj): AnyObj => ({ kind: 'split', orientation: 'horizontal', children: [tab(a), tab(b)], ratios: [0.5, 0.5], collapsed: [false, false] })
                    const root = { kind: 'split', orientation: 'vertical', children: [row(panels[0], panels[1]), row(panels[2], panels[3])], ratios: [0.5, 0.5], collapsed: [false, false] }

                    ;((dock as AnyObj).setLayoutState as (s: AnyObj) => void)({ version: 1, root, windows: [] })
                    await sleep(1500)
                    notes.push(`grid 2x2 applied (${document.querySelectorAll('.SplitGutter').length} gutters, ${document.querySelectorAll('.CodeEditor').length} editors)`)
                }
            }
        }

        if (params.get('count') === '1') {
            installWriteCounters()
            notes.push('write counters installed')

            // Opt-in: see `installDeepStyleCounters`. Off by default so frame
            // timings stay comparable with everything measured before
            // 2026-09-17; on when the question is what the library writes.
            if (params.get('deepwrites') === '1') {
                notes.push(installDeepStyleCounters())
            }
        }

        if (mode.startsWith('search')) {
            findButtonByText('Search').click()
            await sleep(600)

            if (mode === 'search-populated') {
                const input = await waitFor(() => document.querySelector<HTMLInputElement>('input[placeholder="Search project (Enter)"]'), 5000, 'query field')

                input.focus()
                input.value = params.get('q') ?? 'function'
                input.dispatchEvent(new Event('input', { bubbles: true }))
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }))
                input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }))

                try {
                    await waitFor(() => countPainted('.TreeRow') >= 30, 15000, 'search results')
                } catch (error) {
                    notes.push(String(error))
                }

                await sleep(2000)
            }
        }

        // collapse=1: collapse the explorer pane (Split pane 0) through the live
        // Split, exactly as Loom's explorer toggle does, then let the animation settle.
        const collapse = params.get('collapse') === '1'

        if (collapse) {
            const found = findExplorerSplit()

            if (found) {
                ;(found.split.setPaneCollapsed as (i: number, v: boolean) => void).call(found.split, 0, true)
                await sleep(1500)
                notes.push(`collapsed explorer pane 0 (isPaneCollapsed=${(found.split.isPaneCollapsed as (i: number) => boolean).call(found.split, 0)})`)
            } else {
                notes.push('no explorer Split found')
            }
        }

        if (css) {
            const style = document.createElement('style')

            style.textContent = css
            document.head.appendChild(style)
            await sleep(800)
        }

        for (const name of abl) {
            const fn = ABLATIONS[name]

            notes.push(fn ? `${name}: ${fn()}` : `${name}: unknown ablation`)
        }

        // After the ablations on purpose: a count taken under an ablation must
        // reflect the ablated code, so it can say whether the ablation removed
        // the work it claims to rather than merely changing the timing.
        if (params.get('work') === '1') {
            for (const note of installWorkCounters()) {
                notes.push(`work: ${note}`)
            }
        }

        const inject = params.get('inject')

        if (inject) {
            notes.push(applyInjection(inject))
        }

        if (abl.length || inject) {
            await sleep(800)
        }

        const before = {
            viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
            treeRowsTotal: document.querySelectorAll('.TreeRow').length,
            treeRowsPainted: countPainted('.TreeRow'),
            svgPainted: countPainted('svg'),
            textPainted: countPainted('.Text'),
            elements: document.querySelectorAll('*').length,
            codeEditors: document.querySelectorAll('.CodeEditor').length,
            invisible: document.querySelectorAll('.ts-ui-component.invisible').length,
            undisplayed: document.querySelectorAll('.ts-ui-component.undisplayed').length,
            cmLines: document.querySelectorAll('.cm-line').length,
            treeRectHeight: Math.round(document.querySelector('.FileTree')?.getBoundingClientRect().height ?? -1),
            treeDisplay: (() => { const t = document.querySelector('.FileTree'); return t ? getComputedStyle(t).display : 'none-found' })(),
            collapsed: collapse,
            clampTally: clampTally(),
            scan: scanPaintFeatures(),
        }

        const idle = summarize(await measureRaf(60))

        // A collapsed explorer gutter is a strip, not a drag handle: skip the
        // drag phase and rely on the resize phase in that configuration.
        const which = params.get('gutter') ?? 'explorer'

        if (!collapse) {
            notes.push(`drag target: ${pickGutter(which).label}`)
        }

        widthProbe = params.get('widthprobe') === '1'

        const widthsBefore = paneWidths()

        resetWriteCounts()
        workCounts = {}
        counting = true
        workCounting = true
        const drag = collapse ? null : summarize(await runDrag(frames, stepPx, which))
        counting = false
        workCounting = false
        const dragWrites = perFrameWriteCounts(frames)
        const dragWork = perFrameWorkCounts(frames)

        const widthsAfter = paneWidths()
        const widthDelta: Record<string, number> = {}

        for (const key of Object.keys(widthsBefore)) {
            widthDelta[key] = widthsAfter[key] - widthsBefore[key]
        }

        notes.push(`pane width delta over drag: ${Object.entries(widthDelta).map(([k, v]) => `${k}=${v >= 0 ? '+' : ''}${v}`).join(', ')}`)

        if (widthProbe) {
            notes.push(`pane width travel mid-drag: ${Object.entries(widthRange).map(([k, r]) => `${k}=${r.max - r.min}`).join(', ')}`)
        }

        const resizeFrames = parseInt(params.get('resize') ?? '0', 10)
        const resize = resizeFrames > 0 ? summarize(await runResize(resizeFrames, stepPx)) : null

        const idleAfter = summarize(await measureRaf(30))
        const scroll = collapse ? null : summarize(await runWheelScroll(parseInt(params.get('scroll') ?? '120', 10)))

        await report({ scenario, mode, css, abl, frames, stepPx, before, widthsBefore, widthsAfter, widthDelta, widthRange, widthSeries, idle, drag, dragWrites, dragWork, forcedStacks: { ...forcedStacks }, resize, idleAfter, scroll, notes, ua: navigator.userAgent })
    } catch (error) {
        await report({ scenario, mode, css, abl, error: String(error), stack: (error as Error)?.stack, notes })
    }
}

if (scenario) {
    void run()
}
