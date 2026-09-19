// QA-only Tauri stub, used only by the harness's dev server.
export async function configDir(): Promise<string> {
    return '/tmp/loom-fake-config'
}

export async function join(...parts: string[]): Promise<string> {
    return parts.join('/')
}
