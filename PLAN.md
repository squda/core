# Plan — URL → Scraped Content → Automated Form Filling

**Stack:** TypeScript / Node throughout (pnpm, `tsx`, Vitest, Zod).
**Fill surface:** browser automation — Playwright server-side for public pages and every test;
the user's own browser, via an extension, for anything behind a login. See the Phase 7 decision.
**Purpose:** a production system, built for learning. Every phase is chosen partly for what it
forces you to confront — but the target is something deployable, not a demo, which is why Phase 9
is deployment rather than a footnote.
**Two features, not one.** Scraping is a product in its own right — URL in, clean Markdown or JSON
out — and form filling is the second thing built on top of it. Part A ships something usable on its
own; Part B is not the only reason it exists.
**Working solo.** Each phase gives an order of work rather than a split, and the "Done when" is the only reviewer you have.

No timelines. Phases are sized so each one **ends in something you can run**. Don't start a phase until the previous one's "Done when" is actually true.

---

## The shape of the whole thing

```
  URL ──► [Scraper]  ──► Markdown / JSON        (Part A)
                     └─► FormSpec               (the bridge)
                                │
  User info ──► [Profile store] │               (Part B)
                                ▼
                          [Matcher] ──► FillPlan
                                          │
                                          ▼
                                    [Filler] ──► form filled in a real browser
```

Five moving parts. Part A is the whole first half of the project; Part B is the second. The **FormSpec** in the middle is the contract between them — get it wrong and the two halves won't meet.

---

## Where the code lives

> **Decided 2026-08-15.** One repository, four packages. The question that forced it was whether
> the client should be its own repo — with a mobile app maybe coming later.
>
> ```
> packages/schema/   FormSpec, and later Profile and FillPlan. Zod and types, nothing else.
> packages/core/     the scraper, the fetch strategies, the service. Was the whole repo.
> apps/web/          the demo, and later the review UI of Phase 8.
> apps/extension/    not built yet. See the Phase 7 decision.
> ```
>
> **Why not two repos:** the valuable thing here is the contract, not either half. Split the repo
> and `FormSpec` either gets duplicated — where it drifts silently, which the Phase 4 note above
> explicitly warns against — or gets published as a private package, so every added field becomes
> a version bump and an install. Repos should split when deploy cadence, CI or teams diverge.
> Working solo, none of those do.
>
> **Why `schema` is its own package rather than a folder in `core`:** so `apps/web` can import
> `FormSpec` without being able to import Playwright, jsdom, or a database driver. A dependency
> you cannot express is a dependency you cannot accidentally acquire. Its rule: **zero
> dependencies except zod.**
>
> **No mobile app.** The fill surface is a browser; a phone cannot run one. The only part of this
> that suits a phone is approving a FillPlan someone else prepared — a notification and one
> screen, over the same HTTP API. If that is ever worth building it goes in `apps/mobile/` beside
> the others, still not a second repo.

---

## What we are actually building, and for whom

> ### Decision — resolved 2026-08-15
>
> **Build the engine general. Choose the market from usage, not from a guess.**
>
> The alternative considered was picking a vertical up front — the strongest candidate being
> re-keying the same facts into many regulated portals (clinician licensing and credentialing,
> insurance submissions), because that is where the event log, the confidence score, and
> dry-run-before-submit stop being engineering taste and become the customer's compliance
> requirement.
>
> **Why we are not doing that yet:** a vertical is only reachable if you can reach it. With no
> contacts in any of those industries, "find five staffing agencies" is a harder problem than
> building the entire product, and it would be attempted with no working demo in hand.
>
> **What general-first actually means here.** Not "fill any form adequately" — that product is
> Magical, Fillify, and half a dozen extensions, and Chrome shipped agentic browsing in 2026, so
> it is a bad place to stand. It means: the engine is domain-neutral, the first market is
> whichever one the numbers point at, and until they point somewhere the tool is free and wide.
> Job applications are the obvious front door — high volume, people already search for it, and
> every application submitted feeds the matcher a real `observedLabel` from a real form. It is a
> weak business and an excellent sensor. Treat it as the sensor.
>
> **The condition that makes this work:** it is instrumented from the day it ships. A general
> tool nobody measures teaches you nothing. See _What we measure_ before Phase 9.
>
> **The checkpoint, written down now while it is easy to be honest.** Four months after it is in
> anyone's hands, if no group of users has come back week after week, that is an answer too: the
> tool is a trick rather than a need. Change direction then rather than building more of it.

---

# PART A — Scraping

## Phase 1 — One-shot CLI scraper for static pages

**Goal:** `pnpm scrape https://example.com` prints clean Markdown to stdout.

**Steps**

1. Repo setup: pnpm workspace, TypeScript strict mode, `tsx` for running, Vitest for tests, Prettier + ESLint.
2. A `fetchPage(url)` that does an HTTP GET with a real User-Agent, follows redirects, and has a timeout.
3. Validate and normalise the input URL before fetching (reject non-http(s), strip fragments, resolve relative paths).
   > **Decision — resolved 2026-08-13 (the `?utm_source=` question).** Strip tracking params
   > (`utm_*` plus an explicit list: `fbclid`, `gclid`, `ref`, …), keep everything else, and sort
   > what remains. Tracking params identify the _referral_, not the page, so keeping them caches
   > the same document once per traffic source in Phase 3. Unrecognised params stay, because a
   > stripped `?id=42` silently fetches the _wrong page_ — a much worse failure than a duplicate
   > cache entry. The list lives in `src/url.ts`; add to it when a real URL warrants it.
