import { defineConfig } from 'vitest/config'

// Unit tests cover the pure data helpers (paths, language resolution). They
// need no DOM, so the default node environment is used; component/DOM
// behaviour is verified live, not here.
export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
    },
})
