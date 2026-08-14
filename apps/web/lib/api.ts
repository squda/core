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

/** Every form on a page, with each field's label and where that label came from. */
export async function fetchFormSpec(url: string, browser: BrowserMode = 'auto'): Promise<FormSpec> {
  const query = new URLSearchParams({ url, browser });
  const response = await fetch(`/api/form-spec?${query}`);
  if (!response.ok) await readError(response);
  return FormSpecSchema.parse(await response.json());
}

export interface PageText {
  title: string | null;
  description: string | null;
  markdown: string;
  fetchedWith: string;
}

/** The same page as prose. Behind auth whenever Supabase is configured. */
export async function fetchPageText(url: string, browser: BrowserMode = 'auto'): Promise<PageText> {
  const response = await fetch('/api/scrape', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, browser }),
  });
  if (!response.ok) await readError(response);
  return (await response.json()) as PageText;
}
