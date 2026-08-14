/**
 * The contract between the halves of this system.
 *
 * Nothing in here fetches, parses, stores or renders. It is Zod and types and
 * the reasoning behind them, so that every other package — the scraper, the
 * service, the web app, and whatever executes a fill — can agree on the shape
 * of a form without agreeing on anything else.
 *
 * That is also why it is its own package rather than a folder inside `core`:
 * `apps/web` must be able to import `FormSpec` without importing Playwright,
 * jsdom, or a database driver. A dependency it cannot express is a dependency
 * it cannot accidentally acquire.
 *
 * Rule for this package: **zero dependencies except zod.** If something here
 * needs a second one, it belongs in `core`.
 */

/*
 * Extensionless on purpose. This package ships TypeScript source rather than
 * built output, so its consumers are the ones that resolve this path — and they
 * do not agree on the `.js`-means-`.ts` convention that Node's ESM loader
 * needs. `moduleResolution: bundler` is what makes it legal, and it is the
 * right mode here precisely because every consumer is a bundler or tsx.
 */
export * from './form-spec';
