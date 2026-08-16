import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/service/app.js';
import { MemoryCache } from '../src/service/cache.js';
import { BrowserPool } from '../src/fetching/pool.js';
import { Logger } from '../src/support/log.js';
import {
  FetchTimeoutError,
  HttpStatusError,
  NetworkError,
  UnsupportedContentTypeError,
} from '../src/core/errors.js';
import { loadFixture } from './fixtures.js';
import { deferred, fakeResponse, stubFetch } from './helpers.js';
import { scrapeHtml } from '../src/core/scrape.js';

/**
 * Hono apps answer `app.request()` directly, so these run with no port, no
 * socket, and no network — the same speed as every other test here.
 */

function serveFixture(name: string): void {
  const html = loadFixture(name).html;
  vi.stubGlobal('fetch', async (url: string) => ({
    ok: true,
    status: 200,
    url,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    body: null,
    text: async () => html,
  }));
}

async function post(app: ReturnType<typeof createApp>, body: unknown): Promise<Response> {
  return app.request('/scrape', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /scrape', () => {
  it('returns the scraped document', async () => {
    serveFixture('blog-post');

    const response = await post(createApp(), { url: 'https://overreacted.io/the-wet-codebase/' });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.title).toBe('The WET Codebase — overreacted');
    expect(body.markdown).toContain('Violations of DRY');
    expect(body.fetchedWith).toBe('http');
  });

  // The point of the phase: the core needed no changes to grow a second
  // adapter, so the HTTP response is the CLI's --format=json byte for byte.
  it('returns exactly what the CLI would print as json', async () => {
    serveFixture('wikipedia');
    const url = 'https://en.wikipedia.org/wiki/Web_scraping';

    const response = await post(createApp(), { url });
    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(
      [
        'description',
        'feeds',
        'fetchedAt',
        'fetchedWith',
        'images',
        'links',
        'markdown',
        'structured',
        'title',
        'url',
        'wall',
      ].sort(),
    );
  });

  it('passes the browser mode through', async () => {
    const scrape = vi.fn().mockResolvedValue({ url: 'https://a.test/', markdown: '' });

    await post(createApp({ scrape }), { url: 'https://a.test/', browser: 'never' });

    expect(scrape).toHaveBeenCalledWith(
      'https://a.test/',
      expect.objectContaining({ browser: 'never' }),
    );
  });

  it('defaults the browser mode to auto', async () => {
    const scrape = vi.fn().mockResolvedValue({ url: 'https://a.test/', markdown: '' });

    await post(createApp({ scrape }), { url: 'https://a.test/' });

    expect(scrape).toHaveBeenCalledWith(
      'https://a.test/',
      expect.objectContaining({ browser: 'auto' }),
    );
  });
});

describe('bad requests', () => {
  it.each([
    ['no body at all', ''],
    ['not json', '{oops'],
  ])('rejects %s with 400', async (_label, body) => {
    const response = await post(createApp(), body);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('invalid-body');
  });

  it.each([
    ['a missing url', {}],
    ['a url that is not a string', { url: 42 }],
    ['an unknown browser mode', { url: 'https://a.test/', browser: 'maybe' }],
  ])('rejects %s with the failing field named', async (_label, body) => {
    const response = await post(createApp(), body);
    const payload = (await response.json()) as { error: { code: string; issues: unknown[] } };

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe('invalid-request');
    expect(payload.error.issues.length).toBeGreaterThan(0);
  });

  it('rejects an unusable url before any fetch happens', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const response = await post(createApp(), { url: 'javascript:alert(1)' });

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('invalid-url');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('upstream failures map to status codes', () => {
  function failWith(error: unknown) {
    return createApp({
      scrape: vi.fn().mockRejectedValue(error),
    });
  }

  it.each([
    ['a 404 upstream', new HttpStatusError('https://a.test/', 404), 502, 'http-status'],
    [
      'a refused connection',
      new NetworkError('https://a.test/', new Error('nope')),
      502,
      'network',
    ],
    ['a timeout', new FetchTimeoutError('https://a.test/', 15_000), 504, 'timeout'],
    [
      'a pdf',
      new UnsupportedContentTypeError('https://a.test/', 'application/pdf'),
      415,
      'content-type',
    ],
  ])('answers %s with %i', async (_label, error, status, code) => {
    const response = await post(failWith(error), { url: 'https://a.test/' });

    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(code);
  });

  // 404 upstream must not become 404 here — that would claim this endpoint
  // doesn't exist, which is a different and much more confusing thing.
  it('reports the upstream status in the body rather than as our own', async () => {
    const response = await post(failWith(new HttpStatusError('https://a.test/', 404)), {
      url: 'https://a.test/',
    });

    expect(response.status).toBe(502);
    expect((await response.json()).error.upstreamStatus).toBe(404);
  });

  it('never leaks a stack trace on an unexpected error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await failWith(new Error('boom at src/secret.ts:42')).request('/scrape', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://a.test/' }),
    });
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain('secret.ts');
    expect(text).toContain('something went wrong');
  });
});

