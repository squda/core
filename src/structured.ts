import type * as cheerio from 'cheerio';
import { toAbsoluteUrl } from './url.js';

/**
 * The surfaces a site publishes *on purpose*.
 *
 * Extraction is a heuristic guess at which div holds the article. JSON-LD is
 * the site telling you, in a schema, what the page is — and nobody blocks it,
 * because it exists for Google. Read it before trusting anything we inferred.
 *
 * (The third such surface, sitemap.xml, is deliberately not here: it lists a
 * site's *pages*, so it belongs to a crawler, not to a single-page scrape. It
 * is in PLAN.md as part of the crawl feature.)
 */

export interface StructuredData {
  /** schema.org type, e.g. Article, JobPosting, Product. */
  type: string;
  headline: string | null;
  description: string | null;
  author: string | null;
  datePublished: string | null;
  /** Some publishers ship the whole article here. When they do, it beats extraction. */
  articleBody: string | null;
}

export interface Feed {
  url: string;
  title: string;
  kind: 'rss' | 'atom';
}

/** Types worth preferring when a page declares several. */
const CONTENT_TYPES = [
  'NewsArticle',
  'BlogPosting',
  'TechArticle',
  'Article',
  'JobPosting',
  'Product',
  'Recipe',
  'Event',
  'QAPage',
  'WebPage',
];

type JsonObject = Record<string, unknown>;

export function extractStructured($: cheerio.CheerioAPI): StructuredData | null {
  const nodes = collectNodes($);
  if (nodes.length === 0) return null;

  const best =
    CONTENT_TYPES.map((type) => nodes.find((node) => typeOf(node).includes(type))).find(Boolean) ??
    nodes.find((node) => typeof node.headline === 'string' || typeof node.name === 'string');

  if (!best) return null;

  return {
    type: typeOf(best)[0] ?? 'Thing',
    headline: text(best.headline ?? best.name),
    description: text(best.description),
    author: nameOf(best.author),
    datePublished: text(best.datePublished ?? best.uploadDate),
    articleBody: text(best.articleBody),
  };
}

/**
 * Every JSON-LD block on the page, flattened.
 *
 * Each parse is guarded individually: these blocks are written by CMS
 * templates and a trailing comma in one is not a reason to lose the others.
 */
function collectNodes($: cheerio.CheerioAPI): JsonObject[] {
  const nodes: JsonObject[] = [];

  $('script[type="application/ld+json"]').each((_index, element) => {
    const raw = $(element).text().trim();
    if (!raw) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // Malformed block. Common, and not our problem to fix.
    }

    for (const node of flatten(parsed)) nodes.push(node);
  });

  return nodes;
}

/** Unwraps top-level arrays and the @graph container publishers nest things in. */
function flatten(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (!isObject(value)) return [];

  const graph = value['@graph'];
  if (graph) return flatten(graph);
  return [value];
}

function typeOf(node: JsonObject): string[] {
  const type = node['@type'];
  if (typeof type === 'string') return [type];
  if (Array.isArray(type))
    return type.filter((entry): entry is string => typeof entry === 'string');
  return [];
}

/** author is a string, an object with a name, or an array of either. */
function nameOf(value: unknown): string | null {
  if (typeof value === 'string') return collapse(value);
  if (Array.isArray(value)) return nameOf(value[0]);
  if (isObject(value)) return text(value.name);
  return null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? collapse(value) : null;
}

function collapse(value: string): string | null {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned === '' ? null : cleaned;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null;
}

/**
 * RSS and Atom links from <head>. A feed is the machine-readable version of a
 * site's index — cheaper and more reliable than scraping a list page, and the
 * thing to reach for before crawling anything.
 */
export function extractFeeds($: cheerio.CheerioAPI, baseUrl: string): Feed[] {
  const feeds: Feed[] = [];
  const seen = new Set<string>();

  $('link[rel="alternate"]').each((_index, element) => {
    const $link = $(element);
    const type = ($link.attr('type') ?? '').toLowerCase();

    const kind: Feed['kind'] | null = type.includes('atom')
      ? 'atom'
      : type.includes('rss') || type.includes('rdf')
        ? 'rss'
        : null;
    if (!kind) return;

    const url = toAbsoluteUrl($link.attr('href') ?? '', baseUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);

    feeds.push({ url, title: collapse($link.attr('title') ?? '') ?? kind.toUpperCase(), kind });
  });

  return feeds;
}
