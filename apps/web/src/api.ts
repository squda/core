import { FormSpecSchema, type FormSpec } from '@untitled/schema';

/**
 * The browser half of the service's contract.
 *
 * It parses what comes back with the same Zod schema the server validated it
 * with — the whole reason `@untitled/schema` is its own package. If the service
 * ever changes shape, this fails loudly here rather than rendering `undefined`
 * into a table three components down.
 */

const BASE = import.meta.env.VITE_API_URL ?? '/api';

export type BrowserMode = 'auto' | 'never' | 'always';

/** What the service says when it refuses. Worth showing verbatim — it is specific. */
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
    // A non-JSON error body (a proxy's HTML 502 page) leaves the defaults.
  }
  throw new ServiceError(code, message, response.status);
}

export async function fetchFormSpec(url: string, browser: BrowserMode): Promise<FormSpec> {
  const query = new URLSearchParams({ url, browser });
  const response = await fetch(`${BASE}/form-spec?${query}`);
  if (!response.ok) await readError(response);
  return FormSpecSchema.parse(await response.json());
}

export interface PageText {
  title: string | null;
  description: string | null;
  markdown: string;
  fetchedWith: string;
}

export async function fetchPageText(url: string, browser: BrowserMode): Promise<PageText> {
  const response = await fetch(`${BASE}/scrape`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, browser }),
  });
  if (!response.ok) await readError(response);
  const document = (await response.json()) as PageText;
  return document;
}
