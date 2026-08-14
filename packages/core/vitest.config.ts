import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.browser.test.ts', 'node_modules/**'],
    environment: 'node',
    /**
     * The SSRF guard resolves hostnames, and DNS is network. The fast suite
     * stays hermetic by opting out here; the guard itself is tested directly
     * in ssrf.test.ts with an injected resolver and IP literals, which need no
     * lookup at all.
     */
    env: { SCRAPE_ALLOW_PRIVATE: '1' },
  },
});
