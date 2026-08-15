# untitled

URL in, clean Markdown out — the scraping half of a URL → scraped content → automated form
filling project. See [PLAN.md](./PLAN.md) for where it's going.

```
packages/schema/   FormSpec — the contract. Zod and types, nothing else.
packages/core/     the scraper, the fetch strategies, the HTTP service.
apps/web/          paste a url, see every field on the page and where its name came from.
```

`pnpm serve` runs the service, `pnpm web` runs the demo against it, `pnpm dev` runs both.

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

Content behind a click comes too. Tabs, accordions and `<details>` are opened before the page
is read, and a tab panel the page unmounts when you open the next one is collected while it is
still on screen. Only elements that declare themselves as disclosures are touched — `<details>`,
`aria-expanded`, `role="tab"` — so a button that merely says "Show more", or "Sign out", is left
alone. See `src/fetching/expand.ts`.

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

| route                 | what it does                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `POST /scrape`        | `{ url, browser? }` → the document now. Cached pages answer in ~2ms.                          |
| `POST /jobs`          | same body → `202` + a job id, for pages that need a browser                                   |
| `GET /jobs/:id`       | `queued` / `running` / `done` / `failed`, with the document or error                          |
| `GET /form-spec?url=` | the same page read for structure: every form, every field, every label and where it came from |
| `GET /demo?url=`      | both halves in one call, for the public page. No token; rate limited instead                  |
| `GET /health`         | browser pool and job counts                                                                   |

Responses carry `x-cache: hit|miss`. Env vars: `PORT`, `CACHE_PATH`, `BROWSER_CONCURRENCY`,
`CORS_ORIGINS` (comma-separated; empty means no CORS headers at all, which is the default).

Results are cached for an hour, keyed on the normalised url plus fetch mode — so
`?utm_source=twitter` and `?utm_source=rss` are one entry. One browser is shared across all
requests behind a concurrency cap.

## The demo

```console
$ pnpm dev          # service on :3000, demo on :5173
```

Next.js App Router, Tailwind and shadcn. A waitlist page whose argument is the demo: paste a url and
it reports both halves of what the scraper does — the page as Markdown, and every box on it with
what it's called, where that name came from, and whether it's marked sensitive.

The browser never talks to the service directly — `app/api/[...path]/route.ts` forwards everything
under `/api` to it. So there is no CORS to configure, and `SCRAPE_SERVICE_URL` stays on the server
instead of being baked into the bundle. The demo reads through `/demo`, the one endpoint that takes
no token.

It fills nothing. That's Phase 7.

## How it fits together

```
  url ─► normaliseUrl ─► FetchStrategy ─► extractContent ─► toMarkdown ─► Zod ─► ScrapedDocument
                            │
                            ├── HttpStrategy      fetch(), ~200ms
                            └── BrowserStrategy   Playwright, ~600ms, runs the page's JS
```

`scrape()` knows nothing about the CLI, and the CLI knows nothing about HTTP mechanics. The
strategy is chosen by `select.ts`, a pure function over a fetch that already happened.

| where                         | what lives there                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/schema/`            | `FormSpec` and the reasoning behind each field. Zero dependencies except zod, so a browser can import it            |
| `packages/core/src/core/`     | the pipeline: url → fetch result → document. Knows nothing about HTTP, browsers, databases or processes             |
| `packages/core/src/fetching/` | getting the bytes: the `FetchStrategy` seam, the HTTP and browser implementations, the browser pool, the SSRF guard |
| `packages/core/src/service/`  | the HTTP adapter: routes, cache, job queue                                                                          |
| `packages/core/src/support/`  | primitives with no domain in them: concurrency limiter, logger, config, text                                        |
| `packages/core/src/cli.ts`    | entry point — argv in, Markdown or JSON out                                                                         |
| `packages/core/src/server.ts` | entry point — builds the cache, pool and logger, then listens                                                       |
| `apps/web/`                   | the demo: Next.js App Router, one page, plus a proxy route so the browser never calls the service directly          |

Dependencies point one way: `service` and `cli` use `core` and `fetching`; `core` imports neither
of them. That is what let the HTTP adapter arrive without touching the scraper, and what will let
a different store arrive without touching either.

The same rule one level up. `packages/schema` depends on nothing but zod; everything else depends
on it. That is why `apps/web` can validate a `/form-spec` response with the very schema the server
validated it with, and why it has no way to reach Playwright or a database driver even by accident.

## Development

```
pnpm test           fast suite — no network, no browser (~3s)
pnpm test:browser   real Chromium against a local server (~11s)
pnpm typecheck      every package
pnpm lint
pnpm format
```

Tests never hit the live network. `packages/core/fixtures/` holds fifteen real pages captured with
`npx tsx scripts/grab-fixture.ts <url> <name>` from inside `packages/core`; see
[the fixtures README](./packages/core/fixtures/README.md).

Requires Node 22+, pnpm, and `npx playwright install chromium` for the browser path. Both entry
points refuse to start on anything older and say so in one line — `.nvmrc` pins the version, so
`nvm use` in the project directory is enough.

With Supabase configured, auth is required by default on `/scrape`, `/form-spec` and `/jobs`. For
local poking, run `REQUIRE_AUTH=0 pnpm serve`.

`/health` and `/demo` stay open. `/demo` is the one the public waitlist page calls, and it pays for
being open: ten reads per caller per ten minutes (`DEMO_RATE_LIMIT`, `DEMO_WINDOW_MS`), markdown
truncated at 20,000 characters, and `browser=always` refused — `auto` still escalates on a page
that is genuinely empty, so an SPA works, but nobody can force the expensive path on a page that
never needed it.

The web app needs its own `apps/web/.env.local`; Next reads env files from its own directory and
cannot see the root `.env`. See `apps/web/.env.example`.

## Deploying

One Dockerfile, two runtimes. Podman locally, Docker where it deploys — the file is plain
Dockerfile syntax with nothing specific to either.

```console
$ podman build -f packages/core/Dockerfile -t squda-core .   # local
$ podman run -p 8080:8080 --env-file .env squda-core
```

Built from the repository root, because that is where the workspace lockfile lives. The base image
is Playwright's own, pinned to the exact library version in `package.json` — a floating tag becomes
`Executable doesn't exist at /ms-playwright/chromium-…` on some future rebuild, with nothing in the
diff to explain it. Bump both together or neither.

**Building on an Apple Silicon machine to push somewhere else needs `--platform linux/amd64`.**
Podman and Docker both build for the host by default, so an image built here is arm64, and a host
expecting amd64 answers with `exec format error` — a message that says nothing about architecture
and sends you looking at the entrypoint. Building on the platform instead (Cloud Build, Render, a
GitHub Action) sidesteps it entirely, which is the better answer when it is available.

The Dockerfile sets `CHROMIUM_ARGS=--no-sandbox,--disable-dev-shm-usage`, which a container needs
and a laptop does not.

On a server, run it under a restart policy:

```console
$ docker run -d --restart unless-stopped -p 80:8080 --env-file .env squda-core
```

That is the recovery path for the one failure this service cannot catch: Playwright reports some
browser crashes from a CDP callback rather than from the call you made, so they arrive as uncaught
exceptions and take the process with them. Nothing in the code can catch those — and a process
manager restarting a fresh container in two seconds is a better answer than a service that keeps
running with a browser it no longer trusts.

`apps/web` deploys separately as an ordinary Next.js app, and needs `SCRAPE_SERVICE_URL` pointing
at wherever the service landed.
