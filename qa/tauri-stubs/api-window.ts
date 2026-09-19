// QA-only Tauri stub, used only by the harness's dev server.
function noopWindow() {
    return {
        setTitle: async (_title: string) => {},
        close: async () => {},
        onCloseRequested: async (_handler: unknown) => () => {},
        onDragDropEvent: async (_handler: unknown) => () => {},
    }
}

export function getCurrentWindow() {
    return noopWindow()
}
