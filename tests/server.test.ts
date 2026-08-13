import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server.js';
import {
  FetchTimeoutError,
  HttpStatusError,
  NetworkError,
  UnsupportedContentTypeError,
} from '../src/fetch.js';
import { loadFixture } from './fixtures.js';

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

    expect(scrape).toHaveBeenCalledWith('https://a.test/', { browser: 'never' });
  });

  it('defaults the browser mode to auto', async () => {
    const scrape = vi.fn().mockResolvedValue({ url: 'https://a.test/', markdown: '' });

    await post(createApp({ scrape }), { url: 'https://a.test/' });

    expect(scrape).toHaveBeenCalledWith('https://a.test/', { browser: 'auto' });
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

describe('GET /health', () => {
  it('answers without touching the network', async () => {
    const response = await createApp().request('/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
