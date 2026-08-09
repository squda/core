import { scrape } from './scrape.js';

/**
 * Phase 1, step 7 (the --format half) — the CLI. [fetch side]
 *
 * Usage:  pnpm scrape <url> [--format=md|json]
 *
 * Keep this thin. Everything it does should be: read argv, call scrape(),
 * print. In Phase 3 an HTTP handler becomes a second adapter of exactly this
 * shape, and if any real logic leaked in here you'll have to write it twice.
 *
 * TODO:
 *  - parse argv (node:util parseArgs is in the stdlib — you do not need commander)
 *  - --format=md prints doc.markdown, --format=json prints the whole object
 *  - errors go to stderr with a non-zero exit code, not to stdout
 */
async function main(): Promise<void> {
  throw new Error('not implemented: cli');
}

await main();
