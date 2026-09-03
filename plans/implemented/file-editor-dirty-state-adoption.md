---
touches-shared: [src/editor/FileEditor.ts, src/EditorController.ts, TODO.md]
---

# FileEditor Dirty-State Adoption — Implementation Plan

## Overview

`FileEditor` keeps its own dirty flag. A `_dirty` field and a `_cleanText`
snapshot ([src/editor/FileEditor.ts:51-52](src/editor/FileEditor.ts#L51)) are
re-diffed on every `"change"` event the wrapped `CodeEditor` fires
([:115-124](src/editor/FileEditor.ts#L115)), and a constructor callback,
`FileEditorParams.onDirtyChange` ([:38-39](src/editor/FileEditor.ts#L38)),
tells `EditorController` when the flag moves.

`@jimka/typescript-ui` now does that job in the framework. `Component` carries
`isDirty()`, `onDirtyChange()`, `offDirtyChange()` and a protected
`setDirty()`, plus a parent-to-child relay wired in `wireChild` /
`unwireChild` so a container's `isDirty()` folds in every descendant's
([Component.ts:2340-2404](node_modules/@jimka/typescript-ui/src/typescript/lib/core/Component.ts#L2340),
[:6439-6487](node_modules/@jimka/typescript-ui/src/typescript/lib/core/Component.ts#L6439)).
`CodeEditor` is its one adopter: it holds a `_cleanValue` string and sets the
flag from `value !== this._cleanValue` on every document change, with a public
`markClean()` that re-takes the clean text
([CodeEditor.ts:286](node_modules/@jimka/typescript-ui/src/typescript/lib/component/editor/CodeEditor.ts#L286),
[:385-390](node_modules/@jimka/typescript-ui/src/typescript/lib/component/editor/CodeEditor.ts#L385),
[:594-601](node_modules/@jimka/typescript-ui/src/typescript/lib/component/editor/CodeEditor.ts#L594)).
That is the same rule Loom hand-rolled, so `FileEditor`'s override currently
shadows a working inherited implementation.[^same-rule]

This plan deletes Loom's copy. `FileEditor` sheds `_dirty`, `_cleanText`,
`syncDirty()` and its `isDirty()` override; `markClean()` forwards to
`CodeEditor.markClean()`; the `onDirtyChange` constructor callback is dropped
and `EditorController` subscribes through the inherited
`onDirtyChange(listener)` instead. `needsSave()`, the `" •"` tab-label marker,
and every save / close / exit flow keep their present behaviour, with one bug
fixed on the way: a file whose text on disk uses CRLF line endings no longer
reports permanently dirty.[^crlf]

`node_modules/@jimka/typescript-ui` is a symlink to
`../typescript-ui/packages/lib` on this machine, so the new API is available
today with no version bump.

---

## Architecture Decisions

### `FileEditor` deletes its `isDirty()` override rather than delegating

The override at [FileEditor.ts:247-250](src/editor/FileEditor.ts#L247) is
removed outright. `Component.isDirty()`, inherited through `Container`,
already answers correctly: the wrapped `CodeEditor` sets its own flag, and the
relay folds it up through `_body` into `FileEditor`.[^inherit-not-delegate]

### The dirty-change notification becomes a listener, registered by `EditorController`

`FileEditorParams.onDirtyChange` and the `_onDirtyChange` field are deleted.
`EditorController` registers on the file itself at both construction sites:
`file.onDirtyChange(() => this.handleDirtyChange(file))`. The closure supplies
the `file` argument the inherited listener signature does not carry.[^listener-not-callback]

### `saveAs` keeps its explicit `setTabName` call

`markClean()` now fires the listener only when the flag actually flips, so a
save that clears no flag relabels no tab. The explicit
`this.tabs.getTab().setTabName(file, file.getLabel())` in `saveAs`
([EditorController.ts:430](src/EditorController.ts#L430)) stays, and the
`setPath` → `markClean` order at [:427-428](src/EditorController.ts#L427) must
not be reordered.[^saveas-relabel]

| Flow | Dirty before | Dirty after | Listener fires | What relabels the tab |
|---|---|---|---|---|
| `save()` on a dirty file with a path | yes | no | yes | the listener |
| `saveAs()` on a dirty file | yes | no | yes | the listener, then `saveAs`'s own call |
| `saveAs()` on a clean untitled buffer | no | no | **no** | `saveAs`'s own call only |

### No new automated tests

Loom's vitest suite runs in the `node` environment over pure data helpers and
never constructs a component; `vitest.config.ts` records that
"component/DOM behaviour is verified live, not here". This change is entirely
component behaviour, so it is verified by typecheck, greps, and the manual
cases below.[^no-tests]

---

## Public API

`FileEditor`'s exported surface after the change. `isDirty()`,
`onDirtyChange()` and `offDirtyChange()` are inherited from `Component` and
are **not** redeclared.

```typescript
// src/editor/FileEditor.ts

export interface FileEditorParams {
    path: string | null
    name: string
    text: string
    projectRoot: string | null
    // `onDirtyChange` removed — callers use the inherited
    // `FileEditor.onDirtyChange(listener)` instead.
}

class FileEditor extends Container {
    // isDirty(): boolean — inherited from Component, no longer overridden.

    /** Whether Save would do anything: the document is dirty, or has no path yet. */
    needsSave(): boolean

    /** Clears the dirty flag by accepting the editor's current document as clean. */
    markClean(): void

    /** The tab label: the file's display name, with `" •"` appended while dirty. */
    getLabel(): string
}
```

Inherited from `Component`, used by `EditorController`:

```typescript
onDirtyChange(listener: (dirty: boolean) => void): this
isDirty(): boolean
```

---

## Internal Structure

`FileEditor`'s three surviving dirty-aware members, in full:

```typescript
/** Whether Save would do anything: the document is dirty, or has no path yet. */
needsSave(): boolean {
    return this.isDirty() || this._path === null
}

/**
 * Accepts the editor's current document as clean, after a successful save.
 * Clearing the wrapped editor's own flag clears this component's `isDirty()`
 * through the framework's parent-to-child relay, which is what notifies the
 * owner.
 */
markClean(): void {
    this._editor.markClean()
}

/** The tab label: the file's display name, with `" •"` appended while dirty. */
getLabel(): string {
    return this.isDirty() ? `${this._name} •` : this._name
}
```

`handleChange` loses its `syncDirty()` call and keeps only the preview refresh:

```typescript
/** The wrapped editor's `"change"` handler — arms a debounced preview refresh
 *  if the preview page is showing. The dirty flag is the editor's own now, so
 *  nothing here touches it. */
private handleChange = (): void => {
    this.schedulePreviewRefresh()
}
```

`EditorController`'s registration, at both `FileEditor` construction sites:

```typescript
file.onDirtyChange(() => this.handleDirtyChange(file))
```

---

## Ordered Implementation Steps

Steps 1-6 leave the tree failing typecheck (`EditorController` still passes a
now-deleted parameter); steps 7-8 close it, and step 9 is the first checkpoint.

1. **[src/editor/FileEditor.ts](src/editor/FileEditor.ts)** — delete the
   `onDirtyChange` field and its doc comment from `FileEditorParams`
   ([:38-39](src/editor/FileEditor.ts#L38)).

2. **Same file** — delete the three private fields `_dirty`
   ([:51](src/editor/FileEditor.ts#L51)), `_cleanText`
   ([:52](src/editor/FileEditor.ts#L52)) and `_onDirtyChange`
   ([:55](src/editor/FileEditor.ts#L55)), plus the two constructor
   assignments that feed them, at [:87](src/editor/FileEditor.ts#L87) and
   [:90](src/editor/FileEditor.ts#L90). `_dirty` has only its field
   initializer, so it has no constructor line to remove. Leave every other
   field and assignment alone.

3. **Same file** — delete the whole `syncDirty()` method and its doc comment
   ([:109-124](src/editor/FileEditor.ts#L109)), and replace `handleChange`
   and its doc comment ([:100-107](src/editor/FileEditor.ts#L100)) with the
   version in **Internal Structure**.

4. **Same file** — delete the `isDirty()` method and its doc comment
   ([:247-250](src/editor/FileEditor.ts#L247)). Do not replace it with a
   delegating override.

5. **Same file** — replace the bodies of `needsSave()`
   ([:252-255](src/editor/FileEditor.ts#L252)), `markClean()`
   ([:257-262](src/editor/FileEditor.ts#L257)) and `getLabel()`
   ([:264-267](src/editor/FileEditor.ts#L264)) with the versions in
   **Internal Structure**, doc comments included.

6. **Same file** — extend the class JSDoc
   ([:42-47](src/editor/FileEditor.ts#L42)) so it says the dirty flag is the
   wrapped `CodeEditor`'s own, reaching this component through the framework's
   parent-to-child relay, and that `isDirty()` is therefore inherited rather
   than declared here. Do not add an `{@link}` to `Component.setDirty` — it is
   protected.

7. **[src/EditorController.ts](src/EditorController.ts), `newFile()`
   ([:244-250](src/EditorController.ts#L244))** — drop the
   `onDirtyChange: this.handleDirtyChange,` line from the `FileEditor({...})`
   call, and add `file.onDirtyChange(() => this.handleDirtyChange(file))`
   immediately after the construction, before the `this.tabs.addTab(...)`
   line.

8. **Same file, `addFileTab()` ([:305](src/EditorController.ts#L305))** — drop
   `onDirtyChange: this.handleDirtyChange` from the `FileEditor({...})` call,
   and add the same `file.onDirtyChange(() => this.handleDirtyChange(file))`
   line immediately after it, before `this.tabs.addTab(...)`.

9. Check: `npm run typecheck` — clean.

10. **Same file** — update `handleDirtyChange`'s doc comment
    ([:534](src/EditorController.ts#L534)) from
    `` `FileEditor.onDirtyChange`: … `` to say it is registered as a
    `Component` dirty-state listener per open file, and that it relabels the
    tab and resyncs the title/status bar. Leave the arrow field's
    `(file: FileEditor): void` signature and its body unchanged.

11. **Same file** — leave `saveAs`
    ([:406-436](src/EditorController.ts#L406)) and `save`
    ([:445-464](src/EditorController.ts#L445)) otherwise untouched. In
    particular keep `saveAs`'s `setTabName` call at
    [:430](src/EditorController.ts#L430) and its `setPath`-then-`markClean`
    order at [:427-428](src/EditorController.ts#L427).

12. Checks:
    - `grep -n '_dirty\|_cleanText\|syncDirty' src/editor/FileEditor.ts` —
      zero matches.
    - `grep -n 'this.isDirty()' src/editor/FileEditor.ts` — exactly two
      matches, in `needsSave()` and `getLabel()`.
    - `grep -rn '\.onDirtyChange(' src/` — exactly two matches, both the
      registration line in `src/EditorController.ts`.
    - `grep -rln 'setDirty' node_modules/@jimka/typescript-ui/src/typescript/lib --include=*.ts` —
      exactly two files, `core/Component.ts` and
      `component/editor/CodeEditor.ts`, confirming `CodeEditor` is the only
      component in a `FileEditor`'s subtree that can raise the flag.

13. Run `npm run typecheck && npm test && npm run build` — all clean; the
    existing test files are unchanged.

14. **[TODO.md](TODO.md)** — delete the
    **Library `component-dirty-state` support** bullet
    ([:11-24](TODO.md#L11)) and the now-empty `## High` heading above it
    ([:9](TODO.md#L9)). Change nothing else in the file; the *Stale tab icon
    after a cross-type Save As* entry stays.

15. Run the manual cases in **Verification**.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src/editor/FileEditor.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `TODO.md` |

---

## Expected Behaviour

Every case below is **manual verification** in the Tauri window
(`npm run tauri:dev`); none is unit-testable in Loom's harness, per the
decision above. "Marker" means the `" •"` suffix on the tab label together
with the `"• "` prefix on the window title, which move together.

Every case except 10 must behave exactly as it does today. Case 10 is the one
intended change.

1. **A freshly opened file is clean.** Open a file from the tree: no marker,
   and the *File > Save* menu item is greyed out (`canSaveActive()` gates its
   `enabled` flag at
   [src/shell/EditorShell.ts:314](src/shell/EditorShell.ts#L314)).
2. **Typing marks it dirty.** Type one character: the marker appears on both
   the tab and the title.
3. **Undo back to the opened text clears it.** Press Ctrl+Z until the document
   matches the file as opened: the marker disappears.
4. **Save clears it.** With the file dirty, press Ctrl+S: the marker
   disappears and the status bar shows `Saved <name>` for two seconds.
5. **Undo after a save marks it dirty again.** Press Ctrl+Z once after case 4:
   the marker returns, because the document has moved away from the text the
   save accepted.
6. **Format marks it dirty.** *Edit > Format Document* on a clean file adds
   the marker; undoing the format removes it again.
7. **Closing a dirty tab prompts.** Click a dirty tab's ✕: the
   unsaved-changes prompt appears. *Cancel* leaves the tab open and still
   dirty; *Discard* closes it; *Save* writes it and then closes it. Closing a
   clean tab prompts nothing.
8. **Exiting with a dirty file prompts.** Close the window with at least one
   dirty file open: the *Unsaved changes* confirm appears. With every file
   clean, the window closes with no prompt.
9. **An untitled buffer's first save renames its tab.** *File > New File*,
   type nothing, press Ctrl+S, choose a path: the tab's label becomes the
   chosen file's base name with no marker. This is the case where no dirty
   flag flips, so the rename comes from `saveAs`'s own `setTabName` call.
10. **A CRLF file no longer reports permanently dirty.** Open a file whose
    text on disk uses CRLF line endings, type a character, then undo: the
    marker disappears. Today it stays.
11. **Two open dirty files stay independent.** With two files dirty, save one:
    only that tab's marker clears, and the title marker follows whichever tab
    is active.
12. **Markdown preview is unaffected.** With a `.md` file open, toggle the
    preview on and type in the source: the preview still re-renders about a
    quarter-second after typing stops, and the marker still appears.

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — clean; no test file changes, so the suite must be green
  unchanged.
- `npm run build` — clean.
- `grep -n '_dirty\|_cleanText\|syncDirty' src/editor/FileEditor.ts` — zero
  matches.
- `grep -n 'this.isDirty()' src/editor/FileEditor.ts` — exactly two matches
  (`needsSave`, `getLabel`).
- `grep -rn '\.onDirtyChange(' src/` — exactly two matches, both in
  `src/EditorController.ts`.
- `git diff --name-only` — no source file other than
  `src/editor/FileEditor.ts` and `src/EditorController.ts`, plus `TODO.md`.
- `git diff src/editor/FileBreadcrumbs.ts src/shell/ src/data/` — empty.
- Manual: `npm run tauri:dev`, then cases 1-12 above in the app window.

---

## Documentation Impact

- **[TODO.md](TODO.md)** — the `## High` section's single bullet,
  **Library `component-dirty-state` support**, is this plan's own backlog
  entry ("What's left is entirely on Loom's side: move
  `FileEditor`/`EditorController` off their hand-rolled `_dirty` field"). It
  and its now-empty `## High` heading are deleted, matching how Loom retires
  a TODO entry when its feature lands (commit `3e7329a`, *Document the
  breadcrumb band and retire its TODO entry*).
- **[README.md](README.md)** — no change. Its *Tabbed editing* bullet
  describes the dirty dot as user-visible behaviour, which this plan
  preserves; nothing in it names the implementation.
- Loom has no `docs/` tree and no generated API reference, so there is
  nothing else to regenerate.

---

## Potential Challenges

- **The relay reaches `FileEditor` in two hops**, `CodeEditor` → `_body` →
  `FileEditor`, because the editor sits inside the `Card`-managed `_body`
  container ([FileEditor.ts:72-75](src/editor/FileEditor.ts#L72)). Moving the
  editor out of `FileEditor`'s subtree in a future change would silently make
  `isDirty()` return `false`. Mitigation: step 6's class JSDoc records that
  the flag arrives through the subtree.
- **Preview mode does not detach the editor.** `Card.setVisibleComponentId`
  toggles `setVisible` rather than removing components, so switching to the
  Markdown preview leaves the `CodeEditor` wired and its flag counted.
- **`FileBreadcrumbs.setAction` calls `removeComponent`/`addComponent` on the
  preview toggle** ([FileBreadcrumbs.ts](src/editor/FileBreadcrumbs.ts)),
  which runs the relay's `unwireChild`/`wireChild`. Those only adjust the
  counter for a child that reports dirty, and `ToggleButton` never sets the
  flag, so the toggle's coming and going is a no-op for dirty state.[^only-adopter]
- **Containers above `FileEditor` now report dirty too** — the `TabPanel` and
  the shell root fold in every open file's flag. Nothing in Loom reads
  `isDirty()` on them, and this is already true today, since `CodeEditor`
  raises the flag whether or not `FileEditor` reads it.

---

## Critical Files

- [src/editor/FileEditor.ts](src/editor/FileEditor.ts) — the class being
  changed. Read the constructor ([:63-98](src/editor/FileEditor.ts#L63)) for
  where `_body` and the `CodeEditor` are wired, and
  [:100-124](src/editor/FileEditor.ts#L100) for the hand-rolled tracking being
  deleted.
- [src/EditorController.ts](src/EditorController.ts) — every consumer of the
  flag: `canSaveActive` ([:145](src/EditorController.ts#L145)), `saveAs`
  ([:406](src/EditorController.ts#L406)), `save`
  ([:445](src/EditorController.ts#L445)), `closeActive`
  ([:501](src/EditorController.ts#L501)), `handleDirtyChange`
  ([:534](src/EditorController.ts#L534)), `handleBeforeTabClose`
  ([:544](src/EditorController.ts#L544)), `confirmExit`
  ([:604](src/EditorController.ts#L604)), `syncActive`
  ([:617](src/EditorController.ts#L617)).
- [node_modules/@jimka/typescript-ui/src/typescript/lib/core/Component.ts:2331-2404](node_modules/@jimka/typescript-ui/src/typescript/lib/core/Component.ts#L2331)
  and [:6439-6487](node_modules/@jimka/typescript-ui/src/typescript/lib/core/Component.ts#L6439)
  — `isDirty()`, `onDirtyChange()`, the protected `setDirty()`, and the
  `wireChild`/`unwireChild` relay. Read for the exact contract; unmodified by
  this plan.
- [node_modules/@jimka/typescript-ui/src/typescript/lib/component/editor/CodeEditor.ts:385-390](node_modules/@jimka/typescript-ui/src/typescript/lib/component/editor/CodeEditor.ts#L385)
  (`markClean`), [:594-601](node_modules/@jimka/typescript-ui/src/typescript/lib/component/editor/CodeEditor.ts#L594)
  (`onDocChange`, the comparison that sets the flag), and
  [:790-800](node_modules/@jimka/typescript-ui/src/typescript/lib/component/editor/CodeEditor.ts#L790)
  (`mount` re-taking the clean text from the normalized document).
- `../typescript-ui/packages/lib/src/typescript/CodeEditorPanel.ts:30-33`,
  `:58`, `:66-69` — **the precedent this plan mirrors**: a container that
  registers `this.onDirtyChange(this.handleDirtyChange)` on itself, reads its
  own inherited `isDirty()`, and clears the flag through the editor's
  `markClean()`, never tracking anything of its own.
- [src/shell/WelcomeScreen.ts:107](src/shell/WelcomeScreen.ts#L107) — the
  precedent for a per-instance closure handler that captures the value the
  listener signature does not carry.
- [src/editor/FileBreadcrumbs.ts](src/editor/FileBreadcrumbs.ts) — `setAction`
  and its `removeComponent`/`addComponent` pair, read to confirm the relay is
  unaffected.
- `../typescript-ui/plans/implemented/component-dirty-state.md`,
  `code-editor-dirty-state-adoption.md`, and `code-editor-undo-clears-dirty.md`
  — the upstream mechanism, its first adopter, and the follow-on that made the
  flag a comparison against a clean baseline. Read the third for the current
  semantics; the second's *No baseline diffing* Non-Goal was reversed by it.
- [vitest.config.ts](vitest.config.ts) — records why component behaviour is
  not unit-tested in this project.

---

## Non-Goals

- **The stale tab icon after a cross-type *Save As*** stays broken. TODO.md's
  *Known issues* entry traces it to the library having no `Tab.setTabGlyph`,
  not to dirty state; `saveAs`'s relabel path is touched by this plan only in
  that its `setTabName` call is kept, and the glyph is set once at `addTab`
  and never revisited either way.
- **No change to the save/edit race.** `markClean()` still accepts whatever
  the document holds when the write resolves, not the bytes that were written,
  so an edit made during `await writeFileText` is silently treated as saved.
  That silent overwrite is today's behaviour, and this plan does not change
  it.
- **No dirty state for the Markdown preview.** `MarkdownViewer` renders, it
  does not edit, and it never raises the flag.[^only-adopter]
- **No new tests and no test harness.** Loom's vitest setup stays node-only
  over pure data helpers.
- **No library changes.** `@jimka/typescript-ui` is used exactly as shipped;
  nothing under `../typescript-ui/` is edited.
- **No persistence of unsaved buffers.** Dirty state still lives only for the
  life of the window, as TODO.md's hot-reload note records.

---

## Notes

[^same-rule]: Loom and the library converged on the same rule independently.
    Loom's commit `1b59ece`, *Clear the dirty flag when an edit restores the
    saved text exactly*, introduced `_cleanText` and the
    `getValue() !== _cleanText` diff. Upstream,
    `plans/implemented/code-editor-undo-clears-dirty.md` later replaced
    `CodeEditor`'s original "any change marks dirty" flag with
    `setDirty(value !== this._cleanValue)` and made `markClean()` re-take the
    clean text — the same comparison, at the same two moments (construction
    and `markClean`). So the swap is not a behaviour change dressed as a
    refactor: both sides answer "does the document differ from the text at the
    last clean point". The one divergence is line endings, which the CRLF note
    covers.

[^inherit-not-delegate]: The alternative was to keep an override reading
    `this._editor.isDirty()`. It was rejected because it re-states, in Loom,
    a fact the framework already computes — the relay's whole purpose is that
    a container never reaches down into its own subtree to answer the
    question. `CodeEditorPanel`, the library's own demo adopter, reads its
    inherited `isDirty()` from two containers above the editor for exactly
    that reason. Deleting the override also removes the last place a
    `FileEditor` change could silently desynchronise the flag from the
    editor's. The cost is that `isDirty()` no longer appears in
    `FileEditor.ts`, which step 6's class JSDoc addresses. It also means
    `FileEditor.isDirty()` would fold in any *other* dirty-capable descendant
    added later, which is the mechanism's defined behaviour rather than a
    surprise.

[^listener-not-callback]: Keeping `FileEditorParams.onDirtyChange` was the
    smaller diff, and was rejected on two counts. First, it is precisely the
    hand-rolled notification this adoption exists to retire: a bespoke
    constructor callback duplicating a public listener API the class now
    inherits. Second, it would leave `FileEditor` carrying three near-identical
    names — the `onDirtyChange` params field, the `_onDirtyChange` private
    field, and the inherited `onDirtyChange(listener)` method with a different
    signature — which is a re-reading tax on every future reader. The library
    listener's signature is `(dirty: boolean) => void` and carries no
    component, so `EditorController` binds the file in a closure:
    `file.onDirtyChange(() => this.handleDirtyChange(file))`. That shape is
    already used in Loom at
    [src/shell/WelcomeScreen.ts:107](src/shell/WelcomeScreen.ts#L107). No
    teardown is needed: `Component.registerListenerBag` clears the bag on
    destroy, and `Tab` destroys a closed tab's content.

[^crlf]: `readFileText` returns Tauri's `readTextFile` output verbatim, so a
    Windows-authored file arrives with CRLF line endings. `FileEditor`'s
    `_cleanText` is that raw string, while `CodeEditor.getValue()` reads the
    mounted CodeMirror document, which `EditorState.create` normalized to LF.
    The two can therefore never be equal, so today the first keystroke marks
    such a file dirty and no amount of undo clears it. `CodeEditor` avoids
    this by re-taking `_cleanValue` from `state.doc.toString()` inside
    `mount()`, so both sides of its comparison come from the same normalizer.
    Adopting the library flag inherits that fix at no cost. Everything else
    stays consistent: the bytes written on save are
    `file.getEditor().getValue()`, which is the same normalized text
    `markClean()` then accepts as clean.

[^saveas-relabel]: Loom's old `markClean()` notified unconditionally; the
    library's fires only on a real `true` → `false` transition. That matters
    at exactly one call site. `save()`
    ([src/EditorController.ts:445](src/EditorController.ts#L445)) has no
    relabel of its own and relies on the notification, but it is only ever
    reached with a dirty file: `saveActive` guards on `needsSave()` and
    `confirmThenClose` on `isDirty()`, and a path-less buffer is routed to
    `saveAs` before the `markClean()` line. `saveAs()` is the case that can
    run against a clean file — a brand-new untitled buffer saved without ever
    being typed in — and it already relabels explicitly, which is why that
    call must stay. The `setPath` → `markClean` order matters for the same
    reason: `setPath` updates `_name`, and the listener that `markClean` may
    fire reads `getLabel()`, so reversing them would paint the old name.

[^no-tests]: The library tests `CodeEditor`'s dirty flag offline by driving a
    private `onDocChange` under a recording DOM sink; Loom has no equivalent
    harness, and building one to cover a class whose whole job is to wire
    library components together would be a larger change than the one being
    planned. Loom's existing suite covers `paths`, `languages`, `fileIcons`,
    `session`, `gitignore`, `welcomeText` and `workspaceState` — pure
    functions, no components — and this plan adds no pure function to it.

[^only-adopter]: `grep -rln 'setDirty' node_modules/@jimka/typescript-ui/src/typescript/lib --include=*.ts`
    returns exactly two files: `core/Component.ts`, which defines the setter,
    and `component/editor/CodeEditor.ts`, which is the only component that
    calls it. So within a `FileEditor`'s subtree — `FileBreadcrumbs` with its
    `IconText` and `ToggleButton`, and `_body` with the `CodeEditor` and an
    optional `MarkdownViewer` — the `CodeEditor` is the only thing that can
    raise the flag. There is one contributor and one path up, so no
    double-counting is possible. Step 12 repeats this grep as a regression
    check. **At implementation time this grep returned five files, not
    two** — see `## Implementation Notes`.

---

## Implementation Notes

- **The step-12/footnote `grep -rln 'setDirty'` check now returns five
  files, not two.** The library, symlinked to a live local checkout rather
  than a pinned release, has grown three more `setDirty` callers since the
  plan was written: `component/input/AbstractInput.ts`,
  `component/editor/MarkdownEditor.ts` and `component/table/Table.ts`. None
  of the three sits in a `FileEditor`'s subtree — `ToggleButton` extends
  `Button`, `MarkdownViewer` extends `Panel`, and `IconText` extends
  `Component` directly; none is an `AbstractInput`, `MarkdownEditor` or
  `Table` — so the property the check exists to protect (`CodeEditor` is
  the sole dirty-flag source under `FileEditor`, so no double-counting)
  still holds. Only the literal exact-two-files assertion is stale.
  Recorded here rather than edited into the footnote's grep-and-assert,
  since the underlying reasoning is unchanged and a plan edit should
  record what happened, not rewrite the original claim.

- **Manual verification (the plan's `## Expected Behaviour` cases 1-12) was
  executed live, against an isolated display, not the user's desktop.**
  The worker is non-interactive with no isolated test display installed
  (no `Xvfb`/`Xephyr`/`Xnest`, and no passwordless `sudo` to install one),
  and the only `DISPLAY` directly available (`172.22.32.1:0`) is the
  user's own live X server — confirmed by screenshotting it via
  `python-xlib`'s `get_image` (bypassing `pyautogui`'s `gnome-screenshot`
  requirement), which showed an unrelated Chrome window already under
  active automated control on that desktop. Rather than risk synthetic
  input landing on the wrong window there, an isolated `Xvfb` was run
  inside a throwaway Docker container (the user's own Docker daemon,
  usable without `sudo`) listening on TCP, port-mapped to
  `127.0.0.1:6099`; `npm run tauri:dev` was then launched on the host with
  `DISPLAY=127.0.0.1:99`, so the running app rendered only inside the
  container's virtual framebuffer, never on the shared desktop. All input
  (via `Xlib.ext.xtest.fake_input`) and screenshots (via raw
  `X.ZPixmap`/`get_image`, since `pyscreeze` itself was unusable) targeted
  that isolated display exclusively. All file operations were pointed at a
  scratch project folder created under `$HOME`
  (`~/loom-manual-verify-scratch`, required by the fs plugin's
  `$HOME/**` capability scope) rather than either the worktree or the main
  tree, so nothing under either checkout was read or written.

  Every one of the 12 cases was driven and confirmed by screenshot:
  1 (fresh file clean), 2 (typing dirties), 3 (undo-to-clean clears the
  marker), 4 (save clears it), 5 (undo-after-save re-dirties), 6 (Format
  Document on a `.json` file dirties it), 7 (closing a dirty tab shows the
  "Unsaved changes" prompt; Don't Save closes it), 8 (`Ctrl+Q` with a dirty
  file shows the exit confirm), 9 (an untyped untitled buffer's first save
  relabels the tab via `saveAs`'s own `setTabName`, with no marker), 10
  (a CRLF-line-ending file: type, undo, marker clears — the plan's one
  intended behavior change, and previously-broken), 11 (two dirty tabs
  cleared independently — saving one left the other's marker alone), and
  12 (Markdown preview re-renders the edited text while the tab still
  shows the marker). Cases 9 and 10, the two the plan's own reasoning
  flagged as least obvious, both passed. The container and scratch folder
  were torn down afterward; nothing from this session persists.
