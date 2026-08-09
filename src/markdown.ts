import type { Image, Link } from './types.js';

export interface ConvertedContent {
  markdown: string;
  links: Link[];
  images: Image[];
}

/**
 * Phase 1, step 6 — HTML to Markdown. [extract side]
 *
 * TODO:
 *  - turndown, configured (atx headings, fenced code blocks)
 *  - resolve every href and img src to an absolute URL against `baseUrl`,
 *    using toAbsoluteUrl from url.ts — a relative link in the output is a bug
 *  - drop links you can't resolve rather than emitting a broken one
 *  - collapse the runs of blank lines turndown leaves behind
 */
export function toMarkdown(html: string, baseUrl: string): ConvertedContent {
  throw new Error('not implemented: toMarkdown');
}
