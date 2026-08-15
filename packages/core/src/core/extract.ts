import { Readability } from '@mozilla/readability';
import * as cheerio from 'cheerio';
import { JSDOM, VirtualConsole } from 'jsdom';
import { extractFeeds, extractStructured, type Feed, type StructuredData } from './structured.js';
import { collapseWhitespace } from '../support/text.js';
import type { HtmlDocument } from './types.js';

export interface ExtractedContent {
  title: string;
  description: string | null;
  /** Main-content HTML, still HTML at this point. markdown.ts converts it. */
  html: string;
  /** Which path produced `html`. Phase 2's strategy selector reads this. */
  strategy: 'readability' | 'body' | 'json-ld';
  /** What the page says about itself, when it says anything. */
  structured: StructuredData | null;
  feeds: Feed[];
}

/**
 * Phase 1, steps 4–5 — find the actual content.
 *
 * Two parsers on purpose: cheerio to strip junk fast, then jsdom because
 * @mozilla/readability needs a real DOM.
 */

/**
 * Elements that are never content. Removed before Readability runs so its
 * scoring isn't distracted by a 200-link sidebar.
 *
 * There is a tension here worth knowing about: Readability already discounts
 * nav and footer itself, and over-stripping *hurts* it — anything removed here
 * is invisible to its scoring, so an over-broad selector can delete the article.
 * Keep this list to things that are structurally never prose.
 */
const JUNK_SELECTORS = [
  'script',
  'style',
  'noscript',
  'template',
  'nav',
  'footer',
  'aside',
  'iframe',
  'svg',
  'form[role="search"]',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="complementary"]',
  '[hidden]',
  /*
   * Written by the browser strategy, which is the only part of the pipeline
   * that can see a stylesheet. A page hides dialogs with CSS classes —
   * Tailwind's `hidden`, Bootstrap's `d-none` — and to this parser those are
   * ordinary headings that arrive at the top of the article. Matching the class
   * names instead would be a guess, and a bad one: `hidden md:block` is an
   * element that is visible on every screen this scraper uses.
   */
  '[data-scrape-hidden]',
  'link',
  'meta[http-equiv]',
];

/**
 * Ad and consent furniture, matched on class/id.
 *
 * Note the word-boundary matchers (`[class~="ad"]` matches the *token* "ad",
 * not the substring). The naive version, `[class*="ad"]`, also matches
 * "header", "shadow", "loading", and "breadcrumb" — that one selector would
 * quietly delete most of the page.
 */
const FURNITURE_SELECTORS = [
  '[class~="ad"]',
  '[class~="ads"]',
  '[class~="advert"]',
  '[class*="advertisement" i]',
  '[id~="ad"]',
  '[id*="advertisement" i]',
  '[data-ad]',
  '[data-ad-slot]',
  '[aria-label*="advertisement" i]',
  '[class*="cookie-banner" i]',
  '[class*="cookie-consent" i]',
  '[id*="cookie-banner" i]',
  '[class*="newsletter-signup" i]',
  '[class*="social-share" i]',
];

/** jsdom logs CSS parse errors for every stylesheet it can't understand. */
const silentConsole = new VirtualConsole();

export function extractContent(doc: HtmlDocument): ExtractedContent {
  const $ = cheerio.load(doc.html);

  // Read the declared data before stripping: JSON-LD lives in a <script>, and
  // the junk pass removes every one of those.
  const structured = extractStructured($);
  const feeds = extractFeeds($, doc.finalUrl);

  const title = resolveTitle($, structured);
  const description = resolveDescription($, structured);

  $([...JUNK_SELECTORS, ...FURNITURE_SELECTORS].join(',')).remove();

  // Taken before Readability runs: it mutates the document it is given, so the
  // fallback has to be captured from our own copy first.
  const bodyHtml = $('body').html() ?? '';

  const bodyText = collapseWhitespace($('body').text());

  const article = readArticle($.html(), doc.finalUrl);
  if (article && coversEnoughOf(article, bodyText)) {
    return { title, description, html: article.html, strategy: 'readability', structured, feeds };
  }

  // The publisher's own copy of the article beats a dump of <body>, which at
  // this point is a page we failed to find the content in.
  const declared = structured?.articleBody;
  if (declared && declared.length > 200) {
    return {
      title,
      description,
      html: asParagraphs(declared),
      strategy: 'json-ld',
      structured,
      feeds,
    };
  }

  return { title, description, html: bodyHtml, strategy: 'body', structured, feeds };
}

