// QA-only Tauri stub, used only by the harness's dev server. Backs
// @tauri-apps/plugin-fs with the dev server's /__fsops middleware (see
// ../vite.config.qa.ts), so FileTree/SearchPanel see this repo's real directory
// tree instead of throwing outside Tauri.
export const BaseDirectory = { Config: 'config' } as const

async function fsGet(op: string, params: Record<string, string>): Promise<Response> {
    const qs = new URLSearchParams(params).toString()
    const res = await fetch(`/__fsops/${op}?${qs}`)

    if (!res.ok) {
        throw new Error(`${op} failed: ${await res.text()}`)
    }

    return res
}

export async function readDir(path: string): Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean; isSymlink: boolean }>> {
    const res = await fsGet('readDir', { path })

    return res.json()
}

export async function readTextFile(path: string, _opts?: unknown): Promise<string> {
    const res = await fsGet('readTextFile', { path })

    return res.text()
}

export async function stat(path: string, _opts?: unknown): Promise<{ size: number; mtime: Date | null }> {
    const res = await fsGet('stat', { path })
    const json = await res.json()

    return { size: json.size, mtime: json.mtimeMs ? new Date(json.mtimeMs) : null }
}

export async function exists(path: string, _opts?: unknown): Promise<boolean> {
    const res = await fsGet('exists', { path })
    const json = await res.json()

    return json.exists
}

export async function writeTextFile(_path: string, _contents: string, _opts?: unknown): Promise<void> {}
export async function mkdir(_path: string, _opts?: unknown): Promise<void> {}
export async function rename(_from: string, _to: string, _opts?: unknown): Promise<void> {}
export async function remove(_path: string, _opts?: unknown): Promise<void> {}

export async function watch(
    _dir: string,
    _onEvent: (event: { type: unknown; paths: string[] }) => void,
    _opts?: unknown,
): Promise<() => void> {
    return () => {}
}
