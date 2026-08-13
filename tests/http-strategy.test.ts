import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchTimeoutError } from '../src/fetch.js';
import { HttpStrategy } from '../src/http-strategy.js';
import { describeFetchStrategyContract } from './strategy-contract.js';
import { loadFixture } from './fixtures.js';

const PAGE = loadFixture('blog-post');

function htmlResponse(url: string, body: string): Response {
  return {
    ok: true,
    status: 200,
    url,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    body: null,
    text: async () => body,
  } as unknown as Response;
}

function serve(body: string): void {
  vi.stubGlobal('fetch', async (url: string) => htmlResponse(url, body));
}

/** Responds after `delayMs`, unless the abort signal fires first. */
function serveSlowly(delayMs: number): void {
  vi.stubGlobal(
    'fetch',
    (url: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(htmlResponse(url, '<html>slow</html>')), delayMs);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(init.signal?.reason as Error);
        });
      }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpStrategy satisfies the FetchStrategy contract', () => {
  describeFetchStrategyContract(async () => {
    serve(PAGE.html);
    return {
      strategy: new HttpStrategy(),
      url: PAGE.url,
      expectedHtml: '<title>',
    };
  });
});

describe('HttpStrategy specifics', () => {
  it('is named http', () => {
    expect(new HttpStrategy().name).toBe('http');
  });

  it('applies its constructor defaults', async () => {
    serveSlowly(200);

    const failure = await new HttpStrategy({ timeoutMs: 20 })
      .fetch('https://example.com/')
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(FetchTimeoutError);
    expect(failure).toMatchObject({ timeoutMs: 20 });
  });

  it('lets a per-call option override the constructor default', async () => {
    serveSlowly(50);

    const doc = await new HttpStrategy({ timeoutMs: 20 }).fetch('https://example.com/', {
      timeoutMs: 2000,
    });

    expect(doc.status).toBe(200);
  });
});
