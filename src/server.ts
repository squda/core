import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { BrowserPool } from './browser-pool.js';
import { SqliteCache, type ScrapeCache } from './cache.js';
import { FetchError, HttpStatusError } from './fetch.js';
import { scrape as defaultScrape } from './scrape.js';
import { InvalidUrlError } from './url.js';

/**
 * Phase 3, step 1 — the scraper over HTTP.
 *
 * The second adapter onto the same core. cli.ts reads argv and prints; this
 * reads a request body and responds. Neither contains scraping logic, and the
 * proof of that is `scrape()` being imported unchanged — if serving HTTP had
 * required editing it, the layering was wrong.
 *
 * Note how much this file duplicates cli.ts in *shape* and none of it in
 * substance: both translate one error taxonomy into their own vocabulary.
 * The CLI's vocabulary is exit codes; this one's is status codes.
 */

export const ScrapeRequestSchema = z.object({
  url: z.string().min(1, 'url is required'),
  browser: z.enum(['auto', 'never', 'always']).default('auto'),
});

export type ScrapeRequest = z.infer<typeof ScrapeRequestSchema>;

/**
 * The same decision as EXIT_BY_FETCH_KIND in cli.ts, expressed in HTTP.
 *
 * All of these are 5xx except the ones that are our caller's fault: a page we
 * can't reach is not a bad request, and answering 404 because the *upstream*
 * 404'd would claim our endpoint doesn't exist.
 */
const STATUS_BY_FETCH_KIND = {
  timeout: 504,
  network: 502,
  'http-status': 502,
  'content-type': 415,
} as const;

export interface AppOptions {
  /** Injectable for tests, so the server can be exercised without a network. */
  scrape?: typeof defaultScrape;
  /**
   * Pass `null` for no caching at all.
   *
   * The cache lives here rather than inside scrape(): the core stays a
   * function of its input, and a second adapter gets to choose its own policy.
   * A CLI run wants the live page; a service answering the same URL a hundred
   * times does not.
   */
  cache?: ScrapeCache | null;
  /**
   * The browser pool every request shares. Without one, ten simultaneous SPA
   * requests would be ten Chromiums.
   */
  pool?: BrowserPool;
}

export function createApp({ scrape = defaultScrape, cache = null, pool }: AppOptions = {}): Hono {
  const app = new Hono();

  app.get('/health', (context) => context.json({ ok: true, browser: pool?.stats() ?? null }));

  app.post('/scrape', async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(
        { error: { code: 'invalid-body', message: 'expected a JSON body' } },
        400,
      );
    }

    // Parse, don't validate — the same boundary discipline as the Zod schema
    // at the end of the pipeline, applied at the start of this one.
    const parsed = ScrapeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        {
          error: {
            code: 'invalid-request',
            message: 'the request body is not a valid scrape request',
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        },
        400,
      );
    }

    const { url, browser } = parsed.data;

    try {
      // A cache lookup can throw on a url the normaliser rejects, so it sits
      // inside the same try as the scrape and reports the same way.
      const cached = cache?.get(url, browser) ?? null;
      if (cached) {
        context.header('x-cache', 'hit');
        return context.json(cached);
      }

      const document = await scrape(url, pool ? { browser, pool } : { browser });
      cache?.set(url, browser, document);
      context.header('x-cache', 'miss');
      return context.json(document);
    } catch (error) {
      return respondToFailure(context, error);
    }
  });

  return app;
}

function respondToFailure(context: Context, error: unknown): Response {
  if (error instanceof InvalidUrlError) {
    return context.json(
      { error: { code: 'invalid-url', message: error.message, url: error.input } },
      400,
    );
  }

  if (error instanceof FetchError) {
    return context.json(
      {
        error: {
          code: error.kind,
          message: error.message,
          ...(error instanceof HttpStatusError ? { upstreamStatus: error.status } : {}),
        },
      },
      STATUS_BY_FETCH_KIND[error.kind],
    );
  }

  // Never leak a stack trace to a caller. It goes to the log instead.
  console.error('unexpected failure', error);
  return context.json({ error: { code: 'internal', message: 'something went wrong' } }, 500);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  const port = Number(process.env.PORT ?? 3000);
  const cachePath = process.env.CACHE_PATH ?? '.cache/scrape.db';
  mkdirSync(dirname(cachePath), { recursive: true });

  // A service keeps the browser warm between requests; the cap is what stops
  // a burst of SPA urls from becoming a burst of Chromiums.
  const pool = new BrowserPool({
    maxConcurrent: Number(process.env.BROWSER_CONCURRENCY ?? 2),
    idleMs: 30_000,
  });

  const app = createApp({ cache: new SqliteCache(cachePath), pool });
  serve({ fetch: app.fetch, port });
  console.log(`scrape service listening on http://localhost:${port} (cache: ${cachePath})`);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void pool.close().then(() => process.exit(0));
    });
  }
}
