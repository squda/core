import type { HtmlDocument } from './types.js';
import type { FetchOptions } from './strategy.js';

/**
 * Phase 1, step 2 — HTTP GET a page.
 *
 * The error classes below are the start of the taxonomy Phase 2 step 5 fills
 * out. They share a `kind` so a caller can branch on the discriminant rather
 * than on a chain of `instanceof` checks — the browser strategy will want to
 * retry on some kinds and give up on others.
 */

export type FetchErrorKind = 'timeout' | 'network' | 'http-status' | 'content-type';

export abstract class FetchError extends Error {
  abstract readonly kind: FetchErrorKind;

  constructor(
    readonly url: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class FetchTimeoutError extends FetchError {
  readonly kind = 'timeout';
  constructor(
    url: string,
    readonly timeoutMs: number,
  ) {
    super(url, `timed out after ${timeoutMs}ms fetching ${url}`);
  }
}

/** DNS failure, connection refused, TLS error — the request never completed. */
export class NetworkError extends FetchError {
  readonly kind = 'network';
  constructor(url: string, cause: unknown) {
    super(url, `network failure fetching ${url}`, { cause });
  }
}

export class HttpStatusError extends FetchError {
  readonly kind = 'http-status';
  constructor(
    url: string,
    readonly status: number,
  ) {
    super(url, `got ${status} fetching ${url}`);
  }
}

export class UnsupportedContentTypeError extends FetchError {
  readonly kind = 'content-type';
  constructor(
    url: string,
    readonly contentType: string,
  ) {
    super(url, `expected HTML, got ${contentType || 'no content-type'} at ${url}`);
  }
}

/**
 * A real browser's UA. The default Node one (`node`) is blocked or served a
 * degraded page by a lot of sites — the plan calls this out in step 2, and it
 * is the difference between a fixture with content and a fixture with a
 * bot-check page in it.
 */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT_MS = 15_000;

/** The MIME types we're willing to hand to an HTML parser. */
const HTML_TYPES = ['text/html', 'application/xhtml+xml'];

function isHtml(contentType: string): boolean {
  const essence = contentType.split(';')[0]!.trim().toLowerCase();
  return HTML_TYPES.includes(essence);
}

export type { FetchOptions };

/**
 * GET a page and return it unparsed.
 *
 * Redirects are followed; `finalUrl` records where we actually landed, which is
 * what relative links must resolve against. `url` stays as asked for, because
 * that is the page's identity (and in Phase 3, its cache key).
 *
 * @throws {FetchError} one of the four subclasses above.
 */
export async function fetchPage(url: string, options: FetchOptions = {}): Promise<HtmlDocument> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
  } catch (error) {
    if (isTimeout(error)) throw new FetchTimeoutError(url, timeoutMs);
    throw new NetworkError(url, error);
  }

  if (!response.ok) {
    await discard(response);
    throw new HttpStatusError(url, response.status);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!isHtml(contentType)) {
    // Bail before reading the body — this is how a 40MB PDF stays unread.
    await discard(response);
    throw new UnsupportedContentTypeError(url, contentType);
  }

  return {
    url,
    finalUrl: response.url || url,
    html: await response.text(),
    contentType,
    status: response.status,
    fetchedAt: new Date(),
  };
}

/** AbortSignal.timeout() surfaces as a TimeoutError, sometimes wrapped by undici. */
function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError') return true;
  return error.cause instanceof Error && error.cause.name === 'TimeoutError';
}

/** Release the socket on a response we're about to throw away. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already closed. Nothing to release.
  }
}
