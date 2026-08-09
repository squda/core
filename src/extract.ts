import type { HtmlDocument } from './types.js';

export interface ExtractedContent {
  title: string;
  description: string | null;
  /** Main-content HTML, still HTML at this point. markdown.ts converts it. */
  html: string;
}

/**
 * Phase 1, steps 4–5 — find the actual content. [extract side]
 *
 * Two parsers on purpose (plan step 5): cheerio to strip junk fast, then
 * jsdom because @mozilla/readability needs a real DOM. Time both.
 *
 * TODO:
 *  - cheerio: drop <script> <style> <nav> <footer> <aside> <iframe>, ad containers
 *  - jsdom + Readability on what's left
 *  - fall back to <body> when Readability returns null (it does that on
 *    pages that aren't articles — which is most forms, so this matters in Phase 4)
 *  - title: <title> then og:title then <h1>; description: meta description then og:description
 */
export function extractContent(doc: HtmlDocument): ExtractedContent {
  throw new Error('not implemented: extractContent');
}
