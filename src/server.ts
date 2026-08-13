import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serve } from '@hono/node-server';
import { BrowserPool } from './fetching/pool.js';
import { SqliteCache } from './service/cache.js';
import { createApp } from './service/app.js';
import { Logger } from './support/log.js';
import { loadConfig } from './support/config.js';
import { createServiceClient } from './service/supabase.js';
import { SupabaseCache } from './service/supabase-cache.js';
import type { ScrapeCache } from './service/cache.js';

/**
 * The service, wired up and listening.
 *
 * Everything the app needs is built here and handed in — which is what keeps
 * `service/app.ts` free of processes, files and ports, and testable without
 * any of them.
 */

const config = loadConfig();
const logger = new Logger({ service: 'scrape' }, { level: config.logLevel });

// A service keeps the browser warm between requests; the cap is what stops a
// burst of SPA urls from becoming a burst of Chromiums.
const pool = new BrowserPool({ maxConcurrent: config.browserConcurrency, idleMs: 30_000 });

const supabase = config.supabase
  ? createServiceClient(config.supabase.url, config.supabase.serviceRoleKey)
  : undefined;

// Postgres when Supabase is configured, a local file when it isn't — same
// interface either way, so nothing downstream knows which one it got.
let cache: ScrapeCache;
if (supabase) {
  cache = new SupabaseCache(supabase, {
    onError: (error) => logger.error('cache unavailable', { error: String(error) }),
  });
} else {
  const cachePath = process.env.CACHE_PATH ?? '.cache/scrape.db';
  mkdirSync(dirname(cachePath), { recursive: true });
  cache = new SqliteCache(cachePath);
}

serve({
  fetch: createApp({
    cache,
    pool,
    logger,
    ...(supabase ? { supabase } : {}),
    requireAuth: config.requireAuth ?? false,
    jobConcurrency: config.jobConcurrency,
    maxQueued: config.maxQueued,
  }).fetch,
  port: config.port,
});

logger.info('listening', {
  port: config.port,
  store: supabase ? 'supabase' : 'sqlite',
  auth: config.requireAuth ? 'required' : 'off',
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info('shutting down', { signal });
    void Promise.all([pool.close(), cache.close()]).then(() => process.exit(0));
  });
}
