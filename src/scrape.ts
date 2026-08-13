import { HttpStrategy } from './http-strategy.js';
import { extractContent } from './extract.js';
import { toMarkdown } from './markdown.js';
import { normaliseUrl } from './url.js';
import type { FetchStrategy } from './strategy.js';
import { ScrapedDocumentSchema, type HtmlDocument, type ScrapedDocument } from './types.js';

/**
 * The core. Knows nothing about the CLI, and in Phase 3 it must still know
 * nothing about HTTP servers — that layering is the point of the whole project
 * (plan, Phase 3: "the single most transferable idea").
 *
 * This is already written. You only fill in the pieces it calls.
 */
export function scrapeHtml(doc: HtmlDocument): ScrapedDocument {
  const extracted = extractContent(doc);
  const converted = toMarkdown(extracted.html, doc.finalUrl);

  // Parse, don't validate: this is the boundary where our data becomes trusted.
  return ScrapedDocumentSchema.parse({
    url: doc.url,
    fetchedAt: doc.fetchedAt,
    title: extracted.title,
    description: extracted.description,
    markdown: converted.markdown,
    links: converted.links,
    images: converted.images,
  });
}

/**
 * The one strategy Phase 1 had. Callers that don't care get it for free;
 * Phase 2's selector will pass something else without this file changing.
 */
const defaultStrategy = new HttpStrategy();

export async function scrape(
  rawUrl: string,
  strategy: FetchStrategy = defaultStrategy,
): Promise<ScrapedDocument> {
  const url = normaliseUrl(rawUrl);
  const doc = await strategy.fetch(url);
  return scrapeHtml(doc);
}
