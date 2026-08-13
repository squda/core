import { defineConfig } from 'vitest/config';

/**
 * The browser suite: a real Chromium against a real local server. Slower than
 * the rest, so it is kept out of `pnpm test` and run with `pnpm test:browser`.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.browser.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
