---
depends-on: [formatter-options]
touches-shared: [src/data/settings.ts, src/EditorController.ts, tests/settings.test.ts, README.md, TODO.md]
---

# Configurable Formatting Style — Implementation Plan

## Overview

Loom's `formatOnSave` setting and its *Format Document* command both end at
the same argument-free call, `CodeEditor.format()`
([src/EditorController.ts:610](src/EditorController.ts#L610) and
[:657](src/EditorController.ts#L657)). They control *whether* a document is
reformatted, never *how* — every formatter runs on its engine's own
defaults, so indent width, line width, quote style and the rest are not
configurable at all.

This plan adds a `formatting` block to the settings file. It sits alongside
`formatOnSave` in the same two-layer scheme the settings file already uses —
a global `settings.json` under Loom's config folder, optionally overridden
by `<project>/.loom/settings.json` — and its parsed value is handed straight
to `format()`. Three source files change — `src/data/settings.ts` (the
shape, the parser, the merge), `src/EditorController.ts` (one new field,
three lines), and `tests/settings.test.ts` — plus `README.md` and `TODO.md`.
`src/shell/settings.ts`, `src/shell/EditorShell.ts`, and `src/main.ts` need
**no** change — they already load and reapply a whole `Settings` snapshot on
cold start and on every project switch.

`format()` cannot accept options today, so this plan depends on a companion
library plan, `formatter-options`, in the sibling `typescript-ui` repo
(`../typescript-ui/plans/formatter-options.md`). That plan adds the exported
`FormatOptions` interface and threads it from `format(options?)` down to
each engine. **It must be implemented, and `npm run build:lib` must have
been run in that repo, before this plan starts** — Loom resolves
`@jimka/typescript-ui` through a symlink to `packages/lib`, whose `exports`
point at the built `dist/`.

---

## Architecture Decisions

### The settings type is the library's `FormatOptions`, not a Loom copy

`Settings.formatting` and `SettingsOverride.formatting` are both typed
`FormatOptions`, imported from `@jimka/typescript-ui/component/editor`.
Loom declares no parallel interface and performs no field renaming: the
names in the settings file are the names `format()` takes.[^no-copy]

### Formatting settings are per-workspace over global, like every other setting

`formatting` joins the existing two-layer cascade rather than becoming a
global-only setting. Indent width and quote style are exactly the kind of
preference a project imposes on everyone working in it.[^both-layers]

### The block merges field by field, not wholesale

A workspace file that sets only `indentWidth` still inherits the global
file's `useTabs`. `resolveSettings` merges the two blocks by spreading them
over the default, which is the same field-by-field rule it already applies
to the five scalar settings — one nesting level deeper.

| Global `formatting` | Workspace `formatting` | Effective |
|---|---|---|
| absent | absent | `{}` — every formatter keeps its own default |
| `{"indentWidth": 4}` | absent | `{ indentWidth: 4 }` |
| `{"indentWidth": 4, "useTabs": true}` | `{"indentWidth": 2}` | `{ indentWidth: 2, useTabs: true }` |
| `{"indentWidth": 4}` | `{}` | `{ indentWidth: 4 }` — an empty block overrides nothing |
| absent | `{"keywordCase": "upper"}` | `{ keywordCase: "upper" }` |

### An absent field means "the engine's own default" — the default block is `{}`

`DEFAULT_SETTINGS.formatting` is the empty object, not a set of concrete
values. So a fresh install formats byte-for-byte as it does today, and Loom
never has to restate Prettier's or `sql-formatter`'s defaults.[^empty-default]
This makes `formatting` the one `Settings` field whose own sub-fields are
individually optional, against the interface's "always complete, never
partial" doc comment ([src/data/settings.ts:6](src/data/settings.ts#L6));
the field itself is still always present.

### The parser validates every field's type *and* its allowed values

`parseFormatting` drops any field that is not the right type, not a positive
integer where a positive integer is required, or not one of an enum's
listed choices. This is load-bearing, not defensive tidiness. Two concrete
failures it prevents:

- `"keywordCase": "Upper"` — wrong capitalisation. `sql-formatter` does not
  validate the value: it turns `select a from b;` into `\n  a\n\n  b;`,
  **deleting every keyword**, and `format()` then replaces the whole
  document with that.
- `"indentWidth": 2.5` — Prettier refuses a fractional `tabWidth` and
  throws, so every format-on-save would silently fail and every *Format
  Document* would do nothing.

| `formatting` in the file | Parsed `formatting` |
|---|---|
| `{"indentWidth": 4}` | `{ indentWidth: 4 }` |
| `{"indentWidth": 2.5}` | absent — not an integer |
| `{"indentWidth": 0}` | absent — not positive |
| `{"indentWidth": "4"}` | absent — wrong type |
| `{"keywordCase": "upper"}` | `{ keywordCase: "upper" }` |
| `{"keywordCase": "Upper"}` | absent — not one of `preserve`/`upper`/`lower` |
| `{"indentWidth": 4, "keywordCase": "Upper"}` | `{ indentWidth: 4 }` — one bad field never invalidates its neighbours |
| `{"unknownKnob": 1}` | absent — nothing survived, so no block is stored |
| `"formatting": "wide"` | absent — not an object |
| `"formatting": []` | absent — an array is not an options block |

### The parser stores no `undefined`-valued key, which is what makes the spread merge exact

`parseFormatting` assigns a key only when its value survived validation, so
a parsed block never holds a key whose value is `undefined`. That is the
precondition for `resolveSettings`'s spread of the two blocks being an exact
field-by-field merge, and it also keeps `format()` from receiving explicit
`undefined`s, which `sql-formatter` treats as instructions to erase its own
defaults.[^undefined-keys]

### One reader table, checked for completeness by the compiler

`parseFormatting` walks a `FORMATTING_READERS` table mapping every
`FormatOptions` field to the function that reads it, declared with
`satisfies` over a mapped type so a field with no reader is a compile error.
This mirrors the exhaustive name tables the library-side adapters use for
the same set of fields, and deliberately departs from
`parseSettingsOverride`'s hand-written chain of `if` blocks — eleven
homogeneous nested fields is where that chain stops paying.[^reader-table]

### The controller carries the block exactly as it carries `formatOnSave`

A new private field `_formatting`, set from `applySettings`
([src/EditorController.ts:669-674](src/EditorController.ts#L669)) and read by
`formatBeforeSave` and `formatActive` — the same three-point shape
`_formatOnSave` already has ([:54](src/EditorController.ts#L54),
[:605](src/EditorController.ts#L605), [:670](src/EditorController.ts#L670)).
No new plumbing: `EditorShell.openProjectRoot` and `main.ts` already push a
resolved `Settings` through `applySettings`.

---

## Public API

### `src/data/settings.ts` (modified)

```typescript
import type { FormatOptions } from '@jimka/typescript-ui/component/editor'

export interface Settings {
    formatOnSave: boolean
    /** Style options handed to `CodeEditor.format()`; an absent field leaves that formatter's own default alone. */
    formatting: FormatOptions
    showHiddenFiles: boolean
    showIgnoredFiles: boolean
    titleBarTemplate: string
    tabMaxWidthPx: number
}

export interface SettingsOverride {
    version: 1
    formatOnSave?: boolean
    formatting?: FormatOptions
    showHiddenFiles?: boolean
    showIgnoredFiles?: boolean
    titleBarTemplate?: string
    tabMaxWidthPx?: number
}
```

`DEFAULT_SETTINGS`, `emptySettingsOverride`, `parseSettingsOverride`,
`serializeSettingsOverride`, `resolveSettings`, and `renderTitle` all keep
their existing signatures. `renderTitle` is untouched.

### `src/EditorController.ts` (modified)

```typescript
class EditorController {
    private _formatting: FormatOptions = DEFAULT_SETTINGS.formatting

    // Unchanged signatures: applySettings(settings), formatActive(), formatBeforeSave(file).
}
```

### The settings-file schema this adds

```json
{
  "version": 1,
  "formatting": {
    "indentWidth": 4,
    "useTabs": false,
    "lineWidth": 100,
    "singleQuote": true,
    "semicolons": false,
    "trailingComma": "all",
    "arrowParens": "always",
    "bracketSpacing": true,
    "proseWrap": "preserve",
    "htmlWhitespaceSensitivity": "css",
    "keywordCase": "upper"
  }
}
```

| Field | Accepted values |
|---|---|
| `indentWidth` | positive integer |
| `useTabs` | boolean |
| `lineWidth` | positive integer |
| `singleQuote` | boolean |
| `semicolons` | boolean |
| `trailingComma` | `"none"` \| `"es5"` \| `"all"` |
| `arrowParens` | `"always"` \| `"avoid"` |
| `bracketSpacing` | boolean |
| `proseWrap` | `"always"` \| `"never"` \| `"preserve"` |
| `htmlWhitespaceSensitivity` | `"css"` \| `"strict"` \| `"ignore"` |
| `keywordCase` | `"preserve"` \| `"upper"` \| `"lower"` |

### Which of Loom's languages honours which field

Loom registers seven languages: five come from the library's own barrel as
an import side effect, and `src/editor/languages.ts` adds two more with a
grammar but no formatter
([src/editor/languages.ts:74-92](src/editor/languages.ts#L74)).

| Loom language id | Extensions | Formatter engine |
|---|---|---|
| `javascript` | `.js .jsx .mjs .cjs .ts .tsx .mts .cts` | Prettier, `babel-ts` parser |
| `json` | `.json` | Prettier, `json` parser |
| `html` | `.html .htm` | Prettier, `html` parser |
| `markdown` | `.md .markdown` | Prettier, `markdown` parser |
| `sql` | `.sql` | `sql-formatter` |
| `css` | `.css` | **none** |
| `python` | `.py` | **none** |

`css` and `python` honour **no** field of the block. They have no formatter,
so `hasFormatter` ([src/editor/languages.ts:70](src/editor/languages.ts#L70))
keeps format-on-save away from them entirely, and *Format Document* on one
of them runs `CodeEditor.format()`'s whole-document re-indent, which takes
no options. For the other five, the library plan's own applicability table
is authoritative; the short version:

| Field | `javascript` | `json` | `html` | `markdown` | `sql` |
|---|---|---|---|---|---|
| `indentWidth` | ✔ | ✔ | ✔ | ✔ list nesting only | ✔ |
| `useTabs` | ✔ | ✔ | ✔ | — | ✔ |
| `lineWidth` | ✔ | ✔ | ✔ | ✔ only with `proseWrap: "always"` | — |
| `singleQuote` | ✔ | — | — | — | — |
| `semicolons` | ✔ | — | — | — | — |
| `trailingComma` | ✔ | — | — | — | — |
| `arrowParens` | ✔ | — | — | — | — |
| `bracketSpacing` | ✔ | ✔ | — | — | — |
| `proseWrap` | — | — | — | ✔ | — |
| `htmlWhitespaceSensitivity` | — | — | ✔ | — | — |
| `keywordCase` | — | — | — | — | ✔ |

A field a language does not honour is harmless — it reaches that language's
engine and is ignored, or the adapter never forwards it.

---

## Internal Structure

### `src/data/settings.ts` — the default and the merge

```typescript
export const DEFAULT_SETTINGS: Settings = {
    formatOnSave: true,
    // Empty by design: an absent field means "leave that formatter's own
    // default alone", so a fresh install formats exactly as it did before
    // this setting existed and Loom restates no engine's defaults.
    formatting: {},
    showHiddenFiles: false,
    // ... unchanged ...
}
```

`resolveSettings` gains one line, in `Settings` field order:

```typescript
formatting: { ...DEFAULT_SETTINGS.formatting, ...global?.formatting, ...workspace?.formatting },
```

Spreading `undefined` contributes nothing, so an absent layer needs no
guard. `DEFAULT_SETTINGS.formatting` is spread first so the three layers
read in the same order as every other field's `?? DEFAULT_SETTINGS.x` chain;
it also means `resolveSettings` returns a fresh object rather than aliasing
`DEFAULT_SETTINGS.formatting`.

### `src/data/settings.ts` — the reader table and `parseFormatting`

The five choice lists are module constants next to `DEFAULT_SETTINGS`:

```typescript
const TRAILING_COMMA_CHOICES = ['none', 'es5', 'all'] as const
const ARROW_PARENS_CHOICES = ['always', 'avoid'] as const
const PROSE_WRAP_CHOICES = ['always', 'never', 'preserve'] as const
const HTML_WHITESPACE_CHOICES = ['css', 'strict', 'ignore'] as const
const KEYWORD_CASE_CHOICES = ['preserve', 'upper', 'lower'] as const

/**
 * Every {@link FormatOptions} field, mapped to the reader that validates it.
 * The `satisfies` clause is what makes this table exhaustive: a field with
 * no reader here, or a reader whose return type doesn't match the field's,
 * is a compile error rather than a setting that silently never applies.
 */
const FORMATTING_READERS = {
    indentWidth: readOptionalPositiveInteger,
    useTabs: readOptionalBoolean,
    lineWidth: readOptionalPositiveInteger,
    singleQuote: readOptionalBoolean,
    semicolons: readOptionalBoolean,
    trailingComma: (value: unknown) => readOptionalChoice(value, TRAILING_COMMA_CHOICES),
    arrowParens: (value: unknown) => readOptionalChoice(value, ARROW_PARENS_CHOICES),
    bracketSpacing: readOptionalBoolean,
    proseWrap: (value: unknown) => readOptionalChoice(value, PROSE_WRAP_CHOICES),
    htmlWhitespaceSensitivity: (value: unknown) => readOptionalChoice(value, HTML_WHITESPACE_CHOICES),
    keywordCase: (value: unknown) => readOptionalChoice(value, KEYWORD_CASE_CHOICES),
} satisfies { [K in keyof FormatOptions]-?: (value: unknown) => FormatOptions[K] | undefined }

/**
 * Reads the `formatting` block, dropping every field of the wrong type or
 * outside its allowed values; `undefined` when the block is absent, is not
 * an object, or has no usable field left.
 *
 * @param value - The raw `formatting` value from the settings document.
 * @returns The parsed options, or `undefined` when nothing usable survived.
 */
function parseFormatting(value: unknown): FormatOptions | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined
    }

    const doc = value as Record<string, unknown>
    const formatting: Record<string, unknown> = {}

    for (const [field, read] of Object.entries(FORMATTING_READERS)) {
        const parsed = read(doc[field])

        // Assigned only when defined, so the block never holds a key whose
        // value is `undefined` — the merge in `resolveSettings` and
        // `sql-formatter` downstream both depend on that.
        if (parsed !== undefined) {
            formatting[field] = parsed
        }
    }

    // The reader table is the type bridge: each key was written by the
    // reader declared for that exact field, which a string-keyed write
    // cannot express.
    return Object.keys(formatting).length === 0 ? undefined : formatting as FormatOptions
}
```

### `src/data/settings.ts` — the two new field readers

Next to the existing `readOptionalBoolean` / `readOptionalNonEmptyString` /
`readOptionalPositiveNumber` ([:172-194](src/data/settings.ts#L172)):

```typescript
/**
 * Reads a field expected to be a positive whole number. Stricter than
 * {@link readOptionalPositiveNumber} because Prettier rejects a fractional
 * `tabWidth`/`printWidth` outright rather than rounding it.
 *
 * @param value - The field's raw value.
 * @returns The integer, or `undefined` when absent, the wrong type, fractional, or not positive.
 */
function readOptionalPositiveInteger(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * Reads a field expected to be one of a fixed set of strings.
 *
 * @param value - The field's raw value.
 * @param choices - The allowed values.
 * @returns The matching choice, or `undefined` when absent, the wrong type, or not listed.
 */
function readOptionalChoice<T extends string>(value: unknown, choices: readonly T[]): T | undefined {
    return typeof value === 'string' && (choices as readonly string[]).includes(value) ? value as T : undefined
}
```

`readOptionalPositiveNumber` stays as it is — `tabMaxWidthPx` is a CSS pixel
width where a fraction is legal.

### `src/data/settings.ts` — `parseSettingsOverride`

One reader call and one assignment block join the existing five, in
`SettingsOverride` field order:

```typescript
const formatting = parseFormatting(doc.formatting)

if (formatting !== undefined) {
    override.formatting = formatting
}
```

`serializeSettingsOverride` is unchanged — `JSON.stringify` already nests.

### `src/EditorController.ts`

```typescript
private _formatting: FormatOptions = DEFAULT_SETTINGS.formatting
```

declared immediately below `_formatOnSave` ([:54](src/EditorController.ts#L54)),
with `import type { FormatOptions } from '@jimka/typescript-ui/component/editor'`
added to the imports. Then three call-site changes:

```typescript
// applySettings
this._formatting = settings.formatting

// formatBeforeSave
await file.getEditor().format(this._formatting)

// formatActive
await file.getEditor().format(this._formatting)
```

---

## Ordered Implementation Steps

Step 1 gates on the library dependency; steps 2-4 are the test-first cycle
for the pure module; steps 5-7 wire it into the controller; steps 8-11 are
the build, the docs, and the manual pass.

1. **Confirm the dependency has landed.** Run
   `grep -n 'FormatOptions' /home/jika/typescript/typescript-ui/packages/lib/dist/lib/types/component/editor/index.d.ts`
   — it must match. If it does not, `formatter-options` has not been
   implemented and built yet, and nothing below will typecheck. Stop and
   report that instead of proceeding. Also confirm
   `ls -l node_modules/@jimka/typescript-ui` shows a symlink to
   `/home/jika/typescript/typescript-ui/packages/lib`, not a directory
   installed from the registry.

2. **[tests/settings.test.ts](tests/settings.test.ts)** — add every case
   from **Expected Behaviour** below to the existing
   `parseSettingsOverride`, `serializeSettingsOverride`, and
   `resolveSettings` describes, plus one new
   `describe('parseSettingsOverride formatting block')`. Run `npm test` —
   fails, since `formatting` does not exist yet.

3. **[src/data/settings.ts](src/data/settings.ts)** — add the
   `import type { FormatOptions }` line at the top of the file, the
   `formatting` fields on `Settings` ([:7-18](src/data/settings.ts#L7)) and
   `SettingsOverride` ([:21-28](src/data/settings.ts#L21)),
   `DEFAULT_SETTINGS.formatting` ([:31-40](src/data/settings.ts#L31)), the
   five choice constants, `FORMATTING_READERS`, `parseFormatting`,
   `readOptionalPositiveInteger`, `readOptionalChoice`, the new line in
   `resolveSettings` ([:58-66](src/data/settings.ts#L58)), and the new
   reader call plus assignment block in `parseSettingsOverride`
   ([:98-133](src/data/settings.ts#L98)) — all per **Internal Structure**.

4. Checks: `npm test` — green, including every new case.
   `npm run typecheck` — clean.

5. **[src/EditorController.ts](src/EditorController.ts)** — add the
   `FormatOptions` type import, the `_formatting` field below `_formatOnSave`
   ([:54](src/EditorController.ts#L54)), the assignment in `applySettings`
   ([:669-674](src/EditorController.ts#L669)), and the argument at both
   `format()` call sites ([:610](src/EditorController.ts#L610) inside
   `formatBeforeSave`, [:657](src/EditorController.ts#L657) inside
   `formatActive`).

6. **[src/EditorController.ts](src/EditorController.ts)** — extend two doc
   comments. `formatBeforeSave`'s ([:593-603](src/EditorController.ts#L593))
   notes that the reformat runs with the resolved formatting options;
   `applySettings`'s ([:661-668](src/EditorController.ts#L661)) opening list
   gains "the formatting options" alongside "format-on-save, the title
   template, and the tab width cap". Refer to the options in prose — do not
   add a `{@link _formatting}`, so the grep in step 7 stays exact.

7. Checks:
   - `npm run typecheck` — clean.
   - `npm test` — green.
   - `grep -n 'getEditor().format()' src/EditorController.ts` — zero matches
     (both call sites now pass an argument; the doc-comment mention of
     `CodeEditor.format()` on [:597](src/EditorController.ts#L597) is
     deliberately not matched by this pattern).
   - `grep -c 'this\._formatting' src/EditorController.ts` — exactly 3 (the
     `applySettings` assignment and the two `format` calls; the field
     declaration has no `this.`).

8. `npm run build` — clean.

9. **[README.md](README.md)** — the two bullet edits in **Documentation
   Impact**.

10. **[TODO.md](TODO.md)** — delete the **Configurable formatting style**
    entry from `## High`. Confirm its span first with
    `grep -n 'Configurable formatting style' TODO.md` — it sits at
    `TODO.md:48-53` today.

11. Run the manual cases in **Verification**.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `src/data/settings.ts` |
| Modify | `src/EditorController.ts` |
| Modify | `tests/settings.test.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Unit-testable — `tests/settings.test.ts`

**`parseSettingsOverride`, the `formatting` block.** Every input is the full
document text; the column shows the whole parsed override.

| Input | Result |
|---|---|
| `'{"version":1}'` | `{ version: 1 }` — no `formatting` key at all |
| `'{"version":1,"formatting":{}}'` | `{ version: 1 }` — an empty block stores nothing |
| `'{"version":1,"formatting":"wide"}'` | `{ version: 1 }` — not an object |
| `'{"version":1,"formatting":[]}'` | `{ version: 1 }` — an array is not an options block |
| `'{"version":1,"formatting":null}'` | `{ version: 1 }` |
| `'{"version":1,"formatting":{"unknownKnob":1}}'` | `{ version: 1 }` — nothing survived |
| `'{"version":1,"formatting":{"indentWidth":4}}'` | `{ version: 1, formatting: { indentWidth: 4 } }` |
| `'{"version":1,"formatting":{"indentWidth":2.5}}'` | `{ version: 1 }` — fractional |
| `'{"version":1,"formatting":{"indentWidth":0}}'` | `{ version: 1 }` — not positive |
| `'{"version":1,"formatting":{"indentWidth":-2}}'` | `{ version: 1 }` |
| `'{"version":1,"formatting":{"indentWidth":"4"}}'` | `{ version: 1 }` — wrong type |
| `'{"version":1,"formatting":{"lineWidth":100}}'` | `{ version: 1, formatting: { lineWidth: 100 } }` |
| `'{"version":1,"formatting":{"useTabs":true}}'` | `{ version: 1, formatting: { useTabs: true } }` |
| `'{"version":1,"formatting":{"useTabs":"yes"}}'` | `{ version: 1 }` |
| `'{"version":1,"formatting":{"keywordCase":"upper"}}'` | `{ version: 1, formatting: { keywordCase: 'upper' } }` |
| `'{"version":1,"formatting":{"keywordCase":"Upper"}}'` | `{ version: 1 }` — wrong case is not one of the choices |
| `'{"version":1,"formatting":{"trailingComma":"es5"}}'` | `{ version: 1, formatting: { trailingComma: 'es5' } }` |
| `'{"version":1,"formatting":{"trailingComma":"maybe"}}'` | `{ version: 1 }` |
| `'{"version":1,"formatting":{"proseWrap":"always"}}'` | `{ version: 1, formatting: { proseWrap: 'always' } }` |
| `'{"version":1,"formatting":{"htmlWhitespaceSensitivity":"strict"}}'` | `{ version: 1, formatting: { htmlWhitespaceSensitivity: 'strict' } }` |
| `'{"version":1,"formatting":{"arrowParens":"avoid"}}'` | `{ version: 1, formatting: { arrowParens: 'avoid' } }` |
| `'{"version":1,"formatting":{"indentWidth":4,"keywordCase":"Upper"}}'` | `{ version: 1, formatting: { indentWidth: 4 } }` — one bad field, one good |
| `'{"version":1,"formatOnSave":false,"formatting":{"useTabs":true}}'` | `{ version: 1, formatOnSave: false, formatting: { useTabs: true } }` |

One further case, asserted separately because deep equality cannot see it:
for `'{"version":1,"formatting":{"indentWidth":2.5}}'`, the parsed override's
`formatting` must be *absent* — `'formatting' in override` is `false`, not a
key holding `undefined` or `{}`.

**`serializeSettingsOverride`** round-trips a nested block:
`parseSettingsOverride(serializeSettingsOverride(x))` equals `x` for
`x = { version: 1, formatting: { indentWidth: 4, keywordCase: 'upper' } }`.

**`resolveSettings`**

| `global` | `workspace` | `formatting` in the result |
|---|---|---|
| `null` | `null` | `{}` |
| `{ version: 1 }` | `{ version: 1 }` | `{}` |
| `{ version: 1, formatting: { indentWidth: 4 } }` | `null` | `{ indentWidth: 4 }` |
| `{ version: 1, formatting: { indentWidth: 4 } }` | `{ version: 1 }` | `{ indentWidth: 4 }` |
| `{ version: 1, formatting: { indentWidth: 4, useTabs: true } }` | `{ version: 1, formatting: { indentWidth: 2 } }` | `{ indentWidth: 2, useTabs: true }` |
| `null` | `{ version: 1, formatting: { keywordCase: 'upper' } }` | `{ keywordCase: 'upper' }` |

Plus: with both layers `null`, the whole result still deep-equals
`DEFAULT_SETTINGS` (the existing case, which now covers the new field too);
and the returned `formatting` is **not** the same object as
`DEFAULT_SETTINGS.formatting` — mutating one must not affect the other.

### Manual verification — `npm run tauri:dev`

The formatters are live-only, so every case below is manual. Use a scratch
project folder, and edit the global `settings.json` via *File > Open
Settings*, restarting after each change (settings are resolved at cold start
and on a project switch, not live).

Cases 3 onward name only the fields that matter; each is written into a full
document — `{"version": 1, "formatting": { … }}` for a `formatting` field,
and `formatOnSave` at the top level beside `formatting`. A file without
`"version": 1` parses as unusable and every setting falls back to its
default.

1. **A fresh install formats exactly as before.** With no `formatting` block
   anywhere: saving a messy `.ts` file gives 2-space indent, double quotes,
   and semicolons.
2. **`indentWidth` reaches JavaScript.** Global
   `{"version":1,"formatting":{"indentWidth":8}}`, restart, *Format
   Document* on a `.ts` file with a nested block: the block body is indented
   8 spaces.
3. **`singleQuote` and `semicolons` reach JavaScript.**
   `{"indentWidth":8,"singleQuote":true,"semicolons":false}`: string
   literals become single-quoted and statement-terminating semicolons
   disappear.
4. **`indentWidth` reaches JSON.** Same setting, *Format Document* on a
   multi-line `.json` file: 8-space indent. Single-quoting does **not**
   appear — JSON keeps double quotes.
5. **`keywordCase` reaches SQL.** `{"keywordCase":"upper"}`, *Format
   Document* on a `.sql` file: `select`/`from`/`where` become uppercase,
   table and column names unchanged.
6. **`lineWidth` does not reach SQL.** With `{"lineWidth":200}` set, a
   `.sql` file formats identically to no setting at all.
7. **`proseWrap` reaches Markdown.** `{"proseWrap":"always","lineWidth":60}`,
   *Format Document* on a `.md` file with one long paragraph: the paragraph
   re-wraps at 60 columns. Then drop `proseWrap` and keep `lineWidth`: the
   same paragraph stays on one line.
8. **A workspace block overrides the global one.** Global
   `{"indentWidth":8}`, workspace `{"indentWidth":2}`, reopen that folder:
   formatting a `.ts` file there indents 2, and a different project still
   indents 8.
9. **A workspace block inherits the global fields it does not set.** Global
   `{"indentWidth":8,"singleQuote":true}`, workspace `{"indentWidth":2}`:
   that project formats with 2-space indent **and** single quotes.
10. **`formatOnSave` still gates everything.** With
    `{"formatOnSave":false,"formatting":{"indentWidth":8}}`, saving a `.ts`
    file leaves it untouched, while *Format Document* still applies the
    8-space indent.
11. **A bad enum value is ignored, not honoured.**
    `{"keywordCase":"Upper"}`, *Format Document* on a `.sql` file: it
    formats normally with keywords left as written — **not** with every
    keyword deleted. This is the case the parser's enum validation exists
    for.
12. **A fractional `indentWidth` is ignored, not honoured.**
    `{"indentWidth":2.5}`: *Format Document* on a `.ts` file still works, at
    the default 2-space indent, with no error dialog.
13. **CSS and Python are unaffected.** With `{"indentWidth":8}` set, *Format
    Document* on a `.css` and a `.py` file still runs the re-indent fallback
    at CodeMirror's own indent unit — indentation does **not** become 8
    spaces. Saving either file never reformats it, unchanged from today.
14. **A malformed settings file still degrades silently.** Put a trailing
    comma in the global file: the app starts normally on defaults, with no
    dialog.

---

## Verification

- `npm run typecheck` — clean.
- `npm test` — green, with every new `tests/settings.test.ts` case.
- `npm run build` — clean.
- `grep -n 'getEditor().format()' src/EditorController.ts` — zero matches.
- `grep -c 'this\._formatting' src/EditorController.ts` — exactly 3.
- `grep -rln 'FormatOptions' src/` — exactly two files,
  `src/data/settings.ts` and `src/EditorController.ts`.
- `grep -n 'Configurable formatting style' TODO.md` — zero matches.
- Manual: `npm run tauri:dev`, then cases 1-14 above.

---

## Documentation Impact

Loom has no API docs to regenerate; `README.md` and `TODO.md` are the whole
surface.

- **[README.md:65-67](README.md#L65)** — extend the **Format Document**
  bullet's last sentence so it names the style settings:

  ```markdown
  - **Format Document**, and a **Toggle Explorer** command to hide/show the
    file tree. Saving reformats the document first, for the languages that
    have a formatter (JavaScript/TypeScript, JSON, HTML, SQL, Markdown), in
    whatever style the settings file's `formatting` block asks for.
  ```

- **[README.md:68-75](README.md#L68)** — extend the **Settings** bullet's
  coverage list, keeping the rest of the bullet as it is:

  ```markdown
    ... Covers whether saving reformats the document and in what style
    (indent width, line width, quote style, and the rest — per language,
    only where that language's formatter honours the field), the tree's
    default Show Hidden/Show Ignored state, the window title template, and
    the tab strip's width cap — see
    [`src/data/settings.ts`](src/data/settings.ts) for the full set and each
    one's default.
  ```

- **[TODO.md:48-53](TODO.md#L48)** — delete the **Configurable formatting
  style** entry from `## High`; this plan is its resolution.

---

## Potential Challenges

- **The library dependency must be built, not just implemented.** Loom
  typechecks against `packages/lib/dist/lib/types/`, not the library's
  source. Mitigation: step 1's grep against the built `.d.ts`, run before
  anything else.
- **`node_modules/@jimka/typescript-ui` may not be the symlink.** A fresh
  `npm install` in a worktree can pull the published `0.8.0` from the
  registry instead of the sibling checkout, which will not carry
  `FormatOptions` — the exact gap `settings-file.md`'s own implementation
  notes recorded. Mitigation: confirm with `ls -l
  node_modules/@jimka/typescript-ui`, and restore it if needed with
  `ln -s /home/jika/typescript/typescript-ui/packages/lib node_modules/@jimka/typescript-ui`.
- **A bad option value would otherwise reject every format silently.**
  `formatBeforeSave` already swallows a formatter throw and reports
  `Saved <name> (not formatted)` ([:604-619](src/EditorController.ts#L604)),
  so an invalid `indentWidth` would degrade into a status message nobody
  reads. Mitigation: the parser's positive-integer guard, and manual case 12.
- **Every entry in `FORMATTING_READERS` must take exactly one `unknown`
  parameter.** `parseFormatting` calls `read(doc[field])` on a value whose
  type is the *union* of all eleven reader functions, and TypeScript only
  allows calling such a union when the parameter lists line up. A reader
  typed `(value: string)` — or one taking a second argument — makes that one
  call site fail with an error that names the union, not the offending
  reader. Mitigation: the choice-based entries are written as inline
  `(value: unknown) => readOptionalChoice(value, CHOICES)` wrappers for
  exactly this reason, rather than as partially-applied helpers.
- **Settings still apply only at a cold start or a project switch.**
  Editing the `formatting` block in an open tab and saving it does not
  change the running app's `_formatting`. Mitigation: none needed — this is
  the documented behaviour of every existing setting
  ([plans/implemented/settings-file.md](plans/implemented/settings-file.md),
  `## Non-Goals`), and no live reload is introduced here.

---

## Critical Files

- [src/data/settings.ts](src/data/settings.ts) — **the precedent this plan
  extends**: `Settings`/`SettingsOverride`'s optional-field shape,
  `resolveSettings`'s field-by-field workspace-over-global-over-default
  cascade, `parseSettingsOverride`'s drop-the-bad-field-keep-the-document
  rule, and the three existing `readOptional*` helpers the two new ones sit
  beside.
- [src/EditorController.ts:54,604-619,652-674](src/EditorController.ts#L54)
  — `_formatOnSave`, `formatBeforeSave`, `formatActive`, and
  `applySettings`: the three-point field shape `_formatting` copies, and
  both `format()` call sites.
- [src/editor/languages.ts](src/editor/languages.ts) — the extension map,
  the two grammar-only registrations (`css`, `python`), and `hasFormatter`,
  which is why those two never format on save.
- [plans/implemented/settings-file.md](plans/implemented/settings-file.md) —
  the two-layer file convention, the field-by-field merge rule and why it
  deliberately differs from `WorkspaceState`'s wholesale replace, and the
  no-live-reload decision this plan inherits unchanged.
- [plans/implemented/format-on-save.md](plans/implemented/format-on-save.md)
  — where `formatBeforeSave`'s swallow-the-throw behaviour and the
  `hasFormatter` guard come from.
- `../typescript-ui/plans/formatter-options.md` — the companion library
  plan: `FormatOptions`'s exact fields, the per-language applicability
  table this plan summarises, and the `undefined`-key rule the parser
  upholds on Loom's side.
- [tests/settings.test.ts](tests/settings.test.ts) — the test file's
  existing describe layout and assertion style.

---

## Non-Goals

- **No per-language override blocks** (`{"formatting": {"markdown": {…}}}`).
  One flat block is enough: every language-specific field name is distinct,
  and an engine ignores a field its printer does not use, so nothing
  collides. Adding a nesting level would multiply the schema by seven for a
  conflict that does not exist.
- **No option for a language with no formatter.** `css` and `python` are
  registered with a grammar only, so nothing in the block can reach them.
  Making `indentWidth` govern their re-indent fallback means configuring
  CodeMirror's `indentUnit`, which also governs Tab and auto-indent while
  typing — a `CodeEditor` option, not a `format()` argument, and separate
  work in the library.
- **No warning when a setting cannot apply.** Setting `singleQuote` and then
  formatting a Markdown file does nothing, silently. Surfacing that needs a
  per-language applicability model in the app, for a case a documented table
  already covers.
- **No live reload.** The `formatting` block takes effect at the next cold
  start or project switch, exactly like every existing setting.
- **No settings UI, form, or schema file.** The block is hand-edited JSON in
  Loom's own editor, matching how the other five settings are edited.
- **No dropped field is reported.** An invalid value is silently ignored,
  matching `parseSettingsOverride`'s existing degrade-quietly rule.
- **No SQL dialect setting.** `sql-formatter` supports 20 dialects, but the
  dialect is a property of the file, not a workspace style preference, and
  the library exposes no dialect option (see its own plan's `## Non-Goals`).
- **No new settings beyond the formatting block.** `endOfLine` in particular
  stays out: to be coherent it would have to govern every file write, not
  only a formatted one, which is a separate feature touching
  `src/data/workspace.ts`.
- **No versioning change.** The settings file stays at `version: 1`; adding
  an optional field breaks no existing file.

---

## Notes

[^no-copy]: Two alternatives were considered. Declaring Loom's own
    `FormattingSettings` interface with Loom's own field names would mean a
    rename table in `EditorController`, a second place to update whenever
    the library gains a field, and a settings vocabulary that differs from
    the API it drives for no reader's benefit. Declaring
    `Required<FormatOptions>` and giving each field a concrete default would
    force Loom to restate Prettier's and `sql-formatter`'s own defaults,
    which then silently drift on a dependency bump — see [^empty-default].
    Importing the library's type keeps one source of truth and turns a
    library-side removal into a compile error in `FORMATTING_READERS`, which
    is exactly where it should surface. The settings *file*'s schema is
    still Loom's own: `parseFormatting` enumerates the fields it accepts, so
    a field the library adds does nothing until Loom adds a reader for it.

[^both-layers]: The alternative was global-only, on the argument that
    formatting style is a personal preference. It is not, in practice: a
    project with a 4-space, single-quote house style wants that applied to
    everyone editing it, which is precisely what `.editorconfig` and
    `.prettierrc` exist for. `formatOnSave` — the setting this one extends —
    is already both-layer, and splitting the two halves of the same feature
    across different scopes would be the surprising choice.

[^empty-default]: The concrete cost of the alternative: `DEFAULT_SETTINGS`
    would have to carry `indentWidth: 2`, `lineWidth: 80`,
    `trailingComma: 'all'`, `arrowParens: 'always'` and the rest — the
    values Prettier 3.9 happens to use today. Those are not Loom's decisions
    to restate. `trailingComma`'s default changed from `'es5'` to `'all'` in
    Prettier 3.0, so a restated table is a real drift risk, and a restated
    default is also indistinguishable from a user who deliberately asked for
    that value. An empty block leaves each engine authoritative about its
    own defaults, and makes "no `formatting` block" and "today's behaviour"
    the same thing by construction.

[^undefined-keys]: `sql-formatter` builds its effective config with
    `Object.assign({}, defaultOptions, cfg)`, so a key present with the
    value `undefined` overwrites the default rather than being skipped. The
    measured result of passing `{ tabWidth: undefined, keywordCase:
    undefined }` when formatting `select a from b;` is `\na\n\nb;` — both
    keywords gone. The library-side adapters guard against this too, so the
    protection is doubled; Loom's own guard is the cheaper of the two, being
    a property of how the parser builds the object rather than a filter
    applied later.

[^reader-table]: `parseSettingsOverride`'s existing style — read each field
    into a local, then an `if (x !== undefined)` block per field — is
    followed for the five top-level settings and stays followed for
    `formatting` itself. Inside the block it would mean eleven locals and
    eleven near-identical `if` blocks, about thirty-five lines of which the
    only varying part is the field name and the reader. Worse, it fails
    open: forget a field and the code compiles while that setting silently
    never applies, which is the hardest kind of bug to notice in a
    configuration file. The `satisfies` clause over
    `{ [K in keyof FormatOptions]-?: (value: unknown) => FormatOptions[K] | undefined }`
    turns the same omission into a compile error naming the field, and the
    library-side plan uses the same exhaustive-table device over the same
    eleven fields for its own engine mapping — so the two sides of the
    feature read alike.
