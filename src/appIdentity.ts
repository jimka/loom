// The single source of the app's name and tab icon, so the window title and
// the favicon can't drift apart or fall back to the library's own mark.

/** The canonical app name, as it should appear anywhere in the UI. */
export const APP_NAME = 'Loom'

/**
 * The app's mark: a dark, rounded-square tile carrying a light "L"-shaped
 * hook stroke and a vertical orange accent bar. Also the source for the
 * native window/taskbar icon set in `src-tauri/icons/` — regenerate those
 * from `src-tauri/icon-source.svg` (the same artwork) via
 * `npx tauri icon src-tauri/icon-source.svg` if this mark ever changes.
 * The tile's own opaque background carries the mark on both light and dark
 * browser chrome, so — unlike the library's own favicon mark — it needs no
 * `prefers-color-scheme` rule of its own.
 */
export const APP_MARK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240"><rect x="0" y="0" width="240" height="240" rx="50" fill="#141822"/><g transform="translate(48,48) scale(6)"><path d="M8 4 L8 18 L16.5 18" stroke="#eef2f9" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/><rect x="19" y="2.5" width="3" height="17" fill="#fe7802"/></g></svg>'

/**
 * The app's mark as a ready-to-use `data:` URI, for `Body.init`'s `favicon`
 * option. Without it the library installs its own mark and the app wears
 * the framework's identity in the browser tab.
 *
 * Encoded with `encodeURIComponent` rather than a hand-written escape list —
 * an unescaped `#` would truncate the URI at the first colour literal.
 */
export const APP_FAVICON = `data:image/svg+xml,${encodeURIComponent(APP_MARK_SVG)}`
