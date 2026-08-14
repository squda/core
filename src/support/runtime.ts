/**
 * Refuse to start on a Node this project does not support.
 *
 * Not pedantry: on Node 20 the first symptom is a twenty-line stack trace out
 * of `@supabase/realtime-js` about a missing WebSocket — a transitive
 * dependency complaining about something the caller never asked for. The
 * actual problem is one sentence, and this is where it can be said.
 *
 * `engines` in package.json only makes pnpm print a warning, and warnings
 * scroll past. Phase 9's rule applies here too: fail at boot, loudly, rather
 * than midway through the first request.
 */

export const MINIMUM_NODE_MAJOR = 22;

export function checkNodeVersion(version: string = process.versions.node): string | null {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (Number.isFinite(major) && major >= MINIMUM_NODE_MAJOR) return null;

  return [
    `This needs Node ${MINIMUM_NODE_MAJOR} or newer — you are on ${version}.`,
    '',
    '  nvm use 22        (or: nvm install 22)',
    '',
    'Node 20 has no global WebSocket, which @supabase/supabase-js requires at',
    'startup, so the failure otherwise arrives as a stack trace from a package',
    'you never imported.',
  ].join('\n');
}

/** Prints the explanation and stops. Called first thing by both entry points. */
export function assertSupportedNode(): void {
  const problem = checkNodeVersion();
  if (!problem) return;

  process.stderr.write(`${problem}\n`);
  process.exit(1);
}
