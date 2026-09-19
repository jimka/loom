import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeConfig } from 'vite'
import type { Plugin } from 'vite'
import base from '../vite.config'

// The QA harness's dev server: Loom's own config plus what lets the real
// EditorShell run outside the Tauri runtime, in a plain Vite dev server driven
// by MiniBrowser (WebKitGTK). Every `@tauri-apps/*` import is rerouted to a stub
// in `tauri-stubs/`, backed for filesystem ops by this repo's real files via
// `/__fsops`; the harness is injected into index.html; and results are accepted
// on `/__qa/report`. Selected with `vite --config qa/vite.config.qa.ts` (which
// `runqa.sh` does), so Loom's own `vite.config.ts` is never swapped or edited.
// See README.md.
const QA_DIR = path.dirname(fileURLToPath(import.meta.url))
const LOOM_ROOT = path.resolve(QA_DIR, '..')
const STUB_DIR = path.join(QA_DIR, 'tauri-stubs')
const RESULTS_DIR = path.join(QA_DIR, 'results')
const FSOPS_ROOT = LOOM_ROOT

function qaPlugin(): Plugin {
    return {
        name: 'qa-harness',
        transformIndexHtml() {
            return [{ tag: 'script', attrs: { type: 'module', src: `/@fs${path.join(QA_DIR, 'qa-harness.ts')}` }, injectTo: 'body' }]
        },
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const url = new URL(req.url ?? '/', 'http://localhost')

                if (url.pathname === '/__qa/report' && req.method === 'POST') {
                    const chunks: Buffer[] = []

                    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
                    req.on('end', () => {
                        fs.mkdirSync(RESULTS_DIR, { recursive: true })

                        const name = (url.searchParams.get('name') ?? 'unnamed').replace(/[^\w.-]/g, '_')
                        const file = path.join(RESULTS_DIR, `${name}-${Date.now()}.json`)

                        fs.writeFileSync(file, Buffer.concat(chunks))
                        res.end('ok')
                    })

                    return
                }

                if (!url.pathname.startsWith('/__fsops/')) {
                    next()

                    return
                }

                const op = url.pathname.slice('/__fsops/'.length)
                const resolved = path.resolve(url.searchParams.get('path') ?? '')

                if (!resolved.startsWith(FSOPS_ROOT)) {
                    res.statusCode = 403
                    res.end('path outside fsops root')

                    return
                }

                try {
                    if (op === 'readDir') {
                        const entries = fs.readdirSync(resolved, { withFileTypes: true }).map((entry: fs.Dirent) => ({
                            name: entry.name,
                            isDirectory: entry.isDirectory(),
                            isFile: entry.isFile(),
                            isSymlink: entry.isSymbolicLink(),
                        }))

                        res.setHeader('content-type', 'application/json')
                        res.end(JSON.stringify(entries))
                    } else if (op === 'readTextFile') {
                        res.end(fs.readFileSync(resolved, 'utf-8'))
                    } else if (op === 'stat') {
                        const info = fs.statSync(resolved)

                        res.setHeader('content-type', 'application/json')
                        res.end(JSON.stringify({ size: info.size, mtimeMs: info.mtimeMs }))
                    } else if (op === 'exists') {
                        res.setHeader('content-type', 'application/json')
                        res.end(JSON.stringify({ exists: fs.existsSync(resolved) }))
                    } else {
                        res.statusCode = 404
                        res.end('unknown fsops')
                    }
                } catch (error) {
                    res.statusCode = 500
                    res.end(String(error))
                }
            })
        },
    }
}

export default mergeConfig(base, {
    plugins: [qaPlugin()],
    // The folder the harness opens as its project; the harness reads it
    // rather than hard-coding a path.
    define: {
        __QA_PROJECT_ROOT__: JSON.stringify(LOOM_ROOT),
    },
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
