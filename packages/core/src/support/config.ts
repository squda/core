import { z } from 'zod';

/**
 * Configuration, validated once at boot.
 *
 * Phase 9 step 2: a process that refuses to start on a bad config, rather than
 * one that starts happily and fails on the first request that needs the thing
 * you typoed. A missing SUPABASE_URL should not surface as `undefined` in a
 * fetch three layers down.
 */

const BooleanFromEnv = z
  .enum(['0', '1', 'true', 'false'])
  .transform((value) => value === '1' || value === 'true');

export const ConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /** Pages fetched by a browser at once. Each is a context, not a browser. */
  browserConcurrency: z.coerce.number().int().positive().default(2),
  /** Jobs run at once, above the browser cap. */
  jobConcurrency: z.coerce.number().int().positive().default(4),
  /** Jobs allowed to wait before the service answers 503. */
  maxQueued: z.coerce.number().int().positive().default(100),

  /** Allow scraping private/loopback addresses. Never in production. */
  allowPrivate: BooleanFromEnv.default('0'),

  supabase: z
    .object({
      url: z.string().url(),
      /**
       * The service role key bypasses row-level security. It is a server
       * secret: it must never reach a browser, a log line, or a repository.
       */
      serviceRoleKey: z.string().min(20),
    })
    .optional(),

  /**
   * Require a verified Supabase token on scrape endpoints.
   *
   * Defaults to on whenever Supabase is configured: a service that can be
   * called anonymously by accident is worse than one that refuses on the first
   * request while you fix the header.
   */
  requireAuth: BooleanFromEnv.optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const supabase =
    env.SUPABASE_URL || env.SUPABASE_SERVICE_ROLE_KEY
      ? { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY }
      : undefined;

  const parsed = ConfigSchema.safeParse({
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    browserConcurrency: env.BROWSER_CONCURRENCY,
    jobConcurrency: env.JOB_CONCURRENCY,
    maxQueued: env.MAX_QUEUED,
    allowPrivate: env.SCRAPE_ALLOW_PRIVATE,
    supabase,
    requireAuth: env.REQUIRE_AUTH,
  });

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`invalid configuration:\n${problems}`);
  }

  return {
    ...parsed.data,
    requireAuth: parsed.data.requireAuth ?? parsed.data.supabase !== undefined,
  };
}
