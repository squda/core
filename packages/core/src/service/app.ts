import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { BrowserPool } from '../fetching/pool.js';
import type { ScrapeCache } from './cache.js';
import { authenticate, type Caller } from './auth.js';
import type { SupabaseClient } from './supabase.js';
import type { JobStore } from './job-store.js';
import { z } from 'zod';
import { BlockedAddressError, FetchError, HttpStatusError } from '../core/errors.js';
import { Logger } from '../support/log.js';
import { JobQueue, QueueFullError, type JobError } from './queue.js';
import { scrape as defaultScrape, scrapeHtml } from '../core/scrape.js';
import { normaliseUrl } from '../core/url.js';
import { extractForms } from '../core/forms.js';
import { InvalidUrlError } from '../core/errors.js';
import type { ScrapedDocument } from '../core/types.js';
import { RateLimiter } from '../support/rate-limit.js';

/**
 * How much Markdown the open demo endpoint will hand back.
 *
 * A Wikipedia article is 50,000 characters. Nobody reads that in a preview
 * pane, and serving it to an unauthenticated caller on repeat is the cost this
 * endpoint exists to bound.
 */
const DEMO_MARKDOWN_LIMIT = 20_000;

/**
 * Who is asking, for rate-limiting purposes.
 *
 * `x-forwarded-for` is trusted here because this runs behind a proxy that sets
 * it. Directly exposed it is a header a caller writes themselves, and the limit
 * becomes advisory — which is the trade every IP-based limiter makes, and the
 * reason `callerKey` is an option rather than a constant.
 *
 * Everyone we cannot identify shares the `unknown` bucket. That is deliberately
 * strict: an unidentifiable flood is the one most worth slowing down.
 */
function defaultCallerKey(context: Context): string {
  const forwarded = context.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown';
  return context.req.header('x-real-ip') ?? 'unknown';
}

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
  /**
   * How long one fetch may take on the authenticated endpoints. 30s default.
   *
   * Whatever enforces a limit above this — a proxy, a load balancer, a client —
   * needs roughly fifteen seconds more than this number, because an `auto`
   * scrape can spend it twice (HTTP, then browser) and still has consent and
   * expansion to do afterwards.
   */
  fetchTimeoutMs?: number;
  /** The same for `/demo`, shorter: a visitor is watching. 20s default. */
  demoTimeoutMs?: number;
  /** Jobs run at once. Distinct from the browser cap, which is stricter. */
  jobConcurrency?: number;
  /** Jobs allowed to wait. Beyond this the service answers 429 rather than growing. */
  maxQueued?: number;
  /** Where jobs live. Memory by default; Postgres to survive a restart. */
  jobStore?: JobStore;
  /** Where structured logs go. Silent by default so tests don't shout. */
  logger?: Logger;
  /**
   * Verify Supabase tokens on the scrape endpoints. Without a client there is
   * no auth at all — which is the right default for a local CLI-shaped run,
   * and the wrong one for anything reachable, so server.ts insists on it.
   */
  supabase?: SupabaseClient;
  requireAuth?: boolean;
  /**
   * Browser origins allowed to call this service.
   *
   * Empty by default, which sends no CORS headers at all — a browser then
   * refuses the request, and every non-browser caller (curl, the CLI, a server)
   * is unaffected, because CORS is a rule browsers apply to themselves.
   *
   * `apps/web` is the reason this exists. It is an explicit list rather than
   * `*` because the moment auth is required, a wildcard origin with credentials
   * is the mistake that hands any page on the internet a logged-in caller's
   * token.
   */
  corsOrigins?: string[];
  /**
   * Reads allowed per caller per window on the open `/demo` endpoint.
   *
   * Low on purpose. A visitor trying four example pages and one of their own
   * is the behaviour being paid for; anything past that is someone using the
   * waitlist page as an API.
   */
  demoRateLimit?: number;
  demoWindowMs?: number;
  /**
   * How a caller is identified for that limit. Defaults to the client address,
   * read from `x-forwarded-for` when a proxy set one.
   *
   * Injectable because in a test there is no socket, and because whoever
   * deploys this knows which header their proxy is honest about.
   */
  callerKey?: (context: Context) => string;
}

