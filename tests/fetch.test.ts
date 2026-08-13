import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FetchTimeoutError,
  HttpStatusError,
  NetworkError,
  UnsupportedContentTypeError,
  fetchPage,
} from '../src/fetch.js';

/**
 * No network here either. We stub global fetch and assert on what fetchPage
 * does with each shape of response — the point of the exercise is the error
 * taxonomy, and you cannot make a real server 404 on demand.
 */

interface FakeResponseInit {
  status?: number;
  contentType?: string | null;
  /** Where the request landed after redirects. Defaults to the requested url. */
  url?: string;
  body?: string;
}

function fakeResponse(requestedUrl: string, init: FakeResponseInit = {}): Response {
  const status = init.status ?? 200;
  const headers = new Headers();
  const contentType =
    init.contentType === undefined ? 'text/html; charset=utf-8' : init.contentType;
  if (contentType !== null) headers.set('content-type', contentType);

  return {
    ok: status >= 200 && status < 300,
    status,
    url: init.url ?? requestedUrl,
    headers,
    body: null,
    text: async () => init.body ?? '<html></html>',
  } as unknown as Response;
}

function stubFetch(impl: (url: string) => Response | Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => impl(url)),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchPage', () => {
  it('returns the body with the requested url as identity', async () => {
    stubFetch((url) => fakeResponse(url, { body: '<h1>hi</h1>' }));

    const doc = await fetchPage('https://example.com/a');

    expect(doc.html).toBe('<h1>hi</h1>');
    expect(doc.url).toBe('https://example.com/a');
    expect(doc.status).toBe(200);
    expect(doc.fetchedAt).toBeInstanceOf(Date);
  });

  // finalUrl is what markdown.ts resolves relative links against. Swap these
  // two and every link on a redirecting site comes out pointing at the wrong host.
  it('records where a redirect landed in finalUrl, leaving url alone', async () => {
    stubFetch((url) => fakeResponse(url, { url: 'https://www.example.com/a/' }));

    const doc = await fetchPage('https://example.com/a');

    expect(doc.url).toBe('https://example.com/a');
    expect(doc.finalUrl).toBe('https://www.example.com/a/');
  });

  it('sends a browser User-Agent', async () => {
    stubFetch((url) => fakeResponse(url));

    await fetchPage('https://example.com/');

    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toMatch(/^Mozilla\/5\.0/);
  });

  it.each([404, 403, 500])('throws HttpStatusError on %i', async (status) => {
    stubFetch((url) => fakeResponse(url, { status }));

    const error = await fetchPage('https://example.com/').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpStatusError);
    expect(error).toMatchObject({ kind: 'http-status', status });
  });

  it.each(['application/pdf', 'image/png', 'application/json', ''])(
    'refuses content-type %s',
    async (contentType) => {
      stubFetch((url) => fakeResponse(url, { contentType }));

      const error = await fetchPage('https://example.com/').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnsupportedContentTypeError);
      expect(error).toMatchObject({ kind: 'content-type' });
    },
  );

  it('refuses a response with no content-type at all', async () => {
    stubFetch((url) => fakeResponse(url, { contentType: null }));

    await expect(fetchPage('https://example.com/')).rejects.toBeInstanceOf(
      UnsupportedContentTypeError,
    );
  });

  it.each(['text/html', 'text/html; charset=utf-8', 'TEXT/HTML', 'application/xhtml+xml'])(
    'accepts content-type %s',
    async (contentType) => {
      stubFetch((url) => fakeResponse(url, { contentType }));

      await expect(fetchPage('https://example.com/')).resolves.toMatchObject({ status: 200 });
    },
  );

  it('maps an aborted request to FetchTimeoutError', async () => {
    stubFetch(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });

    const error = await fetchPage('https://example.com/', { timeoutMs: 50 }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(FetchTimeoutError);
    expect(error).toMatchObject({ kind: 'timeout', timeoutMs: 50 });
  });

  // undici wraps the real cause, so the naive `error.name` check misses it.
  it('sees a timeout wrapped in another error', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed', {
        cause: new DOMException('aborted', 'TimeoutError'),
      });
    });

    await expect(fetchPage('https://example.com/')).rejects.toBeInstanceOf(FetchTimeoutError);
  });

  it('maps a connection failure to NetworkError, keeping the cause', async () => {
    const cause = new TypeError('fetch failed');
    stubFetch(() => {
      throw cause;
    });

    const error = await fetchPage('https://nope.invalid/').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NetworkError);
    expect(error).toMatchObject({ kind: 'network', url: 'https://nope.invalid/', cause });
  });
});
