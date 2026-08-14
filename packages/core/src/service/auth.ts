import type { Context, MiddlewareHandler } from 'hono';
import type { SupabaseClient } from './supabase.js';

/**
 * Who is calling.
 *
 * Callers send a Supabase access token as `Authorization: Bearer <jwt>`. The
 * token is verified by Supabase, which returns the user it belongs to — so an
 * expired, forged or revoked token fails here rather than three layers down
 * where the damage would already be done.
 *
 * Verification is a network call per request today. That is the honest simple
 * version; local verification against the project's JWKS removes the hop and
 * is the obvious next step if latency matters. It is not a correctness
 * difference, so it can wait for a number that says it should.
 */

export interface Caller {
  id: string;
  email: string | null;
}

export interface AuthOptions {
  client: SupabaseClient;
  /**
   * When false, an anonymous request is allowed through with no caller.
   * Endpoints still see whoever *did* present a valid token.
   */
  required: boolean;
  onError?: (error: unknown) => void;
}

/** Extracts a bearer token, ignoring the header's case and stray whitespace. */
export function bearerToken(header: string | undefined): string | null {
  const match = /^bearer\s+(.+)$/i.exec((header ?? '').trim());
  return match?.[1]?.trim() || null;
}

export function authenticate({
  client,
  required,
  onError = () => {},
}: AuthOptions): MiddlewareHandler {
  return async (context, next) => {
    const token = bearerToken(context.req.header('authorization'));

    if (!token) {
      if (!required) return next();
      return unauthorised(context, 'this endpoint needs a Supabase access token');
    }

    let caller: Caller | null = null;
    try {
      const { data, error } = await client.auth.getUser(token);
      if (error || !data.user) {
        return unauthorised(context, 'that token is not valid');
      }
      caller = { id: data.user.id, email: data.user.email ?? null };
    } catch (error) {
      // Supabase being unreachable is our problem, not the caller's — and it
      // must never read as "your token is bad", which sends someone chasing a
      // login bug that isn't there.
      onError(error);
      return context.json(
        { error: { code: 'auth-unavailable', message: 'could not verify the token' } },
        503,
      );
    }

    context.set('caller', caller);
    return next();
  };
}

function unauthorised(context: Context, message: string): Response {
  context.header('www-authenticate', 'Bearer');
  return context.json({ error: { code: 'unauthorised', message } }, 401);
}
