import type { HtmlDocument, ScrapedDocument } from './types.js';

/**
 * Phase 2, step 3 — decide whether the HTTP result is good enough.
 *
 * A pure function over a fetch that already happened: no network, no browser,
 * no clock. That is what lets it be tuned against the fixture set instead of
 * guessed at, and re-tuned later without anything to mock.
 *
 * It only ever answers "retry with a browser?". It never fetches, and it is
 * never asked about a document the browser already produced — retrying a
 * browser result with a browser is the loop this design has to make impossible.
 */

export interface Verdict {
  needsBrowser: boolean;
  /** Always populated. The reason a page was *not* retried matters just as much. */
  reason: string;
}

/**
 * Below this many characters of Markdown, a page has not said anything.
 *
 * Chosen from the fixtures, not from taste: the client-rendered page yields 12
 * characters, and the thinnest genuinely-static page in the set (httpbin's
 * form) yields 181. Anywhere in that gap works; 150 sits near the middle and
 * leaves room for a short but real page.
 */
const THIN_MARKDOWN = 150;

/**
 * Above this, a page has clearly said something, and a weak signal is not
 * allowed to override that.
 *
 * MDN is why this exists. It carries `<noscript>Enable JavaScript to view this
 * browser compatibility table.</noscript>` — a banner about one *widget* on a
 * page that already handed us 99,000 characters of documentation. Treating
 * that as "needs a browser" fires a Chromium at a page that was already
 * perfect.
 */
const SUBSTANTIAL_MARKDOWN = 1000;

/** Frameworks mount into these. Empty means the app never ran. */
const MOUNT_POINTS = ['root', 'app', '__next', '__nuxt', 'q-app', 'svelte'];

/**
 * The hydration payload a framework ships so the client can rebuild the page.
 *
 * Its presence says a framework rendered this, not whether it rendered the
 * *content* — a server-rendered Next.js page carries `__NEXT_DATA__` too. So
 * this is a weak signal, weighed exactly like the noscript banner: it only
 * counts while the page is also short on content.
 *
 * That pairing is what catches the shape the mount-point check misses — a shell
 * that ships a header and footer around an empty middle. The mount point is not
 * empty (there is chrome in it) and the markdown clears the thinness floor (a
 * footer is a few hundred characters), so without this a page with no content
 * at all reads as a page that said something.
 */
const HYDRATION_MARKERS = [
  '__NEXT_DATA__', // Next.js, pages router
  'self.__next_f', // Next.js, app router
  '__NUXT__', // Nuxt
  '__remixContext', // Remix
  '__sveltekit_', // SvelteKit
  'window.__INITIAL_STATE__', // Vue/Redux SSR, widely copied
];

export function judge(doc: HtmlDocument, scraped: ScrapedDocument): Verdict {
  if (doc.fetchedWith === 'browser') {
    return { needsBrowser: false, reason: 'already fetched with a browser' };
  }

  const emptyMount = findEmptyMountPoint(doc.html);
  if (emptyMount) {
    return { needsBrowser: true, reason: `empty mount point <div id="${emptyMount}">` };
  }

  if (scraped.markdown.length < THIN_MARKDOWN) {
    return {
      needsBrowser: true,
      reason: `only ${scraped.markdown.length} characters of markdown`,
    };
  }

  // Weak signals, so they only count while the page is still short on content.
  if (scraped.markdown.length < SUBSTANTIAL_MARKDOWN) {
    if (demandsJavaScript(doc.html)) {
      return { needsBrowser: true, reason: 'page says it requires JavaScript' };
    }

    const marker = findHydrationMarker(doc.html);
    if (marker) {
      return {
        needsBrowser: true,
        reason: `${scraped.markdown.length} characters around a ${marker} payload`,
      };
    }
  }

  return { needsBrowser: false, reason: `${scraped.markdown.length} characters of markdown` };
}

/**
 * `<div id="root"></div>` — the shell an SPA leaves when its bundle hasn't run.
 * Matched on the raw HTML rather than a parsed DOM because this runs on every
 * scrape, and a regex over a string beats a second parse of a 1.4MB page.
 *
 * Whitespace between the tags counts as empty; anything else does not, since a
 * server-rendered React app puts its markup in exactly this element.
 */
function findEmptyMountPoint(html: string): string | null {
  for (const id of MOUNT_POINTS) {
    const pattern = new RegExp(`<(div|main|section)[^>]*id=["']${id}["'][^>]*>\\s*</\\1>`, 'i');
    if (pattern.test(html)) return id;
  }
  return null;
}

/**
 * Which framework's hydration payload the page carries, if any.
 *
 * A substring scan rather than a parse: these are script contents, and the
 * marker is the variable name the framework writes, so an exact match on the
 * literal is both the cheapest and the least ambiguous test available.
 */
function findHydrationMarker(html: string): string | null {
  return HYDRATION_MARKERS.find((marker) => html.includes(marker)) ?? null;
}

/** The <noscript> banner a JS-only site shows to a client that can't run it. */
function demandsJavaScript(html: string): boolean {
  const noscript = /<noscript[^>]*>([\s\S]{0,400}?)<\/noscript>/i.exec(html);
  if (!noscript) return false;
  return /enable\s+javascript|requires\s+javascript|javascript\s+(?:is\s+)?required/i.test(
    noscript[1] ?? '',
  );
}