4. Parse HTML with `cheerio`. Strip `<script>`, `<style>`, `<nav>`, `<footer>`, ads.
5. Extract the main content. Start with `@mozilla/readability` + `jsdom` — it's the same algorithm Firefox Reader Mode uses. Fall back to `<body>` when Readability returns nothing.
   _(Yes, that's two HTML parsers: cheerio for fast surgical stripping, jsdom because Readability needs a real DOM. Deliberate — you'll feel the difference in speed between them, which is the lesson.)_
6. Convert the resulting HTML to Markdown with `turndown`. Resolve relative links and image `src` to absolute URLs.
7. Define the output shape with Zod:
   ```ts
   { url, fetchedAt, title, description, markdown, links: [{href, text}], images: [{src, alt}] }
   ```
   `--format=md|json` switches between printing `markdown` and the whole object.
8. Save 5–6 real HTML pages into `fixtures/` and write tests against those files — **never** against the live network.

**Done when:** you can scrape a blog post, a docs page, and a Wikipedia article, and the Markdown is genuinely readable. — **Done 2026-08-13.**

> **Added afterwards (2026-08-13):** read the surfaces a site publishes deliberately — JSON-LD
> (`structured`) and RSS/Atom links (`feeds`) — before trusting anything extraction inferred. They
> are never blocked, often cleaner, and JSON-LD's `articleBody` is a better fallback than a `<body>`
> dump when Readability finds nothing. `sitemap.xml` is a _crawl_ surface, so it sits in Phase 10.

**Order of work:** read `src/types.ts` first — it's the contract everything else in this phase plugs into, and it's already written. Then `normaliseUrl` (its tests are already red and waiting), then `fetchPage`, then extract → markdown. Save one fixture early and drive `scrapeHtml` straight off the file, so you aren't re-fetching the network every time you change a line.

**What you'll learn**

- The Node HTTP client story (`fetch`/`undici`), timeouts, redirects, and why User-Agent matters.
- How HTML is actually structured, and why "get the main content" is a heuristic problem, not a parsing problem — read what Readability does.
- **Parse, don't validate:** using Zod as the boundary where untyped outside data becomes a typed object.
- Fixture-based testing, and why a test that hits the network isn't a test.
- Scraping etiquette as a real engineering concern: `robots.txt`, rate limiting, and the fact that a lot of sites' terms prohibit this. Worth reading now, not later.

---

## Phase 2 — JavaScript-rendered pages

**Goal:** the same command works on a page whose content only exists after JS runs.

**Steps**

1. Add Playwright. Launch Chromium headless, `page.goto(url)`, wait for the network to settle, then hand `page.content()` to the _exact same_ extract/convert pipeline from Phase 1.
2. Put both behind one interface:
   ```ts
   interface FetchStrategy {
     fetch(url: string): Promise<{ html: string }>;
   }
   ```
   with `HttpStrategy` and `BrowserStrategy` as the two implementations.
3. Add strategy selection: try HTTP first; if the extracted text is suspiciously short or the body is an empty React root, retry with the browser. Log which path was taken.
4. Reuse one browser instance across scrapes instead of launching per-request — measure the difference.
5. Handle the failure modes explicitly: timeout, 404, non-HTML content-type, infinite-scroll pages, cookie banners covering the content.

**Done when:** a client-rendered page (any SPA-based site) produces the same quality of Markdown as a static one, and you can see in the logs which strategy ran. — **Done 2026-08-14**, step 5 included: consent banners are dismissed before reading, `scrollPasses` gives infinite feeds a budget, and a page that never reaches `networkidle` falls back to `domcontentloaded` rather than timing out.

**Order of work:** define `FetchStrategy` and retrofit the Phase 1 code as `HttpStrategy` _before_ Playwright exists — if the interface is right, adding `BrowserStrategy` afterwards touches nothing around it, and that's the phase's real lesson. Then get one SPA rendering, then the selection heuristic, then the error taxonomy last, once you've actually seen the failures rather than imagined them.

**What you'll learn**

- What a headless browser actually _is_, and precisely why `fetch` returns an empty div on an SPA.
- The **Strategy pattern** — and the more important lesson that a good interface lets you swap something this large without touching the code around it.
- Page lifecycle events: `load` vs `domcontentloaded` vs `networkidle`, and why waiting on the right one is the whole game.
- Resource management: browser instances are expensive and leak if you don't close them.
- Designing an error type that callers can branch on, instead of throwing strings.

---

## Phase 3 — Turn it into a service

**Goal:** `POST /scrape { url }` returns the Markdown/JSON over HTTP.

**Steps**

1. Wrap the scraper in **Hono**. One endpoint, Zod-validated request body.
2. Keep the CLI. It should now be a thin client over the same core function — proof that your core has no HTTP assumptions baked into it.
3. Cache results keyed by normalised URL, with a TTL. Write the SQL by hand here — Phase 5 introduces Drizzle over the same database, and the contrast is the point: you'll know what the ORM is buying you because you'll have done it without one.
   > **Changed 2026-08-14.** This said SQLite via `better-sqlite3`, and it was, until Supabase
   > arrived. Postgres is now the store and the hand-written SQL lives in `supabase/migrations/`,
   > so the contrast Phase 5 wants is intact. SQLite itself is gone: it was the project's only
   > native module — a build approval, a version pin, and the thing that made the Node 22 upgrade
   > segfault — and once Postgres existed, the local store's only remaining job was to stop a dev
   > loop refetching a page. A Map does that.
