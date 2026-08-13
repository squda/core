/**
 * The client string both fetch paths send, so a site sees the same visitor
 * whether or not a browser was involved.
 *
 * A real browser's, because Node's default UA is blocked or served a degraded
 * page by a lot of sites — the difference between a fixture with content and a
 * fixture containing a bot-check page.
 */
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
