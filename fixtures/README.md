# fixtures

Saved HTML pages. Tests run against these files, **never** against the live network
(plan, Phase 1 step 8 — "a test that hits the network isn't a test").

Load them with `loadFixture(name)` from `tests/fixtures.ts`, which returns the recorded
response as an `HtmlDocument` — same shape `fetchPage` produces, so extraction tests run
the real pipeline offline.

## What's here

| name             | why it's here                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `blog-post`      | article-shaped, hand-written HTML — Readability's happy path                               |
| `docs-page`      | MDN: heavy nav/sidebar/breadcrumbs to strip. Redirected — a live `finalUrl` case           |
| `wikipedia`      | huge, tables, footnotes, edit links                                                        |
| `news-article`   | 1.4MB of ads, embeds, and furniture around the content                                     |
| `spa-empty-root` | body is `<div id="root"></div>` — the page that proves you need Phase 2                    |
| `form-page`      | 11 inputs, radios, checkboxes, a select — reused in Phase 4                                |
| `thin-profile`   | x.com logged out: a real page that _looks_ like a login wall — negative case for `wall.ts` |

`manifest.json` records the url, the `finalUrl` after redirects, status, content-type, and
when each was captured. Add a row when you add a page; `tests/fixtures.test.ts` fails if you
forget.

## Adding one

```
npx tsx scripts/grab-fixture.ts https://example.com/post blog-post
```

...or by hand, if you'd rather:

```
curl -sL --compressed -A 'Mozilla/5.0' 'https://example.com/post' -o fixtures/new-page.html
```

Commit them. They're the reason your tests stay deterministic when the site redesigns —
and the reason a failing extraction test means _your parser_ changed, not the internet.
