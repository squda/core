import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/support/config.js';

describe('loadConfig', () => {
  it('has usable defaults with an empty environment', () => {
    expect(loadConfig({})).toMatchObject({
      port: 3000,
      logLevel: 'info',
      browserConcurrency: 2,
      allowPrivate: false,
      requireAuth: false,
    });
  });

  it('reads numbers and booleans out of strings', () => {
    const config = loadConfig({
      PORT: '8080',
      BROWSER_CONCURRENCY: '5',
      SCRAPE_ALLOW_PRIVATE: '1',
    });

    expect(config).toMatchObject({ port: 8080, browserConcurrency: 5, allowPrivate: true });
  });

  // Refusing at boot is the point: a typo should not surface as `undefined`
  // in a fetch three layers down, on the first request that needed it.
  it.each([
    ['PORT', { PORT: 'http' }],
    ['LOG_LEVEL', { LOG_LEVEL: 'chatty' }],
    ['BROWSER_CONCURRENCY', { BROWSER_CONCURRENCY: '0' }],
  ])('refuses a bad %s', (_name, env) => {
    expect(() => loadConfig(env)).toThrow(/invalid configuration/);
  });

  // Empty is the safe default: a service with no browser client should not be
  // advertising itself to one.
  it('sends no CORS headers unless origins are named', () => {
    expect(loadConfig({}).corsOrigins).toEqual([]);
    expect(loadConfig({ CORS_ORIGINS: '  ' }).corsOrigins).toEqual([]);
  });

  it('reads a comma-separated origin list, ignoring the spaces around it', () => {
    expect(
      loadConfig({ CORS_ORIGINS: 'http://localhost:5173, https://app.test' }).corsOrigins,
    ).toEqual(['http://localhost:5173', 'https://app.test']);
  });

  it('refuses half-configured supabase', () => {
    expect(() => loadConfig({ SUPABASE_URL: 'https://x.supabase.co' })).toThrow(
      /invalid configuration/,
    );
  });

  // Auth on by default once Supabase exists: a service that can be called
  // anonymously by accident is worse than one that refuses until you fix a header.
  it('requires auth by default when supabase is configured', () => {
    const config = loadConfig({
      SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(40),
    });

    expect(config.requireAuth).toBe(true);
  });

  it('lets that be turned off deliberately', () => {
    const config = loadConfig({
      SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(40),
      REQUIRE_AUTH: '0',
    });

    expect(config.requireAuth).toBe(false);
  });
});
