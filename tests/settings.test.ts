import { describe, it, expect } from 'vitest'
import {
    DEFAULT_SETTINGS, emptySettingsOverride, parseSettingsOverride, serializeSettingsOverride,
    resolveSettings, renderTitle, withTheme,
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

    it('takes a valid dark theme', () => {
        expect(parseSettingsOverride('{"version":1,"theme":"dark"}')).toEqual({
            version: 1,
            theme: 'dark',
        })
    })

    it('takes a valid light theme', () => {
        expect(parseSettingsOverride('{"version":1,"theme":"light"}')).toEqual({
            version: 1,
            theme: 'light',
        })
    })

    it('drops theme when its capitalisation does not match a listed choice', () => {
        expect(parseSettingsOverride('{"version":1,"theme":"Dark"}')).toEqual({ version: 1 })
    })

    it('drops theme when it is not one of the listed choices', () => {
        expect(parseSettingsOverride('{"version":1,"theme":"solarized"}')).toEqual({ version: 1 })
    })

    it('drops theme when it has the wrong type', () => {
        expect(parseSettingsOverride('{"version":1,"theme":3}')).toEqual({ version: 1 })
    })
})

describe('parseSettingsOverride formatting block', () => {
    it('has no formatting key when the document sets none', () => {
        expect(parseSettingsOverride('{"version":1}')).toEqual({ version: 1 })
    })

    it('drops an empty formatting block, storing nothing', () => {
        expect(parseSettingsOverride('{"version":1,"formatting":{}}')).toEqual({ version: 1 })
    })

    it('drops formatting when it is a string, not an object', () => {
        expect(parseSettingsOverride('{"version":1,"formatting":"wide"}')).toEqual({ version: 1 })
    })

    it('drops formatting when it is an array', () => {
        expect(parseSettingsOverride('{"version":1,"formatting":[]}')).toEqual({ version: 1 })
    })

    it('drops formatting when it is null', () => {
        expect(parseSettingsOverride('{"version":1,"formatting":null}')).toEqual({ version: 1 })
    })

    it('drops an unknown field, storing nothing', () => {
        expect(parseSettingsOverride('{"version":1,"formatting":{"unknownKnob":1}}')).toEqual({ version: 1 })
    })

    it('takes a valid indentWidth', () => {
        expect(parseSettingsOverride('{"version":1,"formatting":{"indentWidth":4}}')).toEqual({
            version: 1,
            formatting: { indentWidth: 4 },
        })
    })

    it('drops a fractional indentWidth', () => {
        expect(parseSettingsOverride('{"version":1,"formatting":{"indentWidth":2.5}}')).toEqual({ version: 1 })
    })

    it('drops a non-positive indentWidth', () => {
        expect(parseSettingsOverride('{"version":1,"formatting":{"indentWidth":0}}')).toEqual({ version: 1 })
    })

    it('drops a negative indentWidth', () => {
        expect(parseSettingsOverride('{"version":1,"formatting":{"indentWidth":-2}}')).toEqual({ version: 1 })
    })

    it('drops indentWidth when it is a string, not a number', () => {
        expect(parseSettingsOverride('{"version":1,"formatting":{"indentWidth":"4"}}')).toEqual({ version: 1 })
    })

    it('takes a valid lineWidth', () => {
        expect(parseSettingsOverride('{"version":1,"formatting":{"lineWidth":100}}')).toEqual({
            version: 1,
            formatting: { lineWidth: 100 },
        })
    })

    it('takes a valid useTabs', () => {
        expect(parseSettingsOverride('{"version":1,"formatting":{"useTabs":true}}')).toEqual({
            version: 1,
            formatting: { useTabs: true },
        })
    })

    it('drops useTabs when it is not a boolean', () => {
        expect(parseSettingsOverride('{"version":1,"formatting":{"useTabs":"yes"}}')).toEqual({ version: 1 })
    })

    it('takes a valid keywordCase', () => {
        expect(parseSettingsOverride('{"version":1,"formatting":{"keywordCase":"upper"}}')).toEqual({
            version: 1,
            formatting: { keywordCase: 'upper' },
        })
    })

    it('drops keywordCase when its capitalisation does not match a listed choice', () => {
        expect(parseSettingsOverride('{"version":1,"formatting":{"keywordCase":"Upper"}}')).toEqual({ version: 1 })
    })

    it('takes a valid trailingComma', () => {
        expect(parseSettingsOverride('{"version":1,"formatting":{"trailingComma":"es5"}}')).toEqual({
            version: 1,
            formatting: { trailingComma: 'es5' },
        })
    })

    it('drops trailingComma when it is not one of the listed choices', () => {
        expect(parseSettingsOverride('{"version":1,"formatting":{"trailingComma":"maybe"}}')).toEqual({ version: 1 })
    })

    it('takes a valid proseWrap', () => {
        expect(parseSettingsOverride('{"version":1,"formatting":{"proseWrap":"always"}}')).toEqual({
            version: 1,
            formatting: { proseWrap: 'always' },
        })
    })

    it('takes a valid htmlWhitespaceSensitivity', () => {
        expect(parseSettingsOverride('{"version":1,"formatting":{"htmlWhitespaceSensitivity":"strict"}}')).toEqual({
            version: 1,
            formatting: { htmlWhitespaceSensitivity: 'strict' },
        })
    })

    it('takes a valid arrowParens', () => {
        expect(parseSettingsOverride('{"version":1,"formatting":{"arrowParens":"avoid"}}')).toEqual({
            version: 1,
            formatting: { arrowParens: 'avoid' },
        })
    })

    it('keeps a good field and drops a bad one in the same block', () => {
        expect(parseSettingsOverride('{"version":1,"formatting":{"indentWidth":4,"keywordCase":"Upper"}}')).toEqual({
            version: 1,
            formatting: { indentWidth: 4 },
        })
    })

    it('parses formatting alongside a top-level field', () => {
        expect(parseSettingsOverride('{"version":1,"formatOnSave":false,"formatting":{"useTabs":true}}')).toEqual({
            version: 1,
            formatOnSave: false,
            formatting: { useTabs: true },
        })
    })

    it('omits the formatting key entirely rather than storing it as undefined or empty', () => {
        const override = parseSettingsOverride('{"version":1,"formatting":{"indentWidth":2.5}}')

        expect(override).not.toBeNull()
        expect('formatting' in (override as SettingsOverride)).toBe(false)
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

    it('round-trips a nested formatting block', () => {
        const override: SettingsOverride = { version: 1, formatting: { indentWidth: 4, keywordCase: 'upper' } }

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

    it('defaults formatting to an empty object when neither layer sets it', () => {
        expect(resolveSettings(null, null).formatting).toEqual({})
    })

    it('defaults formatting to an empty object when both layers are bare overrides', () => {
        expect(resolveSettings({ version: 1 }, { version: 1 }).formatting).toEqual({})
    })

    it('takes a global-only formatting block', () => {
        expect(resolveSettings({ version: 1, formatting: { indentWidth: 4 } }, null).formatting).toEqual({
            indentWidth: 4,
        })
    })

    it('takes a global formatting block through a bare workspace override', () => {
        const result = resolveSettings({ version: 1, formatting: { indentWidth: 4 } }, { version: 1 })

        expect(result.formatting).toEqual({ indentWidth: 4 })
    })

    it('merges a workspace formatting block field-by-field over the global one', () => {
        const result = resolveSettings(
            { version: 1, formatting: { indentWidth: 4, useTabs: true } },
            { version: 1, formatting: { indentWidth: 2 } },
        )

        expect(result.formatting).toEqual({ indentWidth: 2, useTabs: true })
    })

    it('takes a workspace-only formatting block', () => {
        expect(resolveSettings(null, { version: 1, formatting: { keywordCase: 'upper' } }).formatting).toEqual({
            keywordCase: 'upper',
        })
    })

    it('returns a fresh formatting object rather than aliasing DEFAULT_SETTINGS.formatting', () => {
        const result = resolveSettings(null, null)

        expect(result.formatting).not.toBe(DEFAULT_SETTINGS.formatting)
    })

    it('defaults theme to light when neither layer sets it', () => {
        expect(resolveSettings(null, null).theme).toBe('light')
    })

    it('takes a global-only theme', () => {
        expect(resolveSettings({ version: 1, theme: 'dark' }, null).theme).toBe('dark')
    })

    it('lets the workspace theme win over the global one', () => {
        expect(resolveSettings({ version: 1, theme: 'dark' }, { version: 1, theme: 'light' }).theme).toBe('light')
    })

    it('inherits the global theme through a bare workspace override', () => {
        expect(resolveSettings({ version: 1, theme: 'dark' }, { version: 1 }).theme).toBe('dark')
    })
})

describe('withTheme', () => {
    it('creates a fresh document when text is null', () => {
        expect(JSON.parse(withTheme(null, 'dark'))).toEqual({ version: 1, theme: 'dark' })
    })

    it('creates a fresh document when text is not JSON', () => {
        expect(JSON.parse(withTheme('not json', 'dark'))).toEqual({ version: 1, theme: 'dark' })
    })

    it('creates a fresh document when the top level is an array', () => {
        expect(JSON.parse(withTheme('[]', 'dark'))).toEqual({ version: 1, theme: 'dark' })
    })

    it('keeps sibling fields untouched', () => {
        expect(JSON.parse(withTheme('{"version":1,"formatOnSave":false}', 'dark'))).toEqual({
            version: 1,
            formatOnSave: false,
            theme: 'dark',
        })
    })

    it('replaces an existing theme rather than duplicating it', () => {
        expect(JSON.parse(withTheme('{"version":1,"theme":"dark"}', 'light'))).toEqual({
            version: 1,
            theme: 'light',
        })
    })

    it('keeps a field parseSettingsOverride would drop, since it merges onto the raw document', () => {
        expect(JSON.parse(withTheme('{"version":1,"madeUpField":7}', 'dark'))).toEqual({
            version: 1,
            madeUpField: 7,
            theme: 'dark',
        })
    })

    it('normalises a document carrying some other version to version 1', () => {
        expect(JSON.parse(withTheme('{"version":2,"formatOnSave":false}', 'dark'))).toEqual({
            version: 1,
            formatOnSave: false,
            theme: 'dark',
        })
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
