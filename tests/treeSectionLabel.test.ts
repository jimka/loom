import { describe, it, expect } from 'vitest'
import { treeSectionLabel, FILES_SECTION_FALLBACK_LABEL } from '../src/shell/treeSectionLabel'

describe('treeSectionLabel', () => {
    it('shows the fallback label when no project is open', () => {
        expect(treeSectionLabel(null)).toBe(FILES_SECTION_FALLBACK_LABEL)
    })

    it('shows the open project\'s display name', () => {
        expect(treeSectionLabel('/home/jika/typescript/loom')).toBe('loom')
    })
})
