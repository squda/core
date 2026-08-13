import { expect, it } from 'vitest';
import type { FetchStrategy } from '../src/strategy.js';

/**
 * The assertions every FetchStrategy has to satisfy, whatever it is underneath.
 *
 * Written now, with one implementation, so BrowserStrategy arrives already
 * tested rather than tested-by-analogy. Nothing here may mention HTTP or a
 * browser: the moment a case only makes sense for one implementation, it
 * belongs in that implementation's own file, not in the contract.
 */

export interface StrategyUnderTest {
  strategy: FetchStrategy;
  /** A url this strategy can reach in the test environment. */
  url: string;
  /** Something the fetched page is known to contain. */
  expectedHtml: string;
}

export function describeFetchStrategyContract(setup: () => Promise<StrategyUnderTest>): void {
  it('returns the page as an HtmlDocument', async () => {
    const { strategy, url, expectedHtml } = await setup();

    const doc = await strategy.fetch(url);

    expect(doc.html).toContain(expectedHtml);
    expect(doc.status).toBe(200);
    expect(doc.contentType).toMatch(/html/);
    expect(doc.fetchedAt).toBeInstanceOf(Date);
    await strategy.close();
  });

  it('keeps the requested url as identity and reports where it landed', async () => {
    const { strategy, url } = await setup();

    const doc = await strategy.fetch(url);

    expect(doc.url).toBe(url);
    expect(doc.finalUrl).toMatch(/^https?:\/\//);
    await strategy.close();
  });

  it('names itself, so a log can say which path ran', async () => {
    const { strategy } = await setup();

    expect(['http', 'browser']).toContain(strategy.name);
    await strategy.close();
  });

  it('can be closed twice without complaint', async () => {
    const { strategy } = await setup();

    await strategy.close();
    await expect(strategy.close()).resolves.toBeUndefined();
  });

  it('is reusable across calls', async () => {
    const { strategy, url } = await setup();

    const first = await strategy.fetch(url);
    const second = await strategy.fetch(url);

    expect(second.html).toBe(first.html);
    await strategy.close();
  });
}
