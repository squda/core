import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BlockedAddressError } from './errors.js';

/**
 * Phase 9, step 1, pulled forward — because this is a security bug in code
 * that already exists, not a deployment task.
 *
 * This service fetches any url it is handed. Deployed, that means anyone can
 * ask it for `http://169.254.169.254/latest/meta-data/iam/security-credentials/`
 * — the cloud metadata endpoint, which hands instance credentials to anything
 * asking from inside the box. We are inside the box. It would fetch them,
 * convert them to Markdown, and reply.
 *
 * Same shape for `http://localhost:5432`, an internal admin panel, or a
 * `10.x` service that assumed the network was the perimeter.
 *
 * Two things make this harder than a hostname blocklist:
 *
 * 1. **DNS decides, not the string.** `internal.evil.test` can resolve to
 *    127.0.0.1. The address has to be checked, not the name.
 * 2. **Redirects re-open it.** A public url can 302 to 127.0.0.1, so every hop
 *    is checked, which is why fetch.ts follows redirects by hand.
 *
 * A name that does not resolve is *not* blocked here — the DNS error is left
 * to propagate, so an unreachable host still reports as a network failure
 * rather than as a security refusal. Nothing is lost: it cannot be fetched
 * either way, and the caller gets the accurate reason.
 */

export interface GuardOptions {
  /**
   * Allow private and loopback addresses. Off unless `SCRAPE_ALLOW_PRIVATE=1`.
   *
   * Secure by default: development and the test suite opt *in* (they scrape a
   * local server), rather than production having to remember to opt out.
   */
  allowPrivate?: boolean;
  /** Injectable so tests never touch real DNS. */
  resolve?: (hostname: string) => Promise<string[]>;
}

/** Every address a hostname answers with — one public A record does not clear an AAAA that isn't. */
async function resolveAll(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
}

/**
 * @throws {BlockedAddressError} when the url points inside the network.
 */
export async function assertFetchable(url: string, options: GuardOptions = {}): Promise<void> {
  const allowPrivate = options.allowPrivate ?? process.env.SCRAPE_ALLOW_PRIVATE === '1';
  if (allowPrivate) return;

  const { hostname } = new URL(url);
  // URL keeps IPv6 literals in brackets; the address parsers do not want them.
  const host = hostname.replace(/^\[|\]$/g, '');

  const addresses = isIP(host) ? [host] : await (options.resolve ?? resolveAll)(host);

  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new BlockedAddressError(url, address);
    }
  }
}

/**
 * Everything that isn't the public internet.
 *
 * Deliberately broad. A false positive costs one page; a false negative costs
 * whatever that address was protecting.
 */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true; // Unparseable: refuse rather than guess.
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a = 0, b = 0] = parts;

  if (a === 0) return true; // 0.0.0.0/8 — "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local — cloud metadata lives here
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // protocol assignments, incl. 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const value = address.toLowerCase().split('%')[0] ?? '';

  if (value === '::' || value === '::1') return true; // unspecified, loopback

  // ::ffff:127.0.0.1 and friends — an IPv4 address wearing an IPv6 coat.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);

  const head = value.split(':')[0] ?? '';
  const leading = Number.parseInt(head.padStart(4, '0').slice(0, 2), 16);

  if ((leading & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (value.startsWith('fe8') || value.startsWith('fe9')) return true; // fe80::/10
  if (value.startsWith('fea') || value.startsWith('feb')) return true;
  if (value.startsWith('ff')) return true; // multicast
  return false;
}
