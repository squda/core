import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serve } from '@hono/node-server';
import { BrowserPool } from './fetching/pool.js';
import { SqliteCache } from './service/cache.js';
import { createApp } from './service/app.js';
import { Logger } from './support/log.js';

/**
 * The service, wired up and listening.
 *
 * Everything the app needs is built here and handed in — which is what keeps
 * `service/app.ts` free of processes, files and ports, and testable without
 * any of them.
 */

const port = Number(process.env.PORT ?? 3000);
const cachePath = process.env.CACHE_PATH ?? '.cache/scrape.db';
mkdirSync(dirname(cachePath), { recursive: true });

// A service keeps the browser warm between requests; the cap is what stops a
// burst of SPA urls from becoming a burst of Chromiums.
const pool = new BrowserPool({
  maxConcurrent: Number(process.env.BROWSER_CONCURRENCY ?? 2),
  idleMs: 30_000,
});

const logger = new Logger({ service: 'scrape' });
const cache = new SqliteCache(cachePath);

serve({ fetch: createApp({ cache, pool, logger }).fetch, port });
logger.info('listening', { port, cachePath });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info('shutting down', { signal });
    void pool.close().then(() => {
      cache.close();
      process.exit(0);
    });
  });
}