4. A job queue for slow browser scrapes: `POST /scrape` returns a job id immediately, `GET /jobs/:id` returns status and result. An in-memory queue is fine at this stage.
5. Concurrency limit on browser scrapes so ten requests don't launch ten Chromiums.
6. Structured logging with a request id threaded through.
7. **Make the queue safe under real load** (added 2026-08-14, once "production" became the target):
   - **Deduplicate in-flight work.** The same url submitted five times must be one scrape with
     five subscribers, not five browser fetches. The cache only helps _after_ the first finishes.
   - **Bound the intake.** The limiter caps what runs, not what can be submitted; ten thousand
     POSTs is ten thousand jobs in memory. Reject past a queue depth with 429 and `Retry-After`.
   - **Per-job timeout and cancellation**, so one hung page can't hold a slot for its full 30s.
   - **Tell "expired" apart from "never existed"** — both are 404 today, which is a lie in one
     of the two cases. 410 Gone for a job we retired.

**Done when:** you can `curl` a URL and get Markdown back, slow pages go through the job flow, and the second request for the same URL is served from cache.

> **Done 2026-08-14.** `POST /scrape` (sync), `POST /jobs` + `GET /jobs/:id` (async), SQLite cache
> keyed on the normalised url, one shared browser behind a concurrency cap, JSON logs carrying a
> request id from `x-request-id` through the queue and into `scrape()`, and a queue that
> deduplicates in-flight urls, refuses work past a backlog limit (503 + `Retry-After`), aborts a
> job that outruns its budget, and answers 410 rather than 404 for a job it retired.

**Order of work:** HTTP layer first, as thin as you can make it — if the core needs _any_ change to get a second adapter, that's the finding. Then the cache (synchronous, easy to test), then the job queue, then the concurrency limit. Four separately demoable steps; resist building them at once.

**What you'll learn**

- Layering: core logic that knows nothing about HTTP, with CLI and HTTP as two thin adapters over it. This is the single most transferable idea in the project.
- Cache key design and invalidation — normalising `?utm_source=` away is a real decision.
- Why long work can't live in a request/response cycle, and what a job queue actually solves.
- Backpressure and concurrency limits.

---

# THE BRIDGE

## Phase 4 — FormSpec: extracting the form, not the prose

**This is the most important phase in the plan.** Phases 1–3 give you _prose_. Filling a form needs _structure_. If you skip this, Part B restarts from zero.

**Goal:** point the scraper at a page containing a form and get back a machine-readable description of every field.

**Steps**

1. Design the `FormSpec` schema (Zod). Roughly:
   ```ts
   FormSpec  = { url, forms: Form[] }
   Form      = { selector, action, method, fields: Field[], submitSelector }
   Field     = {
     selector,               // how to find it again in the browser
     name, id,
     type,                   // text | email | tel | date | select | checkbox | radio | textarea | file
     label,                  // the visible label — from <label for>, aria-label, placeholder, or nearby text
     required, placeholder,
     options?: {value,label}[],   // for select / radio
     maxLength?, pattern?
   }
   ```
2. Walk the DOM for `<input>`, `<select>`, `<textarea>`, and `role="textbox"` / `contenteditable` elements.
3. Label resolution, in priority order: `<label for=id>` → wrapping `<label>` → `aria-label` / `aria-labelledby` → `placeholder` → nearest preceding text node. Test each path — this is where real sites are messiest.
4. Generate a **stable selector** per field. Prefer `#id`, then `[name=]`, then a scoped CSS path. Do _not_ use auto-generated class names — they change on every deploy.
5. Add `GET /form-spec?url=` to the service.
6. Build a fixture set of 8–10 real forms: a job application, a signup, a checkout, a government form, a multi-step wizard. Snapshot-test the FormSpec for each. — **Completed and strengthened 2026-08-21.** The canonical suite now snapshots ten real forms, including all five named categories. A supplementary shadow-DOM capture is kept outside that suite because saved HTML cannot materialize its roots. Snapshots use readable tables with long options rendered one per line. The government fixture records the first state of GOV.UK's student-finance wizard; deterministic browser tests traverse a two-step server-backed wizard, and the optional live smoke check verifies the production path against GOV.UK itself.

**Done when:** you can point it at a real signup form and get back a JSON list of fields with correct human-readable labels. — **Done and reverified 2026-08-21.** The production browser inspector returns Email Address, Password and Confirm Password from the public QA Practice signup, card/expiry/CVV controls from a public test checkout, and multiple observed states from GOV.UK's eligibility wizard. It also returns structured iframe/shadow-root locator hops and honest warnings when wizard traversal stalls or covers only one branch.

**Order of work:** write the `FormSpec` Zod schema first and then leave it alone for the rest of the phase — everything in Part B is built against it. Collect the fixtures _before_ writing the walker, so you're designing against real messiness instead of an imagined form. Then field discovery + selectors, then label resolution, then the snapshots.

**What you'll learn**

- HTML form semantics properly — including how accessibility attributes (`aria-*`, `<label for>`) are the same information a screen reader uses. Accessible forms are scrapeable forms.
- **Schema-first design:** writing the type before the code, and letting the type be the contract between two people working in parallel.
- Selector stability — the thing every flaky browser test is really about.
- Snapshot testing, and its trap: a snapshot only tells you something _changed_, not that it's _correct_.

