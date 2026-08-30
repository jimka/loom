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
