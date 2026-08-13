import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * supabase-js builds a realtime client eagerly, and that constructor throws
 * without a global WebSocket. Node has had one since 22; this project runs on
 * 20, so it is supplied here.
 *
 * Nothing in this service uses realtime — the shim exists purely so the
 * constructor completes. Deleting it is part of the Node 22 upgrade, which
 * Supabase is already warning about and which also unpins better-sqlite3.
 */
if (typeof globalThis.WebSocket === 'undefined') {
  const { WebSocket } = await import('ws');
  (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
}

/**
 * The service's connection to Supabase.
 *
 * Created with the **service role** key, which bypasses row-level security.
 * That is the deliberate choice recorded in PLAN.md: this is a backend that
 * already knows who the caller is (it verified their token), so it does its
 * own authorisation and RLS is the backstop rather than the mechanism.
 *
 * The consequence is worth stating plainly: any query written here runs with
 * full access. `owner_id = user.id` is a condition we must remember to write,
 * not one Postgres will add for us.
 */
export function createServiceClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: {
      // A server has no session to persist and no token to refresh in the
      // background; both would be a slow leak in a long-lived process.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export type { SupabaseClient };