---

## Phase 4½ — The demo (`apps/web`)

**Built 2026-08-15, out of order and deliberately small.** The plan puts the first UI in Phase 8,
and that is still where the _review_ screen belongs. This is a different thing: a page that shows
what already works, so there is something to point at before Part B exists.

**What it is:** one page. Paste a url, it calls `GET /form-spec`, and it reports every box on the
page — what the box is called, **where that name came from**, and whether we'd trust it.

**What it deliberately is not:** a profile editor, a fill screen, or anything that pretends Part B
is finished. It fills nothing.

> **Rebuilt on Next.js the same day.** It was Vite + React for an afternoon; the App Router replaced
> it before any design was committed to, which is the cheapest possible moment for that change. The
> reasons that survive the switch:
>
> - **A server the client owns.** `app/api/[...path]/route.ts` forwards everything under `/api` to
>   the service, so the browser only ever speaks to one origin. That removes CORS from the deployed
>   story rather than configuring it, and keeps `SCRAPE_SERVICE_URL` on the server instead of baked
>   into a bundle — which starts mattering the moment these calls carry a token.
> - **Room for Phase 8.** The review UI needs sessions, a profile, and server-rendered pages behind
>   a login. That is the App Router's job description, and retrofitting it onto a static SPA later
>   would be the rewrite this switch avoids.
>
> The page itself is currently an unstyled template — a form, a state machine, and a JSON dump —
> awaiting a design. What the template already fixes is the shape: **the four states are idle,
> reading, read, failed**, and errors carry the service's `{ code, message }` rather than a string.
> Getting those wrong is the usual reason a redesign becomes a rewrite.

**The one design decision worth keeping when the design lands.** Build the page around
`labelSource`, not around the labels. Showing that a field was named by `<label for>` versus scraped
off nearby text shows the reader the system's own uncertainty — the honest answer to "what can you
fill?", and the thing no autofill extension displays. It also puts the number that matters on
screen: of the boxes a person fills, how many can we name.

Two supporting changes came with it and both outlive the framework:

- **CORS on the service**, as an explicit origin list (`CORS_ORIGINS`), empty by default. Not `*`:
  the moment auth is required, a wildcard origin with credentials hands any page on the internet a
  caller's token. The Next proxy means the web app no longer needs it — it stays for any other
  browser client, and the extension will be one.
- `form-spec.ts` moved to `packages/schema`, and the client parses responses with the same
  `FormSpecSchema` the server validated them with. That is the monorepo decision earning itself
  back on the first day: the client cannot drift from the contract, because it imports it.

**Done when:** you can hand someone a url and they understand what this does without you talking. —
**Plumbing done 2026-08-15; waiting on a design.**

---

# PART B — Form Filling

## Phase 5 — The profile store ("memory")

> ### Decision — resolved 2026-08-09
>
> The three candidate meanings of "memory" were:
> **(a)** a flat structured profile — `{ firstName, email, phone, addressLine1 }`;
> **(b)** an embedding store, so "what is your postal code?" fuzzy-matches to `zip`;
> **(c)** an append-only log of past submissions, learning from what you've filled before.
>
> **We are building all three, because they are not alternatives — they are three different jobs.**
> (a) is _where values live_. (b) is a _translator_ from a form's wording to our canonical keys.
> (c) is a _diary_ of every value ever entered or corrected.
>
> **Why:** forms name the same thing in wildly different ways, so we need (b); and user
> information should accumulate as we go rather than being hand-maintained, so we need (c).
> But neither (b) nor (c) can answer the only question the filler actually asks — _what is this
> person's postal code right now?_ — so (a) stays. It is no longer hand-maintained, though:
> **the profile is a projection of the log**, computed by folding the events and taking the
> most recent (or highest-trust) value per canonical key.
>
> The two compound. Every correction in Phase 8 appends an event that carries a _real_ label
> from a _real_ form, which then feeds the embedding index. Embedding only our own invented
> alias list would be fuzzy string matching with extra steps; embedding labels the world has
> actually shown us is what makes (b) earn its place.
>
> **Sequencing: the log lands in Phase 5, the embeddings in Phase 6.**
> The log is structural and cannot be retrofitted — a month of overwriting rows leaves no
> history to recover. The embedding index is _derived data_: rebuildable from the log at any
> time, with no migration and nothing lost. It also belongs in Phase 6 on the merits, since
> it is a matching layer; building it in Phase 5 means guessing what a matcher we haven't
> written yet will need.
>
> **Accepted cost:** Phase 5 is meaningfully bigger than a plain profile table would have been.

**Goal:** record everything we know about the user as an append-only log, and read the current profile back out of it.

**Steps**

1. Design the profile schema. Group it: identity, contact, address, employment, documents. Every field gets a canonical key (`address.postalCode`) and a set of **aliases** (`zip`, `zipcode`, `pin code`, `postcode`) — the aliases are the seed vocabulary the Phase 6 matcher and embedding index both build on.
2. **Drizzle ORM** over the Supabase Postgres (not SQLite — see the Phase 3 note), with
   migrations from day one. The tables already exist in `supabase/migrations/0002_profile.sql`.
