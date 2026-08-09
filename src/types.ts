import { z } from 'zod';

/**
 * THE CONTRACT.
 *
 * This file is the only thing both halves of Phase 1 depend on. Agree on it
 * together, then work in parallel without touching each other's files:
 *
 *   fetch side  (url.ts, fetch.ts, cli.ts)  produces HtmlDocument
 *   extract side (extract.ts, markdown.ts)  consumes HtmlDocument -> ScrapedDocument
 *
 * Changing anything here is a conversation, not a commit.
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
