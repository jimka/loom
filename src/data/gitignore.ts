// Pure gitignore-matching helpers. `buildRootIgnoreChain` is the only
// function that performs I/O, and it does so through the two injected
// dependencies below rather than importing workspace.ts directly, so this
// module stays testable with plain in-memory fakes.
import ignore from 'ignore'
import type { Ignore } from 'ignore'
import { joinPath, parentDir, relativePath } from './paths'

/** The file name whose contents define one layer of ignore rules. */
export const GITIGNORE_NAME = '.gitignore'

/** One `.gitignore` file's compiled rules, tagged with the directory they are relative to. */
export interface IgnoreLayer {
  readonly dir: string
  readonly matcher: Ignore
}

/** The ignore rules governing one directory, outermost layer first. */
export type IgnoreChain = readonly IgnoreLayer[]

/** The chain for a directory governed by no ignore rules at all. */
export const EMPTY_IGNORE_CHAIN: IgnoreChain = []

/** Reads a text file, resolving `null` when it is missing or unreadable. */
export type TryReadTextFile = (path: string) => Promise<string | null>

/** Whether a filesystem path exists. */
export type PathExists = (path: string) => Promise<boolean>

/**
 * Whether `name` is a dotfile — the only "hidden" rule this app applies. The
 * Windows hidden attribute is not consulted; see the plan's `## Non-Goals`.
 *
 * @param name - A single directory-entry name (not a path).
 * @returns Whether `name` starts with `.`.
 */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.')
}

/**
 * Builds a matcher from `.gitignore`-style rules text, case-sensitive to
 * match git's own behaviour on the project's live test platform (Linux); see
 * the plan's case-sensitivity footnote.
 *
 * @param text - The raw contents of a `.gitignore` (or exclude) file.
 * @returns A compiled matcher for those rules.
 */
function compileMatcher(text: string): Ignore {
  return ignore({ ignorecase: false }).add(text)
}

/**
 * Extends `chain` with one more layer compiled from `text`, anchored at
 * `dir`. Returns `chain` itself, unchanged, when `text` is `null` — a
 * missing or unreadable `.gitignore` adds no layer.
 *
 * @param chain - The chain to extend.
 * @param dir - The directory `text`'s patterns are relative to.
 * @param text - The file's contents, or `null` when it does not exist.
 * @returns The extended chain, or `chain` itself when `text` is `null`.
 */
export function extendIgnoreChain(chain: IgnoreChain, dir: string, text: string | null): IgnoreChain {
  if (text === null) {
    return chain
  }

  return [...chain, { dir, matcher: compileMatcher(text) }]
}

/**
 * Whether `path` is ignored by `chain`, walked innermost layer first —
 * git's rule that a deeper `.gitignore` overrides a shallower one. Within
 * one layer, `ignore` already applies git's last-matching-pattern-wins rule.
 *
 * @param chain - The ignore chain governing `path`, outermost first.
 * @param path - The absolute path to test.
 * @param isDir - Whether `path` is a directory; a directory is tested with a
 *   trailing `/` appended, since `ignore` cannot otherwise match a
 *   directory-only pattern (see the plan's trailing-slash footnote).
 * @returns Whether any layer's verdict, innermost first, is "ignored".
 */
export function isIgnoredByChain(chain: IgnoreChain, path: string, isDir: boolean): boolean {
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const layer = chain[index]
    const relative = relativePath(layer.dir, path)

    // A layer whose directory does not contain `path` has nothing to say
    // about it. This guard is also load-bearing against `Ignore.test`
    // itself: it throws a `RangeError` on an absolute path and a
    // `TypeError` on an empty one. `relativePath` folds both the "not
    // contained" and the "is the layer's own directory" cases (however the
    // latter is spelled — with or without a trailing separator) into `null`,
    // so neither an absolute nor an empty string ever reaches `.test` below.
    if (relative === null) {
      continue
    }

    const result = layer.matcher.test(isDir ? `${relative}/` : relative)

    if (result.ignored) {
      return true
    }

    if (result.unignored) {
      return false
    }
  }

  return false
}

/** The path to a directory's `.git/info/exclude` file. */
function gitExcludePath(gitDir: string): string {
  return joinPath(joinPath(gitDir, 'info'), 'exclude')
}

/**
 * Walks upward from `dir` looking for a `.git` entry, stopping at the
 * filesystem root. `.git` is probed with `pathExists` (backed by `stat`)
 * rather than a directory-only check, because a linked worktree's `.git` is
 * a file, not a directory.
 *
 * @param dir - The directory to start walking up from.
 * @param pathExists - Injected filesystem-existence check.
 * @returns The repository root directory, or `null` when none is found.
 */
async function findRepositoryRoot(dir: string, pathExists: PathExists): Promise<string | null> {
  let current = dir

  for (;;) {
    if (await pathExists(joinPath(current, '.git'))) {
      return current
    }

    const parent = parentDir(current)

    if (parent === current) {
      return null
    }

    current = parent
  }
}

/**
 * The directories strictly between `repoRoot` and `root` (both exclusive),
 * outermost first. `repoRoot`'s own `.gitignore` and `root`'s own
 * `.gitignore` are each handled separately by the caller.
 *
 * @param repoRoot - The repository root directory.
 * @param root - The opened project folder, at or below `repoRoot`.
 * @returns The intermediate directories, outermost first.
 */
function intermediateDirs(repoRoot: string, root: string): string[] {
  if (root === repoRoot) {
    return []
  }

  const dirs: string[] = []
  let current = parentDir(root)

  while (current !== repoRoot) {
    dirs.unshift(current)

    const parent = parentDir(current)

    if (parent === current) {
      break
    }

    current = parent
  }

  return dirs
}

/**
 * Builds the ignore chain governing everything *above* `root` — the folder
 * the user opened — by walking up to the repository root (if any) and
 * seeding the chain with its exclude file and every `.gitignore` from the
 * repository root down to (but not including) `root` itself. `root`'s own
 * `.gitignore`, if it has one, is added later by the caller when it lists
 * `root` — see the plan's "chain above the opened folder" architecture
 * decision.
 *
 * @param root - The project folder the user opened.
 * @param tryReadTextFile - Injected text-file reader.
 * @param pathExists - Injected filesystem-existence check.
 * @returns The seeded chain, outermost layer first, or {@link EMPTY_IGNORE_CHAIN}
 *   when `root` is not inside a repository.
 */
export async function buildRootIgnoreChain(
  root: string,
  tryReadTextFile: TryReadTextFile,
  pathExists: PathExists,
): Promise<IgnoreChain> {
  const repoRoot = await findRepositoryRoot(root, pathExists)

  if (repoRoot === null) {
    return EMPTY_IGNORE_CHAIN
  }

  let chain = extendIgnoreChain(EMPTY_IGNORE_CHAIN, repoRoot, await tryReadTextFile(gitExcludePath(joinPath(repoRoot, '.git'))))

  // `repoRoot`'s own `.gitignore` belongs in this seeded chain only when
  // `root` is further down the tree; when the opened folder *is* the
  // repository root, that file is `root`'s own and the caller's
  // `loadDirectory` reads it instead (see the plan's architecture decision).
  const gitignoreDirs = root === repoRoot ? [] : [repoRoot, ...intermediateDirs(repoRoot, root)]

  for (const dir of gitignoreDirs) {
    chain = extendIgnoreChain(chain, dir, await tryReadTextFile(joinPath(dir, GITIGNORE_NAME)))
  }

  return chain
}
