---
touches-shared: [README.md, TODO.md, package.json, tsconfig.json, .gitignore]
---

# Retire the QA Harness — Implementation Plan

## Overview

Loom's `qa/` directory holds a WebKitGTK performance harness. It drives a
scenario (usually a gutter drag) in Loom's real shell inside MiniBrowser and
records frame times, DOM writes and geometry
([qa/README.md:3-11](qa/README.md#L3)). The library now has its own QA app,
[`../typescript-ui/packages/qa`](../typescript-ui/packages/qa/README.md). Its
`shell-deep` and `shell-shallow` panels stand in for the harness's two main
scenarios: S1, a 2×2 grid of editors, and S3, a single editor. Both panels
have recorded baselines on MiniBrowser and Tauri
([packages/qa/README.md:310-311, 341-357](../typescript-ui/packages/qa/README.md#L341)).
The library's agenda always meant a small Loom plan to remove `qa/` once those
baselines existed
([00-post-campaign-agenda.md:46-50](../typescript-ui/plans/research/render-review-2026-09-15/00-post-campaign-agenda.md#L46)).
The user decided on 2026-09-21 to do it.

This plan deletes the harness: `qa-harness.ts`, `runqa.sh`, `qa-table.py`,
`qa-forced.py`, `README.md`, and the harness parts of `vite.config.qa.ts`. It
drops `qa` from [tsconfig.json:11-12](tsconfig.json#L11) and
[.gitignore:8-11](.gitignore#L8), and rewrites the one live reference in
[TODO.md:106-125](TODO.md#L106). One piece survives: the *browser shell*.
That is Loom's real `EditorShell` served by Vite to a plain browser tab, with
every Tauri call answered by a stub in `qa/tauri-stubs/` and file reads
answered from the checkout's own files through a `/__fsops` endpoint.
Implemented plans use it for chrome-devtools checks. The stubs and the
endpoint move to a new `browser-shell/` directory, started by a new
`npm run dev:browser` script that [README.md:175-183](README.md#L175)
documents.

The run records in the git-ignored `qa/results/` (182 files, ~12 MB) and
`qa/logs/` (166 files, ~0.9 MB) are **not deleted**: they move to an archive
outside the repository, as the user chose on 2026-09-21. Nothing under `src/`
or `tests/` changes. The whole change is one tooling commit.

---

## Architecture Decisions

### The harness goes; its browser shell stays, as `browser-shell/`

Delete everything in `qa/` except the six Tauri stubs. Move the stubs to
`browser-shell/tauri-stubs/`, unchanged except their header comments. Replace
`qa/vite.config.qa.ts` with `browser-shell/vite.config.browser.ts`. The new
config keeps the old one's shape: `mergeConfig(base, …)` over Loom's own
`vite.config.ts` ([qa/vite.config.qa.ts:99](qa/vite.config.qa.ts#L99)), the
same six `@tauri-apps/*` aliases, and the same `/__fsops` endpoint. It drops
the three harness-only parts: the script injected into `index.html`, the
`/__qa/report` endpoint, and the `__QA_PROJECT_ROOT__` define
([qa/vite.config.qa.ts:25-47, 101-105](qa/vite.config.qa.ts#L25)).[^who-uses-stubs]

The browser shell is not a browser build of Loom: writes, saves and file
watching do nothing in it.

### `npm run dev:browser` starts the browser shell

`package.json` gains
`"dev:browser": "tsc --noEmit && vite --config browser-shell/vite.config.browser.ts"`,
placed right after `"dev"`. [README.md](README.md)'s Development section
documents it.[^script]

### The stubs stay in the typecheck; the new config stays out of it

In `tsconfig.json`, `"qa"` in `include` becomes `"browser-shell"`, and the
`exclude` entry becomes `"browser-shell/vite.config.browser.ts"`. This mirrors
what the harness's own commit, `da2f50a`, did for `qa/`.[^tsc-exclude]

### Implemented plans are left as written

[plans/implemented/file-tree-incremental-refresh.md](plans/implemented/file-tree-incremental-refresh.md)
names `qa/runqa.sh`, `qa/vite.config.qa.ts` and `qa/README.md` (lines 120,
663-664, 725, 745, 792, 794). It is not edited. Loom's implemented plans record
how work was done at the time, and later changes do not rewrite them.[^historical]

### README and TODO point at what replaces the harness

[TODO.md](TODO.md)'s gutter-drag item says to measure "in WebKitGTK
(MiniBrowser drives the real shell)". It now points at the library's QA app,
and says where its real-shell figures came from. The README's Development
section gains the `dev:browser` bullet. Its sentence calling `npm run dev`
"useful for quick UI iteration" is corrected, because the app stops at load in
a plain browser tab.[^readme-dev]

### One tooling commit

Between the implement skill's two plan moves (and its notes commit, if any),
the branch carries one tooling commit. That commit holds every change in the
repository: the deletion, the move, the new config, and the edits to
`tsconfig.json`, `.gitignore`, `package.json`, `README.md` and
`TODO.md`.[^one-commit]

### Where the ignored run records go — decided: archive

**The user chose the archive on 2026-09-21.** The steps below follow it; the
rejected option is kept for the record.

- **Archive (chosen).** Move `qa/results/` to
  `~/.claude/projects/-home-jika-typescript-loom/qa-harness/qa-results/` and
  `qa/logs/` to `…/qa-harness/qa-logs/`. Put copies of `qa-table.py` and
  `qa-forced.py` beside them, reading `qa-results`. Remove both ignore rules
  from `.gitignore`.[^archive]
- **Leave in place.** Skip step 13. In step 6, delete only line 9 (the comment)
  and put `# Local results of Loom's retired QA harness (last in git at da2f50a)`
  in its place, keeping lines 10-11.

| | Archive (chosen) | Leave in place (rejected) |
|---|---|---|
| Loom's tree after the merge | no `qa/` at all | `qa/` holding only ignored folders |
| `.gitignore` | lines 8-11 removed | two `qa/` rules kept, under a new comment |
| Library citations such as `qa-harness/qa-results/base-s1-r1-*.json` ([00-baseline.md:230](../typescript-ui/plans/research/render-review-2026-09-15/00-baseline.md#L230)) | resolve as written | still point at a folder that is gone |
| `python3 qa-table.py base- --writes`, as the library docs write it ([00-baseline.md:227](../typescript-ui/plans/research/render-review-2026-09-15/00-baseline.md#L227)) | runs inside `…/qa-harness/` | no analyser left to run |
| Where the records live | outside every repository, as before `da2f50a` | inside Loom's checkout, deleted by `git clean -fdX` |

---

## What Retiring the Harness Gives Up

This section records the trade-off the user accepted on 2026-09-21.

- **Loom's own shell can no longer be measured by a harness.** The
  `shell-deep` and `shell-shallow` panels are stand-ins, not replicas. Their
  editors hold generated code, their explorer is the library's `Tree` over
  generated folders, and they are built from library components with no Tauri
  API behind them
  ([packages/qa/README.md:341-357](../typescript-ui/packages/qa/README.md#L341)).
  Loom's `FileTree`, `SearchPanel`, `PropertiesPanel`, status-bar readouts
  and `EditorController` never appear in a panel. A cost that Loom's own code
  adds — like the status bar's auto-measuring `Text` recorded in
  [TODO.md:83-93](TODO.md#L83) — is invisible to the QA app. Finding such a
  cost now takes a WebKit Timeline recording of Loom itself under
  `npm run tauri:dev`, then a panel that reproduces the symptom.[^timeline]
- **The render-review campaign's numbers cannot be re-measured or
  extended.** The library's render-review campaign (from 2026-09-15) took
  every measurement made before the QA app existed with this harness, in
  Loom's shell: its baseline, its wave measurements, and the real-shell
  figures in [TODO.md:112-116](TODO.md#L112). Those numbers do not carry over
  to a panel, and no tool remains that measures that shell. A later change
  can be compared only against the panels' own baselines, never against those
  figures.
- **The stand-ins cover part of what the harness measured.**

  | Loom scenario (harness query) | Stand-in | Baseline recorded in the QA app's README |
  |---|---|---|
  | S1 — `mode=filetree&tabs=4&grid=2x2&gutter=dock-h` | `shell-deep`, `drag` on its default `grip=dock-h` | none for `grip=dock-h`; `park`, `drag` with `grip=sidebar` and `theme:4` are recorded |
  | S2 — as S1 with `gutter=dock-v` | `shell-deep`, `grip=dock-v` | none |
  | S3 — `mode=filetree&tabs=1&gutter=explorer` | `shell-shallow`, `drag` on its default `grip=sidebar` | yes (MiniBrowser and Tauri) |
  | S4 — `mode=noproject&resize=120` | none: every shell has an explorer | — |
  | `mode=search-empty`, `mode=search-populated` | none: no `SearchPanel` stand-in | — |

  The harness's Loom-only switches go too: `tabs=N` opened real files from
  the tree, `grid=2x2` rebuilt Loom's live `Dock`, and `lib=` compared two
  library builds inside Loom.[^stand-in-coverage]

---

## Where `qa/` Is Referenced

Every reference found, and what this plan does with it. Searched with
`git grep` over all tracked files for `qa/`, `runqa`, `qa-harness`,
`tauri-stubs`, `vite.config.qa`, `qa-table`, `qa-forced`, `__QA_`,
`__FAKE_PROJECT_ROOT__`, `__fsops` and `MiniBrowser`, plus the untracked
`.claude/` settings and the project memory.

| Location | Reference | Action |
|---|---|---|
| [tsconfig.json:11-12](tsconfig.json#L11) | `"qa"` included, `qa/vite.config.qa.ts` excluded | step 5 |
| [.gitignore:8-11](.gitignore#L8) | `qa/results/`, `qa/logs/` and their comment | step 6 |
| [TODO.md:112-125](TODO.md#L112) | real-shell numbers; "MiniBrowser drives the real shell" | step 9 |
| [README.md](README.md), [CLAUDE.md](CLAUDE.md), [package.json](package.json), `.claude/` | none | README gains `dev:browser` (step 8); `package.json` gains the script (step 7) |
| [plans/implemented/file-tree-incremental-refresh.md](plans/implemented/file-tree-incremental-refresh.md) | `qa/runqa.sh`, `qa/vite.config.qa.ts`, `qa/README.md`, `__FAKE_PROJECT_ROOT__` | left as written |
| [plans/implemented/command-palette-disabled-rows.md:426-430](plans/implemented/command-palette-disabled-rows.md#L426), [temp-tab-italic-styling.md:438](plans/implemented/temp-tab-italic-styling.md#L438) | the `loom-visual-qa-in-sandbox` memory recipe, not `qa/` | left as written |
| `src/`, `tests/`, `index.html`, `src-tauri/`, `vite.config.ts`, `vitest.config.ts` | none | — |
| Project memory: `MEMORY.md`, `loom-visual-qa-in-sandbox.md`, `typescript-ui-render-review-campaign.md` | describe `qa/` as live | step 14 |
| typescript-ui: `packages/qa/README.md`, `plans/implemented/qa-app*.md`, the render-review research | links into `../loom/qa/`, run names | the separate library plan |

---

## Internal Structure

### `browser-shell/vite.config.browser.ts` — the whole file

The `/__fsops` handling is the same code as
[qa/vite.config.qa.ts:49-94](qa/vite.config.qa.ts#L49), split into a
middleware and a per-operation function to meet the code conventions
(function size, JSDoc, and a comment on every HTTP status code). Its
behaviour does not change, including the root check, which stays a plain
`startsWith` prefix test.[^fsops-prefix] The import of Loom's config names
its `.ts` extension.[^config-ext]

```typescript
import * as fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeConfig } from 'vite'
import type { Plugin } from 'vite'
import base from '../vite.config.ts'

// The browser shell: Loom's own config plus what lets the real EditorShell run
// in a plain browser tab, outside the Tauri runtime, for checks driven through
// the chrome-devtools tools. Every `@tauri-apps/*` import is rerouted to a stub
// in `tauri-stubs/`; the filesystem stub reads this checkout's real files
// through the `/__fsops` endpoint below. Started by `npm run dev:browser`, so
// Loom's own `vite.config.ts` is never swapped or edited. To open a project,
// set `window.__FAKE_PROJECT_ROOT__` to a folder inside this checkout, then
// click *Open Folder…*.
const SHELL_DIR = path.dirname(fileURLToPath(import.meta.url))
const LOOM_ROOT = path.resolve(SHELL_DIR, '..')
const STUB_DIR = path.join(SHELL_DIR, 'tauri-stubs')
const FSOPS_ROOT = LOOM_ROOT
const FSOPS_PREFIX = '/__fsops/'

/**
 * Answers one `/__fsops/<op>` request from the real filesystem, in the shape
 * `tauri-stubs/plugin-fs.ts` reads back.
 *
 * @param op - The operation named after `/__fsops/`: `readDir`,
 *     `readTextFile`, `stat` or `exists`.
 * @param target - The absolute path the request names, already checked to
 *     lie under `FSOPS_ROOT`.
 * @param res - The response to write.
 */
function answerFsop(op: string, target: string, res: ServerResponse): void {
    if (op === 'readDir') {
        const entries = fs.readdirSync(target, { withFileTypes: true }).map((entry: fs.Dirent) => ({
            name: entry.name,
            isDirectory: entry.isDirectory(),
            isFile: entry.isFile(),
            isSymlink: entry.isSymbolicLink(),
        }))

        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(entries))
    } else if (op === 'readTextFile') {
        res.end(fs.readFileSync(target, 'utf-8'))
    } else if (op === 'stat') {
        const info = fs.statSync(target)

        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ size: info.size, mtimeMs: info.mtimeMs }))
    } else if (op === 'exists') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ exists: fs.existsSync(target) }))
    } else {
        // HTTP 404 Not Found: the stub asked for an operation this server does not know.
        res.statusCode = 404
        res.end('unknown fsops')
    }
}

/**
 * The dev-server plugin behind `tauri-stubs/plugin-fs.ts`: serves
 * `/__fsops/<op>?path=<absolute path>` for paths under `FSOPS_ROOT` and
 * passes every other request on.
 *
 * @returns The Vite plugin.
 */
function fsopsPlugin(): Plugin {
    return {
        name: 'browser-shell-fsops',
        configureServer(server): void {
            server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void): void => {
                const url = new URL(req.url ?? '/', 'http://localhost')

                if (!url.pathname.startsWith(FSOPS_PREFIX)) {
                    next()

                    return
                }

                const target = path.resolve(url.searchParams.get('path') ?? '')

                if (!target.startsWith(FSOPS_ROOT)) {
                    // HTTP 403 Forbidden: the path lies outside the checkout this server exposes.
                    res.statusCode = 403
                    res.end('path outside fsops root')

                    return
                }

                try {
                    answerFsop(url.pathname.slice(FSOPS_PREFIX.length), target, res)
                } catch (error) {
                    // HTTP 500 Internal Server Error: the filesystem call threw (missing file, a folder read as text, …).
                    res.statusCode = 500
                    res.end(String(error))
                }
            })
        },
    }
}

export default mergeConfig(base, {
    plugins: [fsopsPlugin()],
    resolve: {
        alias: {
            '@tauri-apps/plugin-fs': path.join(STUB_DIR, 'plugin-fs.ts'),
            '@tauri-apps/plugin-dialog': path.join(STUB_DIR, 'plugin-dialog.ts'),
            '@tauri-apps/plugin-os': path.join(STUB_DIR, 'plugin-os.ts'),
            '@tauri-apps/api/window': path.join(STUB_DIR, 'api-window.ts'),
            '@tauri-apps/api/path': path.join(STUB_DIR, 'api-path.ts'),
            '@tauri-apps/api/core': path.join(STUB_DIR, 'api-core.ts'),
        },
    },
})
```

### Stub header comments

Only the leading comment of each stub changes. Code below it stays byte for
byte the same.

| File | Old header | New header |
|---|---|---|
| `api-core.ts`, `api-path.ts`, `api-window.ts`, `plugin-os.ts` | `// QA-only Tauri stub, used only by the harness's dev server.` | `// Browser-shell Tauri stub, used only by ../vite.config.browser.ts.` |
| `plugin-dialog.ts` (lines 1-4) | `// QA-only Tauri stub, used only by the harness's dev server. Returns a fixed`<br>`// folder instead of showing a native picker, so `` `File > Open Folder…` `` can be`<br>`// driven from a script by setting window.__FAKE_PROJECT_ROOT__ before invoking`<br>`// it.` | `// Browser-shell Tauri stub, used only by ../vite.config.browser.ts. Returns a`<br>`// fixed folder instead of showing a native picker, so `` `File > Open Folder…` ``<br>`// can be driven from a script by setting window.__FAKE_PROJECT_ROOT__ before`<br>`// invoking it.` |
| `plugin-fs.ts` (lines 1-4) | `// QA-only Tauri stub, used only by the harness's dev server. Backs`<br>`// @tauri-apps/plugin-fs with the dev server's /__fsops middleware (see`<br>`// ../vite.config.qa.ts), so FileTree/SearchPanel see this repo's real directory`<br>`// tree instead of throwing outside Tauri.` | `// Browser-shell Tauri stub, used only by ../vite.config.browser.ts. Backs`<br>`// @tauri-apps/plugin-fs with that dev server's /__fsops middleware, so`<br>`// FileTree/SearchPanel see this checkout's real directory tree instead of`<br>`// throwing outside Tauri.` |

---

## Ordered Implementation Steps

All repository steps run inside the worktree
(`/home/jika/typescript/loom/.worktrees/retire-qa-harness`). Steps 13 and 14
act outside git and are the only steps that touch anything outside the
worktree.

**Never run `qa/runqa.sh`, MiniBrowser, `npm run tauri:dev` or the library's
`packages/qa` runner.** Each one opens a full-screen window on the user's
desktop. Nothing in this plan needs them.

0. **The archive decision is taken** (*Where the ignored run records go —
   decided: archive*). The user chose the archive on 2026-09-21, so every
   step below applies as written.

1. **Move the stubs.** `mkdir browser-shell && git mv qa/tauri-stubs browser-shell/tauri-stubs`.
   Check: `ls browser-shell/tauri-stubs` lists `api-core.ts api-path.ts
   api-window.ts plugin-dialog.ts plugin-fs.ts plugin-os.ts`.

2. **Rewrite the six stub headers** as the *Stub header comments* table gives
   them. For the four one-line headers:
   `sed -i "1s#.*#// Browser-shell Tauri stub, used only by ../vite.config.browser.ts.#" browser-shell/tauri-stubs/{api-core,api-path,api-window,plugin-os}.ts`.
   Edit lines 1-4 of `plugin-dialog.ts` and `plugin-fs.ts` by hand.
   Check: `grep -rn -E 'QA-only|harness|vite\.config\.qa' browser-shell/tauri-stubs` — zero matches.
   `git diff --cached -M --stat HEAD` may list the four-line `plugin-os.ts`
   as a delete plus an add rather than a rename, since a quarter of it
   changed. That is expected.

3. **Create `browser-shell/vite.config.browser.ts`** with the exact content in
   *Internal Structure*, then `git add browser-shell/vite.config.browser.ts`.

4. **Delete the rest of `qa/`.** `git rm -r qa`. This removes `README.md`,
   `qa-forced.py`, `qa-harness.ts`, `qa-table.py`, `runqa.sh` and
   `vite.config.qa.ts`. Check: `ls qa` fails with "No such file or directory".

5. **`tsconfig.json`** — line 11: replace `"qa"` with `"browser-shell"`. Line
   12: replace `"qa/vite.config.qa.ts"` with
   `"browser-shell/vite.config.browser.ts"`. The result:

   ```json
     "include": ["src", "tests", "browser-shell", "vite.config.ts", "vitest.config.ts"],
     "exclude": ["browser-shell/vite.config.browser.ts"]
   ```

6. **`.gitignore`** — delete lines 8-11: the blank line, the
   `# QA harness output (qa/README.md)` comment, `qa/results/` and `qa/logs/`.
   The file ends at line 7, `merge.sh`, followed by a newline.

7. **`package.json`** — insert after line 10 (`"dev": …`):

   ```json
       "dev:browser": "tsc --noEmit && vite --config browser-shell/vite.config.browser.ts",
   ```

8. **`README.md`** — replace lines 175-183 (the paragraph after the
   ```` ```bash ```` block and the four bullets) with:

   ```markdown
   `tauri:dev` is the real dev flow — it launches the native window backed by
   Tauri's filesystem and dialog plugins. `npm run dev` alone only serves the
   web frontend via Vite, without those native plugins; in a plain browser tab
   the app stops while loading, because `src/data/workspace.ts` asks the OS
   plugin for the platform as it loads. Use `npm run dev:browser` to run the
   shell in a browser tab.

   - `npm run dev:browser` — the real shell in a plain browser tab, for checks
     driven through the chrome-devtools tools. Every `@tauri-apps/*` import is
     swapped for a stub in `browser-shell/tauri-stubs/`, and file reads come
     from this checkout's own files. Set `window.__FAKE_PROJECT_ROOT__` to a
     folder inside the checkout, then click *Open Folder…*. Writes, saves and
     file watching do nothing. It serves on port 1420, as `tauri:dev` does, so
     only one of the two can run at a time.
   - `npm run typecheck` — strict TypeScript check, no emit.
   - `npm test` — run the vitest suite.
   - `npm run build` — frontend production build.
   - `npm run tauri:build` — bundled native app.
   ```

9. **`TODO.md`** — replace lines 106-125 (the whole *The visible editors' own
   resize work is the remaining gutter-drag cost* item) with the text below.
   Only two passages change: where the real-shell numbers came from, and the
   closing sentence on how to measure.

   ```markdown
   - **The visible editors' own resize work is the remaining gutter-drag cost.**
     Two perf rounds in `typescript-ui` (see its `plans/implemented/`: the
     forced-layout coalescing round across `Split`, `ScrollStrip`/`TabBar`,
     `Tree`, `Panel`, `Accordion`, `DragManager` and `AbstractWindow`; then the
     scroll-shadow edge strips, undisplayed inactive tab pages, collapsed panes
     leaving the render tree, and `ScrollStrip`'s clamp-signature read gate)
     removed the library's own per-frame costs from a gutter drag. Real-shell
     numbers, from the WebKitGTK harness Loom kept in `qa/` until 2026-09-21
     (software-rendered, rAF-paced synthetic drag, ms per frame): explorer
     gutter with one editor ≈70 against ≈52 with no project open; ten tabs
     171 → 92; in a 2×2 editor grid the horizontal gutter went 220 → 107, level
     with the vertical gutter's 112. What is left scales with the number of
     *visible* editors whose box changes — roughly 15–20 ms per frame each — and
     is CodeMirror's own re-measure on resize (its `measure`/`getScrollOffset`
     cycle, plus wrap points under `lineWrap`). Not investigated yet: whether
     Loom or the library could defer that re-measure to the settle frame of a
     drag (the coalescing shape the library now uses for its own resize reads)
     without visible lag, or whether it is already as cheap as it gets. Measure
     any attempt in WebKitGTK, not Chromium — paint and layout costs do not
     transfer between the two — with the library's QA app (`typescript-ui`'s
     `packages/qa`), whose `shell-deep` panel shows four editors and
     `code-document` one. Its numbers are not comparable with the figures
     above, which came from Loom's own shell; a WebKit Timeline recording of
     Loom under `npm run tauri:dev` shows whether a result holds in the app.
   ```

10. **Reference sweep.**
    `git grep -n -E 'qa/|runqa|qa-harness|vite\.config\.qa|qa-table|qa-forced|__QA_PROJECT_ROOT__|MiniBrowser|tauri-stubs' -- ':!plans/'`
    — the only matches are in `README.md` (`browser-shell/tauri-stubs/`),
    `TODO.md` (`qa/` in "kept in `qa/` until 2026-09-21") and
    `browser-shell/vite.config.browser.ts` (`tauri-stubs/`). Under "leave in
    place", `.gitignore`'s two kept `qa/` rules match as well. Anything else
    is a missed reference: fix it.

11. **Run the checks in `## Verification`** (typecheck, tests, build, the
    stub-resolution build, the dev-server requests).

12. **Commit** — one tooling commit, per the commit skill. Stage only
    `browser-shell/`, the `qa/` deletions, `tsconfig.json`, `.gitignore`,
    `package.json`, `README.md` and `TODO.md`. Suggested message:

    ```text
    Retire the WebKitGTK QA harness and keep its browser shell

    The library's own QA app now measures render cost in WebKitGTK, and its
    shell-deep and shell-shallow panels stand in for the two Loom scenarios
    this harness measured, with baselines on MiniBrowser and Tauri. The
    harness, its runner and its analysers go. The Tauri stubs and the file
    endpoint that let Loom's real shell run in a browser tab move to
    browser-shell/, started by npm run dev:browser, because chrome-devtools
    checks of the shell still use them.
    ```

    Check: `git status --short` is empty and `git show --stat HEAD` lists
    only those paths.

13. **Archive the run records (outside git).** The records exist only in the
    main tree's `qa/`, so this step uses absolute paths. It runs before the
    branch merges. First run
    `git -C /home/jika/typescript/loom log --format=%h main -- qa/`. It must
    print only `da2f50a`, the one commit that ever touched `qa/`. If it prints
    more, replace `da2f50a` below with the newest printed hash for which
    `git show <hash>:qa/qa-table.py` succeeds.

    First check that the targets are free, and record the counts:

    ```sh
    A=/home/jika/.claude/projects/-home-jika-typescript-loom/qa-harness
    L=/home/jika/typescript/loom
    test ! -e "$A/qa-results" && test ! -e "$A/qa-logs" && echo "targets free"
    ls "$L/qa/results" | wc -l    # 182 today
    ls "$L/qa/logs" | wc -l       # 166 today
    ```

    Stop if `targets free` does not print. Otherwise move the records and
    write the two analysers:

    ```sh
    A=/home/jika/.claude/projects/-home-jika-typescript-loom/qa-harness
    L=/home/jika/typescript/loom
    mv "$L/qa/results" "$A/qa-results"
    mv "$L/qa/logs" "$A/qa-logs"
    git -C "$L" show da2f50a:qa/qa-table.py  | sed "s/'results'/'qa-results'/" > "$A/qa-table.py"
    git -C "$L" show da2f50a:qa/qa-forced.py | sed "s/'results'/'qa-results'/" > "$A/qa-forced.py"
    chmod +x "$A/qa-table.py" "$A/qa-forced.py"
    ```

    Checks: `ls "$A/qa-results" | wc -l` and `ls "$A/qa-logs" | wc -l` print
    the counts recorded above. `(cd "$A" && python3 qa-table.py base-)`
    prints eight rows, `base-s1-r1` to `base-s4-r2`.
    `git -C "$L" status --short --ignored qa` shows no `!! qa/results/` or
    `!! qa/logs/`.

14. **Update the project memory (outside git).** In
    `/home/jika/.claude/projects/-home-jika-typescript-loom/memory/`:
    - `MEMORY.md` line 5: replace the text after the link with
      `— chrome-devtools + npm run dev:browser (Tauri stubs in browser-shell/) for visual and functional checks; Loom's WebKitGTK perf harness was retired 2026-09-21 in favour of typescript-ui's packages/qa`.
    - `loom-visual-qa-in-sandbox.md`: rewrite the `description` the same way.
      Replace the *Location (since 2026-09-19)* paragraph with one saying the
      harness was retired on 2026-09-21 by `feature/retire-qa-harness`: its
      code stays at Loom commit `da2f50a`; its results, logs and analysers are
      in `…/qa-harness/qa-results/`, `qa-logs/`, `qa-table.py` and
      `qa-forced.py`; the stubs and `/__fsops` live on as
      `npm run dev:browser`. Mark the MiniBrowser and harness-extension
      paragraphs as history.
    - `typescript-ui-render-review-campaign.md` line 383: "Loom's `qa/`
      retirement is unblocked" becomes "Loom's `qa/` was retired on
      2026-09-21".

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Move (header comment edited) | `qa/tauri-stubs/api-core.ts` → `browser-shell/tauri-stubs/api-core.ts` |
| Move (header comment edited) | `qa/tauri-stubs/api-path.ts` → `browser-shell/tauri-stubs/api-path.ts` |
| Move (header comment edited) | `qa/tauri-stubs/api-window.ts` → `browser-shell/tauri-stubs/api-window.ts` |
| Move (header comment edited) | `qa/tauri-stubs/plugin-dialog.ts` → `browser-shell/tauri-stubs/plugin-dialog.ts` |
| Move (header comment edited) | `qa/tauri-stubs/plugin-fs.ts` → `browser-shell/tauri-stubs/plugin-fs.ts` |
| Move (header comment edited) | `qa/tauri-stubs/plugin-os.ts` → `browser-shell/tauri-stubs/plugin-os.ts` |
| Create | `browser-shell/vite.config.browser.ts` |
| Delete | `qa/README.md` |
| Delete | `qa/qa-harness.ts` |
| Delete | `qa/runqa.sh` |
| Delete | `qa/vite.config.qa.ts` |
| Delete | `qa/qa-table.py` |
| Delete | `qa/qa-forced.py` |
| Modify | `tsconfig.json` |
| Modify | `.gitignore` |
| Modify | `package.json` |
| Modify | `README.md` |
| Modify | `TODO.md` |
| Move, outside git | `/home/jika/typescript/loom/qa/results/` → `~/.claude/projects/-home-jika-typescript-loom/qa-harness/qa-results/` |
| Move, outside git | `/home/jika/typescript/loom/qa/logs/` → `~/.claude/projects/-home-jika-typescript-loom/qa-harness/qa-logs/` |
| Create, outside git | `~/.claude/projects/-home-jika-typescript-loom/qa-harness/qa-table.py`, `qa-forced.py` |
| Modify, outside git | `~/.claude/projects/-home-jika-typescript-loom/memory/MEMORY.md`, `loom-visual-qa-in-sandbox.md`, `typescript-ui-render-review-campaign.md` |

---

## Expected Behaviour

No Loom behaviour changes, so there are no unit tests to write. Vitest runs in
the `node` environment and cannot start a dev server. Every case below is
checked by a command in `## Verification`.

**Typecheck and build**

- B1. `npm run typecheck` passes, and the stubs are part of it from their new
  path.
- B2. `npx vite build --config browser-shell/vite.config.browser.ts` succeeds.
  The bundle contains no real Tauri OS plugin
  (`__TAURI_OS_PLUGIN_INTERNALS__` is absent) and does contain the stub's
  `__fsops` calls. A missing stub export fails this build with
  `MISSING_EXPORT`, so a pass also proves every `@tauri-apps/*` import Loom
  makes is covered.

**The browser shell's dev server** (`<root>` is the checkout the config lives
in)

| Request | Expected |
|---|---|
| B3. `GET /` | Loom's `index.html`, with no `qa-harness` script tag |
| B4. `GET /__fsops/exists?path=<root>/package.json` | `{"exists":true}` |
| B5. `GET /__fsops/readDir?path=<root>/browser-shell` | JSON array: `tauri-stubs` (`isDirectory: true`) and `vite.config.browser.ts` (`isFile: true`) |
| B6. `GET /__fsops/stat?path=<root>/package.json` | `{"size":…,"mtimeMs":…}` |
| B7. `GET /__fsops/exists?path=/etc/passwd` | status 403 |
| B8. `GET /__fsops/bogus?path=<root>/package.json` | status 404 |
| B9. `GET /__fsops/readTextFile?path=<root>/src` | status 500 (a folder read as text) |
| B10. `POST /__qa/report?name=x` | status 404: the endpoint is gone |
| B11. `GET /src/data/workspace.ts` | the served module imports `…/browser-shell/tauri-stubs/plugin-os.ts` |

**Manual**

- B12. In Chromium through the chrome-devtools tools: the page shows the
  welcome screen. After `window.__FAKE_PROJECT_ROOT__ = '<root>'` and a click
  on *Open Folder…*, `.FileTree .TreeRow` rows appear.

**Archive (step 13)**

- B13. The archive holds as many results and logs as `qa/` held before the
  move, and `python3 qa-table.py base-` run inside it prints eight rows.

---

## Verification

Run everything from the worktree root. If the worktree has no `node_modules`,
link the main tree's first: `ln -s /home/jika/typescript/loom/node_modules node_modules`.

- `npm run typecheck` — clean (B1).
- `npm test` — clean; no test changed.
- `npm run build` — clean.
- Stub-resolution build (B2), to a throwaway folder so `dist/` stays the real
  build:

  ```sh
  O=$(mktemp -d)
  npx vite build --config browser-shell/vite.config.browser.ts --outDir "$O"
  grep -rl '__TAURI_OS_PLUGIN_INTERNALS__' "$O"   # expect no output
  grep -rl '__fsops' "$O/assets"                   # expect at least one file
  rm -rf "$O"
  ```

- Dev-server requests (B3-B11). This starts Vite, which opens no window. Use
  port 1531 so a `tauri:dev` the user may have running on 1420 is not
  disturbed. Stop Vite by its port, never with `pkill -f`.[^kill-by-port]

  ```sh
  ROOT=$PWD
  LOG=$(mktemp)
  ss -ltnp | grep ':1531 '   # must print nothing; otherwise pick another free port for every command below
  (npm run dev:browser -- --port 1531 --strictPort > "$LOG" 2>&1 &)
  for i in $(seq 1 120); do curl -sf -o /dev/null http://localhost:1531/ && break; sleep 0.5; done
  curl -s http://localhost:1531/ | grep -c qa-harness                                          # 0
  curl -s "http://localhost:1531/__fsops/exists?path=$ROOT/package.json"; echo                 # {"exists":true}
  curl -s "http://localhost:1531/__fsops/readDir?path=$ROOT/browser-shell"; echo
  curl -s "http://localhost:1531/__fsops/stat?path=$ROOT/package.json"; echo
  curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:1531/__fsops/exists?path=/etc/passwd"          # 403
  curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:1531/__fsops/bogus?path=$ROOT/package.json"    # 404
  curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:1531/__fsops/readTextFile?path=$ROOT/src"      # 500
  curl -s -o /dev/null -w '%{http_code}\n' -X POST -d '{}' "http://localhost:1531/__qa/report?name=x"       # 404
  curl -s http://localhost:1531/src/data/workspace.ts | grep -o 'browser-shell/tauri-stubs/plugin-os.ts'
  for pid in $(ss -ltnp | awk '/:1531 /' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do kill "$pid"; done
  ```

- B12 is manual and needs the user's go-ahead, since it opens a browser.
  Follow steps 2-3 of the real-shell check in
  [file-tree-incremental-refresh.md:661-664](plans/implemented/file-tree-incremental-refresh.md#L661),
  but start the server with `npm run dev:browser` instead of
  `npx vite --config qa/vite.config.qa.ts`.
- The reference sweep in step 10.
- The archive checks in step 13 (B13).

---

## Potential Challenges

- **Merging before the archive step leaves `?? qa/` in the main tree.** Once
  `.gitignore` loses the `qa/` rules, anything still in the main tree's
  `qa/results/` or `qa/logs/` shows as untracked. A `git add -A` would then
  commit 12 MB of records, and `git clean -fd` would delete them. Step 13
  runs before the merge. Right before merging, run
  `git -C /home/jika/typescript/loom status --short --ignored qa`, and repeat
  step 13's moves for anything it lists.
- **A harness run between step 13 and the merge writes new records** into the
  main tree's `qa/results/`. The pre-merge check above catches them. Move
  them into `qa-results/` beside the rest.
- **The library's docs link into `../loom/qa/`** (for example
  [qa-app.md](../typescript-ui/plans/implemented/qa-app.md) links
  `../loom/qa/qa-harness.ts#L…`). These links break when this branch merges.
  The separate library plan repoints them. The content stays readable with
  `git -C /home/jika/typescript/loom show da2f50a:qa/<file>`.
- **Port 1420 is shared with `tauri:dev`.** `dev:browser` inherits
  `strictPort: true` from Loom's `vite.config.ts`, so it fails at once when
  `tauri:dev` is running rather than moving to another port. The
  verification uses port 1531 for this reason.

---

## Critical Files

- [qa/vite.config.qa.ts](qa/vite.config.qa.ts) — the source of the new config;
  the `/__fsops` code (49-94) moves, and 25-47 and 101-105 are dropped.
- [qa/tauri-stubs/](qa/tauri-stubs/) — the six stubs that move.
- [qa/README.md](qa/README.md) — what the harness did, for the trade-off
  section.
- `git show da2f50a` — the commit that brought the harness in: the exact
  `tsconfig.json` and `.gitignore` lines this plan reverses.
- [plans/implemented/file-tree-incremental-refresh.md:623-700](plans/implemented/file-tree-incremental-refresh.md#L623)
  and its `chromium` footnote — the precedent use of the browser shell.
- [README.md:168-183](README.md#L168), [TODO.md:106-125](TODO.md#L106),
  [tsconfig.json](tsconfig.json), [.gitignore](.gitignore),
  [package.json:9-17](package.json#L9) — the edited files.
- [../typescript-ui/packages/qa/README.md:310-311, 341-357](../typescript-ui/packages/qa/README.md#L341)
  — the stand-ins and their recorded baselines.
- [../typescript-ui/plans/research/render-review-2026-09-15/00-post-campaign-agenda.md:29-50](../typescript-ui/plans/research/render-review-2026-09-15/00-post-campaign-agenda.md#L29)
  — the decision to replace the harness with the QA app.
- `~/.claude/projects/-home-jika-typescript-loom/memory/loom-visual-qa-in-sandbox.md`
  — the memory that step 14 updates.

---

## Non-Goals

- **Library-side documents.** The QA app's README, the post-campaign agenda,
  the `qa-app*` plans' `../loom/qa/` links and the research docs' run-name
  citations are handled by a separate library plan.
- **Editing Loom's implemented plans.** They stay historical records (see
  *Implemented plans are left as written*).
- **Deleting any run record.** `qa/results/` and `qa/logs/` are moved or kept,
  never removed.
- **A Loom-level replacement harness, or a new Loom stand-in panel in the QA
  app.** The user chose the QA app's panels as the measurement surface. New
  panels are library work.
- **Changing what the stubs or `/__fsops` do.** They move with their
  behaviour intact, the plain-prefix root check included.
- **A browser build of Loom** ([TODO.md:30-31](TODO.md#L30)). `dev:browser`
  is a dev-only shell whose writes do nothing, not that build.

---

## Notes

[^who-uses-stubs]: Three implemented plans ran Loom's real shell in Chromium
    through the chrome-devtools tools, and each needed Tauri stubs.
    `file-tree-incremental-refresh.md` (lines 623, 661-664) started
    `npx vite --config qa/vite.config.qa.ts` without `?qa=`, so the harness
    stayed idle. It then set `window.__FAKE_PROJECT_ROOT__` and opened the
    project, for functional checks M1-M13.
    `command-palette-disabled-rows.md` (lines 426-430) and
    `temp-tab-italic-styling.md` (line 438) did the same before `da2f50a`,
    by editing temporary aliases into `vite.config.ts`. Nothing in `src/` or
    `tests/` imports the stubs. Deleting them would send the next such check
    back to temporary edits of `vite.config.ts`, which `da2f50a`'s commit
    message records breaking a whole sweep without any error. The stubs leave
    `qa/` because that name means the harness, and the library's
    `packages/qa` is now the QA surface. The dropped parts serve only the
    harness: `transformIndexHtml` injects `qa-harness.ts`, `/__qa/report`
    writes its results, and `__QA_PROJECT_ROOT__` is read only by
    `qa-harness.ts` (lines 21 and 1993).

[^script]: The harness never had an npm script, because `runqa.sh` started
    Vite itself. With `runqa.sh` and `qa/README.md` gone, the script and its
    README bullet are what make the browser shell findable. The name follows
    the existing `tauri:dev`/`tauri:build` colon grouping. The
    `tsc --noEmit &&` prefix mirrors `dev`.

[^tsc-exclude]: Loom has no `@types/node`, and the config imports `node:fs`,
    `node:http`, `node:path` and `node:url`, so `tsc` would reject it. Vite
    compiles its config without type-checking, so excluding it costs nothing
    at run time. `da2f50a` excluded `qa/vite.config.qa.ts` for the same
    reason, and put the stubs into the typecheck.

[^historical]: Precedent: `file-tree-incremental-refresh` renamed
    `FileTree.refreshSubtree` to `refreshDirectory`, and
    `plans/implemented/filesystem-watching.md` (lines 20, 25) and
    `file-tree-context-menu.md` still name `refreshSubtree`. The `qa/` paths
    in the file-tree plan stay readable at `da2f50a`.

[^readme-dev]: [src/data/workspace.ts:55](src/data/workspace.ts#L55) calls
    `platform()` from `@tauri-apps/plugin-os` while the module loads. Outside
    Tauri, that reads `window.__TAURI_OS_PLUGIN_INTERNALS__.platform` from
    `undefined` and throws. The module graph fails and nothing renders. Left
    as it is, the README would call `npm run dev` useful for UI work, directly
    above a bullet whose reason to exist is that it is not.

[^one-commit]: No file under `src/` or `tests/` changes, so there is no code
    commit. The README's Development section and the TODO sentence describe
    developer tooling, so they ride in the tooling commit rather than a
    documentation commit. The browser shell is carved out of the harness's
    config in the same change. A separate commit for it would first have to
    rewire `qa/vite.config.qa.ts` to the moved stubs, only for the next
    commit to delete that file.

[^archive]: `~/.claude/projects/-home-jika-typescript-loom/qa-harness/` is
    where the harness lived before `da2f50a` brought it into the repository.
    The records were first written there as `qa-results/`, and the folder
    still holds the one-off trace analysers and the `qa-harness.ts.bak-w2`
    backup. Neither `qa-results/` nor `qa-logs/` exists there today. The
    library's research docs cite the records at that old place:
    `qa-harness/qa-results/base-s{1..4}-r{1,2}-*.json` (00-baseline.md:230),
    `qa-results/ceil-s1-…` (same-value-style-write-filter.md:377), and the
    `ssd-h-main`/`ssd-h-wt` runs by name (00-baseline.md:86-87). Moving the
    records back makes those citations true again. The copied analysers
    differ from Loom's only in reading `qa-results` instead of `results`, so
    `python3 qa-table.py base- --writes` works there as 00-baseline.md:227
    writes it. Leaving the records in place would keep a `qa/` folder whose
    only content is ignored and undocumented once `qa/README.md` is gone. The
    risk of the archive is that the folder sits outside every repository and
    any backup Loom has — the same as before `da2f50a`.

[^timeline]: The library's agenda sets this split: "Finding stays in the
    real app (a WebKit Timeline recording); a panel counts as reproducing the
    behaviour only once it shows the same symptom"
    (00-post-campaign-agenda.md:38-40). Chromium runs can miss costs that
    WebKitGTK pays in paint, so a finding in Loom needs a real WebKitGTK
    recording.

[^stand-in-coverage]: Sources: the harness's scenario table
    ([qa/README.md:42-47](qa/README.md#L42)) and its `mode=` list
    ([qa/qa-harness.ts:8](qa/qa-harness.ts#L8)); the shells' default grips
    (`GRIPS` in `../typescript-ui/packages/qa/src/builders/shell.ts:33-37`,
    first entry is the default); and the *Validated* column of the QA app's
    README rows 310-311. That column records `park`, `drag` with
    `grip=sidebar` and `theme:4` for both shells. `shell-deep`'s default
    `dock-h` drag ran in the 2026-09-20 shakedown (`shk-sdeep` in
    `plans/implemented/qa-app-panels.md`), which records no baseline. So S1's
    own gesture has a driver but no recorded baseline. Recording one is
    library work.

[^fsops-prefix]: The root check is a plain `startsWith`, so a sibling folder
    whose name begins with the checkout's path (`/home/jika/typescript/loom-x`)
    would also pass. It is kept unchanged because the server is dev-only,
    listens on localhost, and only reads. The split into `answerFsop` changes
    no response. B7-B9 pin the error codes.

[^config-ext]: `qa/vite.config.qa.ts` imported `'../vite.config'` without
    an extension. Vite 8 warns on every start that its planned native config
    loader will not accept that. Naming the extension removes the warning;
    a trial build and dev-server run with `'../vite.config.ts'` loaded the
    config without complaint. `tsc` never sees the file, so
    `allowImportingTsExtensions` is not needed.

[^kill-by-port]: `qa/runqa.sh` line 16 records why: a `pkill -f` pattern once
    matched the calling shell.
