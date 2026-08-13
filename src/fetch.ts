import {
  FetchTimeoutError,
  HttpStatusError,
  NetworkError,
  UnsupportedContentTypeError,
} from './errors.js';
import { USER_AGENT } from './user-agent.js';
import type { HtmlDocument } from './types.js';
import type { FetchOptions } from './strategy.js';

/**
 * Phase 1, step 2 — HTTP GET a page. The errors it raises live in errors.ts,
 * shared with the browser path.
 */

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
    fetchedWith: 'http',
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
