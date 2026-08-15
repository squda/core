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

  /**
   * The open `/demo` endpoint: reads per caller per window.
   *
   * Everything else needs a token. This one is what the public waitlist page
   * calls, so the cap is what stands between a demo and a free scraping API.
   */
  demoRateLimit: z.coerce.number().int().positive().default(10),
  demoWindowMs: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 60 * 1000),

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

  /**
   * Browser origins allowed to call this service, comma-separated.
   *
   * Empty means no CORS headers, which is the right default: a service with no
   * browser client should not advertise itself to one. `apps/web` sets
   * `CORS_ORIGINS=http://localhost:5173` in development.
   */
  corsOrigins: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),

  /**
   * Chromium launch flags, comma-separated. Empty on a laptop.
   *
   * A container almost always needs `--no-sandbox,--disable-dev-shm-usage`;
   * see `CONTAINER_CHROMIUM_ARGS` for why each one, and why neither is a
   * default. The Dockerfile sets this, so nothing has to be remembered at
   * deploy time.
   */
  chromiumArgs: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((flag) => flag.trim())
        .filter((flag) => flag.length > 0),
    ),
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
    demoRateLimit: env.DEMO_RATE_LIMIT,
    demoWindowMs: env.DEMO_WINDOW_MS,
    allowPrivate: env.SCRAPE_ALLOW_PRIVATE,
    supabase,
    requireAuth: env.REQUIRE_AUTH,
    corsOrigins: env.CORS_ORIGINS,
    chromiumArgs: env.CHROMIUM_ARGS,
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
