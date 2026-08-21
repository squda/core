# fixtures

Saved HTML pages. Tests run against these files, **never** against the live network
(plan, Phase 1 step 8 — "a test that hits the network isn't a test").

Load them with `loadFixture(name)` from `../fixtures.js` — the loader sits one level up,
next to the specs that use it. It returns the recorded response as an `HtmlDocument`, the
same shape `fetchPage` produces, so extraction tests run the real pipeline offline.

## Pages

| name                 | why it's here                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `blog-post`          | article-shaped prose — Readability's happy path                                                                               |
| `docs-page`          | MDN: heavy nav/sidebar/breadcrumbs to strip. Redirected — a live `finalUrl` case                                              |
| `wikipedia`          | huge, tables, footnotes, edit links                                                                                           |
| `news-article`       | 1.4MB of ads, embeds, and furniture around the content                                                                        |
| `book-listing`       | a clean paginated catalogue — proves product cards and the next-page link survive without invented JSON-LD                    |
| `spa-empty-root`     | body is an empty mount point — the page that proves you need Phase 2                                                          |
| `spa-hydrated-shell` | the harder SPA: chrome around an empty middle, so the mount point is not empty and the footer alone clears the thinness floor |
| `tabbed-content`     | the same page rendered — content split across tabs, which Readability reduces to whichever one scores highest                 |
| `thin-profile`       | x.com logged out: a thin real page, the shape a careless login-wall rule flags                                                |

## Forms

Ten canonical real-form snapshots, with the required job application, signup,
checkout, government-form and wizard shapes represented.

| name                     | what only this page has                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `form-page`              | radios and checkboxes that share a `name` — the grouping case, in 1.4KB                            |
| `form-job-application`   | 14 `autocomplete` tokens, and **not one `name` attribute** on the application form                 |
| `form-native-select`     | a 264-option native `<select>`; labels that come only from `nearby-text`; a 423-character selector |
| `form-all-controls`      | radios and checkboxes with **no shared name** — the grouping gap, kept so it stays visible         |
| `form-select-minimal`    | one `<select>` and nothing else. Where you debug grouping when it breaks                           |
| `form-login-minimal`     | the smallest real login: one text, one password                                                    |
| `form-login-nolabels`    | every label from a `placeholder`, because there are no `<label>` elements at all                   |
| `form-signup`            | a public registration form with email, password and password confirmation                          |
| `form-checkout`          | a public test-payment form with card number, expiry selects and CVV                                |
| `form-government-wizard` | the first state of GOV.UK's student-finance eligibility wizard                                     |

`form-shadow-dom` is a supplementary captured host page, not one of the ten
canonical form snapshots: saved HTML cannot contain its materialized shadow
roots or iframe documents. The local browser integration test provides that
coverage against the live DOM.

`manifest.json` records the url, the `finalUrl` after redirects, status, content-type, and
when each was captured. Add a row when you add a page; `tests/fixtures.test.ts` fails if you
forget.

## Known gaps

Worth knowing before trusting the set to prove more than it does.

- A saved HTML fixture can only snapshot one wizard state. Multi-step traversal is covered by
  `form-inspection.browser.test.ts` and the optional `pnpm check:forms-live` GOV.UK smoke check.
- `page.content()` does not serialize shadow-root or iframe documents. `form-shadow-dom` is useful
  static source, while `form-inspection.browser.test.ts` is the proof that live inspection crosses
  open/closed shadow roots, ordinary iframes, and a shadow-root-to-iframe boundary.
- **`thin-profile` is half of what it was.** It used to carry `Log in` / `Sign up` links in its
  nav, which is what made it a trap for the wall detector. Today's x.com ships neither in the
  initial HTML, so that case is now covered only by the constructed tests in `wall.test.ts`.

## Adding one

```
pnpm fixture https://example.com/post blog-post
pnpm fixture https://example.com/form new-form --browser
```

`--browser` renders the page first, which is the only way to capture a form a framework
builds at runtime. The grabber is `../grab-fixture.ts`; it is one of two intentional network
tools, alongside the opt-in `../check-live-forms.ts` smoke check. Neither runs in the test suite.
The grabber creates this directory and the manifest if they are missing, so it can rebuild the
whole set from nothing.

## When one of these changes

These are captures of live pages, and live pages move. A test that fails after a re-capture
is usually the page changing, not the code regressing — but that is a conclusion to reach by
reading the diff, never the assumption to start from.
