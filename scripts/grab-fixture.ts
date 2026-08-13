import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fetchPage } from '../src/fetch.js';
import { normaliseUrl } from '../src/url.js';

/**
 * Save a page into fixtures/ and record it in the manifest.
 *
 *     npx tsx scripts/grab-fixture.ts <url> <name>
 *
 * The one place in this repo that is *supposed* to touch the network. Tests
 * read what it writes; they never call it.
 */

const fixturesDir = new URL('../fixtures/', import.meta.url);
const manifestUrl = new URL('manifest.json', fixturesDir);

interface FixtureEntry {
  name: string;
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  fetchedAt: string;
  bytes: number;
}

async function main(): Promise<void> {
  const { positionals } = parseArgs({ allowPositionals: true });
  const [rawUrl, name] = positionals;

  if (!rawUrl || !name) {
    throw new Error('usage: tsx scripts/grab-fixture.ts <url> <name>');
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error(`name must be kebab-case: got ${JSON.stringify(name)}`);
  }

  const url = normaliseUrl(rawUrl);
  const doc = await fetchPage(url, { timeoutMs: 20_000 });

  await writeFile(new URL(`${name}.html`, fixturesDir), doc.html);

  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8')) as FixtureEntry[];
  const entry: FixtureEntry = {
    name,
    url: doc.url,
    finalUrl: doc.finalUrl,
    status: doc.status,
    contentType: doc.contentType,
    fetchedAt: doc.fetchedAt.toISOString(),
    bytes: doc.html.length,
  };

  // Re-grabbing an existing fixture replaces its row rather than duplicating it.
  const index = manifest.findIndex((candidate) => candidate.name === name);
  if (index === -1) manifest.push(entry);
  else manifest[index] = entry;

  await writeFile(manifestUrl, JSON.stringify(manifest, null, 2) + '\n');

  console.log(`saved fixtures/${name}.html — ${doc.html.length} bytes from ${doc.finalUrl}`);
  if (doc.finalUrl !== doc.url) console.log(`note: redirected from ${doc.url}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
