import { describe, it, expect, vi } from 'vitest'
import { buildPaletteCommands } from '../src/shell/commands'
import type { PaletteCommandActions, PaletteCommand } from '../src/shell/commands'

/** Builds a `PaletteCommandActions` with every predicate `false` and every callback a no-op, overridable per test. */
const actions = (over: Partial<PaletteCommandActions> = {}): PaletteCommandActions => ({
    onNewFile: () => {},
    onOpenFolder: () => {},
    onToggleExplorer: () => {},
    onExit: () => {},
    canSaveActive: () => false,
    onSave: () => {},
    hasActiveFile: () => false,
    onSaveAs: () => {},
    onCloseFile: () => {},
    onFormat: () => {},
    onFind: () => {},
    isShowingHidden: () => false,
    onToggleHidden: () => {},
    isShowingIgnored: () => false,
    onToggleIgnored: () => {},
    ...over,
})

/** Looks up a command by id, throwing (via a failed assertion) if it's missing. */
const findCommand = (commands: PaletteCommand[], id: string): PaletteCommand => {
    const command = commands.find(c => c.id === id)

    expect(command).toBeDefined()

    return command as PaletteCommand
}

describe('buildPaletteCommands', () => {
    it('returns all eleven commands in a fixed order when nothing is available', () => {
        const commands = buildPaletteCommands(actions())

        expect(commands.map(c => c.id)).toEqual([
            'new-file', 'open-folder', 'toggle-explorer', 'exit',
            'save', 'save-as', 'close-file', 'find', 'format-document',
            'toggle-hidden-files', 'toggle-ignored-files',
        ])
    })

    it('returns the same eleven ids in the same order when everything is available', () => {
        const commands = buildPaletteCommands(actions({ canSaveActive: () => true, hasActiveFile: () => true }))

        expect(commands.map(c => c.id)).toEqual([
            'new-file', 'open-folder', 'toggle-explorer', 'exit',
            'save', 'save-as', 'close-file', 'find', 'format-document',
            'toggle-hidden-files', 'toggle-ignored-files',
        ])
    })

    it('marks the per-file commands disabled when no file is active and saving is unavailable', () => {
        const commands = buildPaletteCommands(actions())

        for (const id of ['save', 'save-as', 'close-file', 'find', 'format-document']) {
            expect(findCommand(commands, id).enabled).toBe(false)
        }
    })

    it('marks the always-available commands enabled regardless of state', () => {
        const commands = buildPaletteCommands(actions())

        for (const id of ['new-file', 'open-folder', 'toggle-explorer', 'exit', 'toggle-hidden-files', 'toggle-ignored-files']) {
            expect(findCommand(commands, id).enabled).toBe(true)
        }
    })

    it('leaves Save disabled but the other file commands enabled on a clean active file', () => {
        const commands = buildPaletteCommands(actions({ hasActiveFile: () => true, canSaveActive: () => false }))

        expect(findCommand(commands, 'save').enabled).toBe(false)

        for (const id of ['save-as', 'close-file', 'find', 'format-document']) {
            expect(findCommand(commands, id).enabled).toBe(true)
        }
    })

    it('enables Save once the active file has unsaved changes', () => {
        const commands = buildPaletteCommands(actions({ hasActiveFile: () => true, canSaveActive: () => true }))

        expect(findCommand(commands, 'save').enabled).toBe(true)
    })

    it('labels the hidden-files toggle by the current visibility state', () => {
        expect(findCommand(buildPaletteCommands(actions({ isShowingHidden: () => false })), 'toggle-hidden-files').title)
            .toBe('Show Hidden Files')

        expect(findCommand(buildPaletteCommands(actions({ isShowingHidden: () => true })), 'toggle-hidden-files').title)
            .toBe('Hide Hidden Files')
    })

    it('labels the ignored-files toggle by the current visibility state', () => {
        expect(findCommand(buildPaletteCommands(actions({ isShowingIgnored: () => false })), 'toggle-ignored-files').title)
            .toBe('Show Ignored Files')

        expect(findCommand(buildPaletteCommands(actions({ isShowingIgnored: () => true })), 'toggle-ignored-files').title)
            .toBe('Hide Ignored Files')
    })

    it('keeps a working run callback on a disabled command', () => {
        const onSave = vi.fn()
        const commands = buildPaletteCommands(actions({ onSave }))

        findCommand(commands, 'save').run()

        expect(onSave).toHaveBeenCalledOnce()
    })
})
