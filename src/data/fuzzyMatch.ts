// Pure fuzzy-matching helpers backing the command palette's file and command
// search — no imports, no I/O, so both modes share one scoring/ranking pair.

/** Base score for each query character matched, regardless of position. */
const MATCH_BASE_SCORE = 1
/** Bonus for a match landing at index 0 or right after a `/` — rewards matching a file's own name over a directory segment. */
const SEGMENT_START_BONUS = 2
/** Bonus for a match immediately following the previous one — rewards a contiguous run over scattered letters. */
const CONTIGUOUS_BONUS = 1

/**
 * Case-insensitive ordered-subsequence match score between `query` and
 * `candidate`, or `null` when `query`'s characters do not all appear, in
 * order, somewhere in `candidate`. An empty `query` matches every candidate
 * with score `0`.
 *
 * @param query - The typed search text.
 * @param candidate - The string being scored against `query`.
 * @returns The match score, or `null` when `query` is not an ordered
 *   subsequence of `candidate`.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
    if (query === '') {
        return 0
    }

    const q = query.toLowerCase()
    const c = candidate.toLowerCase()
    let candidateIndex = 0
    let previousMatchedIndex = -2
    let score = 0

    for (const ch of q) {
        while (candidateIndex < c.length && c[candidateIndex] !== ch) {
            candidateIndex += 1
        }

        if (candidateIndex >= c.length) {
            return null
        }

        score += MATCH_BASE_SCORE

        if (candidateIndex === 0 || c[candidateIndex - 1] === '/') {
            score += SEGMENT_START_BONUS
        }

        if (candidateIndex === previousMatchedIndex + 1) {
            score += CONTIGUOUS_BONUS
        }

        previousMatchedIndex = candidateIndex
        candidateIndex += 1
    }

    return score
}

/**
 * Filters `items` to those `toText` renders as a fuzzy match for `query`,
 * ranked highest score first, ties broken alphabetically by `toText`, capped
 * at `limit` entries.
 *
 * @param query - The typed search text.
 * @param items - The candidate items to filter and rank.
 * @param toText - Renders an item to the string `fuzzyScore` matches against.
 * @param limit - The maximum number of items to return.
 * @returns The matching items, ranked and capped.
 */
export function filterAndRankFuzzy<T>(
    query: string,
    items: readonly T[],
    toText: (item: T) => string,
    limit: number,
): T[] {
    const scored = items
        .map(item => ({ item, text: toText(item), score: fuzzyScore(query, toText(item)) }))
        .filter((entry): entry is { item: T; text: string; score: number } => entry.score !== null)

    scored.sort((a, b) => b.score - a.score || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))

    return scored.slice(0, limit).map(entry => entry.item)
}