export function createApp({
  scrape = defaultScrape,
  cache = null,
  pool,
  fetchTimeoutMs = 30_000,
  demoTimeoutMs = 20_000,
  jobConcurrency = 4,
  maxQueued = 100,
  jobStore,
  logger = new Logger({}, { write: () => {} }),
  supabase,
  requireAuth = false,
  corsOrigins = [],
  demoRateLimit = 10,
  demoWindowMs = 10 * 60 * 1000,
  callerKey = defaultCallerKey,
}: AppOptions = {}): Hono<AppEnv> {
  const demoLimiter = new RateLimiter({ limit: demoRateLimit, windowMs: demoWindowMs });
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
      timeoutMs: fetchTimeoutMs,
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

  /**
   * A page as fetched, before extraction touches it.
   *
   * The form walker needs the original HTML — Readability keeps a <form> and
   * throws its controls away — so this cannot come from the document cache,
   * which stores Markdown.
   */
  async function fetchDocument(url: string, browser: string, timeoutMs: number) {
    const { HttpStrategy } = await import('../fetching/http.js');
    const normalised = normaliseUrl(url);

    /*
     * Through the pool, never `new BrowserStrategy()`.
     *
     * Two things go wrong when this path builds its own. It launches and kills
     * a Chromium per request, which is the exact cost the pool exists to
     * remove and which the concurrency cap then cannot bound. And it is
     * constructed with no options, so the launch flags a container needs —
     * `--no-sandbox` above all — never reach it, and the service works on a
     * laptop and refuses to start a browser in production.
     *
     * A pool is optional here because a test may not want one; falling back to
     * a one-off strategy keeps that working, and is the only case that should
     * ever construct one.
     */
    async function withBrowser() {
      if (pool) return pool.fetch(normalised, { timeoutMs });

      const { BrowserStrategy } = await import('../fetching/browser.js');
      const strategy = new BrowserStrategy();
      try {
        return await strategy.fetch(normalised, { timeoutMs });
      } finally {
        await strategy.close();
      }
    }

    if (browser === 'always') return withBrowser();

    const document = await new HttpStrategy().fetch(normalised, { timeoutMs });
    if (browser === 'never') return document;

    // Same rule the scraper uses: an empty shell means the page builds itself.
    const { judge } = await import('../core/select.js');
    const { scrapeHtml } = await import('../core/scrape.js');
    if (!judge(document, scrapeHtml(document)).needsBrowser) return document;

    return withBrowser();
  }

  /** Fetch once and read forms while the real page is still alive. */
  async function inspectFormPage(url: string, browser: string, timeoutMs: number) {
    if (browser === 'never') {
      const document = await fetchDocument(url, 'never', timeoutMs);
      return { document, spec: extractForms(document) };
    }

    const normalised = normaliseUrl(url);
    if (pool) return pool.inspectForms(normalised, { timeoutMs });

    const { BrowserStrategy } = await import('../fetching/browser.js');
    const strategy = new BrowserStrategy();
    try {
      return await strategy.inspectForms(normalised, { timeoutMs });
    } finally {
      await strategy.close();
    }
  }

  const queue = new JobQueue(
    async (url, browser, signal) =>
      (await scrapeOnce(url, browser, logger.child({ job: true }), signal)).document,
    {
      concurrency: jobConcurrency,
      maxQueued,
      describeError,
      ...(jobStore ? { store: jobStore } : {}),
      // Deduplicate on the same identity the cache uses, so the utm variants of
      // one page are one job rather than five.
      keyOf: (url, browser) => `${browser}\n${normaliseUrl(url)}`,
    },
  );

  const app = new Hono<AppEnv>();

  // Before anything else, so a rejected preflight still gets its headers.
  if (corsOrigins.length > 0) {
    app.use(
      '*',
      cors({
        origin: corsOrigins,
        allowHeaders: ['content-type', 'authorization', 'x-request-id'],
        exposeHeaders: ['x-cache', 'x-request-id'],
        credentials: true,
      }),
    );
  }

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

  /**
   * Auth guards every endpoint that costs something.
   *
   * `/form-spec` joined this list on 2026-08-15. It had been open because it
   * arrived in Phase 4 alongside a demo that needed it, but it walks the same
   * expensive path as `/scrape` — same fetch, same browser escalation — so
   * leaving it open left the whole service reachable through the cheaper door.
   *
   * `/health` stays open: a load balancer carries no token and the answer
   * reveals nothing. `/demo` stays open on purpose and pays for it with a rate
   * limit instead.
   */
  if (supabase) {
    const guard = authenticate({
      client: supabase,
      required: requireAuth,
      onError: (error) => logger.error('auth check failed', { error: String(error) }),
    });
    app.use('/scrape', guard);
    app.use('/form-spec', guard);
    app.use('/jobs', guard);
    app.use('/jobs/*', guard);
  }

  app.get('/health', async (context) =>
    context.json({ ok: true, browser: pool?.stats() ?? null, jobs: await queue.stats() }),
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

  /**
   * Phase 4, step 5 — the same page, read for structure instead of prose.
   *
   * It fetches through the same `scrape()` path so the browser escalation, the
   * SSRF guard and the concurrency cap all apply — then walks the raw HTML,
   * because extraction strips every <input> on the way to Markdown.
   *
   * Not cached: a FormSpec is cheap to produce once the page is in hand, and
   * the page itself is already cached one layer down.
   */
  app.get('/form-spec', async (context) => {
    const url = context.req.query('url');
    if (!url) {
      return context.json({ error: { code: 'invalid-request', message: 'url is required' } }, 400);
    }

    const browser = context.req.query('browser') ?? 'auto';
    if (browser !== 'auto' && browser !== 'never' && browser !== 'always') {
      return context.json(
        { error: { code: 'invalid-request', message: 'browser must be auto, never or always' } },
        400,
      );
    }

    try {
      const { spec } = await inspectFormPage(url, browser, fetchTimeoutMs);
      log(context).info('form spec', {
        url,
        forms: spec.forms.length,
        fields: spec.forms.reduce((total, form) => total + form.fields.length, 0),
      });
      return context.json(spec);
    } catch (error) {
      return respondToFailure(context, error);
    }
  });

  /**
   * The one open door — for the public waitlist page, and nothing else.
   *
   * Added 2026-08-15, when `/form-spec` was closed. The page has to work for a
   * visitor who has no account, and the two honest ways to allow that are to
   * hand the browser a token (which is then not a secret) or to open one narrow
   * path and cap it. This is the second.
   *
   * What makes it narrow rather than just "the same thing without auth":
   *
   *  - **One call, both halves.** The demo needs the text and the fields; two
   *    endpoints would mean two rate-limit units for one visitor action, and a
   *    page that half-works when the second one is refused.
   *  - **No `browser=always`.** Form-aware auto mode uses the browser because
   *    static HTML cannot expose iframe documents or shadow roots; callers can
   *    only opt down to the cheaper `never` mode, not add stronger behavior.
   *  - **Rate limited per caller**, which is the whole point.
   *  - **Markdown truncated.** A visitor is reading a preview, not exporting a
   *    corpus, and it caps what a single request can cost to serve.
   */
  app.get('/demo', async (context) => {
    const url = context.req.query('url');
    if (!url) {
      return context.json({ error: { code: 'invalid-request', message: 'url is required' } }, 400);
    }

    const browser = context.req.query('browser') ?? 'auto';
    if (browser !== 'auto' && browser !== 'never') {
      return context.json(
        {
          error: {
            code: 'invalid-request',
            message: 'browser must be auto or never on this endpoint',
          },
        },
        400,
      );
    }

    const decision = demoLimiter.check(callerKey(context));
    context.header('x-ratelimit-remaining', String(decision.remaining));
    if (!decision.allowed) {
      context.header('retry-after', String(decision.retryAfter));
      log(context).info('demo rate limited', { url, retryAfter: decision.retryAfter });
      return context.json(
        {
          error: {
            code: 'rate-limited',
            message: `That is enough for now — try another page in ${decision.retryAfter} seconds.`,
          },
        },
        429,
      );
    }

    try {
      // One browser visit, read twice. Live inspection must happen before the
      // page closes; its serialized document then feeds the prose pipeline.
      const { document, spec } = await inspectFormPage(url, browser, demoTimeoutMs);
      const scraped = scrapeHtml(document);

      log(context).info('demo', {
        url,
        fetchedWith: document.fetchedWith,
        forms: spec.forms.length,
        fields: spec.forms.reduce((total, form) => total + form.fields.length, 0),
      });

      return context.json({
        spec,
        text: {
          title: scraped.title,
          description: scraped.description,
          fetchedWith: scraped.fetchedWith,
          markdown: scraped.markdown.slice(0, DEMO_MARKDOWN_LIMIT),
          truncated: scraped.markdown.length > DEMO_MARKDOWN_LIMIT,
          characters: scraped.markdown.length,
        },
      });
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
      const job = await queue.add(url, browser, context.get('caller')?.id ?? null);
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

  app.get('/jobs/:id', async (context) => {
    const id = context.req.param('id');
    const job = await queue.get(id);
    if (job) return context.json(job);

    // Gone is not the same as never existed, and a caller polling a job we
    // retired deserves to be told which one happened.
    if (await queue.wasRetired(id)) {
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
