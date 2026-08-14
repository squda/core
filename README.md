# core

URL in, clean Markdown out — the scraping half of a URL → scraped content → automated form
filling project. See [PLAN.md](./PLAN.md) for where it's going.

```console
$ pnpm scrape https://overreacted.io/the-wet-codebase/
The [Don’t Repeat Yourself](https://en.wikipedia.org/wiki/Don%27t_repeat_yourself) Wikipedia
article states:

> Violations of DRY are typically referred to as WET solutions, which is commonly taken to
> stand for “write every time”, “write everything twice”, “we enjoy typing” …
```

Pages that build themselves with JavaScript work too. It fetches over HTTP first and retries
with a real browser only when the result comes back empty:

```console
$ pnpm scrape https://excalidraw.com/ --verbose
· retrying with a browser — empty mount point <div id="root">
· fetched with browser — 556 characters of markdown
```

## Usage

```
pnpm scrape <url> [options]

  --format=md|json   markdown (default) or the whole document
  --browser=auto     retry with a browser when a page looks empty (default)
  --browser=never    plain HTTP only
  --browser=always   go straight to the browser
  -v, --verbose      log which path was taken, on stderr
```

Logs and errors go to stderr, so `pnpm scrape <url> > page.md` gets clean Markdown.

Exit codes: `0` ok · `1` usage · `2` invalid url · `3` timeout · `4` network · `5` http error ·
`6` not HTML · `70` unexpected.

## As a service

```console
$ pnpm serve
scrape service listening on http://localhost:3000 (cache: .cache/scrape.db)
```

| route           | what it does                                                         |
| --------------- | -------------------------------------------------------------------- |
| `POST /scrape`  | `{ url, browser? }` → the document now. Cached pages answer in ~2ms. |
| `POST /jobs`    | same body → `202` + a job id, for pages that need a browser          |
| `GET /jobs/:id` | `queued` / `running` / `done` / `failed`, with the document or error |
| `GET /health`   | browser pool and job counts                                          |

Responses carry `x-cache: hit|miss`. Env vars: `PORT`, `CACHE_PATH`, `BROWSER_CONCURRENCY`.

Results are cached for an hour, keyed on the normalised url plus fetch mode — so
`?utm_source=twitter` and `?utm_source=rss` are one entry. One browser is shared across all
requests behind a concurrency cap.

## How it fits together

```
  url ─► normaliseUrl ─► FetchStrategy ─► extractContent ─► toMarkdown ─► Zod ─► ScrapedDocument
                            │
                            ├── HttpStrategy      fetch(), ~200ms
                            └── BrowserStrategy   Playwright, ~600ms, runs the page's JS
```

`scrape()` knows nothing about the CLI, and the CLI knows nothing about HTTP mechanics. The
strategy is chosen by `select.ts`, a pure function over a fetch that already happened.

| where           | what lives there                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/core/`     | the pipeline: url → fetch result → document. Knows nothing about HTTP, browsers, databases or processes             |
| `src/fetching/` | getting the bytes: the `FetchStrategy` seam, the HTTP and browser implementations, the browser pool, the SSRF guard |
| `src/service/`  | the HTTP adapter: routes, cache, job queue                                                                          |
| `src/support/`  | primitives with no domain in them: concurrency limiter, logger, text                                                |
| `src/cli.ts`    | entry point — argv in, Markdown or JSON out                                                                         |
| `src/server.ts` | entry point — builds the cache, pool and logger, then listens                                                       |

Dependencies point one way: `service` and `cli` use `core` and `fetching`; `core` imports neither
of them. That is what let the HTTP adapter arrive without touching the scraper, and what will let
a different store arrive without touching either.

## Development

```
pnpm test           fast suite — no network, no browser (~3s)
pnpm test:browser   real Chromium against a local server (~11s)
pnpm typecheck
pnpm lint
pnpm format
```

Tests never hit the live network. `fixtures/` holds six real pages captured with
`npx tsx scripts/grab-fixture.ts <url> <name>`; see [fixtures/README.md](./fixtures/README.md).

Requires Node 22+, pnpm, and `npx playwright install chromium` for the browser path. Both entry
points refuse to start on anything older and say so in one line — `.nvmrc` pins the version, so
`nvm use` in the project directory is enough.

With Supabase configured, auth is required by default. For local poking, run
`REQUIRE_AUTH=0 pnpm serve`.
