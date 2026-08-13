import { describe, expect, it } from 'vitest';
import { toMarkdown } from '../src/markdown.js';

const BASE = 'https://example.com/docs/guide/intro';

describe('conversion', () => {
  it('uses atx headings and dash bullets', () => {
    const { markdown } = toMarkdown('<h2>Setup</h2><ul><li>One</li><li>Two</li></ul>', BASE);

    expect(markdown).toBe('## Setup\n\n-   One\n-   Two');
  });

  it('fences code blocks with their language', () => {
    const { markdown } = toMarkdown(
      '<pre><code class="language-ts">const x = 1;\n</code></pre>',
      BASE,
    );

    expect(markdown).toBe('```ts\nconst x = 1;\n```');
  });

  it('takes a bare class as the language only when it stands alone', () => {
    expect(toMarkdown('<pre><code class="rust">fn main() {}</code></pre>', BASE).markdown).toBe(
      '```rust\nfn main() {}\n```',
    );
    // `hljs javascript` is a highlighter's own classes, not a language label.
    expect(
      toMarkdown('<pre><code class="hljs javascript">let x;</code></pre>', BASE).markdown,
    ).toBe('```\nlet x;\n```');
  });

  it('collapses the blank lines turndown leaves behind', () => {
    const { markdown } = toMarkdown('<p>One</p><div></div><div></div><p>Two</p>', BASE);

    expect(markdown).not.toMatch(/\n{3}/);
    expect(markdown).toBe('One\n\nTwo');
  });

  it('leaves no trailing whitespace, which Markdown reads as a hard break', () => {
    const { markdown } = toMarkdown('<p>Line one   </p><p>Line two</p>', BASE);

    expect(markdown.split('\n').every((line) => line === line.trimEnd())).toBe(true);
  });
});

describe('links', () => {
  it('resolves a relative href against the page it was found on', () => {
    const { markdown, links } = toMarkdown('<a href="../setup">Setup</a>', BASE);

    expect(markdown).toBe('[Setup](https://example.com/docs/setup)');
    expect(links).toEqual([{ href: 'https://example.com/docs/setup', text: 'Setup' }]);
  });

  it('keeps an absolute href as-is', () => {
    const { links } = toMarkdown('<a href="https://other.test/x">X</a>', BASE);

    expect(links[0]?.href).toBe('https://other.test/x');
  });

  // Dropping the whole <a> would lose the words with it.
  it.each(['javascript:void(0)', 'mailto:hi@example.com', 'tel:+15550100'])(
    'unwraps a %s link, keeping its text',
    (href) => {
      const { markdown, links } = toMarkdown(
        `<p>See <a href="${href}">this thing</a> now.</p>`,
        BASE,
      );

      expect(markdown).toBe('See this thing now.');
      expect(links).toEqual([]);
    },
  );

  it('unwraps an anchor with no href at all', () => {
    const { markdown, links } = toMarkdown('<a name="top">Top</a>', BASE);

    expect(markdown).toBe('Top');
    expect(links).toEqual([]);
  });

  it('collapses whitespace in link text', () => {
    const { links } = toMarkdown('<a href="/a">\n  Spread   out\n</a>', BASE);

    expect(links[0]?.text).toBe('Spread out');
  });

  // The array is an index of the page, not a transcript of it.
  it('lists a repeated link once but keeps both in the markdown', () => {
    const html = '<p><a href="/a">A</a> and <a href="/a">A</a></p>';
    const { markdown, links } = toMarkdown(html, BASE);

    expect(links).toHaveLength(1);
    expect(markdown.match(/\[A\]/g)).toHaveLength(2);
  });

  it('treats the same target with different text as two links', () => {
    const { links } = toMarkdown('<a href="/a">First</a><a href="/a">Second</a>', BASE);

    expect(links).toHaveLength(2);
  });
});

describe('images', () => {
  it('resolves src and keeps alt', () => {
    const { markdown, images } = toMarkdown('<img src="/logo.png" alt="The logo">', BASE);

    expect(markdown).toBe('![The logo](https://example.com/logo.png)');
    expect(images).toEqual([{ src: 'https://example.com/logo.png', alt: 'The logo' }]);
  });

  it('defaults a missing alt to an empty string rather than dropping the image', () => {
    const { images } = toMarkdown('<img src="/logo.png">', BASE);

    expect(images).toEqual([{ src: 'https://example.com/logo.png', alt: '' }]);
  });

  it.each(['data-src', 'data-original', 'data-lazy-src'])(
    'falls back to %s for a lazy-loaded image',
    (attr) => {
      const { images } = toMarkdown(`<img ${attr}="/lazy.png" alt="Lazy">`, BASE);

      expect(images[0]?.src).toBe('https://example.com/lazy.png');
    },
  );

  it('takes the first candidate from srcset, without its width descriptor', () => {
    const { images } = toMarkdown('<img srcset="/a-480.png 480w, /a-960.png 960w" alt="A">', BASE);

    expect(images[0]?.src).toBe('https://example.com/a-480.png');
  });

  it('removes an image whose src cannot be resolved', () => {
    const { markdown, images } = toMarkdown(
      '<p>Before<img src="data:image/png;base64,AAAA">After</p>',
      BASE,
    );

    expect(images).toEqual([]);
    expect(markdown).toBe('BeforeAfter');
  });
});
