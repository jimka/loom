// Tauri-backed load and lazy-create calls for settings — pure shape and
// parsing live in `../data/settings`; this module is where that shape meets
// the app-wide and per-workspace files on disk, mirroring `./session`.
import { resolveSettings, parseSettingsOverride, serializeSettingsOverride, emptySettingsOverride } from '../data/settings'
import type { Settings } from '../data/settings'
import {
    readSettingsText, writeSettingsText, globalSettingsPath,
    readWorkspaceSettingsText, writeWorkspaceSettingsText, workspaceSettingsPath,
} from '../data/workspace'

/**
 * Loads the effective settings: the global file layered under `root`'s own
 * file, when `root` isn't `null`.
 *
 * @param root - The open project folder, or `null` when none is open.
 * @returns The fully resolved settings.
 */
export async function loadResolvedSettings(root: string | null): Promise<Settings> {
    const globalText = await readSettingsText()
    const global = globalText === null ? null : parseSettingsOverride(globalText)
    const workspaceText = root === null ? null : await readWorkspaceSettingsText(root)
    const workspace = workspaceText === null ? null : parseSettingsOverride(workspaceText)

    return resolveSettings(global, workspace)
}

/**
 * The app-wide settings file's path, creating it with an empty override
 * first if it doesn't exist yet.
 *
 * @returns The app-wide settings file's path.
 */
export async function ensureGlobalSettingsFile(): Promise<string> {
    if ((await readSettingsText()) === null) {
        await writeSettingsText(serializeSettingsOverride(emptySettingsOverride()))
    }

    return globalSettingsPath()
}

/**
 * `root`'s own settings file's path, creating it with an empty override
 * first if it doesn't exist yet.
 *
 * @param root - The project folder to ensure a settings file for.
 * @returns `root`'s own settings file's path.
 */
export async function ensureWorkspaceSettingsFile(root: string): Promise<string> {
    if ((await readWorkspaceSettingsText(root)) === null) {
        await writeWorkspaceSettingsText(root, serializeSettingsOverride(emptySettingsOverride()))
    }

    return workspaceSettingsPath(root)
}
