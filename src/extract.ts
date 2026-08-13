import { Readability } from '@mozilla/readability';
import * as cheerio from 'cheerio';
import { JSDOM, VirtualConsole } from 'jsdom';
import type { HtmlDocument } from './types.js';

export interface ExtractedContent {
  title: string;
  description: string | null;
  /** Main-content HTML, still HTML at this point. markdown.ts converts it. */
  html: string;
  /** Which path produced `html`. Phase 2's strategy selector reads this. */
  strategy: 'readability' | 'body';
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

  const title = resolveTitle($);
  const description = resolveDescription($);

  $([...JUNK_SELECTORS, ...FURNITURE_SELECTORS].join(',')).remove();

  // Taken before Readability runs: it mutates the document it is given, so the
  // fallback has to be captured from our own copy first.
  const bodyHtml = $('body').html() ?? '';

  const article = readArticle($.html(), doc.finalUrl);
  if (article) return { title, description, html: article, strategy: 'readability' };

  return { title, description, html: bodyHtml, strategy: 'body' };
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

/** <title>, then og:title, then the first <h1>. */
function resolveTitle($: cheerio.CheerioAPI): string {
  const candidates = [
    $('head > title').first().text(),
    $('meta[property="og:title"]').attr('content'),
    $('h1').first().text(),
  ];

  for (const candidate of candidates) {
    const cleaned = collapseWhitespace(candidate);
    if (cleaned) return cleaned;
  }
  return '';
}

/** meta description, then og:description. Null when the page offers neither. */
function resolveDescription($: cheerio.CheerioAPI): string | null {
  const candidates = [
    $('meta[name="description"]').attr('content'),
    $('meta[property="og:description"]').attr('content'),
  ];

  for (const candidate of candidates) {
    const cleaned = collapseWhitespace(candidate);
    if (cleaned) return cleaned;
  }
  return null;
}

function collapseWhitespace(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}
