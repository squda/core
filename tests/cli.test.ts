import { afterEach, describe, expect, it, vi } from 'vitest';
import { run, type CliStreams } from '../src/cli.js';
import { loadFixture } from './fixtures.js';

/**
 * The CLI is exercised through run(), which returns an exit code instead of
 * calling process.exit — so a failing case is an assertion, not a dead test
 * runner. The network is stubbed with fixture HTML.
 */

function capture(): CliStreams & { stdout: string; stderr: string } {
  const streams = {
    stdout: '',
    stderr: '',
    out(text: string) {
      streams.stdout += text;
    },
    err(text: string) {
      streams.stderr += text;
    },
  };
  return streams;
}

function serve(body: string, init: { status?: number; contentType?: string } = {}): void {
  const status = init.status ?? 200;
  vi.stubGlobal('fetch', async (url: string) => ({
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: new Headers({ 'content-type': init.contentType ?? 'text/html; charset=utf-8' }),
    body: null,
    text: async () => body,
  }));
}

function serveFixture(name: string): void {
  serve(loadFixture(name).html);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('output', () => {
  it('prints markdown by default', async () => {
    serveFixture('blog-post');
    const streams = capture();

    const code = await run(['https://overreacted.io/the-wet-codebase/'], streams);

    expect(code).toBe(0);
    expect(streams.stdout).toContain('> Violations of DRY');
    expect(streams.stdout.endsWith('\n')).toBe(true);
    expect(streams.stderr).toBe('');
  });

  it('prints the whole document as json on --format=json', async () => {
    serveFixture('blog-post');
    const streams = capture();

    const code = await run(['https://overreacted.io/the-wet-codebase/', '--format=json'], streams);
    const parsed = JSON.parse(streams.stdout) as Record<string, unknown>;

    expect(code).toBe(0);
    expect(parsed.title).toBe('The WET Codebase — overreacted');
    expect(parsed.markdown).toContain('Violations of DRY');
    expect(Array.isArray(parsed.links)).toBe(true);
    // Dates have to survive the round trip as something a consumer can parse.
    expect(new Date(parsed.fetchedAt as string).getTime()).not.toBeNaN();
  });

  it('prints usage on --help and exits clean', async () => {
    const streams = capture();

    const code = await run(['--help'], streams);

    expect(code).toBe(0);
    expect(streams.stdout).toContain('usage:');
    expect(streams.stderr).toBe('');
  });
});

describe('usage errors', () => {
  it.each([
    [[], 'no url given'],
    [['https://a.test/', 'https://b.test/'], 'expected one url'],
    [['https://a.test/', '--format=yaml'], 'unknown format'],
    [['https://a.test/', '--nope'], 'Unknown option'],
  ])('%j exits 1 with a message on stderr', async (argv, expected) => {
    const streams = capture();

    const code = await run(argv, streams);

    expect(code).toBe(1);
    expect(streams.stderr).toContain(expected);
    expect(streams.stdout).toBe('');
  });

  it('never writes a partial document to stdout when it fails', async () => {
    const streams = capture();

    await run(['not a url'], streams);

    expect(streams.stdout).toBe('');
  });
});

describe('failure exit codes', () => {
  it('exits 2 on an invalid url, without touching the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const streams = capture();

    const code = await run(['javascript:alert(1)'], streams);

    expect(code).toBe(2);
    expect(streams.stderr).toContain('unsupported scheme');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('exits 5 on an http error, and says what a 403 usually means', async () => {
    serve('<html></html>', { status: 403 });
    const streams = capture();

    const code = await run(['https://example.com/'], streams);

    expect(code).toBe(5);
    expect(streams.stderr).toContain('got 403');
    expect(streams.stderr).toContain('real browser');
  });

  // Advice keyed to the kind alone told a 404 about 403s. The status matters.
  it.each([
    [404, 'no page at that url'],
    [429, 'rate limited'],
    [503, "isn't ours"],
  ])('explains a %i in its own terms', async (status, expected) => {
    serve('<html></html>', { status });
    const streams = capture();

    const code = await run(['https://example.com/'], streams);

    expect(code).toBe(5);
    expect(streams.stderr).toContain(expected);
  });

  it('exits 6 on a non-HTML page', async () => {
    serve('%PDF-1.7', { contentType: 'application/pdf' });
    const streams = capture();

    const code = await run(['https://example.com/paper.pdf'], streams);

    expect(code).toBe(6);
    expect(streams.stderr).toContain('only reads HTML');
  });

  it('exits 3 on a timeout and points at Phase 2', async () => {
    vi.stubGlobal('fetch', () => {
      throw new DOMException('aborted', 'TimeoutError');
    });
    const streams = capture();

    const code = await run(['https://example.com/'], streams);

    expect(code).toBe(3);
    expect(streams.stderr).toContain('Phase 2');
  });

  it('exits 4 when the connection fails', async () => {
    vi.stubGlobal('fetch', () => {
      throw new TypeError('fetch failed');
    });
    const streams = capture();

    const code = await run(['https://nope.invalid/'], streams);

    expect(code).toBe(4);
    expect(streams.stderr).toContain('check the hostname');
  });
});
