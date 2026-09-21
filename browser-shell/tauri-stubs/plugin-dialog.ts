// Browser-shell Tauri stub, used only by ../vite.config.browser.ts. Returns a
// fixed folder instead of showing a native picker, so `File > Open Folder…`
// can be driven from a script by setting window.__FAKE_PROJECT_ROOT__ before
// invoking it.
export async function open(_opts?: unknown): Promise<string | null> {
    return (window as unknown as { __FAKE_PROJECT_ROOT__?: string }).__FAKE_PROJECT_ROOT__ ?? null
}

export async function save(_opts?: unknown): Promise<string | null> {
    return null
}