describe('caching', () => {
  it('serves the second request for a url without scraping again', async () => {
    const scrape = vi.fn().mockResolvedValue(scrapeHtml(loadFixture('blog-post')));
    const app = createApp({ scrape, cache: new MemoryCache() });
    const url = 'https://overreacted.io/the-wet-codebase/';

    const first = await post(app, { url });
    const second = await post(app, { url });

    expect(first.headers.get('x-cache')).toBe('miss');
    expect(second.headers.get('x-cache')).toBe('hit');
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(await second.json()).toEqual(await first.json());
  });

  // The Phase 1 url decision, visible from the outside at last.
  it('counts a tracking-tagged url as the same page', async () => {
    const scrape = vi.fn().mockResolvedValue(scrapeHtml(loadFixture('blog-post')));
    const app = createApp({ scrape, cache: new MemoryCache() });

    await post(app, { url: 'https://overreacted.io/the-wet-codebase/?utm_source=twitter' });
    const second = await post(app, {
      url: 'https://overreacted.io/the-wet-codebase/?utm_source=rss',
    });

    expect(second.headers.get('x-cache')).toBe('hit');
    expect(scrape).toHaveBeenCalledTimes(1);
  });

  it('does not serve an auto result to a browser=never request', async () => {
    const scrape = vi.fn().mockResolvedValue(scrapeHtml(loadFixture('blog-post')));
    const app = createApp({ scrape, cache: new MemoryCache() });
    const url = 'https://overreacted.io/the-wet-codebase/';

    await post(app, { url });
    const second = await post(app, { url, browser: 'never' });

    expect(second.headers.get('x-cache')).toBe('miss');
    expect(scrape).toHaveBeenCalledTimes(2);
  });

  it('never caches a failure', async () => {
    const scrape = vi.fn().mockRejectedValue(new HttpStatusError('https://a.test/', 500));
    const app = createApp({ scrape, cache: new MemoryCache() });

    await post(app, { url: 'https://a.test/' });
    await post(app, { url: 'https://a.test/' });

    expect(scrape).toHaveBeenCalledTimes(2);
  });

  it('works with no cache at all', async () => {
    const scrape = vi.fn().mockResolvedValue(scrapeHtml(loadFixture('blog-post')));
    const app = createApp({ scrape });

    const response = await post(app, { url: 'https://overreacted.io/the-wet-codebase/' });

    expect(response.headers.get('x-cache')).toBe('miss');
  });
});

