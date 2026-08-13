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

/** Raw result of getting a page. No parsing has happened yet. */
export interface HtmlDocument {
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

/** The final output of a scrape. This is what the CLI prints as JSON. */
export const ScrapedDocumentSchema = z.object({
  url: z.string().url(),
  fetchedAt: z.coerce.date(),
  title: z.string(),
  description: z.string().nullable(),
  markdown: z.string(),
  links: z.array(LinkSchema),
  images: z.array(ImageSchema),
});

export type Link = z.infer<typeof LinkSchema>;
export type Image = z.infer<typeof ImageSchema>;
export type ScrapedDocument = z.infer<typeof ScrapedDocumentSchema>;
