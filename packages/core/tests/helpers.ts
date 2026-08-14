import { vi } from 'vitest';
import type { HtmlDocument } from '../src/core/types.js';

/**
 * Shared test scaffolding. Not a test file — the helpers every suite was
 * otherwise redeclaring.
 */

/** A promise resolved by hand, so a test controls exactly when work finishes. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface FakeResponseInit {
  status?: number;
  /** `null` means the header is absent entirely, not empty. */
  contentType?: string | null;
  /** Where the request landed after redirects. Defaults to the requested url. */
  url?: string;
  body?: string;
}

/**
 * A Response-shaped object.
 *
 * Not a real `Response`: that class has a read-only, always-empty `.url`, so
 * the redirect case would be untestable against the genuine article.
 */
export function fakeResponse(requestedUrl: string, init: FakeResponseInit = {}): Response {
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

/** Replaces global fetch for the duration of a test. Undo with vi.unstubAllGlobals(). */
export function stubFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (url: string, init: RequestInit) => impl(url, init));
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** Serves one HTML body for any url. */
export function serveHtml(body: string, init: FakeResponseInit = {}) {
  return stubFetch((url) => fakeResponse(url, { ...init, body }));
}

/** An HtmlDocument built around some HTML, as a strategy would have returned it. */
export function htmlDocument(html: string, overrides: Partial<HtmlDocument> = {}): HtmlDocument {
  return {
    url: 'https://example.com/p',
    fetchedWith: 'http',
    finalUrl: 'https://example.com/p',
    html,
    contentType: 'text/html',
    status: 200,
    fetchedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** A 302 pointing somewhere else. Redirects are followed by hand, so tests build the chain. */
export function redirectResponse(location: string, status = 302): Response {
  return {
    ok: false,
    status,
    url: 'about:redirect',
    headers: new Headers({ location }),
    body: null,
    text: async () => '',
  } as unknown as Response;
}