3. The **event log** — append-only, never updated, never deleted:
   ```ts
   FieldEvent = {
     id, observedAt,
     canonicalKey,           // 'address.postalCode'
     value,
     source,                 // 'seed' | 'user-edit' | 'form-fill' | 'correction'
     confidence,
     observedLabel?,         // the exact text the form used, when it came from a form
     url?                    // where we saw it
   }
   ```
   `observedLabel` is the field that makes Phase 6's index worth building — guard it.
4. The **projection**: `getProfile()` folds the log into current values per canonical key. Write it as a pure function over events so it's testable without a database. Decide and write down the resolution rule when two events disagree (most recent? highest confidence? `user-edit` always beats `form-fill`?).
5. Writes go through `appendEvent()` only. No `UPDATE` on a value anywhere in the codebase — if you catch one in review, that's a bug.
6. API: `GET /profile` (the projection), `PUT /profile` and per-field update (which append rather than overwrite), and `GET /profile/:key/history` (the log for one key — you will want this the first time a fill goes wrong).
7. A `sensitive` flag on fields (national ID, DOB, card details). It marks rather than blocks —
   see the Phase 7 note — so the filler still fills them and the review UI highlights them. The
   same word is used on the FormSpec side (`src/core/sensitive.ts`), deliberately.
8. Seed one real profile for yourself to test with — as `source: 'seed'` events, like everything else.

**Done when:** you can write a profile through the API, restart the process, read it back intact, and see the full history of any single field. Deleting the projection and recomputing it from the log gives you byte-identical output.

**Order of work:** the projection is a pure function over events — write it and its tests before any database exists, since that's the part you can get wrong invisibly. Then Drizzle, migrations, and the append path, then the API. The canonical keys and alias vocabulary are more thinking than typing: do them on paper in one sitting, because Phase 6 inherits whatever you decide here.

**What you'll learn**

- Data modelling: canonical keys vs. the many names the world uses for the same thing. This is a **domain modelling** exercise, and the alias table _is_ your domain vocabulary.
- **Event sourcing, in its smallest honest form:** state as a fold over an immutable log, and why "current value" being _derived_ rather than _stored_ buys you history, debuggability, and undo for free.
- Migrations, and why you want them before you have data rather than after.
- Handling personal data deliberately — what's sensitive, what you'd encrypt, what you'd refuse to store at all. Note the tension an append-only log creates with deletion, and write down how you'd honour "delete my data" against a store that never deletes.
- Repository-pattern separation between storage and the rest of the app.

---

## Phase 6 — The matcher: FormSpec + Profile → FillPlan

**Goal:** given a FormSpec and a Profile, decide what goes in each box — with a confidence score and no browser involved.

**Steps**

1. Output type:
   ```ts
   FillPlan = { url, entries: { selector, fieldLabel, value, source, confidence, reason }[],
                unmatched: Field[] }
   ```
2. Layer the matching, cheapest first:
   - **Exact:** field `name`/`id` equals a canonical key or a known alias.
   - **Normalised:** lowercase, strip punctuation, singularise, then compare (`first_name` → `firstname`).
   - **Type-constrained:** `type="email"` narrows candidates to email-ish profile keys.
   - **Fuzzy:** string distance over labels, above a threshold.
   - **Semantic (the (b) half of the Phase 5 decision):** embed the form's label and compare it against an index built from every canonical key, its aliases, _and_ every `observedLabel` the event log has ever recorded for that key. Cosine similarity, above a threshold. This is the layer that catches "PIN code" → `address.postalCode` when no string rule would.
   - **LLM fallback:** send the unmatched labels plus the profile keys to Claude and ask for a mapping with reasons. Use it as the _last_ layer, not the first.
     Build the index as a plain array of vectors and compare in a loop — at a few hundred entries that is microseconds, and no vector database earns its keep here. Rebuild it from the log on startup; it's derived data, so it is always safe to throw away.
3. Every entry carries a `reason` explaining why the match was made. Non-negotiable — without it you cannot debug a wrong fill.
4. Value formatting: dates to the form's expected format, phone numbers with/without country code, selects mapped to a valid `option` value rather than free text.
5. Confidence thresholds: auto-fill above, flag for review below.
6. Test the matcher as a **pure function** over your Phase 4 fixtures. No browser, no network, fast.

**Done when:** feeding in a real job-application FormSpec produces a correct FillPlan you'd be happy to execute, and each entry explains itself.

**Order of work:** deterministic layers 1–4 first, then count how many fields they already match across your Phase 4 fixtures. That number is the honest argument for the embedding layer — write it down before you build it. Then the formatters, then embeddings, then the LLM fallback last.

**What you'll learn**

- Layered matching: exhaust cheap deterministic rules before reaching for a model. Most "AI features" are 80% rules.
- String normalisation and fuzzy matching (Levenshtein / Jaro-Winkler) — and where they fail. Then, directly above it, where embeddings succeed for exactly the cases string distance can't reach, and what they cost you in latency and explainability.
- Prompt design for **structured output**, and validating the model's JSON with Zod because it will eventually return something malformed.
- Designing for explainability: confidence scores and reasons as a first-class output.
- The value of a pure function — this whole phase is testable in milliseconds because nothing in it touches the world.

---

## Phase 7 — The filler: execute the FillPlan

