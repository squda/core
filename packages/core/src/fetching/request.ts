import {
  BlockedAddressError,
  FetchTimeoutError,
  HttpStatusError,
  NetworkError,
  UnsupportedContentTypeError,
} from '../core/errors.js';
import { assertFetchable } from './ssrf.js';
import { USER_AGENT } from './user-agent.js';
import type { HtmlDocument } from '../core/types.js';
import type { FetchOptions } from './strategy.js';

/**
 * Phase 1, step 2 — HTTP GET a page. The errors it raises live in errors.ts,
 * shared with the browser path.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Redirect hops we will follow.
 *
 * Followed by hand rather than with `redirect: 'follow'`, because the SSRF
 * guard has to see every hop: a public url that 302s to 127.0.0.1 walks
 * straight past a check that only ran on the first one.
 */
const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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

  // Whichever fires first: our patience, or the caller giving up.
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;

  let response: Response;
  let finalUrl = url;
  try {
    ({ response, finalUrl } = await follow(url, signal, options.allowPrivate));
  } catch (error) {
    if (error instanceof BlockedAddressError) throw error;
    // A caller-side abort is not a timeout of ours, but it is still the end of
    // this fetch; the caller already knows why it cancelled.
    if (options.signal?.aborted || isTimeout(error)) throw new FetchTimeoutError(url, timeoutMs);
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
    finalUrl,
    html: await response.text(),
    contentType,
    status: response.status,
    fetchedAt: new Date(),
  };
}

/**
 * Follow redirects ourselves, checking each destination before going there.
 *
 * Returns where we landed, which is what relative links resolve against —
 * `response.url` is the *requested* url under `redirect: 'manual'`, so the
 * chain has to be tracked here.
 */
async function follow(
  startUrl: string,
  signal: AbortSignal,
  allowPrivate: boolean | undefined,
): Promise<{ response: Response; finalUrl: string }> {
  let current = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertFetchable(current, allowPrivate === undefined ? {} : { allowPrivate });

    const response = await fetch(current, {
      redirect: 'manual',
      signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      return { response, finalUrl: current };
    }

    await response.body?.cancel().catch(() => {});
    current = new URL(location, current).toString();
  }

  throw new Error(`more than ${MAX_REDIRECTS} redirects from ${startUrl}`);
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
