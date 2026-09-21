// Browser-shell Tauri stub, used only by ../vite.config.browser.ts.
export async function configDir(): Promise<string> {
    return '/tmp/loom-fake-config'
}

export async function join(...parts: string[]): Promise<string> {
    return parts.join('/')
}
