import { readFileSync } from 'node:fs';
import type { HtmlDocument } from '../src/core/types.js';

/**
 * Loads the saved pages in fixtures/ as HtmlDocuments, so the extract and
 * markdown tests can run the real pipeline with no network in the loop.
 *
 * Not a test file — a helper the tests import.
 */

interface FixtureEntry {
  name: string;
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  fetchedAt: string;
  bytes: number;
  fetchedWith?: 'http' | 'browser';
}

const manifestUrl = new URL('../fixtures/manifest.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as FixtureEntry[];

export const fixtureNames = manifest.map((entry) => entry.name);

/**
 * The recorded response for a saved page, exactly as fetchPage would have
 * returned it — including `finalUrl`, which several fixtures redirected to.
 */
export function loadFixture(name: string): HtmlDocument {
  const entry = manifest.find((candidate) => candidate.name === name);
  if (!entry) {
    throw new Error(`no fixture named ${name}. Available: ${fixtureNames.join(', ')}`);
  }

  const html = readFileSync(new URL(`../fixtures/${name}.html`, import.meta.url), 'utf8');

  return {
    url: entry.url,
    fetchedWith: entry.fetchedWith ?? 'http',
    finalUrl: entry.finalUrl,
    html,
    contentType: entry.contentType,
    status: entry.status,
    fetchedAt: new Date(entry.fetchedAt),
  };
}
