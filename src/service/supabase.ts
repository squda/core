import { createClient, type SupabaseClient } from '@supabase/supabase-js';

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
