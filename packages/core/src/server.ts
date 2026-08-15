import { serve } from '@hono/node-server';
import { assertSupportedNode } from './support/runtime.js';
import { BrowserPool } from './fetching/pool.js';
import { MemoryCache } from './service/cache.js';
import { createApp } from './service/app.js';
import { Logger } from './support/log.js';
import { loadConfig } from './support/config.js';
import { createServiceClient } from './service/supabase.js';
import { SupabaseCache } from './service/supabase-cache.js';
import { SupabaseJobStore } from './service/supabase-job-store.js';
import type { JobStore } from './service/job-store.js';
import type { ScrapeCache } from './service/cache.js';

/**
 * The service, wired up and listening.
 *
 * Everything the app needs is built here and handed in — which is what keeps
 * `service/app.ts` free of processes, files and ports, and testable without
 * any of them.
 */

// Before anything imports supabase-js, which fails obscurely on Node 20.
assertSupportedNode();

const config = loadConfig();
const logger = new Logger({ service: 'scrape' }, { level: config.logLevel });

// A service keeps the browser warm between requests; the cap is what stops a
// burst of SPA urls from becoming a burst of Chromiums.
const pool = new BrowserPool({
  maxConcurrent: config.browserConcurrency,
  idleMs: 30_000,
  launchArgs: config.chromiumArgs,
});

/**
 * Survive a browser that dies badly.
 *
 * Playwright reports some failures from a CDP callback rather than from the
 * call you made, so they arrive as uncaught exceptions that no `try` around
 * `fetch()` can see:
 *
 *     Error: Assertion error
 *       at _CRSession._onMessage (playwright-core/lib/coreBundle.js:34801)
 *       at Immediate.<anonymous>
 *
 * The default response to that is to exit, and for most services it should be.
 * Here it means one bad page takes down every other request in flight and the
 * next visitor pays a cold start — on Lambda, fifteen seconds of one — because
 * a stranger's site crashed a renderer. The browser is the only component that
 * throws this way, and the recovery for it is known: throw the browser away.
 * The next request launches a fresh one.
 *
 * Deliberately not a general catch-all. It logs at error with the stack, so a
 * real bug hiding here is visible in the logs rather than silently swallowed.
 */
process.on('uncaughtException', (error) => {
  logger.error('uncaught exception — discarding the browser and staying up', {
    error: error.message,
    stack: error.stack,
  });
  void pool.close().catch(() => {});
});

const supabase = config.supabase
  ? createServiceClient(config.supabase.url, config.supabase.serviceRoleKey)
  : undefined;

// Postgres when Supabase is configured, a local file when it isn't — same
// interface either way, so nothing downstream knows which one it got.
let cache: ScrapeCache;
let jobStore: JobStore | undefined;
if (supabase) {
  cache = new SupabaseCache(supabase, {
    onError: (error) => logger.error('cache unavailable', { error: String(error) }),
  });
  // Jobs outlive the process here: a restart mid-scrape leaves a readable
  // record rather than an id that 404s.
  jobStore = new SupabaseJobStore(supabase, {
    onError: (error) => logger.error('job store failed', { error: String(error) }),
  });
} else {
  cache = new MemoryCache();
}

serve({
  fetch: createApp({
    cache,
    pool,
    logger,
    ...(supabase ? { supabase } : {}),
    ...(jobStore ? { jobStore } : {}),
    requireAuth: config.requireAuth ?? false,
    jobConcurrency: config.jobConcurrency,
    maxQueued: config.maxQueued,
    corsOrigins: config.corsOrigins,
    demoRateLimit: config.demoRateLimit,
    demoWindowMs: config.demoWindowMs,
  }).fetch,
  port: config.port,
});

logger.info('listening', {
  port: config.port,
  store: supabase ? 'supabase' : 'memory (nothing survives a restart)',
  auth: config.requireAuth ? 'required' : 'off',
  cors: config.corsOrigins.length > 0 ? config.corsOrigins.join(', ') : 'off',
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info('shutting down', { signal });
    void Promise.all([pool.close(), cache.close()]).then(() => process.exit(0));
  });
}
