import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { BrowserPool } from '../src/fetching/pool.js';
import { startTestServer, type TestServer } from './test-server.js';

/** Real Chromium, real local server. Run with `pnpm test:browser`. */

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

describe('the cap', () => {
  // The bug this step exists to fix: ten requests must not be ten browsers.
  it('serves ten concurrent fetches from one browser', async () => {
    const launch = vi.spyOn(chromium, 'launch');
    const pool = new BrowserPool({ maxConcurrent: 2, idleMs: 5_000 });

    try {
      const documents = await Promise.all(
        Array.from({ length: 10 }, () => pool.fetch(`${server.origin}/`)),
      );

      expect(documents).toHaveLength(10);
      expect(documents.every((document) => document.status === 200)).toBe(true);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(pool.stats().launches).toBe(1);
    } finally {
      await pool.close();
      launch.mockRestore();
    }
  });

  it('holds concurrency at the cap while work is queued', async () => {
    const pool = new BrowserPool({ maxConcurrent: 2, idleMs: 5_000 });

    try {
      const inFlight = Array.from({ length: 6 }, () => pool.fetch(`${server.origin}/`));
      await Promise.resolve();

      expect(pool.stats().active).toBeLessThanOrEqual(2);
      expect(pool.stats().queued).toBeGreaterThan(0);

      await Promise.all(inFlight);
      expect(pool.stats().active).toBe(0);
    } finally {
      await pool.close();
    }
  });

  it('shares one launch between fetches that arrive together', async () => {
    const launch = vi.spyOn(chromium, 'launch');
    const pool = new BrowserPool({ maxConcurrent: 4, idleMs: 5_000 });

    try {
      await Promise.all([pool.fetch(`${server.origin}/`), pool.fetch(`${server.origin}/spa`)]);

      expect(launch).toHaveBeenCalledTimes(1);
    } finally {
      await pool.close();
      launch.mockRestore();
    }
  });
});

describe('lifetime', () => {
  it('keeps the browser warm between fetches when idleMs allows', async () => {
    const launch = vi.spyOn(chromium, 'launch');
    const pool = new BrowserPool({ idleMs: 5_000 });

    try {
      await pool.fetch(`${server.origin}/`);
      expect(pool.stats().open).toBe(true);

      await pool.fetch(`${server.origin}/`);
      expect(launch).toHaveBeenCalledTimes(1);
    } finally {
      await pool.close();
      launch.mockRestore();
    }
  });

  // The CLI's shape: an open browser holds handles, and the process would
  // never exit. Closing on idle is what lets `pnpm scrape` return.
  it('closes as soon as it goes idle when idleMs is zero', async () => {
    const pool = new BrowserPool({ idleMs: 0 });

    await pool.fetch(`${server.origin}/`);
    await vi.waitFor(() => expect(pool.stats().open).toBe(false));
  });

  it('relaunches after closing', async () => {
    const pool = new BrowserPool({ idleMs: 0 });

    await pool.fetch(`${server.origin}/`);
    await vi.waitFor(() => expect(pool.stats().open).toBe(false));

    await expect(pool.fetch(`${server.origin}/`)).resolves.toMatchObject({ status: 200 });
    expect(pool.stats().launches).toBe(2);
    await pool.close();
  });

  it('can be closed twice', async () => {
    const pool = new BrowserPool({ idleMs: 5_000 });
    await pool.fetch(`${server.origin}/`);

    await pool.close();
    await expect(pool.close()).resolves.toBeUndefined();
  });

  // A failed fetch must return its slot, or the pool deadlocks after `max`
  // failures — under load only, which is the worst way to discover it.
  it('frees its slot when a fetch fails', async () => {
    const pool = new BrowserPool({ maxConcurrent: 1, idleMs: 5_000 });

    try {
      await expect(pool.fetch(`${server.origin}/missing`)).rejects.toThrow();
      expect(pool.stats().active).toBe(0);

      await expect(pool.fetch(`${server.origin}/`)).resolves.toMatchObject({ status: 200 });
    } finally {
      await pool.close();
    }
  });
});
