---
depends-on: [project-wide-search]
touches-shared: [src/data/projectSearch.ts, src/explorer/SearchPanel.ts, src/explorer/searchResults.ts, README.md, TODO.md]
---

# Regular-Expression and Match-Case Project Search — Implementation Plan

## Overview

The explorer's Search view matches a case-insensitive plain substring today. This plan gives it the two toggles the in-file find panel already has — *match case* and *regexp* — so a project-wide query can be case-sensitive, a regular expression, or both. This is [`TODO.md:20`](TODO.md#L20)'s `## High` entry.

Three source files change, all of them inside the search feature. [`src/data/projectSearch.ts:107`](src/data/projectSearch.ts#L107)'s `findMatches` and [`src/data/projectSearch.ts:157`](src/data/projectSearch.ts#L157)'s `searchFiles` stop taking a raw `query: string` and take a compiled query instead, and the module gains a `compileQuery` that turns the panel's three inputs into one. [`src/explorer/SearchPanel.ts:95`](src/explorer/SearchPanel.ts#L95) gains two `Checkbox`es in a row under the query field, and passes their state into every run. [`src/explorer/searchResults.ts:15`](src/explorer/searchResults.ts#L15)'s `SearchStatus` gains an `'invalid-regex'` phase so a malformed pattern says so in the status line instead of looking like a search that found nothing.

Nothing else moves. The results tree, the folder grouping, the streaming-and-cancellation walk, the reveal-a-match path, the rail, the chord, the palette entry, and the Edit menu are all untouched — [`src/shell/EditorShell.ts:153`](src/shell/EditorShell.ts#L153) builds the panel with exactly the parameters it builds it with today.

---

## Architecture Decisions

### The two toggles are `Checkbox`es labelled `match case` and `regexp`

The panel gains a `Container` laid out by `HBox`, holding `new Checkbox({ label: 'match case' })` and `new Checkbox({ label: 'regexp' })`, placed between the query field and the status line. The labels are CodeMirror's own, verbatim and lower-case.[^checkbox-not-togglebutton]

### The query becomes a `SearchQuery`, compiled once per run

`SearchPanel` builds a `SearchQuery` — `{ text, caseSensitive, regexp }` — from its three controls, hands it to `compileQuery` once per run, and passes the resulting `CompiledQuery` down to `searchFiles`. `findMatches` never compiles anything.[^compile-once]

### A project-wide match keeps exactly its current five fields

`SearchMatch` is unchanged: `path`, `line`, `column`, `length`, `lineText`. What changes is what `length` means — it is now the length of *this* match's own text, not the length of the query. A project-wide replace reuses this shape plus the `SearchQuery`/`compileQuery` pair; it does not need new fields on a match.[^match-shape]

### Matching stays line-by-line, so no pattern can span a line break

`findMatches` keeps splitting the file on `LINE_SPLIT` ([`src/data/projectSearch.ts:22`](src/data/projectSearch.ts#L22)) and matching within each line. A regex is applied to one line at a time, so `^` and `$` bind to the line's own ends and a pattern containing `\n` matches nothing. This is a deliberate narrowing of what the in-file panel does.[^no-multiline]

### The regex flavour and flags are `@codemirror/search`'s own

A pattern is compiled with `new RegExp(text, 'gmu')`, plus `i` when *match case* is off — the flag set `@codemirror/search`'s `RegExpCursor` uses (`node_modules/@codemirror/search/dist/index.js:137`, `:168`). Validity is therefore identical in both panels: a pattern the in-file panel rejects, the Search view rejects too.[^flags]

### An invalid pattern is reported in the status line

`compileQuery` returns `null` for a pattern `new RegExp` throws on, and the panel paints the status line `Invalid regular expression.` — a new `'invalid-regex'` phase on `SearchStatus`. No disk is touched. The in-file panel shows nothing at all in this case; the Search view says so out loud.[^invalid-visible]

### A zero-length match is skipped, and scanning advances one character past it

A regex that can match the empty string (`x*`) reports no match at the positions where it matches nothing, and the scan moves forward one character so it cannot loop forever.

| Line | Pattern | Matches (column, length) | Why |
|---|---|---|---|
| `aXb` | `X*` | (1, 1) | the empty matches at columns 0, 2, and 3 are skipped |
| `ab` | `x*` | none | every match is empty, so nothing is reported |
| `a1 b22` | `\d+` | (1, 1), (4, 2) | each match carries its own length |
| `aaa` | `a+` | (0, 3) | greedy, and scanning resumes after the match |

### Flipping a toggle re-runs the search

Each `Checkbox`'s `"change"` event calls the same `runSearch` Enter calls. One click is one run, and an empty query field still just clears and goes idle.[^rerun-on-toggle]

### No new guard against a runaway pattern

A regular expression with nested quantifiers — `(a+)+b` is the classic — can take exponential time on a long line, and JavaScript cannot interrupt a running `RegExp.exec` to stop it. The existing `maxMatches`/`maxFiles` ceilings ([`src/explorer/SearchPanel.ts:20`](src/explorer/SearchPanel.ts#L20)) and the run-supersedes-run cancellation stay exactly as they are: no time budget, no pattern blacklist, no worker.[^no-regex-guard]

---

## Public API

`src/data/projectSearch.ts` — two new exported types, one new exported function, one new exported constant, and two changed signatures:

```typescript
/** What the Search view's three controls say: the text typed into the query
 *  field, and the two toggles beside it. */
export interface SearchQuery {
    /** The pattern — a plain substring, or a regular-expression source when `regexp` is set. */
    text: string
    /** Whether matching distinguishes upper from lower case. */
    caseSensitive: boolean
    /** Whether `text` is a regular-expression source rather than a plain substring. */
    regexp: boolean
}

/** A {@link SearchQuery} resolved into the form the line scanner uses. The
 *  `substring` arm's `needle` is already case-folded when `caseSensitive` is
 *  `false`; the `regexp` arm's `re` is shared across every file in a run. */
export type CompiledQuery =
    | { kind: 'substring'; needle: string; caseSensitive: boolean }
    | { kind: 'regexp'; re: RegExp }

/** The flags every regex query is compiled with, before `i` is appended for a
 *  case-insensitive run. */
export const REGEXP_FLAGS: string

/** `query` compiled for scanning, or `null` for an empty pattern or an invalid
 *  regular-expression source. */
export function compileQuery(query: SearchQuery): CompiledQuery | null

/** Was `(path, text, query: string, limit)`. */
export function findMatches(path: string, text: string, compiled: CompiledQuery, limit: number): SearchMatch[]

/** Was `(paths, query: string, readText, onFileMatches, isCancelled, limits)`. */
export async function searchFiles(
    paths: readonly string[],
    compiled: CompiledQuery,
    readText: ReadFileText,
    onFileMatches: (matches: SearchMatch[]) => void,
    isCancelled: () => boolean,
    limits: SearchLimits,
): Promise<SearchOutcome>
```

`MatchLocation`, `SearchMatch`, `SearchCompletion`, `SearchOutcome`, `SearchLimits`, `ReadFileText`, `BINARY_SNIFF_CHARS`, `MAX_LINE_PREVIEW_CHARS`, and `isProbablyBinary` are unchanged.

`src/explorer/searchResults.ts` — one widened union member:

```typescript
export interface SearchStatus {
    phase: 'idle' | 'running' | 'failed' | 'invalid-regex' | 'complete' | 'match-limit' | 'file-limit'
    matchCount: number
    fileCount: number
    filesSearched: number
}
```

`src/explorer/SearchPanel.ts` — no public surface change. `SearchPanelParams`, `setProjectRoot`, and `focusQuery` are untouched.

---

## Internal Structure

### Compiling a query

```typescript
export function compileQuery(query: SearchQuery): CompiledQuery | null {
    if (query.text === '') {
        return null
    }

    if (!query.regexp) {
        return {
            kind: 'substring',
            needle: query.caseSensitive ? query.text : query.text.toLowerCase(),
            caseSensitive: query.caseSensitive,
        }
    }

    try {
        return { kind: 'regexp', re: new RegExp(query.text, query.caseSensitive ? REGEXP_FLAGS : `${REGEXP_FLAGS}i`) }
    } catch {
        return null
    }
}
```

`null` covers both an empty pattern and an invalid one, which the caller tells apart by checking for an empty pattern first — `SearchPanel.runSearch` already does that before anything else.

| `text` | `caseSensitive` | `regexp` | Result |
|---|---|---|---|
| `''` | `false` | `false` | `null` |
| `''` | `false` | `true` | `null` |
| `Foo` | `false` | `false` | `{ kind: 'substring', needle: 'foo', caseSensitive: false }` |
| `Foo` | `true` | `false` | `{ kind: 'substring', needle: 'Foo', caseSensitive: true }` |
| `a+` | `false` | `true` | `{ kind: 'regexp', re }`, `re.flags === 'gimu'` |
| `a+` | `true` | `true` | `{ kind: 'regexp', re }`, `re.flags === 'gmu'` |
| `(` | `false` | `true` | `null` |
| `a\-b` | `false` | `true` | `null` — the `u` flag rejects `\-` |

### Matching one line

A private `MatchSpan` — `{ column, length }` — is one hit's position inside a single line. Two private helpers produce them, and `findMatches` owns the line loop.

```typescript
function substringSpans(line: string, needle: string, caseSensitive: boolean): MatchSpan[] {
    const spans: MatchSpan[] = []
    const haystack = caseSensitive ? line : line.toLowerCase()
    let column = haystack.indexOf(needle)

    while (column !== -1) {
        spans.push({ column, length: needle.length })

        column = haystack.indexOf(needle, column + needle.length)
    }

    return spans
}

function regexpSpans(line: string, re: RegExp): MatchSpan[] {
    const spans: MatchSpan[] = []

    // Reset per line, not per file: `re` carries the `g` flag and therefore a
    // mutable `lastIndex`, and one `CompiledQuery` is shared by every line of
    // every file in a run.
    re.lastIndex = 0

    let match = re.exec(line)

    while (match !== null) {
        if (match[0].length === 0) {
            // A pattern that can match nothing (`x*`) matches at every
            // position; `exec` leaves `lastIndex` where it started, so the
            // scan has to step forward itself or it never terminates.
            re.lastIndex += 1
        } else {
            spans.push({ column: match.index, length: match[0].length })
        }

        match = re.exec(line)
    }

    return spans
}
```

`findMatches` keeps its signature's shape and its `limit` behaviour:

```typescript
export function findMatches(path: string, text: string, compiled: CompiledQuery, limit: number): SearchMatch[] {
    const matches: SearchMatch[] = []

    if (limit <= 0) {
        return matches
    }

    const lines = text.split(LINE_SPLIT)

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        const spans = compiled.kind === 'regexp'
            ? regexpSpans(line, compiled.re)
            : substringSpans(line, compiled.needle, compiled.caseSensitive)

        if (spans.length === 0) {
            continue
        }

        const lineText = previewOf(line)

        for (const span of spans) {
            matches.push({ path, line: index + 1, column: span.column, length: span.length, lineText })

            if (matches.length === limit) {
                return matches
            }
        }
    }

    return matches
}
```

The empty-query guard that used to open this function (`if (query === '' || limit <= 0)`) is gone — an empty pattern can no longer reach here, because `compileQuery` turns it into `null` and `SearchPanel.runSearch` never calls the walk with `null`. The same guard comes out of `searchFiles` ([`src/data/projectSearch.ts:167`](src/data/projectSearch.ts#L167)) for the same reason.

### What a match carries, and what replace will reuse

A project-wide match is a `SearchMatch`: `path`, `line` (1-based), `column` (0-based, within the line, counted in UTF-16 code units), `length` (this match's own text length, in the same units), and `lineText` (the line trimmed and truncated to `MAX_LINE_PREVIEW_CHARS` — a label, never the line itself).

| Line | `CompiledQuery` | Matches |
|---|---|---|
| `const Foo = foo` | substring `foo`, insensitive | `(line 1, column 6, length 3)`, `(1, 12, 3)` |
| `const Foo = foo` | substring `Foo`, sensitive | `(1, 6, 3)` |
| `a1 b22` | regexp `\d+` | `(1, 1, 1)`, `(1, 4, 2)` |

Those four coordinates are what `EditorController.openFileAt` and `editorSearch.revealRange` already consume, and they are what a replace pass needs to locate the text to substitute. Capture groups are deliberately *not* stored: a replace pass has to re-read the file from disk before it can write it, and re-running the same `CompiledQuery` over the re-read text is both how it confirms the match still exists and how it obtains the groups for a `$1`-style replacement. The reusable pieces are `SearchQuery` (what the user asked for), `compileQuery` (how it becomes a scanner), and `SearchMatch` (where the hits are).

### The panel's new row

```typescript
const matchCaseToggle = new Checkbox({ label: MATCH_CASE_LABEL })
const regexpToggle = new Checkbox({ label: REGEXP_LABEL })
const toggleRow = Container({
    layoutManager: new HBox({ spacing: TOGGLE_SPACING }),
    components: [matchCaseToggle, regexpToggle],
})
```

The panel's `VBox` children become `[queryField, toggleRow, statusText, { component: resultsTree, constraints: { weight: 1 } }]`. Only the tree carries a `weight`, so the row keeps its preferred height exactly as the query field and the status line do.

`runSearch` reads the three controls through one private accessor and validates before it paints `'running'`:

```typescript
private currentQuery(): SearchQuery {
    return {
        text: this._queryField.getValue(),
        caseSensitive: this._matchCaseToggle.isSelected(),
        regexp: this._regexpToggle.isSelected(),
    }
}
```

```typescript
const query = this.currentQuery()

this._runId += 1

const runId = this._runId

this.clearResults()

if (query.text === '') {
    this.paintStatus(IDLE_STATUS)

    return
}

const compiled = compileQuery(query)

if (compiled === null) {
    this.paintStatus(INVALID_REGEX_STATUS)

    return
}

this.paintStatus({ phase: 'running', matchCount: 0, fileCount: 0, filesSearched: 0 })
```

The rest of `runSearch` is unchanged apart from passing `compiled` where it passed `query` ([`src/explorer/SearchPanel.ts:221`](src/explorer/SearchPanel.ts#L221)).

### Status line

One new row joins the table `searchSummaryText` already implements:

| `phase` | Text |
|---|---|
| `invalid-regex` | `Invalid regular expression.` |

---

## Ordered Implementation Steps

1. **`tests/projectSearch.test.ts`** — rewrite the `findMatches` and `searchFiles` suites against the new signatures and add a `compileQuery` suite, covering every row of `## Expected Behaviour`'s unit tables. Keep the existing `fakeReadText` helper and the `isProbablyBinary` suite untouched. Import `compileQuery` and the `SearchQuery` type alongside the existing imports. Every `findMatches` call now passes a `CompiledQuery`, so build it through `compileQuery` rather than by hand — a test that hand-rolls `{ kind: 'substring', needle: 'Foo', caseSensitive: false }` would not catch a case-folding bug in `compileQuery`. Delete the old `searchFiles` empty-query case (`completion: 'complete'`, all counts 0); its replacement is the `compileQuery('')` row in the new suite. Run `npm test` — red, because `compileQuery` does not exist and `findMatches` still takes a string.

2. **`src/data/projectSearch.ts`** — add the types, the constant, and the functions:
   - `SearchQuery` and `CompiledQuery` after `ReadFileText` ([`src/data/projectSearch.ts:65`](src/data/projectSearch.ts#L65)), with the TSDoc from `## Public API`.
   - `export const REGEXP_FLAGS = 'gmu'` beside `LINE_SPLIT` ([`src/data/projectSearch.ts:22`](src/data/projectSearch.ts#L22)), documented as: the flag set `@codemirror/search`'s `RegExpCursor` compiles with (`g` to scan, `m` and `u` to keep validity and semantics identical to the in-file panel's), hardcoded rather than feature-detected the way CodeMirror does because Loom runs only in the Tauri webview.
   - A private `MatchSpan` interface, then `substringSpans` and `regexpSpans`, then `compileQuery`, all from `## Internal Structure`, placed after `previewOf` ([`src/data/projectSearch.ts:73`](src/data/projectSearch.ts#L73)) and before `isProbablyBinary`.
   - Replace `findMatches`' body with the version from `## Internal Structure`, and update its TSDoc: it now reports every occurrence of a *compiled* query, case-sensitively or not, as a substring or a regular expression.
   - In `searchFiles`, rename the `query: string` parameter to `compiled: CompiledQuery`, delete the `if (query === '')` early return ([`src/data/projectSearch.ts:167`](src/data/projectSearch.ts#L167)), and pass `compiled` to `findMatches`. Update its `@param` to say an empty or invalid pattern never reaches it, because `compileQuery` returns `null` for one.
   - Update the module header comment: it walks a list of file paths and reports every line matching a compiled query, which may be case-sensitive and may be a regular expression.

   Run `npm test` — the `projectSearch` suite is green. `npm run typecheck` now **fails** on `SearchPanel.ts`, which still passes a string to `searchFiles`; step 5 fixes it. Do not add a temporary cast.

3. **`tests/searchResults.test.ts`** — add one `searchSummaryText` case for `{ phase: 'invalid-regex', matchCount: 0, fileCount: 0, filesSearched: 0 }` → `'Invalid regular expression.'`, following the existing one-assertion-per-case style. Run `npm test` — red.

4. **`src/explorer/searchResults.ts`** — add `'invalid-regex'` to `SearchStatus.phase` ([`src/explorer/searchResults.ts:15`](src/explorer/searchResults.ts#L15)), between `'failed'` and `'complete'`, and add `case 'invalid-regex': return 'Invalid regular expression.'` to `searchSummaryText`'s switch ([`src/explorer/searchResults.ts:224`](src/explorer/searchResults.ts#L224)), after the `'failed'` case. `completionSummary` is untouched — the new phase never reaches it, exactly as `'idle'`, `'running'`, and `'failed'` never do. Run `npm test` — green.

5. **`src/explorer/SearchPanel.ts`** — the panel:
   - Add `Checkbox` to the existing `@jimka/typescript-ui/component/input` import ([`src/explorer/SearchPanel.ts:4`](src/explorer/SearchPanel.ts#L4)), add `HBox` to the `@jimka/typescript-ui/layout` import ([`:3`](src/explorer/SearchPanel.ts#L3)), add `compileQuery` to the value import from `../data/projectSearch` ([`:7`](src/explorer/SearchPanel.ts#L7)), and add `SearchQuery` to the type import beside it ([`:8`](src/explorer/SearchPanel.ts#L8)). `Container` is already imported from `@jimka/typescript-ui/core` ([`:1`](src/explorer/SearchPanel.ts#L1)); leave that line alone.
   - Module constants after `QUERY_PLACEHOLDER` ([`:32`](src/explorer/SearchPanel.ts#L32)):
     - `MATCH_CASE_LABEL = 'match case'` and `REGEXP_LABEL = 'regexp'` — CodeMirror's own checkbox labels, copied verbatim so the two panels name the same toggle the same way.
     - `TOGGLE_SPACING = 8` — the gap between the two checkboxes, in pixels; wider than the panel's own 4px `VBox` spacing so the two labels read as two controls rather than one run of text.
   - `INVALID_REGEX_STATUS: SearchStatus = { phase: 'invalid-regex', matchCount: 0, fileCount: 0, filesSearched: 0 }` beside `IDLE_STATUS` ([`:35`](src/explorer/SearchPanel.ts#L35)), documented as the status a malformed regular expression paints, shared by nothing else.
   - Two new private readonly fields, `_matchCaseToggle: Checkbox` and `_regexpToggle: Checkbox`, after `_queryField` ([`:75`](src/explorer/SearchPanel.ts#L75)).
   - Build the two checkboxes and the `toggleRow` from `## Internal Structure` among the constructor's pre-`super` locals, after `statusText` ([`:104`](src/explorer/SearchPanel.ts#L104)), and put `toggleRow` into the `components` array between `queryField` and `statusText` ([`:120`](src/explorer/SearchPanel.ts#L120)).
   - Assign the two fields beside the existing assignments ([`:133`](src/explorer/SearchPanel.ts#L133)), and wire both toggles next to the existing listener registrations ([`:145`](src/explorer/SearchPanel.ts#L145)): `matchCaseToggle.on('change', () => { void this.runSearch() })`, same for `regexpToggle`. Use `"change"`, not `"action"` — `"change"` is the `Checkbox`'s own value-changed event and fires once per real transition.
   - Add the private `currentQuery()` accessor from `## Internal Structure` immediately before `runSearch` ([`:192`](src/explorer/SearchPanel.ts#L192)), and replace `runSearch`'s opening with the version from `## Internal Structure`.
   - Update the class doc comment ([`:53`](src/explorer/SearchPanel.ts#L53)–[`:73`](src/explorer/SearchPanel.ts#L73)): Enter runs a search over every file `listFiles` returns, matching a plain substring or a regular expression, case-insensitively unless *match case* is set; flipping either toggle re-runs the search; a malformed regular expression reports itself in the status line and reads no files. Update `runSearch`'s own doc comment the same way.
   - Leave `setProjectRoot` ([`:151`](src/explorer/SearchPanel.ts#L151)) alone — a project switch clears the query and the results but keeps both toggles where the user set them.

   Run `npm run typecheck` — green again. Run `npm test` — all suites green.

6. **`README.md`** — rewrite the **Project search** bullet's first sentence ([`README.md:54`](README.md#L54)–[`:56`](README.md#L56)): Ctrl/Cmd+Shift+F switches the sidebar to its **Search** view, and Enter runs the query over every file the command palette lists, as a plain substring or — with the *regexp* toggle — a regular expression, case-insensitively unless *match case* is set. Add one clause saying the two toggles match the in-file find panel's own, that a regular expression is matched against one line at a time, and that a malformed pattern is reported in the status line. Leave the rest of the bullet (the tree, the click conventions, the size and binary guards) as it stands.

7. **`TODO.md`** — two edits:
   - Delete the `## High` section's **Regular-expression and match-case project search** bullet ([`TODO.md:20`](TODO.md#L20)–[`:22`](TODO.md#L22)) outright.
   - Add a `## Low` bullet, **Interruptible project-search matching**: a pathological regular expression (nested quantifiers over a very long line) blocks the main thread until that line's match attempt finishes, because JavaScript cannot interrupt a running `RegExp.exec`; the walk's per-file `await` keeps the panel responsive between files, and the `maxFiles`/`maxMatches` ceilings bound the run, but the only real fix is matching off the main thread in a worker.

8. **Checkpoints** — `grep -rn 'query: string' src/data/projectSearch.ts` expects zero matches; `grep -rn 'toLowerCase' src/data/projectSearch.ts` expects exactly two (`compileQuery` and `substringSpans`); `grep -rn 'Regular-expression and match-case' TODO.md` expects zero matches; `grep -rn 'compileQuery' src/` expects exactly two files (`projectSearch.ts`, `SearchPanel.ts`).

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Modify | `src/data/projectSearch.ts` |
| Modify | `src/explorer/searchResults.ts` |
| Modify | `src/explorer/SearchPanel.ts` |
| Modify | `tests/projectSearch.test.ts` |
| Modify | `tests/searchResults.test.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Unit-testable — `tests/projectSearch.test.ts`

`compileQuery` — every row of the `## Internal Structure` compile table. Assert the `substring` arm by deep equality, and the `regexp` arm by `kind`, `re.source`, and `re.flags` (`'gimu'` case-insensitive, `'gmu'` case-sensitive).

`findMatches`, called as `findMatches('/p/f.ts', text, compileQuery(query)!, 10)` unless a row says otherwise:

| Text | `text` | `caseSensitive` | `regexp` | Result |
| --- | --- | --- | --- | --- |
| `const Foo = foo` | `foo` | `false` | `false` | `(1, 6, 3)`, `(1, 12, 3)` — today's behaviour, unchanged |
| `const Foo = foo` | `Foo` | `true` | `false` | one match, `(1, 6, 3)` |
| `const Foo = foo` | `foo` | `true` | `false` | one match, `(1, 12, 3)` |
| `aaaa` | `aa` | `false` | `false` | `(1, 0, 2)`, `(1, 2, 2)` — scanning resumes after each hit |
| `a\r\nb` | `b` | `false` | `false` | one match at `(2, 0, 1)` |
| `    return x` | `return` | `false` | `false` | one match whose `lineText` is `return x` |
| `aaaa` | `a` | `false` | `false` | with `limit` 1: exactly one match |
| `a1 b22` | `\d+` | `false` | `true` | `(1, 1, 1)`, `(1, 4, 2)` — each match's own length |
| `aaa` | `a+` | `false` | `true` | one match, `(1, 0, 3)` |
| `aXb` | `X*` | `false` | `true` | one match, `(1, 1, 1)` — empty matches are skipped |
| `ab` | `x*` | `false` | `true` | no matches |
| `Foo` | `^foo$` | `false` | `true` | one match, `(1, 0, 3)` — anchors bind to the line |
| `Foo` | `^foo$` | `true` | `true` | no matches |
| `a\nb` | `a\nb` | `false` | `true` | no matches — a pattern cannot span a line break |
| `a\nb` | `a` | `false` | `true` | one match at `(1, 0, 1)` |
| `a1\nb2` | `\d` | `false` | `true` | `(1, 1, 1)` and `(2, 1, 1)` — the shared `RegExp`'s `lastIndex` is reset per line |
| a 300-character line of `x` | `x+` | `false` | `true` | one match of length 300, whose `lineText` is 120 `x`s followed by `…` |

Each tuple is `(line, column, length)`; every returned match carries `path` as `'/p/f.ts'`.

`searchFiles`, against the existing `fakeReadText`:

| Setup | Expected |
| --- | --- |
| two files, one matching, substring query | `completion: 'complete'`, `matchCount` 1, `fileCount` 1, `filesSearched` 2; `onFileMatches` called once |
| two files both matching, regexp query `\d+` | both files' matches reported, `fileCount` 2 — one `CompiledQuery` serves both files |
| a file whose read rejects, then a matching file | the rejecting file is skipped, `filesSearched` counts both, the second file's matches are reported |
| a file containing a NUL, query `PNG` | no matches; `filesSearched` counts it |
| three matching files, `maxMatches: 2` | `completion: 'match-limit'`, `matchCount` exactly 2, third file never read |
| five files, `maxFiles: 2` | `completion: 'file-limit'`, `filesSearched` 2 |
| `isCancelled` returning `true` on the second call | `completion: 'cancelled'`, only the first file's matches reported |
| a file whose only candidate differs in case, case-sensitive query | no matches |
| a file with no matches, then a matching file | `onFileMatches` called once, never with an empty array |

### Unit-testable — `tests/searchResults.test.ts`

`searchSummaryText({ phase: 'invalid-regex', matchCount: 0, fileCount: 0, filesSearched: 0 })` is `'Invalid regular expression.'`. Every existing case keeps its current result.

### Manual verification — the live app (`npm run tauri:dev`)

The node-environment vitest harness mounts no components, so everything below is checked by hand in the Search view with Loom's own repository open as the project.

| Action | Expected |
| --- | --- |
| Open the Search view | Two checkboxes, *match case* and *regexp*, sit between the query field and the status line, both clear |
| Query `searchpanel`, both toggles clear | Matches in `SearchPanel.ts` and its importers, as today |
| Tick *match case* with that query still in the field | The search re-runs by itself; the lower-case-only hits survive and `SearchPanel` itself drops out |
| Untick *match case* | The search re-runs and the original result set comes back |
| Tick *regexp*, query `find[A-Z]\w+` | Matches `findMatches`, `findFromDOM`, and friends; each leaf's highlight in the editor covers the whole matched identifier, not just the first three characters |
| Tick *regexp*, query `^import ` | Only lines starting with `import `, because anchors bind to each line |
| Tick *regexp*, query `(` | Status line reads `Invalid regular expression.`, the tree empties, and nothing is read from disk |
| Fix the pattern to `(a)` and press Enter | The run proceeds normally; the invalid-pattern message is gone |
| Tick *regexp*, query `a\-b` | `Invalid regular expression.` — the same pattern is rejected by Ctrl/Cmd+F's panel too |
| Tick *regexp*, query `x*` | `No matches.` rather than a hit on every column of every line |
| Tick *regexp*, query `interface\nSearch` | `No matches.` — a pattern cannot span a line break |
| Tick *regexp* with the query field empty | Nothing runs; the status line stays `Enter a query to search the project.` |
| Tick *regexp*, query `.` | The run stops at the match ceiling and the status line names it |
| Click a regex match leaf | The file opens with the whole matched text selected and centred |
| Flip a toggle while a run is still streaming | The old results are replaced; none of the first run's rows survive |
| Tick both toggles, then open a different project folder | The query and results clear; both toggles stay ticked |
| Switch to the Files view and back | Both toggles keep their state |
| Ctrl/Cmd+F in the editor | CodeMirror's own panel still opens with its own *match case* / *regexp* / *by word* checkboxes, independent of the Search view's |

---

## Verification

- `npm run typecheck` — clean (expected to fail only between steps 2 and 5).
- `npm test` — all suites pass, including the rewritten `projectSearch` suite and the widened `searchResults` suite.
- `npm run build` — clean. No dependency is added, so this is a regression check only.
- `grep -rn 'query: string' src/data/projectSearch.ts` — zero matches. `grep -rn 'compileQuery' src/` — two files. `grep -rn 'Regular-expression and match-case' TODO.md` — zero matches.
- `npm run tauri:dev`, then walk the manual table in the explorer's Search view.

---

## Documentation Impact

- `README.md` — the `## Highlights` **Project search** bullet gains the two toggles, the one-line-at-a-time rule, and the invalid-pattern behaviour (step 6). `## Architecture` is unchanged: no new dependency, and the app still reaches the native shell only through `src/data/workspace.ts`.
- `TODO.md` — the `## High` regex/match-case entry is deleted and a `## Low` entry on interruptible matching is added (step 7).
- No library documentation changes. Nothing in `@jimka/typescript-ui` is modified.

---

## Potential Challenges

- **One `RegExp` is reused across every line of every file.** It carries the `g` flag, so its `lastIndex` survives between calls; `regexpSpans` resets it at the top of every line. A missed reset shows up as matches disappearing from the second file onward, which is what the `a1\nb2` and the two-matching-files test rows pin.
- **The `u` flag rejects patterns that look harmless.** `a\-b` and other redundant escapes throw at construction, so they are reported as invalid. That is the in-file panel's behaviour too, which is the point of copying its flags; do not drop `u` to be lenient, or the two panels start disagreeing about which patterns are valid.
- **A pathological pattern freezes the window until one line's match attempt finishes.** JavaScript cannot interrupt a running `RegExp.exec`, so no ceiling in the walk can stop it. The walk's per-file `await` keeps the panel responsive between files, so a merely slow run can still be superseded by pressing Enter again; step 7 records the worker-based fix as a backlog entry.
- **`previewOf` is now called once per matching line rather than once per match.** The `lineText` every match on a line carries is the same string object, which is what the results tree already shows. Nothing depends on per-match identity, but do not "optimise" by hoisting it above the `spans.length === 0` check — that would trim and truncate every line in the project.
- **Bumping `lastIndex` by one can land between a surrogate pair.** The only consequence is a possibly-missed empty match at that position, and an empty match is never reported anyway.

---

## Critical Files

| File | Why |
| --- | --- |
| [`src/data/projectSearch.ts`](src/data/projectSearch.ts) | The matcher and the walk being changed, and `previewOf` / `LINE_SPLIT` / `SearchMatch`, which are not |
| [`src/explorer/SearchPanel.ts`](src/explorer/SearchPanel.ts) | The panel's `VBox`, its `_runId` cancellation, and `runSearch`'s existing empty-query branch |
| [`src/explorer/searchResults.ts`](src/explorer/searchResults.ts) | `SearchStatus` and `searchSummaryText`'s switch |
| [`src/editor/editorSearch.ts`](src/editor/editorSearch.ts) | The in-file panel this feature mirrors: `search({ top: true })` is `@codemirror/search`'s own chrome, which is why there is no Loom-side toggle state to copy |
| `node_modules/@codemirror/search/dist/index.js` | `baseFlags` (line 137), `RegExpCursor`'s compile (line 168), `validRegExp` (line 299), and `SearchQuery.valid` (line 557) — the flavour, the validity rule, and the silent-on-invalid behaviour being mirrored or deviated from |
| [`src/shell/EditorShell.ts:153`](src/shell/EditorShell.ts#L153) | Confirms the shell needs no change: the panel owns its own toggles and its `SearchPanelParams` are untouched |
| [`src/editor/FileBreadcrumbs.ts:61`](src/editor/FileBreadcrumbs.ts#L61) | The `Container` + `HBox` row idiom the toggle row follows |
| [`plans/implemented/project-wide-search.md`](plans/implemented/project-wide-search.md) | The feature being extended; its `[^plain-substring]` footnote is the decision this plan reverses |
| [`plans/implemented/file-search.md`](plans/implemented/file-search.md) | Records that the in-file panel's toggles are CodeMirror's own chrome with no Loom code behind them |

---

## Non-Goals

- **A whole-word toggle.** The in-file panel has a third checkbox, *by word*; `TODO.md`'s entry asks for regexp and match case only, and a user who wants word matching can write `\bfoo\b` once *regexp* exists.
- **Multi-line regular expressions.** Matching stays per line, for the reasons in `## Architecture Decisions`.
- **Project-wide replace.** Still its own `TODO.md` entry. This plan fixes the match shape and the query shape that replace will build on, and adds nothing toward writing files.
- **Search-as-you-type, or live validation of a half-typed pattern.** Nothing runs, and nothing is validated, until Enter or a toggle click — which is what makes a malformed pattern typed mid-keystroke cost nothing.
- **Persisting the toggles.** Neither toggle reaches `session.json`, `.loom/workspace.json`, or `settings.json`; both start clear on every launch, the same gap `TODO.md`'s entry on remembering explorer state already tracks.
- **Off-main-thread or interruptible matching.** Recorded as a `TODO.md` `## Low` entry in step 7, not built here.
- **Raising the 200-match ceiling.** A regex query can match far more broadly than a substring one, which makes the ceiling more useful, not less.
- **Highlighting the matched span inside a result row's label.** A leaf still reads `line: lineText`; nothing paints the matched range within it.
- **Re-skinning the toggles.** Two default `Checkbox`es, themed by the library's own tokens.

---

## Notes

[^checkbox-not-togglebutton]: The capability manifest (`node_modules/@jimka/typescript-ui/llms.txt`) offers four candidates for a two-state control: `Checkbox`, `Toggle` (a sliding pill switch), `ToggleButton`, and `ToolBar` as a host for a strip of them. `Checkbox` wins because it is what the thing being mirrored already is — `@codemirror/search`'s panel paints three `<input type="checkbox">`es labelled `match case`, `regexp`, and `by word`, and the `TODO.md` entry names the first two by those labels. A labelled checkbox is also self-describing in a 300px sidebar, where a glyph-only `ToggleButton` would need an icon for "regular expression" that Font Awesome has no good candidate for and that would have to be registered in `src/main.ts`. Loom's own `ToggleButton` uses — the rail's two view handles and `FileEditor`'s preview toggle — are both glyph-only buttons in a toolbar-like strip, which is a different job. `Toggle` is for a setting that takes effect immediately and reads as on/off, not for a matching modifier beside a query field.

[^compile-once]: The alternative is to pass the `SearchQuery` itself down and let `findMatches` compile per file, which would build the same `RegExp` up to `maxFiles` times and re-decide validity on each one — with no way to report the invalid case to the user, because `findMatches` returns a match array and has nowhere to put a failure. Compiling once also puts validation exactly where the panel needs it: before `listFiles()` is awaited, so an invalid pattern never costs a project walk. `CompiledQuery` is a discriminated union rather than a single `RegExp` because the substring path is worth keeping — escaping a plain query into a regex would make every non-regex search pay regex machinery, and would silently change what a query like `a.b` or `$1` means for users who never tick *regexp*.

[^match-shape]: Three options were weighed for the follow-on replace feature. Storing the matched text and its capture groups on every `SearchMatch` was rejected: a replace pass must re-read each file from disk before writing it (the run's results are already only as fresh as the last walk), and re-running the same `CompiledQuery` over the re-read text is both how it confirms the match is still there and how it gets the groups — so stored groups would be a second, staler copy of something it has to recompute anyway. Storing a raw document offset was rejected when the original plan was written, for reasons that have not changed: `EditorState.create` normalises line endings, so an offset taken from disk text is wrong past line 1 in a CRLF file. What is left is the line/column/length triple, which clamps safely against a file that has moved on, and which `editorSearch.revealRange` already consumes. The one real change is `length`: it used to be `query.length` for every match in a run, and is now each match's own extent, which matters for a regex whose matches differ in length.

[^no-multiline]: `@codemirror/search` switches to a `MultilineRegExpCursor` when a pattern contains `\s`, `\W`, `\D`, `\n`, `\r`, or `[^` (`node_modules/@codemirror/search/dist/index.js:167`), so the in-file panel does match across line breaks for those patterns. Following it here would break the results model rather than extend it: a match is addressed by a 1-based line, a 0-based column, and a length, every leaf in the results tree is labelled with one line's text, and `revealRange` selects a range inside one line. A match spanning four lines has no single line to belong to, no single preview to show, and no length that means anything within a line. The narrowing is also invisible in the common case — `\s` and `[^x]` patterns still work, they just stop at the line end — and the cost of getting it wrong the other way is a whole second results model for a minority of patterns.

[^flags]: `baseFlags` in `@codemirror/search` is `"gm" + (/x/.unicode == null ? "" : "u")`, which evaluates to `"gmu"` on every engine that has shipped in the last decade, and `ignoreCase` appends `i`. Copying the string exactly is what makes the two panels agree on validity, which is the part users notice: `u` rejects redundant escapes like `\-`, and a pattern accepted by one panel and rejected by the other would look like a bug in whichever one rejected it. `m` is inert here — the subject is a single line with no line break in it, so `^` and `$` already anchor at its ends — and is kept only so the flag string is the same one. The runtime feature test is dropped because Loom runs only inside the Tauri webview; `README.md` records that a browser build would need a second filesystem implementation nobody runs.

[^invalid-visible]: CodeMirror's panel sets `SearchQuery.valid` to `false` and then simply does not search (`dist/index.js:557`, `:812`), which in a live document is self-explanatory: the highlights vanish as you type and come back when the pattern closes. The Search view has no such feedback — it does not search as you type, so the only observable result of pressing Enter on a malformed pattern would be an empty tree, indistinguishable from a pattern that found nothing and from a run that is about to start. The panel already owns a status line with a phase enum and a pure formatter, so saying it costs one enum member, one switch case, and one test. Reusing the existing `'failed'` phase was rejected: its text, `Could not read the project folder.`, is about I/O and would be a lie.

[^rerun-on-toggle]: The run-on-Enter rule exists to stop a full project read per keystroke. A toggle click is not a keystroke — it is one deliberate act, and the user's intent in clicking *match case* with results on screen is unambiguous. Leaving the results stale instead would put the panel in a state where the toggles describe one thing and the tree shows another, with nothing on screen saying so. CodeMirror's own panel re-runs on every toggle change for the same reason. The run that a toggle starts supersedes any run still in flight through the existing `_runId` counter, so two fast clicks cannot interleave.

[^no-regex-guard]: Catastrophic backtracking — a pattern like `(a+)+b` against a long line — is the one failure mode a regex toggle adds that a substring search cannot have, and it cannot be contained by a ceiling in the walk: JavaScript has no way to interrupt a running `RegExp.exec`, so by the time any check could run, the damage is done. Three guards were considered and all rejected. A wall-clock budget checked between files bounds a *slow* run, but a slow run is already interruptible — every file's read `await`s, so the panel stays responsive and a second Enter supersedes the run — and it does nothing for the one case that actually freezes the window. Skipping lines above some length would make matches silently disappear from exactly the files (minified bundles, generated data) where a user is most likely to be hunting for something. Running the scan in a worker is the only real fix and is a different-sized project: a new build entry point, a structured-clone boundary for every file's text, and a second copy of the cancellation protocol. The residual exposure is also smaller here than it first looks, because `listFilesRecursive` applies the `.gitignore` chain, which keeps `dist/` and `node_modules/` — where the very long lines live — out of the searched set in the first place.