describe('the job flow', () => {
  async function poll(app: ReturnType<typeof createApp>, id: string) {
    let body!: { status: string; document?: { title: string }; error?: { code: string } };
    await vi.waitFor(async () => {
      const response = await app.request(`/jobs/${id}`);
      body = await response.json();
      expect(['done', 'failed']).toContain(body.status);
    });
    return body;
  }

  it('accepts work and answers before it is finished', async () => {
    const scrape = vi.fn().mockResolvedValue(scrapeHtml(loadFixture('blog-post')));
    const app = createApp({ scrape });

    const response = await app.request('/jobs', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://overreacted.io/the-wet-codebase/' }),
    });
    const job = (await response.json()) as { id: string; status: string; document: null };

    expect(response.status).toBe(202);
    expect(response.headers.get('location')).toBe(`/jobs/${job.id}`);
    expect(job.document).toBeNull();
  });

  it('reports the document once the work is done', async () => {
    const scrape = vi.fn().mockResolvedValue(scrapeHtml(loadFixture('blog-post')));
    const app = createApp({ scrape });

    const created = await app.request('/jobs', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://overreacted.io/the-wet-codebase/' }),
    });
    const { id } = (await created.json()) as { id: string };
    const finished = await poll(app, id);

    expect(finished.status).toBe('done');
    expect(finished.document?.title).toBe('The WET Codebase — overreacted');
  });

  // A failed job is a completed request: 200 with a failed status, not a 500.
  it('reports a failure as a finished job, explained the same way /scrape would', async () => {
    const scrape = vi.fn().mockRejectedValue(new HttpStatusError('https://a.test/', 404));
    const app = createApp({ scrape });

    const created = await app.request('/jobs', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://a.test/' }),
    });
    const { id } = (await created.json()) as { id: string };
    const finished = await poll(app, id);

    expect(finished.status).toBe('failed');
    expect(finished.error?.code).toBe('http-status');
  });

  it('fills the cache, so the synchronous endpoint answers instantly afterwards', async () => {
    const scrape = vi.fn().mockResolvedValue(scrapeHtml(loadFixture('blog-post')));
    const app = createApp({ scrape, cache: new MemoryCache() });
    const url = 'https://overreacted.io/the-wet-codebase/';

    const created = await app.request('/jobs', { method: 'POST', body: JSON.stringify({ url }) });
    await poll(app, ((await created.json()) as { id: string }).id);

    const direct = await post(app, { url });

    expect(direct.headers.get('x-cache')).toBe('hit');
    expect(scrape).toHaveBeenCalledTimes(1);
  });

  it('validates the body exactly as /scrape does', async () => {
    const response = await createApp().request('/jobs', { method: 'POST', body: '{}' });

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('invalid-request');
  });

  it('rejects a url it cannot use, without making the caller poll to find out', async () => {
    const response = await createApp().request('/jobs', {
      method: 'POST',
      body: JSON.stringify({ url: 'javascript:alert(1)' }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('invalid-url');
  });

  it('coalesces simultaneous requests for one page into a single job', async () => {
    const gate = deferred();
    const scrape = vi.fn(async () => {
      await gate.promise;
      return scrapeHtml(loadFixture('blog-post'));
    });
    const app = createApp({ scrape });
    const url = 'https://overreacted.io/the-wet-codebase/';

    const responses = await Promise.all(
      ['?utm_source=a', '?utm_source=b', ''].map((suffix) =>
        app.request('/jobs', { method: 'POST', body: JSON.stringify({ url: url + suffix }) }),
      ),
    );
    const ids = await Promise.all(
      responses.map(async (r) => ((await r.json()) as { id: string }).id),
    );

    expect(new Set(ids).size).toBe(1);
    expect(scrape).toHaveBeenCalledTimes(1);

    gate.resolve();
  });

  it('answers 503 with retry-after once the backlog is full', async () => {
    const gate = deferred();
    const scrape = vi.fn(async () => {
      await gate.promise;
      return scrapeHtml(loadFixture('blog-post'));
    });
    const app = createApp({ scrape, jobConcurrency: 1, maxQueued: 1 });

    for (const path of ['a', 'b', 'c']) {
      await app.request('/jobs', {
        method: 'POST',
        body: JSON.stringify({ url: `https://example.test/${path}` }),
      });
    }
    const rejected = await app.request('/jobs', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.test/d' }),
    });

    expect(rejected.status).toBe(503);
    expect(rejected.headers.get('retry-after')).toBe('30');
    expect((await rejected.json()).error.code).toBe('queue-full');

    gate.resolve();
  });

  it('404s an id it never issued', async () => {
    const response = await createApp().request('/jobs/does-not-exist');

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('no-such-job');
  });
});

