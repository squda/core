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

Results are cached in SQLite for an hour, keyed on the normalised url plus fetch mode — so
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

| file                  | job                                                             |
| --------------------- | --------------------------------------------------------------- |
| `url.ts`              | canonical URL for fetching and caching; link resolution         |
| `fetch.ts`            | the HTTP GET, and the error taxonomy everything else uses       |
| `strategy.ts`         | the `FetchStrategy` interface                                   |
| `http-strategy.ts`    | `fetchPage` behind that interface                               |
| `browser-strategy.ts` | Playwright behind the same interface                            |
| `select.ts`           | "was that result empty enough to retry?"                        |
| `structured.ts`       | JSON-LD and RSS/Atom — the surfaces a site publishes on purpose |
| `wall.ts`             | login walls, bot checks, consent screens — 200 OK, wrong page   |
| `extract.ts`          | strip the junk, find the article                                |
| `markdown.ts`         | HTML → Markdown, every URL resolved absolute                    |
| `scrape.ts`           | composes them; validates with Zod                               |
| `cli.ts`              | argv in, Markdown or JSON out, exit codes on failure            |

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

Requires Node 20+, pnpm, and `npx playwright install chromium` for the browser path.