/** JSON-LD articleBody is plain text. Give it the minimum structure markdown needs. */
function asParagraphs(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block)}</p>`)
    .join('\n');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** What Readability produced, with the text kept so coverage can be judged. */
interface Article {
  html: string;
  text: string;
}

/**
 * Below this share of the page's text, Readability picked a section rather than
 * the content, and <body> is the safer answer.
 *
 * Readability scores by paragraph density and returns the single best-scoring
 * subtree. On a page whose content is split across tabs, cards or accordions,
 * the densest subtree is one of them — and the rest of the page is dropped
 * without a word. myscheme.gov.in is the fixture: the FAQ accordion scores
 * highest, so a scheme's eligibility, benefits and application process all
 * disappeared behind an answer about interest rates.
 *
 * A ratio rather than a character count, because "kept a third of the page" is
 * the actual failure and it means the same thing at any page size.
 */
const MIN_COVERAGE = 0.5;

/**
 * Under this many characters of body text, the ratio is noise.
 *
 * A short page is mostly furniture by volume — a title, a nav crumb, a button —
 * so Readability legitimately keeps a small share of it. Below this we trust
 * Readability's own judgement, which is what the 200-character floor inside
 * `readArticle` already guards.
 */
const COVERAGE_FLOOR = 2000;

/**
 * Did Readability keep enough of the page to be believed?
 *
 * Only ever *rejects* Readability in favour of <body>. Falling back costs some
 * navigation noise in the markdown; the failure it prevents is losing most of
 * the page silently, which is far more expensive and impossible to notice from
 * the output.
 */
function coversEnoughOf(article: Article, bodyText: string): boolean {
  if (bodyText.length < COVERAGE_FLOOR) return true;
  return article.text.length / bodyText.length >= MIN_COVERAGE;
}

/**
 * Readability returns null on anything that isn't article-shaped — which is
 * every form, and so most of Phase 4. The <body> fallback is a normal path,
 * not an error path.
 */
function readArticle(html: string, url: string): Article | null {
  const dom = new JSDOM(html, { url, virtualConsole: silentConsole });
  const article = new Readability(dom.window.document).parse();
  if (!article) return null;

  const content = article.content?.trim();
  if (!content) return null;

  // Readability wraps everything in <div id="readability-page-1">, so a "no
  // content" result still has ~100 characters of wrapper in it. Judge on the
  // text instead.
  if (article.textContent.trim().length < 200) return null;

  // Collapsed for the caller's coverage ratio, which compares this against the
  // body text: markup indentation is not content, and counting it on one side
  // of a ratio and not the other measures the page's formatting, not its text.
  return { html: content, text: collapseWhitespace(article.textContent) };
}

/** <title>, then og:title, then JSON-LD's headline, then the first <h1>. */
function resolveTitle($: cheerio.CheerioAPI, structured: StructuredData | null): string {
  const candidates = [
    $('head > title').first().text(),
    $('meta[property="og:title"]').attr('content'),
    structured?.headline ?? undefined,
    $('h1').first().text(),
  ];

  for (const candidate of candidates) {
    const cleaned = collapseWhitespace(candidate);
    if (cleaned) return cleaned;
  }
  return '';
}

/** meta description, then og:description, then JSON-LD's. Null when there is none. */
function resolveDescription(
  $: cheerio.CheerioAPI,
  structured: StructuredData | null,
): string | null {
  const candidates = [
    $('meta[name="description"]').attr('content'),
    $('meta[property="og:description"]').attr('content'),
    structured?.description ?? undefined,
  ];

  for (const candidate of candidates) {
    const cleaned = collapseWhitespace(candidate);
    if (cleaned) return cleaned;
  }
  return null;
}
