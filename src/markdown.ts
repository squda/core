import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { toAbsoluteUrl } from './url.js';
import { collapseWhitespace } from './text.js';
import type { Image, Link } from './types.js';

export interface ConvertedContent {
  markdown: string;
  links: Link[];
  images: Image[];
}

/**
 * Phase 1, step 6 — HTML to Markdown.
 *
 * The URL rewriting happens in cheerio *before* turndown sees the HTML. Doing
 * it after would mean regexing over Markdown to find link targets, which is
 * the kind of job that looks fine until a URL contains a bracket.
 */

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  hr: '---',
  linkStyle: 'inlined',
});

/**
 * Keep the language on a fenced block.
 *
 * `language-ts` / `lang-ts` is the convention worth trusting. A bare class is
 * only used when it's the *only* class, because highlighters also add
 * `hljs`, `highlight`, `prettyprint` and friends — guessing from a list of
 * classes labels half your code blocks `hljs`.
 */
function codeLanguage(className: string): string {
  const prefixed = /(?:language|lang)-([a-z0-9+#-]+)/i.exec(className);
  if (prefixed) return prefixed[1]!.toLowerCase();

  const classes = className.split(/\s+/).filter(Boolean);
  if (classes.length === 1 && /^[a-z0-9+#-]+$/i.test(classes[0]!)) return classes[0]!.toLowerCase();

  return '';
}

turndown.addRule('fencedCodeWithLanguage', {
  filter: (node) => node.nodeName === 'PRE' && node.firstChild?.nodeName === 'CODE',
  replacement: (_content, node) => {
    const code = node.firstChild as HTMLElement;
    const language = codeLanguage(code.getAttribute?.('class') ?? '');
    const body = (code.textContent ?? '').replace(/\n+$/, '');
    return `\n\n\`\`\`${language}\n${body}\n\`\`\`\n\n`;
  },
});

/**
 * Lazy-loaded images keep the real URL out of `src`. Checked in this order;
 * `srcset` contributes its first candidate, since the descriptors after the
 * space are widths, not part of the URL.
 */
const IMAGE_SRC_ATTRS = ['src', 'data-src', 'data-original', 'data-lazy-src'];

function resolveImageSrc($img: cheerio.Cheerio<never>, baseUrl: string): string | null {
  for (const attr of IMAGE_SRC_ATTRS) {
    const resolved = toAbsoluteUrl($img.attr(attr) ?? '', baseUrl);
    if (resolved) return resolved;
  }

  const firstCandidate = ($img.attr('srcset') ?? '').split(',')[0]?.trim().split(/\s+/)[0] ?? '';
  return toAbsoluteUrl(firstCandidate, baseUrl);
}

/**
 * Convert extracted content HTML to Markdown, resolving every URL against the
 * page it came from.
 *
 * Links and images that can't be resolved to http(s) — `javascript:`, `mailto:`,
 * a bare `#anchor` with no page — are unwrapped to plain text rather than
 * emitted broken. `ScrapedDocumentSchema` would reject them anyway: both arrays
 * are typed as `.url()`, so a broken link fails the parse at the boundary.
 */
export function toMarkdown(html: string, baseUrl: string): ConvertedContent {
  const $ = cheerio.load(html, null, false);

  const links: Link[] = [];
  const images: Image[] = [];

  $('a').each((_index, element) => {
    const $a = $(element);
    const href = toAbsoluteUrl($a.attr('href') ?? '', baseUrl);

    if (!href) {
      // Unwrap: the words stay, the dead link goes.
      $a.replaceWith($a.contents());
      return;
    }

    $a.attr('href', href);
    links.push({ href, text: collapseWhitespace($a.text()) });
  });

  $('img').each((_index, element) => {
    const $img = $(element);
    const src = resolveImageSrc($img as cheerio.Cheerio<never>, baseUrl);

    if (!src) {
      $img.remove();
      return;
    }

    const alt = collapseWhitespace($img.attr('alt'));
    $img.attr('src', src);
    $img.attr('alt', alt);
    images.push({ src, alt });
  });

  return {
    markdown: tidy(turndown.turndown($.html())),
    links: dedupe(links, (link) => `${link.href}\n${link.text}`),
    images: dedupe(images, (image) => image.src),
  };
}

/**
 * Turndown leaves runs of blank lines behind where it dropped elements.
 * Collapse to at most one, and normalise the trailing whitespace per line so
 * the output doesn't carry Markdown's accidental hard-break syntax.
 */
function tidy(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The same link often appears many times on a page (Wikipedia's citation
 * backlinks, a docs sidebar). The Markdown keeps every occurrence — this only
 * tidies the `links`/`images` arrays, which are an index, not a transcript.
 */
function dedupe<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const identity = key(item);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
