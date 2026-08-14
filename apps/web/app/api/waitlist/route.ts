import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/**
 * The waitlist.
 *
 * Its own route rather than going through the catch-all proxy, because this is
 * the web app's data and not the scrape service's — the service scrapes pages
 * and should not grow a second job.
 *
 * Sits in front of `waitlist_signups` (see supabase/migrations). Requires the
 * service role key, which is why it can only run here on the server.
 */

/** Deliberately loose. An address that a real MTA accepts is not worth re-deriving here. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function refuse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(request: Request) {
  let email: unknown;
  try {
    ({ email } = (await request.json()) as { email?: unknown });
  } catch {
    return refuse('invalid-request', 'expected a json body', 400);
  }

  if (typeof email !== 'string' || !EMAIL.test(email.trim())) {
    return refuse('invalid-email', 'that address is missing an @ or a domain', 400);
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    // Said plainly rather than pretending to have stored it. A waitlist that
    // silently drops addresses is worse than one that is visibly switched off.
    return refuse(
      'waitlist-unconfigured',
      'the waitlist is not connected yet — SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are unset',
      503,
    );
  }

  // Stored lowercased so Someone@Work.com and someone@work.com are one person.
  const normalised = email.trim().toLowerCase();
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const { error } = await supabase.from('waitlist_signups').insert({ email: normalised });

  if (error) {
    // 23505 is Postgres' unique violation. Being on the list twice is not a
    // failure, so it is reported as the ordinary outcome it is.
    if (error.code === '23505') return NextResponse.json({ status: 'already' });
    return refuse('waitlist-failed', 'could not record that address', 500);
  }

  return NextResponse.json({ status: 'joined' });
}
