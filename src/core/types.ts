import { z } from 'zod';

/**
 * THE CONTRACT.
 *
 * Every other file in Phase 1 depends on this one, and on nothing else of
 * each other:
 *
 *   url.ts, fetch.ts, cli.ts     produce HtmlDocument
 *   extract.ts, markdown.ts      consume HtmlDocument -> ScrapedDocument
 *
 * That seam is what lets you build one side without holding the other in your
 * head. Changing anything here is a decision — make it on purpose, not while
 * you're mid-way through fixing something else.
 */

/** Which FetchStrategy produced a document. */
export type StrategyName = 'http' | 'browser';

/** Raw result of getting a page. No parsing has happened yet. */
export interface HtmlDocument {
  /**
   * How this page was fetched. Stamped by the strategy that produced it, so
   * the fact travels with the data instead of being carried alongside it —
   * `scrapeHtml` is a pure function and has no other way to know.
   */
  fetchedWith: StrategyName;
  /** The URL we were asked for, after normalisation. */
  url: string;
  /** Where we actually ended up, after redirects. May differ from `url`. */
  finalUrl: string;
  /** Raw response body. */
  html: string;
  /** e.g. "text/html; charset=utf-8" — used to reject PDFs, images, etc. */
  contentType: string;
  status: number;
  fetchedAt: Date;
}

export const LinkSchema = z.object({
  href: z.string().url(),
  text: z.string(),
});

export const ImageSchema = z.object({
  src: z.string().url(),
  alt: z.string(),
});

export const StructuredDataSchema = z.object({
  type: z.string(),
  headline: z.string().nullable(),
  description: z.string().nullable(),
  author: z.string().nullable(),
  datePublished: z.string().nullable(),
  articleBody: z.string().nullable(),
});

export const FeedSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  kind: z.enum(['rss', 'atom']),
});

export const WallSchema = z.object({
  kind: z.enum(['login', 'captcha', 'consent']),
  reason: z.string(),
});

/** The final output of a scrape. This is what the CLI prints as JSON. */
export const ScrapedDocumentSchema = z.object({
  url: z.string().url(),
  fetchedAt: z.coerce.date(),
  fetchedWith: z.enum(['http', 'browser']),
  title: z.string(),
  description: z.string().nullable(),
  markdown: z.string(),
  links: z.array(LinkSchema),
  images: z.array(ImageSchema),
  /** What the page declares about itself in JSON-LD, when it declares anything. */
  structured: StructuredDataSchema.nullable(),
  /** RSS/Atom feeds the page advertises — the cheap way to find its other pages. */
  feeds: z.array(FeedSchema),
  /**
   * Set when the page succeeded but isn't the page you wanted — a login wall,
   * a bot check, a consent screen. Null on an ordinary page. Phase 4 must
   * refuse to build a FormSpec from a document where this is set.
   */
  wall: WallSchema.nullable(),
});

export type Link = z.infer<typeof LinkSchema>;
export type Image = z.infer<typeof ImageSchema>;
export type ScrapedDocument = z.infer<typeof ScrapedDocumentSchema>;
