import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts so tests do not drag in the SvelteKit plugin:
// the unit tests only cover plain TypeScript modules.
export default defineConfig({
    test: {
        include: ['src/**/*.test.ts']
    }
});
