import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { BrowserPool } from './browser-pool.js';
import { SqliteCache, type ScrapeCache } from './cache.js';
import { FetchError, HttpStatusError } from './errors.js';
import { JobQueue, type JobError } from './queue.js';
import { scrape as defaultScrape } from './scrape.js';
import { InvalidUrlError } from './errors.js';
import type { ScrapedDocument } from './types.js';

/**
 * Phase 3 — the scraper over HTTP.
 *
 * The second adapter onto the same core. cli.ts reads argv and prints; this
 * reads a request body and responds. Neither contains scraping logic, and the
 * proof is `scrape()` being imported unchanged.
 *
 * Two ways in, because the work has two shapes:
 *
 *   POST /scrape   answer now.    Right for cached pages and static ones.
 *   POST /jobs     answer later.  Right for anything that needs a browser.
 *
 * The plan folds these together — "POST /scrape returns a job id immediately".
 * They are split here because a cache hit answers in 2ms, and making that
 * caller poll for a job they could have had inline is a worse API than having
 * two endpoints. Both share one path underneath, so neither can drift.
 */

export const ScrapeRequestSchema = z.object({
  url: z.string().min(1, 'url is required'),
  browser: z.enum(['auto', 'never', 'always']).default('auto'),
});

export type ScrapeRequest = z.infer<typeof ScrapeRequestSchema>;

/**
 * The same decision as EXIT_BY_FETCH_KIND in cli.ts, expressed in HTTP.
 *
 * All 5xx except the ones that are our caller's fault: a page we can't reach
 * is not a bad request, and answering 404 because the *upstream* 404'd would
 * claim our endpoint doesn't exist.
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
   */
  cache?: ScrapeCache | null;
  /**
   * The browser pool every request shares. Without one, ten simultaneous SPA
   * requests would be ten Chromiums.
   */
  pool?: BrowserPool;
  /** Jobs run at once. Distinct from the browser cap, which is stricter. */
  jobConcurrency?: number;
}

export function createApp({
  scrape = defaultScrape,
  cache = null,
  pool,
  jobConcurrency = 4,
}: AppOptions = {}): Hono {
  /** The one path to a document. Both endpoints go through it. */
  async function scrapeOnce(
    url: string,
    browser: string,
  ): Promise<{ document: ScrapedDocument; cached: boolean }> {
    const cached = cache?.get(url, browser) ?? null;
    if (cached) return { document: cached, cached: true };

    const options = { browser: browser as ScrapeRequest['browser'] };
    const document = await scrape(url, pool ? { ...options, pool } : options);
    cache?.set(url, browser, document);
    return { document, cached: false };
  }

  const queue = new JobQueue(async (url, browser) => (await scrapeOnce(url, browser)).document, {
    concurrency: jobConcurrency,
    describeError,
  });

  const app = new Hono();

  app.get('/health', (context) =>
    context.json({ ok: true, browser: pool?.stats() ?? null, jobs: queue.stats() }),
  );

  app.post('/scrape', async (context) => {
    const request = await readRequest(context);
    if ('response' in request) return request.response;

    const { url, browser } = request.data;
    try {
      // A cache lookup can throw on a url the normaliser rejects, so it sits
      // inside the same try as the scrape and reports the same way.
      const { document, cached } = await scrapeOnce(url, browser);
      context.header('x-cache', cached ? 'hit' : 'miss');
      return context.json(document);
    } catch (error) {
      return respondToFailure(context, error);
    }
  });

  app.post('/jobs', async (context) => {
    const request = await readRequest(context);
    if ('response' in request) return request.response;

    const { url, browser } = request.data;
    const job = queue.add(url, browser);

    context.header('location', `/jobs/${job.id}`);
    return context.json(job, 202);
  });

  app.get('/jobs/:id', (context) => {
    const job = queue.get(context.req.param('id'));
    if (!job) {
      return context.json({ error: { code: 'no-such-job', message: 'unknown job id' } }, 404);
    }
    return context.json(job);
  });

  return app;
}

type ParsedRequest = { data: ScrapeRequest } | { response: Response };

/** Reads and validates a scrape request, or hands back the 400 to return. */
async function readRequest(context: Context): Promise<ParsedRequest> {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return {
      response: context.json(
        { error: { code: 'invalid-body', message: 'expected a JSON body' } },
        400,
      ),
    };
  }

  // Parse, don't validate — the same boundary discipline as the Zod schema at
  // the end of the pipeline, applied at the start of this one.
  const parsed = ScrapeRequestSchema.safeParse(body);
  if (parsed.success) return { data: parsed.data };

  return {
    response: context.json(
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
    ),
  };
}

/**
 * One description of a failure, used by both the synchronous response and the
 * job record — so `GET /jobs/:id` explains a timeout exactly as `POST /scrape`
 * would have.
 */
export function describeError(error: unknown): JobError & { upstreamStatus?: number } {
  if (error instanceof InvalidUrlError) {
    return { code: 'invalid-url', message: error.message };
  }
  if (error instanceof FetchError) {
    return {
      code: error.kind,
      message: error.message,
      ...(error instanceof HttpStatusError ? { upstreamStatus: error.status } : {}),
    };
  }
  return { code: 'internal', message: 'something went wrong' };
}

function statusFor(error: unknown): 400 | 415 | 500 | 502 | 504 {
  if (error instanceof InvalidUrlError) return 400;
  if (error instanceof FetchError) return STATUS_BY_FETCH_KIND[error.kind];
  return 500;
}

function respondToFailure(context: Context, error: unknown): Response {
  // Never leak a stack trace to a caller. It goes to the log instead.
  if (!(error instanceof FetchError) && !(error instanceof InvalidUrlError)) {
    console.error('unexpected failure', error);
  }
  return context.json({ error: describeError(error) }, statusFor(error));
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
