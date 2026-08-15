import type { Page } from 'playwright';

/**
 * Content that is on the page but not in the DOM until something is clicked.
 *
 * Rendering a page answers "what did JavaScript build?". It does not answer
 * "what would a reader see after opening the accordion?" — and on a tabbed
 * page most of the content is behind that question. myscheme.gov.in happened
 * to ship all six of its tabs, which is luck, not the rule.
 *
 * ## Why this is an allowlist and never a guess
 *
 * Clicking things on a stranger's page is not a neutral act. A button can
 * submit a form, place an order, or sign you out. So nothing here is matched on
 * how it looks or what it says: every target is an element that has *declared*,
 * in the HTML, that it reveals content — `<details>`, `aria-expanded`,
 * `role="tab"`. Those attributes exist for assistive technology, and expanding
 * them is precisely what they are a contract for.
 *
 * That rules out "Show more" text matching, which is the obvious next idea and
 * the reason it is not here: `<button>Sign Out</button>` and
 * `<button>Show all</button>` are indistinguishable to a text rule that is
 * loose enough to be useful.
 *
 * The other half of the safety story is upstream: every fetch runs in a fresh
 * browser context with no cookies, so there is no session to act on and no
 * account to damage. That is what makes this safe enough to run by default.
 */

export interface ExpandOptions {
  /** Hard ceiling on clicks. A page of 500 accordions is not worth 500 clicks. */
  maxClicks?: number;
  /** Wall-clock budget for the whole pass. */
  budgetMs?: number;
}

export interface ExpandResult {
  /** How many controls were opened. Zero on most pages, which is the fast path. */
  expanded: number;
  /** Why the pass stopped. Logged, so a truncated page is visible rather than assumed. */
  reason: 'nothing to expand' | 'done' | 'click budget' | 'time budget' | 'page navigated';
}

const DEFAULT_MAX_CLICKS = 40;
const DEFAULT_BUDGET_MS = 5_000;

/**
 * One click's patience.
 *
 * Deliberately short. A control that will not accept a click in a quarter of a
 * second is one we skip, not one we wait for — there are up to forty of them
 * and the budget is shared.
 */
const CLICK_TIMEOUT_MS = 250;

export async function expandDisclosures(
  page: Page,
  options: ExpandOptions = {},
): Promise<ExpandResult> {
  const { maxClicks = DEFAULT_MAX_CLICKS, budgetMs = DEFAULT_BUDGET_MS } = options;
  const deadline = Date.now() + budgetMs;

  // <details> needs no click: the open state is an attribute, so setting it is
  // both safer and cheaper than dispatching events at a summary element.
  let expanded = await openDetails(page);

  // Before anything is clicked. Opening the second tab is what destroys the
  // first one's panel, so expanding a page could otherwise *lose* the content
  // that was on screen when we arrived — trading one tab for another rather
  // than collecting them all.
  await stashOpenPanels(page);

  const startedAt = page.url();
  let reason: ExpandResult['reason'] = 'done';
  let sawCandidate = expanded > 0;

  // Re-queried every iteration, never collected up front: opening one control
  // routinely reveals another, and any handle taken before a click can be
  // pointing at an element the framework has since replaced.
  for (;;) {
    if (expanded >= maxClicks) {
      reason = 'click budget';
      break;
    }
    if (Date.now() > deadline) {
      reason = 'time budget';
      break;
    }

    // An ElementHandle, not a Locator, and the difference is load-bearing here.
    // A locator re-runs its selector on every action; marking the element as
    // handled would therefore exclude it from that selector, and the very next
    // `.click()` would silently land on a *different* control. A handle is a
    // fixed reference to one node, so mark-then-click acts on the same element.
    const control = await page
      .locator(CANDIDATE_SELECTOR)
      .first()
      .elementHandle({ timeout: CLICK_TIMEOUT_MS })
      .catch(() => null);

    if (!control) {
      reason = sawCandidate ? 'done' : 'nothing to expand';
      break;
    }
    sawCandidate = true;

    try {
      // A tab's panel can be unmounted the moment the next tab opens, so its
      // content is copied out while it is on screen. Accordions keep theirs,
      // but stashing both costs nothing and means one rule instead of two.
      const panelId = await control.getAttribute('aria-controls').catch(() => null);

      // Marked before the click, so that a control which fails to open — or one
      // whose framework leaves `aria-expanded="false"` on a panel it did open —
      // cannot be picked again on the next pass. This is what terminates the
      // loop; without it a single stubborn control spends the whole budget.
      await control.evaluate((element) => element.setAttribute('data-scrape-expanded', ''));

      try {
        await control.click({ timeout: CLICK_TIMEOUT_MS });
        expanded += 1;
      } catch {
        // Covered by an overlay, disabled, or simply not clickable. Already
        // marked, so the next iteration moves past it.
        continue;
      }

      if (page.url() !== startedAt) {
        reason = 'page navigated';
        break;
      }

      await stashPanel(page, panelId);
    } catch {
      // Detached mid-iteration, and unmarkable as a result. Re-querying without
      // a way to skip it is how this spins, so stop instead.
      reason = 'done';
      break;
    } finally {
      await control.dispose().catch(() => {});
    }
  }

  // The stash exists to rescue panels the page threw away. Anything still in
  // the document does not need rescuing, and keeping both copies would print
  // the section twice — which reads as a bug in the scraper, not a quirk of
  // the page. Cheapest to sort out once, at the end, when the DOM has settled.
  await pruneStash(page);

  return { expanded, reason };
}

