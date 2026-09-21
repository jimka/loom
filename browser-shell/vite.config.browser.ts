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