> ### Decision — resolved 2026-08-15: where the filling happens
>
> **The server builds the plan. The user's own browser executes it.**
>
> This phase originally assumed server-side Playwright throughout. That works until the form is
> behind a login, which — for anything worth automating repeatedly — it always is. The obvious fix
> is to store the user's credentials and log in for them, "like a password manager". It is the
> wrong fix, for three reasons that are each independently fatal:
>
> 1. **A password manager fills a login box on the user's machine; it never logs in as them from
>    somewhere else.** Holding thousands of live third-party credentials on a server makes this a
>    security product first and a form filler second, and one breach ends it.
> 2. **Two-factor auth defeats it anyway.** A stored password does not get past a code sent to a
>    phone, so the hard case stays hard and the risk was taken for nothing.
> 3. **It is against most sites' terms**, and the consequence lands on the _user's_ account, not
>    ours. Note where Phase 10 lands on the same question: logged-out scraping is defensible,
>    logged-in automation against terms the user accepted is not.
>
> **What the split buys.** In the user's browser the session already exists, so there is nothing to
> store, no 2FA wall, and the traffic looks like what it is — a person on their own machine, which
> is also the entire Phase 10 problem not happening.
>
> **What it costs:** the browser has to be open. That is a real limitation and it is worth being
> honest that it rules out "fills your forms overnight". It is survivable because this product
> requires a human at the submit step _by design_ — dry-run is the default and always will be, so
> the person is present at the only moment that matters anyway. What must run unattended is the
> preparation: watching for new forms, scraping public pages, matching, and notifying. All of that
> is server work and none of it needs to be anyone in particular.
>
> **So the shape is:** `apps/extension/` is a hand the service directs. Server says "this url, this
> plan"; the extension fills, verifies, screenshots, and reports back. The `FillPlan` type in
> `packages/schema` is the wire format between them, exactly as `FormSpec` is between the scraper
> and the matcher.
>
> **Server-side Playwright does not go away.** It stays for public pages, for the fixtures, for the
> browser fetch strategy, and — later — for business customers who deliberately provision an
> account for us to use, which is a different thing from holding a stranger's password.
>
> **Consequence for the plan:** "filling behind logins" moves off the _Deliberately not in this
> plan_ list and into this phase. It is now a requirement rather than a stop condition. CAPTCHAs
> and payment steps stay hard stops.

**Goal:** the FillPlan is executed against a real page — in a real browser the user is already
signed into — and nothing is submitted.

**Steps**

1. `fillForm(url, plan)`: open the page, locate each field by its selector, set the value by field type — `fill()` for text, `selectOption()` for selects, `check()` for checkboxes, `setInputFiles()` for uploads. Write it against Playwright first, because that is testable against local fixtures; the extension implements the same operations against the same `FillPlan`, which is what keeps them honest.
2. **Dry-run mode first, and make it the default.** Fill everything, screenshot the result, close without submitting. Only an explicit `--submit` clicks the button.
3. Verify after writing: read each value back and confirm it stuck. `fill()` dispatches an `input` event and works with React most of the time — but masked inputs, autocomplete widgets, and rich text editors will drop it. When a value doesn't stick, fall back to character-by-character typing (`locator.pressSequentially()`), and if that fails too, dispatch the events by hand.
4. Handle what real pages do: fields that appear only after another is filled, multi-step wizards, validation errors surfacing on blur.
5. Report the outcome: filled / failed / skipped per field, with a screenshot and the final page state.
6. Stop conditions — refuse to proceed past a CAPTCHA or a payment step.
   > **Changed 2026-08-14.** This also said "or anything marked `sensitive`". It no longer does:
   > the filler fills every field it has a value for, and `sensitive` is a _label_ rather than a
   > gate. Two things make that defensible — the filler can only type what the profile store
   > holds, so a card number never stored is a card number never typed; and dry-run is the
   > default, so nothing is submitted until a person has looked. What the flag still buys is a
   > review screen that highlights those rows and a report that names them. CAPTCHAs and payment
   > steps remain hard stops: those are boundaries, not preferences.

**Done when:** you run one command against a real form URL and get back a screenshot of it correctly filled, unsubmitted.

**Order of work:** dry-run mode, the screenshot, and the per-field report first — build the ability to _see_ what happened before you build anything that can go wrong for real. Then fill mechanics per field type, then read-back verification, then the stop conditions.

**What you'll learn**

- Browser automation in depth: locators, auto-waiting, and why `sleep()` is always the wrong fix.
- How controlled React inputs differ from plain DOM inputs — a genuinely useful thing to understand about the frontend framework itself.
- Idempotency and verification: never trust that a write succeeded; read it back.
- Designing a destructive operation safely — dry-run by default, explicit opt-in to submit. Apply this everywhere for the rest of your career.
- Where automation _should_ stop. CAPTCHAs and payment steps are boundaries, not obstacles.

---

## Phase 8 — Tie it together

**Goal:** one command, URL to filled form.

**Steps**

1. `POST /autofill { url, dryRun }` → scrape → FormSpec → match → fill → report.
2. A minimal review UI: show the FillPlan, let the user correct a value, then execute. Rows whose field is `sensitive` are highlighted — that flag marks rather than blocks, so this screen is where it earns its keep. **This grows out of `apps/web`, which already exists** (Phase 4½) and already renders a form's fields with their provenance; a FillPlan row is that same row with a value and a confidence on it. Ask for missing values here, in our own screen, rather than sending someone back to the ugly original form — that is most of what makes this feel like a product rather than a script.
3. Corrections write back to the profile _and_ to the alias table, so the same label matches next time. This is the first place the system genuinely learns.
4. End-to-end test against a form you host locally, so it can't break or rate-limit you.

