import { FormSpecSchema, type FormSpec } from '@untitled/schema';

/**
 * The browser half of the service's contract.
 *
 * Responses are parsed with the same Zod schema the server validated them
 * with — the reason `@untitled/schema` is its own package. If the service ever
 * changes shape this fails loudly here, rather than rendering `undefined` into
 * a component three levels down.
 *
 * Calls go to /api, which the catch-all route handler forwards to the service.
 */

export type BrowserMode = 'auto' | 'never' | 'always';

/** What the service says when it refuses. Specific enough to show verbatim. */
export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

async function readError(response: Response): Promise<never> {
  let code = 'unknown';
  let message = `the service answered ${response.status}`;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
  } catch {
    // A non-JSON error body leaves the defaults in place.
  }
  throw new ServiceError(code, message, response.status);
}

export interface PageText {
  title: string | null;
  description: string | null;
  fetchedWith: string;
  markdown: string;
  /** True when the service cut the markdown short. Say so rather than implying that was all of it. */
  truncated: boolean;
  /** The real length, before truncation. */
  characters: number;
}

export interface DemoRead {
  spec: FormSpec;
  text: PageText;
}

/**
 * The demo endpoint: both halves of a page in one call.
 *
 * `/scrape` and `/form-spec` both require a token, and a public waitlist page
 * has no one to get a token from. `/demo` is the one open door — rate limited,
 * markdown truncated, and unable to be forced down the browser path — so a
 * visitor can try it without an account and without it becoming a free API.
 *
 * One call rather than two on purpose: two would spend two of the visitor's
 * rate-limit allowance on one click, and half-work when the second is refused.
 */
export async function fetchDemo(url: string, browser: BrowserMode = 'auto'): Promise<DemoRead> {
  const query = new URLSearchParams({ url, browser });
  const response = await fetch(`/api/demo?${query}`);
  if (!response.ok) await readError(response);

  const body = (await response.json()) as { spec: unknown; text: PageText };
  return { spec: FormSpecSchema.parse(body.spec), text: body.text };
}

export type JoinResult = 'joined' | 'already';

/** The waitlist. Its own route rather than the proxy — it is this app's data, not the service's. */
export async function joinWaitlist(email: string): Promise<JoinResult> {
  const response = await fetch('/api/waitlist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!response.ok) await readError(response);
  const body = (await response.json()) as { status?: JoinResult };
  return body.status === 'already' ? 'already' : 'joined';
}
