import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { FetchError, HttpStatusError, type FetchErrorKind } from './fetch.js';
import { InvalidUrlError } from './url.js';
import { scrape } from './scrape.js';

/**
 * Phase 1, step 7 (the --format half) — the CLI.
 *
 *   pnpm scrape <url> [--format=md|json]
 *
 * Thin on purpose: read argv, call scrape(), print. In Phase 3 an HTTP handler
 * becomes a second adapter of exactly this shape, and anything that leaked in
 * here would have to be written twice.
 */

const USAGE = `scrape — url to markdown

usage:
  pnpm scrape <url> [--format=md|json]

options:
  --format=md     print the markdown (default)
  --format=json   print the whole ScrapedDocument
  --browser=auto  retry with a browser when a page looks empty (default)
  --browser=never plain HTTP only
  --browser=always go straight to the browser
  -v, --verbose   log which path was taken, on stderr
  -h, --help      this

exit codes:
  0 ok            2 invalid url     4 network failure   6 unsupported type
  1 usage         3 timeout         5 http error        70 unexpected
`;

const EXIT = {
  ok: 0,
  usage: 1,
  invalidUrl: 2,
  unexpected: 70,
} as const;

/**
 * A distinct code per failure kind, so a shell script can branch without
 * parsing our English. This is the same taxonomy Phase 3's HTTP layer will map
 * to status codes — one decision, two adapters.
 */
const EXIT_BY_FETCH_KIND: Record<FetchErrorKind, number> = {
  timeout: 3,
  network: 4,
  'http-status': 5,
  'content-type': 6,
};

export interface CliStreams {
  out: (text: string) => void;
  err: (text: string) => void;
}

const processStreams: CliStreams = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/**
 * Runs one invocation and returns the exit code. Never calls process.exit —
 * that belongs to the entry point below, and keeping it out of here is what
 * makes the CLI testable.
 */
export async function run(argv: string[], streams: CliStreams = processStreams): Promise<number> {
  let url: string | undefined;
  let format = 'md';
  let browser = 'auto';
  let verbose = false;

  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        format: { type: 'string', default: 'md' },
        browser: { type: 'string', default: 'auto' },
        verbose: { type: 'boolean', short: 'v', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
    });

    if (values.help) {
      streams.out(USAGE);
      return EXIT.ok;
    }

    [url] = positionals;
    format = values.format;
    browser = values.browser;
    verbose = values.help === false && values.verbose;

    if (positionals.length > 1) {
      return usageError(streams, `expected one url, got ${positionals.length}`);
    }
  } catch (error) {
    return usageError(streams, error instanceof Error ? error.message : String(error));
  }

  if (!url) return usageError(streams, 'no url given');
  if (format !== 'md' && format !== 'json') {
    return usageError(streams, `unknown format ${JSON.stringify(format)}, expected md or json`);
  }
  if (browser !== 'auto' && browser !== 'never' && browser !== 'always') {
    return usageError(
      streams,
      `unknown browser mode ${JSON.stringify(browser)}, expected auto, never or always`,
    );
  }

  try {
    // The log goes to stderr so `pnpm scrape url > page.md` still gets clean
    // markdown — the same reason errors do.
    const doc = await scrape(url, {
      browser,
      log: verbose ? (message) => streams.err(`· ${message}\n`) : () => {},
    });
    streams.out(format === 'json' ? JSON.stringify(doc, null, 2) + '\n' : doc.markdown + '\n');
    return EXIT.ok;
  } catch (error) {
    return reportFailure(streams, error);
  }
}

function usageError(streams: CliStreams, message: string): number {
  streams.err(`error: ${message}\n\n${USAGE}`);
  return EXIT.usage;
}

/**
 * The one place that turns an error type into something a person reads. Each
 * message says what happened *and* what to do about it, because "TimeoutError"
 * on its own has never helped anyone.
 */
function reportFailure(streams: CliStreams, error: unknown): number {
  if (error instanceof InvalidUrlError) {
    streams.err(`error: ${error.message}\n`);
    return EXIT.invalidUrl;
  }

  if (error instanceof FetchError) {
    streams.err(`error: ${error.message}\n${adviceFor(error)}\n`);
    return EXIT_BY_FETCH_KIND[error.kind];
  }

  streams.err(`unexpected error: ${error instanceof Error ? error.stack : String(error)}\n`);
  return EXIT.unexpected;
}

function adviceFor(error: FetchError): string {
  switch (error.kind) {
    case 'timeout':
      return 'the page may be slow or may need a browser — Phase 2 handles that.';
    case 'network':
      return 'check the hostname and your connection.';
    case 'http-status':
      return adviceForStatus(error instanceof HttpStatusError ? error.status : 0);
    case 'content-type':
      return 'this scraper only reads HTML pages.';
  }
}

function adviceForStatus(status: number): string {
  if (status === 404) return 'no page at that url.';
  if (status === 401 || status === 403)
    return 'the server refused us — it may want a real browser or a login.';
  if (status === 429) return 'rate limited. Wait, then try again more slowly.';
  if (status >= 500) return "the server is having trouble — that one isn't ours.";
  return 'the server refused the request.';
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await run(process.argv.slice(2));
}
