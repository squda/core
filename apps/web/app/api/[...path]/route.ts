import { NextResponse, type NextRequest } from 'next/server';

/**
 * Everything under /api is forwarded to the scrape service.
 *
 * One catch-all rather than a file per endpoint: the service already decides
 * what its routes are, and duplicating that list here would only create a
 * second place to forget to update.
 *
 * Two things this buys, both of which the Vite version had to work around:
 *
 *  - **No CORS.** The browser only ever talks to this Next server, so the
 *    service needs no origin list in production either.
 *  - **The service url stays on the server.** It is read from the environment
 *    here, not from a NEXT_PUBLIC_ variable baked into the bundle — which
 *    matters the moment a token has to be attached to these calls.
 */

const SERVICE = process.env.SCRAPE_SERVICE_URL ?? 'http://localhost:3000';

/** Hop-by-hop headers, plus the ones the fetch layer must set itself. */
const STRIPPED = new Set(['host', 'connection', 'content-length', 'accept-encoding']);

async function proxy(request: NextRequest, path: string[]): Promise<Response> {
  const target = new URL(`/${path.join('/')}`, SERVICE);
  target.search = request.nextUrl.search;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!STRIPPED.has(key.toLowerCase())) headers.set(key, value);
  });

  // GET and HEAD must not carry a body at all; `exactOptionalPropertyTypes`
  // means passing `undefined` is not the same as omitting it, so it is spread
  // in rather than set. `duplex` is what undici requires when the body is a
  // stream, and it is not in the DOM's RequestInit type.
  const sendsBody = request.method !== 'GET' && request.method !== 'HEAD';

  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      redirect: 'manual',
      ...(sendsBody ? ({ body: request.body, duplex: 'half' } as RequestInit) : {}),
    });

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch {
    // The service being down is a normal state during development, and it
    // should read as one rather than as a stack trace in the browser console.
    return NextResponse.json(
      {
        error: {
          code: 'service-unreachable',
          message: `no scrape service at ${SERVICE} — is \`pnpm serve\` running?`,
        },
      },
      { status: 502 },
    );
  }
}

type Context = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, context: Context) {
  return proxy(request, (await context.params).path);
}

export async function POST(request: NextRequest, context: Context) {
  return proxy(request, (await context.params).path);
}
