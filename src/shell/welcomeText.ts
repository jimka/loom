// The welcome screen's state-to-copy rule, split out of WelcomeScreen.ts so
// it stays unit testable: vitest.config.ts runs in the `node` environment
// with no DOM, and a module that imports @jimka/typescript-ui's components
// touches `document` at load time.
import { APP_NAME } from '../appIdentity'
import { projectName } from '../data/paths'

/** The welcome screen's heading and hint text for a given state. */
export interface WelcomeCopy {
    /** The page's large heading line. */
    heading: string
    /** The muted line under the heading. */
    hint: string
}

/**
 * The welcome screen's copy for the current project state.
 *
 * @param projectRoot - The open project folder, or `null` when none is open.
 * @returns The heading and hint to show.
 */
export function welcomeCopy(projectRoot: string | null): WelcomeCopy {
    if (projectRoot === null) {
        return {
            heading: `Welcome to ${APP_NAME}`,
            hint: 'Open a project folder to start editing.',
        }
    }

    return {
        heading: projectName(projectRoot),
        hint: 'Select a file in the explorer to start editing.',
    }
}
