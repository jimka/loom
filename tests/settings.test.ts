import { describe, it, expect } from 'vitest'
import {
    DEFAULT_SETTINGS, emptySettingsOverride, parseSettingsOverride, serializeSettingsOverride,
    resolveSettings, renderTitle,
} from '../src/data/settings'
import type { SettingsOverride } from '../src/data/settings'

describe('parseSettingsOverride', () => {
    it('returns null for an empty string', () => {
        expect(parseSettingsOverride('')).toBeNull()
    })

    it('returns null for text that is not JSON', () => {
        expect(parseSettingsOverride('not json')).toBeNull()
    })

    it('returns null when the top level is an array', () => {
        expect(parseSettingsOverride('[]')).toBeNull()
    })

    it('returns null when the top level is null', () => {
        expect(parseSettingsOverride('null')).toBeNull()
    })

    it('returns null when version is not 1', () => {
        expect(parseSettingsOverride('{"version":2}')).toBeNull()
    })

    it('returns a bare override for a minimal valid document', () => {
        expect(parseSettingsOverride('{"version":1}')).toEqual({ version: 1 })
    })

    it('takes a valid formatOnSave field', () => {
        expect(parseSettingsOverride('{"version":1,"formatOnSave":false}')).toEqual({
            version: 1,
            formatOnSave: false,
        })
    })

    it('drops formatOnSave when it has the wrong type, keeping the rest of the document usable', () => {
        expect(parseSettingsOverride('{"version":1,"formatOnSave":"nope"}')).toEqual({ version: 1 })
    })

    it('drops a non-positive tabMaxWidthPx', () => {
        expect(parseSettingsOverride('{"version":1,"tabMaxWidthPx":-5}')).toEqual({ version: 1 })
    })

    it('takes a valid positive tabMaxWidthPx', () => {
        expect(parseSettingsOverride('{"version":1,"tabMaxWidthPx":300}')).toEqual({
            version: 1,
            tabMaxWidthPx: 300,
        })
    })

    it('drops an empty titleBarTemplate', () => {
        expect(parseSettingsOverride('{"version":1,"titleBarTemplate":""}')).toEqual({ version: 1 })
    })

    it('takes a valid non-empty titleBarTemplate', () => {
        expect(parseSettingsOverride('{"version":1,"titleBarTemplate":"{name}"}')).toEqual({
            version: 1,
            titleBarTemplate: '{name}',
        })
    })
})

describe('emptySettingsOverride', () => {
    it('returns a bare override with no field set', () => {
        expect(emptySettingsOverride()).toEqual({ version: 1 })
    })
})

describe('serializeSettingsOverride', () => {
    it('round-trips through parseSettingsOverride', () => {
        const override: SettingsOverride = { version: 1, formatOnSave: true }

        expect(parseSettingsOverride(serializeSettingsOverride(override))).toEqual(override)
    })
})

describe('resolveSettings', () => {
    it('deep-equals DEFAULT_SETTINGS when both layers are null', () => {
        expect(resolveSettings(null, null)).toEqual(DEFAULT_SETTINGS)
    })

    it('takes a global-only override, leaving every other field at its default', () => {
        expect(resolveSettings({ version: 1, formatOnSave: false }, null)).toEqual({
            ...DEFAULT_SETTINGS,
            formatOnSave: false,
        })
    })

    it('lets a workspace override win over a global one for the same field', () => {
        expect(resolveSettings({ version: 1, formatOnSave: false }, { version: 1, formatOnSave: true })).toEqual({
            ...DEFAULT_SETTINGS,
            formatOnSave: true,
        })
    })

    it('merges independent fields from each layer together', () => {
        const result = resolveSettings({ version: 1, showHiddenFiles: true }, { version: 1, tabMaxWidthPx: 100 })

        expect(result.showHiddenFiles).toBe(true)
        expect(result.tabMaxWidthPx).toBe(100)
    })
})

describe('renderTitle', () => {
    it('expands dirty, name, and app for a clean file', () => {
        expect(renderTitle('{dirty}{name} — {app}', { name: 'app.ts', app: 'Loom', dirty: false }))
            .toBe('app.ts — Loom')
    })

    it('expands the dirty marker for a dirty file', () => {
        expect(renderTitle('{dirty}{name} — {app}', { name: 'app.ts', app: 'Loom', dirty: true }))
            .toBe('• app.ts — Loom')
    })

    it('expands a template with just {name}', () => {
        expect(renderTitle('{name}', { name: 'x.ts', app: 'Loom', dirty: false })).toBe('x.ts')
    })

    it('never shows the dirty marker when the template has no {dirty} slot', () => {
        expect(renderTitle('{app}: {name}', { name: 'x.ts', app: 'Loom', dirty: true })).toBe('Loom: x.ts')
    })

    it('returns a template with no placeholders unchanged', () => {
        expect(renderTitle('no placeholders', { name: 'x.ts', app: 'Loom', dirty: false })).toBe('no placeholders')
    })
})
