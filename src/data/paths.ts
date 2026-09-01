// Pure path helpers — no imports. `baseName` and `extensionOf` split on both
// `/` and `\` so a project opened from a Windows path still resolves.

/**
 * The final path segment, split on both `/` and `\`.
 *
 * @param path - A file or directory path.
 * @returns The last segment (the file or directory's own name).
 */
export function baseName(path: string): string {
  const segments = path.split(/[/\\]/)

  return segments[segments.length - 1]
}

/**
 * A project folder's display name: its last path segment, ignoring a
 * trailing separator.
 *
 * @param root - A project folder path.
 * @returns The folder's own name, or `root` itself when trimming a trailing
 *   separator leaves nothing (e.g. the filesystem root `/`).
 */
export function projectName(root: string): string {
  const trimmed = root.replace(/[/\\]+$/, '')

  return trimmed === '' ? root : baseName(trimmed)
}

/**
 * The lowercased extension of `path`'s base name — everything after its
 * *last* dot. A base name whose only dot is its first character (a dotfile
 * like `.gitignore`) and one with no dot at all both have no extension.
 *
 * @param path - A file path.
 * @returns The lowercased extension, without its leading dot, or `""`.
 */
export function extensionOf(path: string): string {
  const name = baseName(path)
  const lastDot = name.lastIndexOf('.')

  if (lastDot <= 0) {
    return ''
  }

  return name.slice(lastDot + 1).toLowerCase()
}

/**
 * Joins `name` onto `parent` using whichever separator `parent` already
 * uses — `\` if `parent` contains one, `/` otherwise — without doubling a
 * separator `parent` already ends with.
 *
 * @param parent - The parent directory path.
 * @param name - The child's own name (not a path).
 * @returns The joined path.
 */
export function joinPath(parent: string, name: string): string {
  const sep = parent.includes('\\') ? '\\' : '/'

  return parent.endsWith(sep) ? parent + name : parent + sep + name
}

/** A directory-listing item shaped enough to sort — carries no path of its own. */
export interface SortableEntry {
  name: string
  isDir: boolean
}

/**
 * Orders directory-listing entries with directories before files, each
 * group sorted case-insensitively by `name`; a case-insensitive tie is
 * broken by the raw (case-sensitive) name so the result is stable.
 *
 * @param items - The entries to order.
 * @returns A new array in directories-first, case-insensitive name order.
 */
export function sortDirEntries<T extends SortableEntry>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.isDir !== b.isDir) {
      return a.isDir ? -1 : 1
    }

    const lowerA = a.name.toLowerCase()
    const lowerB = b.name.toLowerCase()

    if (lowerA !== lowerB) {
      return lowerA < lowerB ? -1 : 1
    }

    if (a.name === b.name) {
      return 0
    }

    return a.name < b.name ? -1 : 1
  })
}

/**
 * Every non-empty segment of `path`, split on both `/` and `\`.
 *
 * @param path - A file or directory path, absolute or relative.
 * @returns The segments, leading/trailing/repeated separators dropped.
 */
export function pathSegments(path: string): string[] {
  return path.split(/[/\\]/).filter(segment => segment.length > 0)
}

/**
 * `path` rewritten relative to `root`, or `null` when `path` does not sit
 * strictly below `root`.
 *
 * @param root - The directory to measure against, or `null` when none is open.
 * @param path - The path to rewrite.
 * @returns The portion of `path` below `root`, or `null`.
 */
export function relativeTo(root: string | null, path: string): string | null {
  if (root === null) {
    return null
  }

  const sep = root.includes('\\') ? '\\' : '/'
  const prefix = root.endsWith(sep) ? root : root + sep

  return path.startsWith(prefix) ? path.slice(prefix.length) : null
}

/**
 * Whether `path` is `root` itself or lives anywhere under it, comparing path
 * segments so a same-prefix sibling (`/p2` under `/p`) is never mistaken for
 * being inside it.
 *
 * @param root - The candidate ancestor directory.
 * @param path - The path to test.
 * @returns Whether `path` is `root` or a descendant of it.
 */
export function isUnderRoot(root: string, path: string): boolean {
  const rootSegments = root.split(/[/\\]/).filter(segment => segment !== '')
  const pathSegments = path.split(/[/\\]/).filter(segment => segment !== '')

  if (pathSegments.length < rootSegments.length) {
    return false
  }

  return rootSegments.every((segment, index) => segment === pathSegments[index])
}