describe('request logging', () => {
  function captureLogs() {
    const lines: Record<string, unknown>[] = [];
    const logger = new Logger({}, { write: (line) => lines.push(JSON.parse(line)) });
    return { logger, lines };
  }

  it('gives every request an id and echoes it back', async () => {
    const { logger, lines } = captureLogs();
    const app = createApp({ logger });

    const response = await app.request('/health');
    const id = response.headers.get('x-request-id');

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines.at(-1)).toMatchObject({ message: 'request', requestId: id, status: 200 });
  });

  // A proxy in front of us has usually assigned one already; keeping it is what
  // makes a trace survive the hop.
  it('keeps an id the caller supplied', async () => {
    const { logger, lines } = captureLogs();
    const app = createApp({ logger });

    const response = await app.request('/health', { headers: { 'x-request-id': 'from-proxy' } });

    expect(response.headers.get('x-request-id')).toBe('from-proxy');
    expect(lines.at(-1)).toMatchObject({ requestId: 'from-proxy' });
  });

  it('logs what a scrape did, against the request that caused it', async () => {
    const { logger, lines } = captureLogs();
    const scrape = vi.fn().mockResolvedValue(scrapeHtml(loadFixture('blog-post')));
    const app = createApp({ scrape, logger });

    await post(app, { url: 'https://overreacted.io/the-wet-codebase/' });

    expect(lines.some((line) => line.message === 'scraped' && line.fetchedWith === 'http')).toBe(
      true,
    );
    expect(new Set(lines.map((line) => line.requestId)).size).toBe(1);
  });

  it('logs a failure as a warning, without a stack', async () => {
    const { logger, lines } = captureLogs();
    const scrape = vi.fn().mockRejectedValue(new HttpStatusError('https://a.test/', 403));
    const app = createApp({ scrape, logger });

    await post(app, { url: 'https://a.test/' });

    const failure = lines.find((line) => line.message === 'request failed');
    expect(failure).toMatchObject({ level: 'warn', code: 'http-status' });
    expect(failure?.reason).toContain('403');
    expect(failure).not.toHaveProperty('stack');
  });

  it('logs an unexpected error at error level, with the stack', async () => {
    const { logger, lines } = captureLogs();
    const scrape = vi.fn().mockRejectedValue(new Error('boom'));
    const app = createApp({ scrape, logger });

    await post(app, { url: 'https://a.test/' });

    const failure = lines.find((line) => line.message === 'unexpected failure');
    expect(failure).toMatchObject({ level: 'error' });
    expect(String(failure?.stack)).toContain('boom');
  });
});