**Done when:** URL in one end, screenshot of a filled form out the other, with a review step in the middle.

**Order of work:** wire the orchestration end-to-end with no UI at all first, against a form you host locally. Then the review UI, then the write-back loop.

Integration bugs live in the gaps between modules, and working alone you built every one of those gaps yourself — which makes them harder to see, not easier, because the same assumption sits on both sides of the seam. Two cheap substitutes for a second pair of eyes: leave the end-to-end run a day and come back to it, and read each module's _caller_ rather than the module, in the order the data flows. Where you find a wrong interface, fix the interface — not the call site that's working around it.

**What you'll learn**

- Composing independently-built modules and discovering which interfaces you got wrong. Expect at least one — the phases are far enough apart in time that Phase 4's you and Phase 8's you are effectively two different people.
- Human-in-the-loop design — where confirmation belongs in an automated pipeline.
- Feedback loops: a correction that improves future behaviour, which is the cheapest form of "learning" a system can have.
- End-to-end testing against a controlled fixture rather than the live internet.

---

## What we measure

**This is not an analytics section. It is the entire market strategy**, and without it the decision
to build general first is just a decision not to choose. Build this alongside Phase 8, before the
thing is in anyone's hands — a month of unrecorded usage cannot be recovered, in exactly the way a
month of overwritten profile rows cannot.

Per fill attempt, record:

| what                                               | why it is the one to record                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| the site's domain and its kind                     | which industry actually showed up, as opposed to which one we imagined                                 |
| fields matched automatically vs. corrected by hand | a domain with a high correction rate is either a bad fit or an underserved one — go and find out which |
| **did this user come back the following week**     | the only number that separates a business from a demo                                                  |
| forms per user per month                           | separates "tried it once" from "depends on it"                                                         |
| which `labelSource` the matcher had to work from   | feeds straight back into Phase 6 — it tells you whether the semantic layer is earning its cost         |

The question all of it exists to answer, asked at the checkpoint and not before:

> **Which kind of site do people come back to, week after week?**

Then talk to the twenty users at the top of that list. The point of shipping something free and
general is that by the time this question is worth asking, the people who can answer it are already
using the thing — which is the version of "market research" available to someone with no contacts
in any particular industry.

**Handle it as personal data from the first line.** These are records of which sites a named person
fills forms on. Aggregate where aggregate will do, keep raw events short-lived, and write down what
you'd hand over if someone asked for everything you hold on them — the same tension the Phase 5
append-only log already creates with deletion, arriving a second time.

---

## Phase 9 — Ship it

**This is a production system, not a demo.** Everything before this runs on your laptop; this
phase is what stands between that and something other people depend on. Do it before Phase 10 —
a scraper that is hard to deploy and hard to observe does not become easier once it is also
fighting bot protection.

**Goal:** the service runs somewhere that isn't your machine, survives a restart, and tells you
what it is doing.

**Steps**

1. **Close the SSRF hole first.** This service fetches any url it is handed — which, deployed,
   means anyone can point it at `http://169.254.169.254/` (cloud metadata, and therefore your
   credentials), at `http://localhost:5432`, or at anything else inside your network. Before
   fetching: resolve the host, reject private, loopback, link-local and multicast ranges, and
   re-check _after every redirect_, because a public url can redirect to `127.0.0.1`. This is the
   single most important item in the phase and the one most often missed.
2. **Configuration by environment**, validated with Zod at boot, and a process that refuses to
   start on a bad config rather than failing on the first request. `PORT`, `CACHE_PATH`,
   `BROWSER_CONCURRENCY` already exist informally — give them a schema.
3. **Containerise.** Playwright's own image, or install Chromium's system libraries yourself.
   Run as a non-root user. This is where you find out how large a browser image really is.
4. **Graceful shutdown.** Stop accepting, let in-flight jobs finish or fail cleanly, close the
   browser pool and the database, then exit. The pool already closes on SIGINT/SIGTERM; the
   server and jobs do not.
5. **Decide what survives a restart.** In-memory jobs vanish today, and the SQLite cache is a
   file on one machine's disk — both are fine on one box and wrong the moment there are two.
   Either commit to a single instance and say so, or move jobs and cache to shared storage.
6. **Observability.** Structured JSON logs with a request id (Phase 3 step 6), a `/metrics`
   endpoint or equivalent, and the numbers that actually matter here: scrapes by strategy, cache
   hit rate, queue depth, browser launches, p95 latency by path.
7. **Limits and abuse.** Rate limit per caller, a maximum response size (a 1.4MB news page is
   normal; a 500MB one is an attack), and a hard cap on how long any single request may take.
8. **CI.** Run `pnpm test`, `typecheck`, `lint` on every push, and `test:browser` on a schedule —
   it needs a browser image and takes ten times as long.

**Done when:** someone else can deploy it from a clean checkout with documented env vars, kill it
mid-scrape without corruption, and answer "what is it doing right now?" from logs and metrics.

**Order of work:** SSRF guard first — it is a security bug in code that already exists, not a
deployment task. Then config + graceful shutdown (both small, both change how everything starts
and stops), then the container, then observability, then limits.

**What you'll learn**

- SSRF as a concrete thing you built by accident rather than an OWASP bullet point. Any service
  that fetches a user-supplied url has this hole until it is explicitly closed.
