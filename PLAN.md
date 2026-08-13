# Plan — URL → Scraped Content → Automated Form Filling

**Stack:** TypeScript / Node throughout (pnpm, `tsx`, Vitest, Zod).
**Fill surface:** headless browser automation (Playwright).
**Purpose:** learning project. Every phase is chosen partly for what it forces you to confront.
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
> dump when Readability finds nothing. `sitemap.xml` is a _crawl_ surface, so it sits in Phase 9.

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

**Done when:** a client-rendered page (any SPA-based site) produces the same quality of Markdown as a static one, and you can see in the logs which strategy ran. — **Done 2026-08-13**, bar step 5's remaining failure modes (cookie banners, infinite scroll).

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
3. Cache results keyed by normalised URL, with a TTL. SQLite (`better-sqlite3`) is plenty; skip Redis. Write the SQL by hand here — Phase 5 introduces Drizzle over the same database, and the contrast is the point: you'll know what the ORM is buying you because you'll have done it without one.
4. A job queue for slow browser scrapes: `POST /scrape` returns a job id immediately, `GET /jobs/:id` returns status and result. An in-memory queue is fine at this stage.
5. Concurrency limit on browser scrapes so ten requests don't launch ten Chromiums.
6. Structured logging with a request id threaded through.

**Done when:** you can `curl` a URL and get Markdown back, slow pages go through the job flow, and the second request for the same URL is served from cache.

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
6. Build a fixture set of 8–10 real forms: a job application, a signup, a checkout, a government form, a multi-step wizard. Snapshot-test the FormSpec for each.

**Done when:** you can point it at a real signup form and get back a JSON list of fields with correct human-readable labels.

**Order of work:** write the `FormSpec` Zod schema first and then leave it alone for the rest of the phase — everything in Part B is built against it. Collect the fixtures _before_ writing the walker, so you're designing against real messiness instead of an imagined form. Then field discovery + selectors, then label resolution, then the snapshots.

**What you'll learn**

- HTML form semantics properly — including how accessibility attributes (`aria-*`, `<label for>`) are the same information a screen reader uses. Accessible forms are scrapeable forms.
- **Schema-first design:** writing the type before the code, and letting the type be the contract between two people working in parallel.
- Selector stability — the thing every flaky browser test is really about.
- Snapshot testing, and its trap: a snapshot only tells you something _changed_, not that it's _correct_.

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
2. SQLite via **Drizzle ORM**, with migrations from day one.
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
7. A `sensitive` flag on fields (national ID, DOB, card details) that the filler must treat differently later.
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

**Goal:** Playwright opens the page and fills the form for real.

**Steps**

1. `fillForm(url, plan)`: open the page, locate each field by its selector, set the value by field type — `fill()` for text, `selectOption()` for selects, `check()` for checkboxes, `setInputFiles()` for uploads.
2. **Dry-run mode first, and make it the default.** Fill everything, screenshot the result, close without submitting. Only an explicit `--submit` clicks the button.
3. Verify after writing: read each value back and confirm it stuck. `fill()` dispatches an `input` event and works with React most of the time — but masked inputs, autocomplete widgets, and rich text editors will drop it. When a value doesn't stick, fall back to character-by-character typing (`locator.pressSequentially()`), and if that fails too, dispatch the events by hand.
4. Handle what real pages do: fields that appear only after another is filled, multi-step wizards, validation errors surfacing on blur.
5. Report the outcome: filled / failed / skipped per field, with a screenshot and the final page state.
6. Stop conditions — refuse to proceed past a CAPTCHA, a payment step, or anything marked `sensitive` without explicit confirmation.

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
2. A minimal review UI: show the FillPlan, let the user correct a value, then execute. (Vite + React, or plain HTML — this doesn't need to be nice.)
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

## Phase 9 — Getting in when a site says no

**Do not start this until Phase 8 ships.** It is listed because it is real work you intend to do,
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
   Phase 1.5 already added the per-page half of this; the crawl half (sitemap → many URLs) belongs
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

Note these down, resist them until Phase 8 ships: authentication and multi-user support, deployment/hosting, a browser extension, CAPTCHA handling, filling behind logins, resume/document parsing, a real job queue (BullMQ).

~~rate-limit/proxy infrastructure~~ — moved _into_ the plan as **Phase 9**, after Phase 8 ships.

~~embedding-based semantic matching~~ — pulled _into_ scope by the Phase 5 decision above, as a Phase 6 matching layer. It is the one thing we deliberately added to this plan; everything else on this list stays out.

A vector database stays out too. If brute-force cosine over a few hundred vectors ever becomes the bottleneck, that is a genuinely good problem and you can revisit it then.

---

## Two things to settle before writing any code

1. ~~**Which "memory" you're building** (Phase 5's open decision). Write the answer down.~~ — **Settled 2026-08-09: all three, layered.** See the decision block in Phase 5.
2. **That the FormSpec schema is settled before Phase 4 starts.** It's the contract everything in Part B is built against, and you'll be building against it weeks after writing it. Put it in the code, write down _why_ each field is there, and treat a change to it as a decision you make deliberately rather than a drive-by edit while fixing something else.