describe('GET /form-spec', () => {
  it('returns the forms on a page', async () => {
    const html = loadFixture('form-login-minimal').html;
    stubFetch((url) => fakeResponse(url, { body: html }));

    const response = await createApp().request(
      '/form-spec?url=https://the-internet.herokuapp.com/login',
    );
    const spec = (await response.json()) as { forms: { fields: unknown[] }[] };

    expect(response.status).toBe(200);
    expect(spec.forms[0]?.fields).toHaveLength(2);
  });

  // Extraction strips every <input> on the way to Markdown, so this endpoint
  // must read the original HTML rather than anything the scraper cached.
  it('sees fields that the markdown pipeline throws away', async () => {
    const html = loadFixture('form-job-application').html;
    stubFetch((url) => fakeResponse(url, { body: html }));

    const response = await createApp().request('/form-spec?url=https://job-boards.test/x');
    const spec = (await response.json()) as { forms: { fields: { label: string }[] }[] };
    const fields = spec.forms.flatMap((form) => form.fields);

    // 23 on the application form, plus the reCAPTCHA textarea Google injects
    // outside it. Both are boxes on the page, so both are in the spec.
    expect(fields).toHaveLength(24);
    expect(fields.some((field) => field.label === 'First Name*')).toBe(true);
  });

  it.each([
    ['no url', '/form-spec'],
    ['an unknown browser mode', '/form-spec?url=https://a.test/&browser=maybe'],
  ])('rejects %s with 400', async (_label, path) => {
    const response = await createApp().request(path);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('invalid-request');
  });

  /**
   * The fast suite sets SCRAPE_ALLOW_PRIVATE=1 to stay hermetic, so the guard
   * is asserted directly rather than through the endpoint — what matters here
   * is that this route goes through the same fetch path as everything else,
   * which the two tests above already show.
   */
  it('fetches through the guarded path, not around it', async () => {
    const fetchSpy = stubFetch((url) => fakeResponse(url, { body: '<form><input></form>' }));

    await createApp().request('/form-spec?url=https://example.com/');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('GET /health', () => {
  it('answers without touching the network', async () => {
    const response = await createApp().request('/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      browser: null,
      jobs: { queued: 0, running: 0, done: 0, failed: 0, inFlight: 0 },
    });
  });

  // How the concurrency numbers are read from outside — no browser is
  // launched to answer this, the pool only reports what it is already doing.
  it('reports pool stats when the app has one', async () => {
    const response = await createApp({ pool: new BrowserPool() }).request('/health');

    expect(await response.json()).toEqual({
      ok: true,
      browser: { active: 0, queued: 0, launches: 0, open: false },
      jobs: { queued: 0, running: 0, done: 0, failed: 0, inFlight: 0 },
    });
  });
});

/**
 * CORS is a rule browsers apply to themselves, so these assert on headers
 * rather than on anything being blocked — nothing here is a browser. What
 * matters is that the headers appear only for origins that were named.
 */
describe('CORS', () => {
  const origin = 'http://localhost:5173';

  it('sends nothing at all by default', async () => {
    const response = await createApp().request('/health', { headers: { origin } });

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers a preflight for an origin it was given', async () => {
    const app = createApp({ corsOrigins: [origin] });

    const response = await app.request('/scrape', {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST' },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
  });

  // The reason the option is a list and never '*': with credentials allowed, a
  // wildcard origin hands any page on the internet a logged-in caller's token.
  it('refuses an origin that is not on the list', async () => {
    const response = await createApp({ corsOrigins: [origin] }).request('/health', {
      headers: { origin: 'https://not-ours.test' },
    });

    expect(response.headers.get('access-control-allow-origin')).not.toBe('https://not-ours.test');
  });

  // x-cache is the header the demo reads to show whether a page was cached.
  // Cross-origin, a header the server does not expose is invisible to script.
  it('exposes the headers a browser client actually reads', async () => {
    const response = await createApp({ corsOrigins: [origin] }).request('/health', {
      headers: { origin },
    });

    expect(response.headers.get('access-control-expose-headers')).toContain('x-cache');
  });
});

/**
 * The one endpoint that answers without a token, and therefore the one that has
 * to be narrow. These assert the narrowness, not the happy path — the happy
 * path is /form-spec and /scrape, already covered above.
 */
describe('GET /demo', () => {
  const page = () => stubFetch((url) => fakeResponse(url, { body: loadFixture('form-page').html }));

  it('answers both halves in one call', async () => {
    page();

    const response = await createApp().request('/demo?url=https://a.test/signup');
    const body = (await response.json()) as {
      spec: { forms: unknown[] };
      text: { markdown: string; characters: number; truncated: boolean };
    };

    expect(response.status).toBe(200);
    expect(body.spec.forms.length).toBeGreaterThan(0);
    expect(body.text.markdown.length).toBeGreaterThan(0);
    expect(body.text.truncated).toBe(false);
  });

  // Auto still escalates on a genuinely empty page, so an SPA works. What is
  // refused is *forcing* the expensive path on a page that never needed it.
  it('will not let a caller force the browser', async () => {
    const response = await createApp().request('/demo?url=https://a.test/&browser=always');

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('invalid-request');
  });

  it('needs a url like every other endpoint', async () => {
    expect((await createApp().request('/demo')).status).toBe(400);
  });

  it('refuses past the limit, and says when to come back', async () => {
    page();
    const app = createApp({ demoRateLimit: 2, callerKey: () => 'one-caller' });

    expect((await app.request('/demo?url=https://a.test/1')).status).toBe(200);
    expect((await app.request('/demo?url=https://a.test/2')).status).toBe(200);

    const refused = await app.request('/demo?url=https://a.test/3');
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await refused.json()).error.code).toBe('rate-limited');
  });

  it('counts callers separately', async () => {
    page();
    let who = 'first';
    const app = createApp({ demoRateLimit: 1, callerKey: () => who });

    expect((await app.request('/demo?url=https://a.test/1')).status).toBe(200);
    expect((await app.request('/demo?url=https://a.test/2')).status).toBe(429);

    who = 'second';
    expect((await app.request('/demo?url=https://a.test/3')).status).toBe(200);
  });

  it('reports what is left, so a client need not guess', async () => {
    page();
    const app = createApp({ demoRateLimit: 3, callerKey: () => 'x' });

    const response = await app.request('/demo?url=https://a.test/1');
    expect(response.headers.get('x-ratelimit-remaining')).toBe('2');
  });

  // A visitor is reading a preview, not exporting a corpus. The cap is what
  // bounds the cost of one unauthenticated request.
  it('truncates a long page and admits that it did', async () => {
    const long = `<html><body><article>${'word '.repeat(30_000)}</article></body></html>`;
    stubFetch((url) => fakeResponse(url, { body: long }));

    const response = await createApp().request('/demo?url=https://a.test/long');
    const body = (await response.json()) as {
      text: { markdown: string; truncated: boolean; characters: number };
    };

    expect(body.text.markdown.length).toBe(20_000);
    expect(body.text.truncated).toBe(true);
    expect(body.text.characters).toBeGreaterThan(20_000);
  });

  it('reports a refusing site the same way the other endpoints do', async () => {
    stubFetch((url) => fakeResponse(url, { status: 403, body: 'no' }));

    const response = await createApp().request('/demo?url=https://blocked.test/');

    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe('http-status');
  });
});
