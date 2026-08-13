import { describe, expect, it } from 'vitest';
import { assertFetchable, isPrivateAddress } from '../src/ssrf.js';
import { BlockedAddressError } from '../src/errors.js';
import { fetchPage } from '../src/fetch.js';
import { fakeResponse, redirectResponse, stubFetch } from './helpers.js';

/** Never touches DNS: hostnames go through an injected resolver, or are IP literals. */
const resolvesTo = (address: string) => async () => [address];

describe('what counts as private', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'the rest of loopback'],
    ['10.0.0.1', 'private class A'],
    ['172.16.0.1', 'private class B'],
    ['172.31.255.255', 'the end of class B'],
    ['192.168.1.1', 'private class C'],
    ['169.254.169.254', 'cloud metadata'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['0.0.0.0', 'this network'],
    ['255.255.255.255', 'broadcast'],
    ['224.0.0.1', 'multicast'],
    ['::1', 'IPv6 loopback'],
    ['fd00::1', 'IPv6 unique-local'],
    ['fe80::1', 'IPv6 link-local'],
    ['::ffff:127.0.0.1', 'IPv4 loopback wearing an IPv6 coat'],
    ['not-an-address', 'anything unparseable'],
  ])('blocks %s (%s)', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '192.169.0.1', '2606:4700::1111'])(
    'allows %s',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});

describe('the guard', () => {
  it('refuses an ip literal pointing inside', async () => {
    await expect(
      assertFetchable('http://169.254.169.254/latest/meta-data/', { allowPrivate: false }),
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });

  // The whole reason a hostname blocklist is not enough.
  it('refuses a public-looking name that resolves inside', async () => {
    await expect(
      assertFetchable('https://totally-normal.test/', {
        allowPrivate: false,
        resolve: resolvesTo('127.0.0.1'),
      }),
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it('refuses when any one of several addresses is private', async () => {
    await expect(
      assertFetchable('https://mixed.test/', {
        allowPrivate: false,
        resolve: async () => ['93.184.216.34', '10.0.0.5'],
      }),
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it('allows a name that resolves to the public internet', async () => {
    await expect(
      assertFetchable('https://example.com/', {
        allowPrivate: false,
        resolve: resolvesTo('93.184.216.34'),
      }),
    ).resolves.toBeUndefined();
  });

  it('lets a local server through when explicitly allowed', async () => {
    await expect(
      assertFetchable('http://127.0.0.1:3000/', { allowPrivate: true }),
    ).resolves.toBeUndefined();
  });

  it('names the address it refused, not just the url', async () => {
    const error = await assertFetchable('http://192.168.0.1/admin', {
      allowPrivate: false,
    }).catch((e: unknown) => e);

    expect((error as BlockedAddressError).address).toBe('192.168.0.1');
    expect((error as Error).message).toContain('not a public address');
  });
});

describe('through fetchPage', () => {
  it('refuses before opening a connection', async () => {
    const fetchSpy = stubFetch(() => fakeResponse('http://127.0.0.1/'));

    await expect(fetchPage('http://127.0.0.1/', { allowPrivate: false })).rejects.toBeInstanceOf(
      BlockedAddressError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * The case a single up-front check misses entirely: the url you were handed
   * is public, and the *second* request is the one that reaches the metadata
   * service. Redirects are followed by hand precisely so this hop is checked.
   */
  it('refuses a public url that redirects inside', async () => {
    // A public IP literal for the first hop, so the test needs no DNS at all.
    const fetchSpy = stubFetch((url) =>
      url === 'https://93.184.216.34/'
        ? redirectResponse('http://169.254.169.254/latest/meta-data/')
        : fakeResponse(url, { body: '<html>credentials</html>' }),
    );

    const error = await fetchPage('https://93.184.216.34/', { allowPrivate: false }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(BlockedAddressError);
    expect((error as BlockedAddressError).address).toBe('169.254.169.254');
    // The first hop happened; the second never left.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
