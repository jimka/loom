// The app's single seam onto ThemeManager: every other module reads or
// switches the theme through this file rather than importing ThemeManager
// itself, so the whole app has exactly one call site to reason about. Not
// unit-tested: vitest.config.ts runs the `node` environment with no DOM, so
// ThemeManager.setTheme has nothing to write to — see the plan's manual
// verification list instead.
import { ThemeManager, ModernTheme, DarkTheme } from '@jimka/typescript-ui/core'
import type { Theme } from '@jimka/typescript-ui/core'
import { Dialog } from '@jimka/typescript-ui/overlay'
import type { ThemeName } from '../data/settings'
import { saveGlobalTheme } from './settings'
import { messageOf } from '../errors'

/** Each `theme` value's library theme. `ModernTheme` is the library's own default. */
const THEMES: Record<ThemeName, Theme> = {
    light: ModernTheme,
    dark: DarkTheme,
}

/**
 * Applies `theme` to the whole UI through `ThemeManager.setTheme`.
 *
 * @param theme - The theme to apply.
 */
export function applyTheme(theme: ThemeName): void {
    ThemeManager.setTheme(THEMES[theme])
}

/**
 * Which theme is live right now, read back from `ThemeManager` rather than
 * mirrored in a Loom-owned field, so it can never drift from what the page
 * is actually painted with.
 *
 * @returns The live theme.
 */
export function currentThemeName(): ThemeName {
    return ThemeManager.getTheme().colorScheme === 'dark' ? 'dark' : 'light'
}

/**
 * Applies `theme` and records it in the app-wide settings file. The theme is
 * applied first, so a failed write still leaves the UI switched and reports
 * only that the choice was not remembered.
 *
 * @param theme - The theme to select.
 */
export async function selectTheme(theme: ThemeName): Promise<void> {
    applyTheme(theme)

    try {
        await saveGlobalTheme(theme)
    } catch (error) {
        await Dialog.error('Could not save the theme', messageOf(error))
    }
}
