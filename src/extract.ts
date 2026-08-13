import { Readability } from '@mozilla/readability';
import * as cheerio from 'cheerio';
import { JSDOM, VirtualConsole } from 'jsdom';
import { extractFeeds, extractStructured, type Feed, type StructuredData } from './structured.js';
import { collapseWhitespace } from './text.js';
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

  const article = readArticle($.html(), doc.finalUrl);
  if (article)
    return { title, description, html: article, strategy: 'readability', structured, feeds };

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

/**
 * Readability returns null on anything that isn't article-shaped — which is
 * every form, and so most of Phase 4. The <body> fallback is a normal path,
 * not an error path.
 */
function readArticle(html: string, url: string): string | null {
  const dom = new JSDOM(html, { url, virtualConsole: silentConsole });
  const article = new Readability(dom.window.document).parse();
  if (!article) return null;

  const content = article.content?.trim();
  if (!content) return null;

  // Readability wraps everything in <div id="readability-page-1">, so a "no
  // content" result still has ~100 characters of wrapper in it. Judge on the
  // text instead.
  if (article.textContent.trim().length < 200) return null;

  return content;
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
