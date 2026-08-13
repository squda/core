/**
 * Everything that can go wrong before a page becomes a document.
 *
 * One module because two strategies and three adapters share it: HttpStrategy
 * and BrowserStrategy both throw these, and cli.ts, server.ts and the job queue
 * each translate the same `kind` into their own vocabulary — exit codes, status
 * codes, and job error codes respectively. Kept apart from fetch.ts so the
 * browser path doesn't have to import the HTTP mechanism to raise a timeout.
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
 * Thrown when a url resolves to an address inside the network — loopback,
 * private, link-local (cloud metadata). Its own class because it is the
 * caller's mistake, not the network's: it answers 400, never 502.
 */
export class BlockedAddressError extends Error {
  constructor(
    readonly url: string,
    readonly address: string,
  ) {
    super(`refusing to fetch ${url}: ${address} is not a public address`);
    this.name = 'BlockedAddressError';
  }
}

/**
 * Thrown when a string isn't a URL we're willing to fetch. Raised before any
 * network call, which is why it is not a FetchError.
 */
export class InvalidUrlError extends Error {
  constructor(
    readonly input: string,
    reason: string,
  ) {
    super(`invalid url ${JSON.stringify(input)}: ${reason}`);
    this.name = 'InvalidUrlError';
  }
}
