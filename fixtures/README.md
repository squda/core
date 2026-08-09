# fixtures

Saved HTML pages. Tests run against these files, **never** against the live network
(plan, Phase 1 step 8 — "a test that hits the network isn't a test").

Phase 1 wants 5–6 pages with genuinely different structure. Suggested:

- a blog post (article-shaped — Readability's happy path)
- a docs page (heavy nav/sidebar to strip)
- a Wikipedia article (huge, tables, footnotes)
- a news article (ads, cookie banner, paywall furniture)
- a page whose body is an empty `<div id="root">` (proves you need Phase 2)
- something with a form on it (you'll reuse it in Phase 4)

Grab one with:

    curl -sL --compressed -A 'Mozilla/5.0' 'https://example.com/post' -o fixtures/blog-post.html

Commit them. They're the reason your tests stay deterministic when the site redesigns.
