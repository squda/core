import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { BrowserPool } from '../fetching/pool.js';
import type { ScrapeCache } from './cache.js';
import { authenticate, type Caller } from './auth.js';
import type { SupabaseClient } from './supabase.js';
import { z } from 'zod';
import { BlockedAddressError, FetchError, HttpStatusError } from '../core/errors.js';
import { Logger } from '../support/log.js';
import { JobQueue, QueueFullError, type JobError } from './queue.js';
import { scrape as defaultScrape } from '../core/scrape.js';
import { normaliseUrl } from '../core/url.js';
import { InvalidUrlError } from '../core/errors.js';
import type { ScrapedDocument } from '../core/types.js';

/**
 * Phase 3 — the scraper over HTTP: routing and translation, nothing else.
 *
 * Building the app is separate from running one. Everything here takes its
 * cache, browser pool and logger as arguments, so a test constructs an app
 * with none of them and `src/server.ts` constructs the real one.
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

/** What a request carries beyond its body: the logger stamped with its id. */
type AppEnv = { Variables: { log: Logger; caller?: Caller } };

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
  /** Jobs allowed to wait. Beyond this the service answers 429 rather than growing. */
  maxQueued?: number;
  /** Where structured logs go. Silent by default so tests don't shout. */
  logger?: Logger;
  /**
   * Verify Supabase tokens on the scrape endpoints. Without a client there is
   * no auth at all — which is the right default for a local CLI-shaped run,
   * and the wrong one for anything reachable, so server.ts insists on it.
   */
  supabase?: SupabaseClient;
  requireAuth?: boolean;
}

export function createApp({
  scrape = defaultScrape,
  cache = null,
  pool,
  jobConcurrency = 4,
  maxQueued = 100,
  logger = new Logger({}, { write: () => {} }),
  supabase,
  requireAuth = false,
}: AppOptions = {}): Hono<AppEnv> {
  /** The one path to a document. Both endpoints go through it. */
  async function scrapeOnce(
    url: string,
    browser: string,
    log: Logger,
    signal?: AbortSignal,
  ): Promise<{ document: ScrapedDocument; cached: boolean }> {
    const cached = (await cache?.get(url, browser)) ?? null;
    if (cached) {
      log.info('cache hit', { url, browser });
      return { document: cached, cached: true };
    }

    const document = await scrape(url, {
      browser: browser as ScrapeRequest['browser'],
      ...(pool ? { pool } : {}),
      ...(signal ? { signal } : {}),
      // scrape()'s own narration, stamped with this request's id.
      log: (message) => log.debug(message, { url }),
    });
    await cache?.set(url, browser, document);
    log.info('scraped', {
      url,
      browser,
      fetchedWith: document.fetchedWith,
      markdown: document.markdown.length,
      ...(document.wall ? { wall: document.wall.kind } : {}),
    });
    return { document, cached: false };
  }

  const queue = new JobQueue(
    async (url, browser, signal) =>
      (await scrapeOnce(url, browser, logger.child({ job: true }), signal)).document,
    {
      concurrency: jobConcurrency,
      maxQueued,
      describeError,
      // Deduplicate on the same identity the cache uses, so the utm variants of
      // one page are one job rather than five.
      keyOf: (url, browser) => `${browser}\n${normaliseUrl(url)}`,
    },
  );

  const app = new Hono<AppEnv>();

  /**
   * Every request gets an id and a timing line.
   *
   * The id is taken from `x-request-id` when a proxy already assigned one, so a
   * trace survives the hop, and echoed back so a caller can quote it in a bug
   * report.
   */
  app.use('*', async (context, next) => {
    const requestId = context.req.header('x-request-id') ?? randomUUID();
    const log = logger.child({ requestId, method: context.req.method, path: context.req.path });

    context.set('log', log);
    context.header('x-request-id', requestId);

    const started = Date.now();
    await next();
    log.info('request', {
      status: context.res.status,
      ms: Date.now() - started,
      ...(context.get('caller') ? { callerId: context.get('caller')?.id } : {}),
    });
  });

  // Auth guards the endpoints that cost something. /health stays open: a load
  // balancer has no token, and the answer reveals nothing.
  if (supabase) {
    const guard = authenticate({
      client: supabase,
      required: requireAuth,
      onError: (error) => logger.error('auth check failed', { error: String(error) }),
    });
    app.use('/scrape', guard);
    app.use('/jobs', guard);
    app.use('/jobs/*', guard);
  }

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
      const { document, cached } = await scrapeOnce(url, browser, log(context));
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

    try {
      // Validated here rather than inside the job: making someone poll to
      // discover they typed the url wrong is a bad way to say 400.
      normaliseUrl(url);
      const job = queue.add(url, browser);
      log(context).info('job accepted', { jobId: job.id, url, browser });
      context.header('location', `/jobs/${job.id}`);
      return context.json(job, 202);
    } catch (error) {
      if (error instanceof QueueFullError) {
        context.header('retry-after', '30');
        return context.json({ error: { code: 'queue-full', message: error.message } }, 503);
      }
      return respondToFailure(context, error);
    }
  });

  app.get('/jobs/:id', (context) => {
    const id = context.req.param('id');
    const job = queue.get(id);
    if (job) return context.json(job);

    // Gone is not the same as never existed, and a caller polling a job we
    // retired deserves to be told which one happened.
    if (queue.wasRetired(id)) {
      return context.json(
        { error: { code: 'job-expired', message: 'this job finished and has since been retired' } },
        410,
      );
    }

    return context.json({ error: { code: 'no-such-job', message: 'unknown job id' } }, 404);
  });

  return app;
}

type ParsedRequest = { data: ScrapeRequest } | { response: Response };

/** Reads and validates a scrape request, or hands back the 400 to return. */
async function readRequest(context: Context<AppEnv>): Promise<ParsedRequest> {
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
  if (error instanceof BlockedAddressError) {
    return { code: 'blocked-address', message: error.message };
  }
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
  // The caller asked for something they may not have. Not a network failure.
  if (error instanceof BlockedAddressError) return 400;
  if (error instanceof InvalidUrlError) return 400;
  if (error instanceof FetchError) return STATUS_BY_FETCH_KIND[error.kind];
  return 500;
}

/** The per-request logger, or a silent one outside a request. */
function log(context: Context<AppEnv>): Logger {
  return context.get('log') ?? new Logger({}, { write: () => {} });
}

function respondToFailure(context: Context<AppEnv>, error: unknown): Response {
  const described = describeError(error);
  const expected =
    error instanceof FetchError ||
    error instanceof InvalidUrlError ||
    error instanceof BlockedAddressError;

  // Never leak a stack trace to a caller — it goes to the log instead, where
  // the request id makes it findable.
  // `reason`, not `message` — a field called message would overwrite the log
  // line's own, which is how "request failed" silently became "got 403".
  const fields = { code: described.code, reason: described.message };

  if (expected) {
    log(context).warn('request failed', fields);
  } else {
    log(context).error('unexpected failure', {
      ...fields,
      stack: error instanceof Error ? error.stack : String(error),
    });
  }

  return context.json({ error: described }, statusFor(error));
}
