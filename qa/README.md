# QA harness

Measures `@jimka/typescript-ui` render performance inside Loom's real shell, in
WebKitGTK — the engine Loom ships on under Tauri, and the slowest one
available, which is why measurements are taken here rather than in Chromium.
It drives a scenario (typically a gutter drag) frame by frame and records frame
times, counted per-frame work, DOM/CSSOM writes and pane geometry.

**Every run opens a full-screen MiniBrowser window on the desktop and takes
it over until the run ends (about a minute).** Don't start runs, and never
leave an agent to start them, without the user's go-ahead.

## Files

| file | purpose |
|---|---|
| `qa-harness.ts` | Injected into the page. Builds the scenario, drives it, measures, and POSTs a JSON result. Its header lists every query parameter. |
| `vite.config.qa.ts` | Loom's own `vite.config.ts` plus the QA additions: `@tauri-apps/*` aliased to `tauri-stubs/`, the harness injected, `/__qa/report` and `/__fsops` endpoints. |
| `tauri-stubs/` | Lets the real shell run outside Tauri; filesystem calls read this repo's files through `/__fsops`. |
| `runqa.sh` | Runs one scenario end to end and prints the result file. |
| `qa-table.py` | Tabulates results by name prefix: `qa/qa-table.py <prefix> [--writes]`. |
| `qa-forced.py` | Prints forced-layout reads and their stacks for a result prefix. |

`results/` and `logs/` are created on first run and are not committed.

## Running

The library must be built first (`npm run build:lib` in the typescript-ui
checkout). Then, from the repository root:

```sh
qa/runqa.sh <name> main '<query params>'
QA_WT_LIB=<path>/packages/lib qa/runqa.sh <name> wt '<query params>'
```

`main` measures the checkout Loom normally uses (`QA_MAIN_LIB`, default
`../typescript-ui/packages/lib`). `wt` measures another build, such as a
worktree's, for comparison. The script re-points Loom's `@jimka/typescript-ui`
symlink for the run and always restores it to the main checkout afterwards.
Loom's own `vite.config.ts` is never touched.

The two scenarios the render-review campaign used:

| scenario | query params |
|---|---|
| S1 — 2×2 editor grid, horizontal dock gutter | `mode=filetree&tabs=4&grid=2x2&gutter=dock-h&count=1` |
| S3 — one editor, explorer gutter | `mode=filetree&tabs=1&gutter=explorer&count=1` |

Add `work=1` for per-frame call counters grouped by class, `widthprobe=1` for
geometry probes during the drag, and `abl=<name>[,<name>…]` for runtime
ablations (the `ABLATIONS` table in `qa-harness.ts`).

## Reading results

- **Only compare runs from the same session.** Absolute frame times drift 8–14%
  between sessions on the same build, which is larger than most effects worth
  measuring. Compare a change against its baseline by interleaving the two
  arms in one sweep, and run a baseline arm at both ends to see the drift.
- **Check geometry, not just time.** An ablation or change whose `widthRange`
  differs from the baseline laid the page out differently, so its timing isn't
  comparable. Check a deep scene (S1) and a shallow one (S3): a change can hold
  geometry on S3 and break it on S1.
- **Check that every run wrote a result.** `runqa.sh` exits 1 with `NO RESULT`
  when a run produced nothing; the Vite log in `logs/` says why.
