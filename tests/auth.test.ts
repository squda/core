import { describe, expect, it, vi } from 'vitest';
import { bearerToken } from '../src/service/auth.js';
import { createApp } from '../src/service/app.js';
import { scrapeHtml } from '../src/core/scrape.js';
import { loadFixture } from './fixtures.js';
import type { SupabaseClient } from '../src/service/supabase.js';

/**
 * Supabase is faked at its edge — `auth.getUser` — so these run with no
 * network and no project. What is being tested is our handling of each answer
 * it can give, which is the part we wrote.
 */
function fakeSupabase(getUser: (token: string) => unknown): SupabaseClient {
  return {
    auth: { getUser: vi.fn(async (token: string) => getUser(token)) },
  } as unknown as SupabaseClient;
}

const user = { data: { user: { id: 'user-1', email: 'a@b.test' } }, error: null };
const rejected = { data: { user: null }, error: { message: 'invalid JWT' } };

function scrapes() {
  return vi.fn().mockResolvedValue(scrapeHtml(loadFixture('blog-post')));
}

function post(app: ReturnType<typeof createApp>, headers: Record<string, string> = {}) {
  return app.request('/scrape', {
    method: 'POST',
    headers,
    body: JSON.stringify({ url: 'https://overreacted.io/the-wet-codebase/' }),
  });
}

describe('bearerToken', () => {
  it.each([
    ['Bearer abc.def.ghi', 'abc.def.ghi'],
    ['bearer abc', 'abc'],
    ['  Bearer   abc  ', 'abc'],
  ])('reads %s', (header, expected) => {
    expect(bearerToken(header)).toBe(expected);
  });

  it.each([undefined, '', 'Basic abc', 'Bearer', 'Bearer   '])('rejects %s', (header) => {
    expect(bearerToken(header)).toBeNull();
  });
});

describe('when auth is required', () => {
  const app = () =>
    createApp({ scrape: scrapes(), supabase: fakeSupabase(() => user), requireAuth: true });

  it('refuses an anonymous request', async () => {
    const response = await post(app());

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect((await response.json()).error.code).toBe('unauthorised');
  });

  it('refuses a token Supabase does not accept', async () => {
    const rejecting = createApp({
      scrape: scrapes(),
      supabase: fakeSupabase(() => rejected),
      requireAuth: true,
    });

    const response = await post(rejecting, { authorization: 'Bearer forged' });

    expect(response.status).toBe(401);
  });

  it('lets a verified caller through', async () => {
    const response = await post(app(), { authorization: 'Bearer good-token' });

    expect(response.status).toBe(200);
    expect((await response.json()).title).toBe('The WET Codebase — overreacted');
  });

  // Supabase being down is our problem, not the caller's. Answering 401 would
  // send someone chasing a login bug that does not exist.
  it('answers 503, not 401, when the check itself fails', async () => {
    const broken = createApp({
      scrape: scrapes(),
      supabase: fakeSupabase(() => {
        throw new Error('supabase unreachable');
      }),
      requireAuth: true,
    });

    const response = await post(broken, { authorization: 'Bearer good-token' });

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('auth-unavailable');
  });

  it('leaves /health open, because a load balancer has no token', async () => {
    expect((await app().request('/health')).status).toBe(200);
  });

  it('guards the job endpoints too', async () => {
    const response = await app().request('/jobs', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://a.test/' }),
    });

    expect(response.status).toBe(401);
  });
});

describe('when auth is optional', () => {
  it('allows an anonymous request', async () => {
    const app = createApp({
      scrape: scrapes(),
      supabase: fakeSupabase(() => user),
      requireAuth: false,
    });

    expect((await post(app)).status).toBe(200);
  });

  // Optional does not mean unchecked: a token that is presented is verified,
  // so a caller can never be mistaken for someone they aren't.
  it('still refuses a bad token when one is offered', async () => {
    const app = createApp({
      scrape: scrapes(),
      supabase: fakeSupabase(() => rejected),
      requireAuth: false,
    });

    expect((await post(app, { authorization: 'Bearer forged' })).status).toBe(401);
  });
});

describe('with no supabase configured', () => {
  it('does not authenticate at all', async () => {
    const app = createApp({ scrape: scrapes() });

    expect((await post(app)).status).toBe(200);
  });
});
