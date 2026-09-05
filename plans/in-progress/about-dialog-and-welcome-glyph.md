---
touches-shared: [src/appIdentity.ts, src/main.ts, src/shell/EditorShell.ts, src/shell/WelcomeScreen.ts, README.md, TODO.md]
---

# About Dialog & Welcome-Screen Mark — Implementation Plan

## Overview

Two pieces of app identity, neither of which Loom shows today.

**An About dialog.** A *Close*-only modal, opened from a new button pinned to the far right of the menu bar. It names the app, says in one line what the app is, and gives its author plus GitHub links to Loom and to the UI library Loom is built on. Two new files carry it: `src/shell/DismissDialog.ts`, a dismiss-only `Dialog` subclass ported from SQLAdmin, and `src/shell/aboutDialog.ts`, which builds the body as one Markdown string. [`src/shell/EditorShell.ts:383`](src/shell/EditorShell.ts#L383)'s `buildMenuBar` gains the button, [`src/shell/EditorShell.ts:38`](src/shell/EditorShell.ts#L38)'s `MenuBarActions` gains an `onAbout` callback, [`src/main.ts:30`](src/main.ts#L30) registers one more glyph, and [`src/appIdentity.ts:5`](src/appIdentity.ts#L5) gains an `APP_TAGLINE` constant.

**The Loom mark on the welcome screen.** [`src/shell/WelcomeScreen.ts:64`](src/shell/WelcomeScreen.ts#L64) stacks heading, hint, *Open Folder…* button and recent-projects list in one centred `VBox`. An `Image` showing [`src/appIdentity.ts:27`](src/appIdentity.ts#L27)'s `APP_FAVICON` data URI joins that column as its first child, at a locked 80×80.

The two pieces share no code and can land in either order or separately.[^independent] Both are pure additions: no existing behaviour changes, and nothing outside the eight files in `## Files to Create / Modify / Delete` is touched.

---

## Architecture Decisions

### Port SQLAdmin's `DismissDialog`, without its extra-buttons option

`src/shell/DismissDialog.ts` is a near-verbatim port of [`../sqladmin/frontend/src/shell/DismissDialog.ts`](../sqladmin/frontend/src/shell/DismissDialog.ts): a `Dialog` subclass that wraps the caller's body in a 16px-inset `Panel` and always ends its footer in *Close*. The port drops the source's `extraButtons` option and adapts the source to Loom's formatting.[^dismiss-port]

The class-plus-`callable()` export shape is identical in both codebases, so it carries over unchanged — the same shape [`src/shell/WelcomeScreen.ts:124`](src/shell/WelcomeScreen.ts#L124) and [`src/shell/EditorShell.ts:434`](src/shell/EditorShell.ts#L434) already use.

### The About dialog carries no Version line

The body shows name, tagline, author, source link and UI-library link — no version.[^no-version]

### Register `circle-info` in `main.ts`, not in the module that uses it

The new glyph is imported and registered in [`src/main.ts:30`](src/main.ts#L30)'s single `Glyph.register(...)` call, alongside every other glyph the shell names.[^glyph-root]

### Pin the far-right button to the built `MenuBar`, mirroring SQLAdmin

`buildMenuBar` keeps building the File/Edit/View menus exactly as it does now, then appends a flex `Spacer` and the About `Button` to the returned bar — the pattern at [`../sqladmin/frontend/src/shell/SqlAdminShell.ts:412`](../sqladmin/frontend/src/shell/SqlAdminShell.ts#L412). `MenuBar` lays its children out with an `HBox`, so the flex spacer absorbs the width between the left-aligned menus and the button.

### Lock the mark's size with `minSize` and `maxSize`, not `preferredSize` alone

The welcome `Image` receives the same 80×80 size as all three of `preferredSize`, `minSize` and `maxSize`. `Image` overrides `getPreferredSize()` to report the picture's natural dimensions and never consults the `preferredSize` constraint, so `preferredSize` alone leaves the 240×240 artwork rendering at full size.[^mark-size]

| Options passed to `Image` | What the layout reads | Rendered mark |
|---|---|---|
| none | `Image.getPreferredSize()` → natural 240×240 | 240×240 — fills the column |
| `preferredSize` only | the same override; the constraint is ignored | 240×240 — unchanged |
| `preferredSize` + `minSize` + `maxSize` | `LayoutManager.resolveBounds` clamps the cell to the child's own min/max | 80×80 |

### Show each URL as its own link text

Both links read as the bare URL — `[github.com/jimka/loom](https://github.com/jimka/loom)` — so the address is legible whether or not a click reaches a browser.[^link-text]

---

## Public API

`src/appIdentity.ts` — one added constant:

```typescript
/** A one-line description of what the app is. */
export const APP_TAGLINE: string
```

`src/shell/DismissDialog.ts` — new module:

```typescript
export interface DismissDialogOptions {
    title: string        // title-bar text
    content: Component   // the body, mounted inside the padded wrapper
    width: number        // dialog panel width in pixels
}

class DismissDialog extends Dialog {
    constructor(options: DismissDialogOptions)
}

// Callable-class export: callers write `DismissDialog(options)`, no `new`.
export { DismissDialogCallable as DismissDialog }
```

`src/shell/aboutDialog.ts` — new module:

```typescript
export function openAboutDialog(): void
```

`src/shell/EditorShell.ts` — one added field on the existing (non-exported) `MenuBarActions` interface:

```typescript
/** Opens the About dialog — the far-right menu-bar button. */
onAbout: () => void
```

---

## Internal Structure

### `src/shell/DismissDialog.ts`

```typescript
// A dismiss-only information modal: a padded content wrapper around the
// caller's body, a title bar, and a footer that ends in Close. The base owns
// the padded wrapper (a single 16px inset on all four sides) so every caller
// gets identical padding without declaring its own.
//
// The content must never set its own `autoScroll`: `Dialog`'s own content
// container already wraps whatever `contentComponent` it is handed in a Panel
// with `autoScroll: 'y'`, so a second one nests one scroll region inside
// another and the dialog shows two scrollbars.
import { Dialog, DialogButtons } from '@jimka/typescript-ui/overlay'
import { Panel, callable } from '@jimka/typescript-ui/core'
import type { Component } from '@jimka/typescript-ui/core'
import { VBox } from '@jimka/typescript-ui/layout'
import { Insets } from '@jimka/typescript-ui/primitive'

/**
 * The content's padding inset, in pixels — the same value on all four sides,
 * declared once here so no caller writes its own and dismiss-only dialogs
 * cannot drift apart in padding.
 */
const CONTENT_PAD = 16

/** Construction inputs for {@link DismissDialog}. */
export interface DismissDialogOptions {
    /** Title-bar text. */
    title: string
    /** The dialog body. Mounted inside the padded content wrapper this class owns. */
    content: Component
    /** Dialog panel width in pixels. */
    width: number
}

/**
 * A dismiss-only information modal. Wraps `options.content` in a padded
 * `Panel` before handing it to `Dialog` as `contentComponent`, so callers
 * never build that wrapper themselves.
 */
class DismissDialog extends Dialog {
    /**
     * @param options - The dialog's title, body, and width.
     */
    constructor(options: DismissDialogOptions) {
        const body = Panel({
            // Stretch the content to the dialog's content width so it has a
            // concrete width to wrap and self-measure within.
            layoutManager: new VBox({ itemAlign: 'stretch' }),
            insets: new Insets(CONTENT_PAD, CONTENT_PAD, CONTENT_PAD, CONTENT_PAD),
            components: [options.content],
        })

        super({
            title: options.title,
            contentComponent: body,
            buttons: [DialogButtons.Close],
            width: options.width,
            closeOnBackdrop: true,
        })
    }
}

const DismissDialogCallable = callable(DismissDialog)
type DismissDialogCallable = DismissDialog
export { DismissDialogCallable as DismissDialog }
```

### `src/shell/aboutDialog.ts`

```typescript
// The About dialog: a small, dismiss-only modal reached from the far right of
// the menu bar. It names the app, says in one line what it is, who wrote it,
// and where the app and its UI library live on GitHub. Built on
// `DismissDialog` so it matches the app's other modals; the body is a single
// authored Markdown string rendered by the library's read-only Markdown
// component.
import { Markdown } from '@jimka/typescript-ui/component/display'
import { DismissDialog } from './DismissDialog'
import { APP_NAME, APP_TAGLINE } from '../appIdentity'

/**
 * The dialog's fixed width, in pixels. `Dialog` sizes its height to the
 * wrapped content, measured at this width, so the body copy can be natural
 * sentences that wrap rather than hand-broken single lines. 460 matches
 * SQLAdmin's own About dialog: clear of `Dialog`'s 320px floor, a little
 * under its 480px default, and wide enough for the two link lines to sit on
 * one line each.
 */
const DIALOG_WIDTH = 460

/**
 * The dialog body, authored as Markdown and built from the `appIdentity`
 * constants so the name and tagline cannot drift from what the rest of the
 * UI shows. Blank lines between blocks are required — the renderer lexes
 * them as separate paragraphs, and without them the whole body collapses
 * into one.
 */
const ABOUT_MARKDOWN = `# ${APP_NAME}

${APP_TAGLINE}

**Author:** Jimmy Karlsson

**Source:** [github.com/jimka/loom](https://github.com/jimka/loom)

**UI library:** [github.com/jimka/typescript-ui](https://github.com/jimka/typescript-ui)`

/**
 * Opens the modal About dialog. Fire-and-forget: the only outcome is
 * dismissal — the Close button, Escape, a backdrop click, or the title-bar
 * close — so the resolved result is deliberately ignored. The Markdown body
 * needs no explicit teardown: `Dialog.hide` destroys the dialog and the
 * children registered under it, the body among them.
 */
export function openAboutDialog(): void {
    void DismissDialog({
        title: `About ${APP_NAME}`,
        content: Markdown(ABOUT_MARKDOWN),
        width: DIALOG_WIDTH,
    }).show()
}
```

### `buildMenuBar`'s new tail in `src/shell/EditorShell.ts`

The `menus:` array is unchanged; only the surrounding statements are new.

```typescript
function buildMenuBar(actions: MenuBarActions): MenuBar {
    const menuBar = MenuBar({
        menus: [ /* …File, Edit and View, exactly as today… */ ],
    })

    // Pin an About button to the far right of the bar: a flex spacer eats the
    // width between the left-aligned menus and the button, so the button sits
    // at the trailing edge. Appended after the factory rather than through
    // `menus` (whose entries are dropdown openers) — safe because the shell
    // builds its menus once and never calls setMenus again, which would wipe
    // these appended children.
    const about = Button({ glyph: 'circle-info', text: 'About', showText: true, showDescription: false, compact: true, flat: true })

    about.on('action', actions.onAbout)
    menuBar.addComponent(Spacer.flex())
    menuBar.addComponent(about)

    return menuBar
}
```

### The mark in `src/shell/WelcomeScreen.ts`

Module constants, beside the existing `HEADING_FONT_SIZE` / `CONTENT_SPACING` group:

```typescript
/**
 * The Loom mark's rendered edge length on the welcome screen, in pixels.
 * Exactly a third of the mark's own 240-unit viewBox, so its 18-unit strokes
 * land on whole pixels (6px), and large enough to read as the page's mark
 * above the 20px heading without dominating the column.
 */
const MARK_SIZE_PX = 80

/**
 * The mark's locked display size. Passed as all three of `preferredSize`,
 * `minSize` and `maxSize`: `Image.getPreferredSize` reports the picture's
 * natural dimensions and ignores the `preferredSize` constraint, so the
 * min/max pair is what actually holds the 240×240 artwork at MARK_SIZE_PX.
 */
const MARK_SIZE = { width: MARK_SIZE_PX, height: MARK_SIZE_PX }
```

Construction, inside the constructor before the `super(...)` call:

```typescript
const mark = Image(APP_FAVICON, { preferredSize: MARK_SIZE, minSize: MARK_SIZE, maxSize: MARK_SIZE })
```

and the `super(...)` component list becomes `components: [mark, heading, hint, openFolder, recentList]`. The mark is not stored on the instance — nothing updates it after construction.

---

## Ordered Implementation Steps

### The About dialog

1. **Add `APP_TAGLINE` to [`src/appIdentity.ts`](src/appIdentity.ts).** Place it directly after `APP_NAME` (line 5), before the `APP_MARK_SVG` block:

   ```typescript
   /**
    * A one-line description of what the app is, for the About dialog's body.
    * Carries Markdown inline-code backticks around the library's package
    * name: the dialog renders this string as Markdown, and that is its only
    * consumer.
    */
   export const APP_TAGLINE = 'A local desktop code editor built on `@jimka/typescript-ui`, packaged with Tauri.'
   ```

   In the same edit, amend the file's opening comment (lines 1–2) so it reads "the app's name, tagline, and tab icon" rather than "the app's name and tab icon".

2. **Create [`src/shell/DismissDialog.ts`](src/shell/DismissDialog.ts)** with the source in `## Internal Structure`. Then `npm run typecheck` — clean (the module compiles with no caller yet).

3. **Create [`src/shell/aboutDialog.ts`](src/shell/aboutDialog.ts)** with the source in `## Internal Structure`. Then `npm run typecheck` — clean.

4. **Register the glyph in [`src/main.ts`](src/main.ts).** Add `import { circle_info } from '@jimka/typescript-ui/glyphs/solid/circle_info'` after the `gear` import (line 18), and add `circle_info` to the `Glyph.register(...)` call at lines 30–33. Then `grep -n 'circle_info' src/main.ts` — expect exactly two matches.

5. **Wire the action into [`src/shell/EditorShell.ts`](src/shell/EditorShell.ts).** Three edits in one pass:
   - Imports: add `Spacer` to the existing `@jimka/typescript-ui/component/container` import (line 6, currently `{ CheckboxMenuRow }`); add `import { Button } from '@jimka/typescript-ui/component/button'`; add `import { openAboutDialog } from './aboutDialog'` beside the other `./`-relative shell imports.
   - `MenuBarActions` (line 38): add `/** Opens the About dialog — the far-right menu-bar button. */ onAbout: () => void` as the last member, after `hasProjectRoot`.
   - The `actions` object in the constructor (line 120): add `onAbout: () => openAboutDialog(),` as its last entry.

   Then `npm run typecheck` — clean. It fails if the `MenuBarActions` member and the `actions` entry did not land together, which is why they are one step.

6. **Add the far-right button in `buildMenuBar`** ([`src/shell/EditorShell.ts:383`](src/shell/EditorShell.ts#L383)), per `## Internal Structure`: change `return MenuBar({…})` into `const menuBar = MenuBar({…})`, leave the `menus:` array untouched, then append the spacer and button and `return menuBar`. Update the function's JSDoc summary (line 377) from "The File, Edit, and View menus." to name the far-right About button as well. Then `npm run typecheck` — clean.

### The welcome-screen mark

7. **Add the mark to [`src/shell/WelcomeScreen.ts`](src/shell/WelcomeScreen.ts).** Four edits in one pass:
   - Imports: add `import { Image } from '@jimka/typescript-ui/component/display'` after the `Button` import (line 4), and `import { APP_FAVICON } from '../appIdentity'` beside the existing `../data/paths` import.
   - Constants: add `MARK_SIZE_PX` and `MARK_SIZE` from `## Internal Structure` above `HEADING_FONT_SIZE` (line 9).
   - Constructor: build `mark` (see `## Internal Structure`) as the first local, and make it the first entry of the `super(...)` `components` array (line 67).
   - Class JSDoc (lines 35–43): the sentence listing the column's contents ("holding the heading, the hint, the Open Folder button, and …") gains the mark at the front of that list.

   Then `npm run typecheck` — clean.

### Documentation

8. **Update [`README.md`](README.md).** In the **Welcome screen** bullet (lines 41–42), say the screen is shown under the Loom mark. Insert a new bullet immediately after it:

   ```markdown
   - **About** — a *Close*-only dialog on the far right of the menu bar,
     naming the app and its author, with links to Loom's own repository and to
     the UI library it is built on.
   ```

9. **Update [`TODO.md`](TODO.md).** Add one bullet at the end of the `## Known issues / loose ends` section (line 82 onwards):

   ```markdown
   - **External links depend on the webview.** The About dialog's *Source* and
     *UI library* links render as `target="_blank"` anchors — the library's
     Markdown default. Loom wires no opener/shell plugin (see the plugin list
     under `## Notes`), so whether a click reaches the system browser is up to
     the platform's webview. Each link's text is the URL itself, so the
     address stays readable either way.
   ```

10. **Run the whole of `## Verification`,** including the manual cases.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `src/shell/DismissDialog.ts` |
| Create | `src/shell/aboutDialog.ts` |
| Modify | `src/appIdentity.ts` |
| Modify | `src/main.ts` |
| Modify | `src/shell/EditorShell.ts` |
| Modify | `src/shell/WelcomeScreen.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

Loom's vitest suite runs in the `node` environment and covers the pure data helpers only — [`vitest.config.ts`](vitest.config.ts) records that "component/DOM behaviour is verified live, not here". Both pieces here are component construction with no branching rule to pin, so **no new automated test is added** and every case below is manual verification in the Tauri window (`npm run tauri:dev`).[^no-test]

### About dialog

1. **The button sits at the trailing edge.** The menu bar shows *File*, *Edit* and *View* left-aligned as before, and an **About** button with a filled info-circle glyph at the far right. Widening and narrowing the window keeps the button at the right edge and the menus at the left.
2. **The glyph renders.** The button shows the info circle, not a blank gap or a missing-glyph box — this is what proves the `circle-info` registration landed.
3. **Clicking About opens the dialog.** Title bar reads *About Loom*. The body shows "Loom" as a heading, then the tagline sentence with `@jimka/typescript-ui` rendered as inline code, then **Author:** Jimmy Karlsson, **Source:** github.com/jimka/loom, **UI library:** github.com/jimka/typescript-ui. Exactly one footer button, *Close*. No Version line anywhere.
4. **The body is padded and wraps.** Text is inset from all four panel edges, the tagline wraps inside the 460px panel rather than being clipped, and the dialog shows **at most one** scrollbar — never two nested ones.
5. **Every dismissal path works.** *Close*, Escape, a click on the backdrop outside the panel, and the title-bar close each dismiss the dialog and remove the backdrop. The editor, tree and menus respond normally afterwards.
6. **Reopening works repeatedly.** Open and dismiss the dialog ten times: no leftover backdrop, no stacked panels, no growing set of dialogs behind the current one.
7. **Links do not hijack the window.** Clicking *Source* either opens the system browser or does nothing. It must **not** navigate the Loom window itself to GitHub; if it does, apply the fallback in `## Potential Challenges`.
8. **The rest of the menu bar is unchanged.** Every File/Edit/View item still opens, and enablement still greys out per-file items with no file open.

### Welcome-screen mark

9. **No project open.** The welcome screen shows the Loom mark — a dark rounded-square tile with the light hook stroke and orange bar — centred above the "Welcome to Loom" heading, with the hint, *Open Folder…* and any Recent Projects list below, in that order.
10. **The mark is 80×80.** About four times the 20px heading's font size, not a column-filling 240px block. If it renders far larger, the `minSize`/`maxSize` options did not land.
11. **Project open, no file open.** The mark still sits above the heading, which now shows the project's name.
12. **Resizing does not resize the mark.** Widening, narrowing and shortening the window, and dragging the explorer split wider, leave the mark at the same size; the column stays centred and no horizontal scrollbar appears.
13. **The empty state still switches away.** Opening a file swaps the welcome page for the tab strip; closing the last file brings the welcome page — mark included — back.

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — clean and unchanged; no test file is touched.
- `npm run build` — clean.
- `grep -rn 'circle_info\|circle-info' src/` — exactly three matches: the import and the `Glyph.register` argument in `src/main.ts`, and the `Button` glyph name in `src/shell/EditorShell.ts`.
- `grep -rn 'APP_TAGLINE' src/` — exactly two matches: the definition in `src/appIdentity.ts` and the use in `src/shell/aboutDialog.ts`.
- `grep -rn 'APP_VERSION\|__APP_VERSION__' src/ vite.config.ts vitest.config.ts` — zero matches, confirming no version plumbing crept in.
- `grep -n 'Spacer' src/shell/EditorShell.ts` — exactly two matches: the import and the `Spacer.flex()` call.
- `grep -n 'setMenus' src/shell/EditorShell.ts` — zero matches; a `setMenus` call would discard the appended spacer and button.
- `git diff --name-only` and `git status --porcelain` — the eight files in the table above, and no other tracked file.
- Manual: `npm run tauri:dev`, then cases 1–13 in `## Expected Behaviour`. Cases 2, 4, 7 and 10 are the ones most likely to fail; the rest guard what already worked.

---

## Documentation Impact

Loom has no docs site and no API reference — `README.md` and `TODO.md` are the whole documentation surface, and both are edited in steps 8 and 9. Neither new module is part of a public package: Loom is `"private": true` with no export barrel, so nothing else needs re-exporting or listing.

---

## Potential Challenges

- **The mark renders at 240×240.** Means only `preferredSize` reached the `Image`. Confirm all three of `preferredSize`, `minSize` and `maxSize` are in the options bag — the min/max pair is what the layout actually clamps to.
- **A link navigates the Loom window to GitHub.** Would leave the app showing a web page until restart. Fallback: drop the two Markdown links and show each URL as an inline-code span (`` `github.com/jimka/loom` ``), keeping the same visible text with no anchor, and reword the `TODO.md` bullet from step 9 to say the addresses are shown as text because the webview navigates in place.
- **The About button disappears after some later change.** Only one thing removes it: a `setMenus` call on the built bar, which rebuilds the bar's children. Loom builds its menus once; keep it that way.
- **`Image` shadows the DOM's global `Image` inside `WelcomeScreen.ts`.** Expected and harmless — nothing in that module uses the browser constructor. Do not rename the import.
- **Two nested scrollbars in the dialog.** Caused by giving the dialog content its own `autoScroll`; `Dialog` already wraps `contentComponent` in a scrolling panel. `DismissDialog`'s header comment records this; keep it there.

---

## Critical Files

Read before starting:

- [`../sqladmin/frontend/src/shell/DismissDialog.ts`](../sqladmin/frontend/src/shell/DismissDialog.ts) — the port source for step 2, including the nested-scroll warning its header carries.
- [`../sqladmin/frontend/src/shell/aboutDialog.ts`](../sqladmin/frontend/src/shell/aboutDialog.ts) — the About dialog precedent: Markdown body built from `appIdentity` constants, fire-and-forget `show()`.
- [`../sqladmin/frontend/src/shell/SqlAdminShell.ts:412`](../sqladmin/frontend/src/shell/SqlAdminShell.ts#L412) — the far-right menu-bar button pattern step 6 mirrors, comment included.
- [`src/shell/EditorShell.ts`](src/shell/EditorShell.ts) — `MenuBarActions`, the `actions` object, and `buildMenuBar`; also the callable-class export shape at line 434.
- [`src/shell/WelcomeScreen.ts`](src/shell/WelcomeScreen.ts) — the centred `VBox`, the documented module-constant style the new constants follow.
- [`src/main.ts:27`](src/main.ts#L27) — the composition-root glyph registration and the comment explaining why every shell glyph is registered there.
- [`src/appIdentity.ts`](src/appIdentity.ts) — `APP_NAME`, `APP_FAVICON`, and the `APP_MARK_SVG` doc comment describing the 240×240 tile.
- [`../typescript-ui/packages/lib/src/typescript/lib/component/display/Image.ts`](../typescript-ui/packages/lib/src/typescript/lib/component/display/Image.ts) — the `getPreferredSize` / `getMinSize` overrides behind the size-pinning decision.
- [`vitest.config.ts`](vitest.config.ts) — why this change adds no automated test.

---

## Non-Goals

- **No version line, and no version plumbing.** No Vite `define`, no `APP_VERSION`, no reconciliation of `package.json`'s `0.0.0` against `src-tauri/tauri.conf.json`'s `0.1.0`.[^no-version]
- **No Diagnostics/Debug footer button.** SQLAdmin's About dialog carries one because it has a `DiagnosticsOverlay` to open; Loom has no such surface, so its dialog is Close-only.
- **No command-palette entry for About.** [`src/shell/commands.ts:54`](src/shell/commands.ts#L54)'s list covers commands that act on the workspace or the editor; adding one would also mean widening `PaletteCommandActions`.
- **No keyboard accelerator for About.** `onAbout` goes on `MenuBarActions`, not on `AcceleratorActions` — nothing in `src/shell/shortcuts.ts` changes.
- **No opener/shell Tauri plugin** to force external links into the system browser. That is a new Rust dependency plus a capability entry, and `TODO.md`'s plugin list already tracks it.
- **The mark is not added anywhere else** — not to the About dialog body, the menu bar, or the status bar.

---

## Notes

[^independent]: The About dialog touches `appIdentity.ts`, `main.ts` and `EditorShell.ts`; the mark touches `WelcomeScreen.ts` and reads `APP_FAVICON`, which already exists. The only file both pieces read is `appIdentity.ts`, and the mark needs nothing this plan adds there. So steps 1–6 and step 7 can be committed separately, in either order, and each typechecks and runs on its own.

[^dismiss-port]: SQLAdmin's `extraButtons` option exists to carry that app's Diagnostics button. Loom's single caller is Close-only, so shipping the option would ship an unused branch on day one; a future caller that needs extra buttons can add it back with its first use. The other adaptations are formatting only — Loom writes no statement-terminating semicolons, uses single quotes, and does not column-align its imports, so the port is reflowed to match its neighbours in `src/shell/`. Nothing structural changes: the class extends `Dialog`, owns the padded `Panel`, and is exported through `callable()` exactly as in the source. Porting rather than inlining the wrapper into `aboutDialog.ts` keeps the padded-content-plus-Close rule and the nested-scroll warning in one place, which is what the source file exists to do.

[^no-version]: Loom has no maintained version number to show. `package.json` says `0.0.0`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` both say `0.1.0`, and nothing injects any of them into the frontend — `vite.config.ts` has no `define`, and `grep -rn 'APP_VERSION\|__APP_VERSION__' src/ vite.config.ts` finds nothing. SQLAdmin can show a version because its Vite config injects `__APP_VERSION__` from its own `package.json`; copying that here would mean adding the define to `vite.config.ts` and `vitest.config.ts`, an ambient declaration, and a decision about which of the two disagreeing numbers wins — build plumbing for a number nobody maintains. `README.md`'s Status section calls Loom "an early, actively-evolving dogfood project … not published or packaged for distribution", so a version line would be noise at best and misleading at worst. If Loom is ever released, wiring a version is a small, separate change.

[^glyph-root]: `src/main.ts:27`'s comment states the rule directly: "Every glyph the shell, the tree, and the unsaved-changes prompt reference by name, plus the per-file-type set from fileIcons.ts, registered once here at the composition root." Every glyph Loom names — including ones used by a single shell module, such as `gear` and `magnifying-glass` — is registered there, and no Loom module calls `Glyph.register` itself. SQLAdmin does the opposite for its About dialog (`aboutDialog.ts` registers `gauge_high` locally), but Loom's own precedent wins.

[^mark-size]: `Image.getPreferredSize()` returns the element's natural size unconditionally — it never reads `getPreferredSizeConstraint()`, so the `preferredSize` option cannot bind it, whatever the component's own docs page implies. Two other paths do bind it. `LayoutManager.resolveBounds` clamps each child's cell to the child's own min and max sizes, and `Component.setMinSize`/`setMaxSize` also write CSS `min-*`/`max-*` on the element, so the `<img>` is capped even if a layout hands it a larger box. `preferredSize` is still passed: it is the option the library's own docs and its `image-basic` demo use, it is what a reader will look for, and it costs nothing. An explicit `minSize` is needed for a second reason too — absent one, `Image.getMinSize()` derives a minimum of `min(natural, 100)`, i.e. 100px, which would floor the mark above the intended size. On the number: the mark's artwork is a 240-unit viewBox whose inner strokes are 18 units wide, so 80px is an exact 1:3 downscale and those strokes land on 6 whole pixels; 80 also sits mid-range in the 64–96 band that reads as a welcome-screen mark rather than a favicon or a splash graphic.

[^link-text]: Loom runs in a Tauri webview and wires no opener or shell plugin, so a `target="_blank"` anchor — what the library's Markdown component emits for every link by default — has no guaranteed way to reach the system browser. Writing each link's text as its own URL means the reader can read and retype the address even where the click does nothing, which is also what SQLAdmin's About dialog does for its own two links.

[^no-test]: `tests/welcomeText.test.ts` exists because `welcomeCopy` has a rule to test — project open versus not — and `src/shell/welcomeText.ts` was split out of `WelcomeScreen.ts` precisely so that rule could be imported without touching `document`. Neither new module has such a rule: `aboutDialog.ts` builds one fixed string, and the mark is one constructor call. Splitting the About body into a pure module to assert a constant against itself would add a file and prove nothing.