- The gap between "runs on my machine" and "runs": config, shutdown, restart, and what state
  quietly assumed there was only ever one process.
- Why in-memory anything is a scaling decision in disguise.
- What to measure. Most services log volumes of text and still can't answer the one question
  you have at 3am.

---

## Phase 10 — Getting in when a site says no

**Do not start this until Phase 9 ships.** It is listed because it is real work you intend to do,
not because it is next. Everything before it makes the product; this makes the product reach
further, and it is the one phase whose results decay — the techniques below have a shelf life of
months, so learning them early means learning them twice.

**What you're up against** (measured in Aug 2026 across ~25 sites: StackOverflow, Quora, Medium and
github/join all refuse, Amazon hangs):

1. **TLS fingerprint** (JA3/JA4) — cipher and extension order identifies the client before a byte of
   HTTP is sent. This is why StackOverflow refuses us in 310ms.
2. **HTTP/2 fingerprint** — frame and header ordering, window sizes.
3. **Headless markers** — `navigator.webdriver`, absent codecs, a SwiftShader WebGL renderer.
   _Already tested: forcing `--browser=always` through those 403s still returns 403._
4. **IP reputation** — datacenter ranges score badly before anything else is looked at.
5. **Behaviour** — Amazon accepts the connection and answers nothing, spending our timeout rather
   than their error page.

**Steps, cheapest first**

1. **Exhaust the free surfaces first.** Official APIs, data dumps, `sitemap.xml`, RSS, JSON-LD.
   Phase 1 already added the per-page half of this; the crawl half (sitemap → many URLs) belongs
   here. Most "blocked" problems are a wrong-source problem.
2. **Swap the browser binary.** `chromium.launch()` in `browser-strategy.ts` is one line behind the
   `FetchStrategy` seam. Camoufox (patched Firefox, C++-level fingerprint control) and Patchright /
   nodriver (patched Chromium) are the current answers; `playwright-extra`'s stealth plugin is dead,
   detected by its own patches. Re-run the 18-site survey and get a real before/after number.
3. **Impersonate at the TLS layer** for the HTTP path — `curl-impersonate` / `curl-cffi` replicate
   Chrome's exact handshake, which is what a plain `fetch` can never do.
4. **Rotate egress** — residential proxies, billed per GB. This is where scraping stops being free.
5. **Or pay someone** — ScraperAPI, Bright Data, Zyte sell a URL-in/HTML-out endpoint and make the
   arms race their full-time job. For anything in production this is the honest answer.

**Done when:** you can state, with numbers, how many of the 18 survey sites each rung buys you, and
what it costs per thousand pages. A negative result is a real result here.

**Where to stop.** _hiQ v. LinkedIn_ (9th Cir. 2022) held that scraping public pages isn't
"unauthorized access" under the CFAA, and _Meta v. Bright Data_ (2024) reinforced that for
logged-out pages — but hiQ then **lost** on breach of LinkedIn's user agreement. The line that
emerged: logged-out public scraping is defensible; logged-in scraping against terms you accepted is
not. That is the same boundary Phase 7 already draws at CAPTCHAs, payments, and logins. Keep it.
Rate limits and GDPR still apply on every rung.

**What you'll learn**

- What a bot-protection stack actually inspects, layer by layer — most of which has nothing to do
  with the User-Agent everyone reaches for first.
- That the cheapest fix is usually a different source, not a better disguise.
- How to run an experiment against a claim ("a browser gets past a 403") and accept a negative
  result. This one is already logged in `cli.ts` as advice.
- Where the legal line sits, and why it lands in the same place as the ethical one.

---

## Deliberately not in this plan

Note these down, resist them until Phase 8 ships: CAPTCHA handling, resume/document parsing, a real job queue (BullMQ).

~~rate-limit/proxy infrastructure~~ — moved _into_ the plan as **Phase 9**, after Phase 8 ships.

~~authentication and multi-user support~~ — arrived early and unplanned, when Supabase did (2026-08-14). It is in.

~~a browser extension~~ and ~~filling behind logins~~ — both moved _into_ **Phase 7** by the 2026-08-15 decision above. They turned out to be the same item: the extension is how you fill behind a login without holding anyone's password. Note what this list got wrong, because it is a useful kind of wrong — these were resisted as scope, and one of them was actually the answer to a problem the plan had not yet met.

**Storing users' passwords for third-party sites stays out, permanently.** Not "until later" — this is the one item on this list with a reason that does not expire. Sessions in the user's own browser, or an account a business deliberately provisions for us. Never a stranger's password on our server.

~~embedding-based semantic matching~~ — pulled _into_ scope by the Phase 5 decision above, as a Phase 6 matching layer. It is the one thing we deliberately added to this plan; everything else on this list stays out.

A vector database stays out too. If brute-force cosine over a few hundred vectors ever becomes the bottleneck, that is a genuinely good problem and you can revisit it then.

---

## Two things to settle before writing any code

1. ~~**Which "memory" you're building** (Phase 5's open decision). Write the answer down.~~ — **Settled 2026-08-09: all three, layered.** See the decision block in Phase 5.
2. **That the FormSpec schema is settled before Phase 4 starts.** It's the contract everything in Part B is built against, and you'll be building against it weeks after writing it. Put it in the code, write down _why_ each field is there, and treat a change to it as a decision you make deliberately rather than a drive-by edit while fixing something else.