/**
 * Controls that have declared they reveal something, minus the ones we have
 * already handled.
 *
 * `[data-scrape-expanded]` is our own marker. It is what makes the loop
 * terminate: a control whose click did nothing — or one whose framework leaves
 * `aria-expanded="false"` on a panel it did open — would otherwise be picked
 * again on every pass.
 */
const CANDIDATE_SELECTOR = [
  '[aria-expanded="false"]:not([data-scrape-expanded])',
  '[role="tab"][aria-selected="false"]:not([data-scrape-expanded])',
]
  .map((selector) => `${selector}:visible`)
  .join(', ');

/**
 * Copy the panels that are already open, before any click can close them.
 *
 * Reads the same `aria-controls` contract the loop does, from the other side:
 * a tab that is selected, or a control that is already expanded, is pointing at
 * content the reader can see right now.
 */
async function stashOpenPanels(page: Page): Promise<void> {
  const ids = await page.evaluate(() =>
    [
      ...document.querySelectorAll('[role="tab"][aria-selected="true"], [aria-expanded="true"]'),
    ].flatMap((element) => {
      const id = element.getAttribute('aria-controls');
      return id ? [id] : [];
    }),
  );

  for (const id of ids) await stashPanel(page, id);
}

/** Drop rescued copies whose original is still in the document. */
async function pruneStash(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const stash = document.getElementById('scrape-revealed');
      if (!stash) return;

      for (const copy of [...stash.children]) {
        const id = copy.getAttribute('data-scrape-panel');
        if (id && document.getElementById(id)?.textContent?.trim()) copy.remove();
      }

      if (!stash.children.length) stash.remove();
    })
    .catch(() => {});
}

/** Open every closed <details>, and report how many there were. */
async function openDetails(page: Page): Promise<number> {
  return page.evaluate(() => {
    const closed = [...document.querySelectorAll('details:not([open])')];
    for (const details of closed) details.setAttribute('open', '');
    return closed.length;
  });
}

/**
 * Copy a revealed panel somewhere the final `page.content()` will still see it.
 *
 * The alternative — read the panel and keep it in Node — would mean this
 * function returning HTML for the caller to splice in, and the caller no longer
 * being able to say "the document is whatever the browser has". Keeping the
 * accumulation inside the page means `page.content()` stays the single source
 * of what we scraped.
 *
 * `hidden` on the stash keeps it out of the rendered page, and out of the way
 * of any later click. Extraction reads HTML, not pixels, so it still counts.
 */
async function stashPanel(page: Page, panelId: string | null): Promise<void> {
  if (!panelId) return;

  await page
    .evaluate((id) => {
      const panel = document.getElementById(id);
      if (!panel || !panel.textContent?.trim()) return;

      let stash = document.getElementById('scrape-revealed');
      if (!stash) {
        stash = document.createElement('div');
        stash.id = 'scrape-revealed';
        // Moved off-screen rather than hidden, and the distinction is the whole
        // point: extraction strips `[hidden]` as junk, so a stash that hid
        // itself properly would be deleted before anyone read it. This keeps it
        // out of the way of clicks while leaving it plainly in the document.
        stash.style.cssText = 'position:absolute;left:-99999px;top:0';
        document.body.append(stash);
      }

      // The panel can be reached twice — once as a tab's target, once as its
      // own aria-expanded control — and a duplicated section reads as a bug in
      // the scraper rather than a quirk of the page.
      if (stash.querySelector(`[data-scrape-panel="${CSS.escape(id)}"]`)) return;

      const copy = panel.cloneNode(true) as HTMLElement;
      copy.removeAttribute('id');
      copy.setAttribute('data-scrape-panel', id);

      // A copy is text, not a control. Its clones of any nested tab or
      // accordion are dead — clicking them runs no handler — so they are marked
      // as already handled to keep them out of the loop's candidate list. Reuses
      // the loop's own marker rather than inventing a second exclusion rule.
      copy.setAttribute('data-scrape-expanded', '');
      for (const nested of copy.querySelectorAll('*')) {
        nested.setAttribute('data-scrape-expanded', '');
      }

      stash.append(copy);
    }, panelId)
    .catch(() => {});
}
