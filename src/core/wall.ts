import type { Link } from './types.js';

/**
 * Soft failures: pages that succeed and still tell you nothing — HTTP 200,
 * real content, wrong page. A login wall, a bot check, a consent screen.
 *
 * fetch.ts catches pages that *fail*; select.ts catches pages that came back
 * *empty*; neither sees this third case.
 *
 * ## What the evidence actually says
 *
 * This was written after a run across ~25 real sites, and the run did **not**
 * find one. Sites that wall you mostly refuse at the door instead — Quora,
 * Medium, StackOverflow and GitHub's signup page all answer 403, which the
 * error taxonomy already handles. Instagram and LinkedIn, the two classic
 * "login wall" examples, both served real profile content.
 *
 * The one page that looked like a wall was not: x.com logged-out shows a
 * genuine profile with `Log in` / `Sign up` in the header nav, and it is kept
 * as the `thin-profile` fixture — as a *negative* case, because it is exactly
 * the shape a careless detector would flag.
 *
 * So this ships as a guard for Phase 4 rather than a fix for something
 * observed: a FormSpec built from a login page would describe the *login form*
 * and never know it read the wrong thing. The positive cases below are
 * synthetic and labelled as such. Tighten them when a real wall turns up.
 *
 * Detection is deliberately conservative — a false positive calls a real page
 * useless, which is worse than missing a wall. Every rule requires the page to
 * be thin as well as suspicious, because a long article that discusses logging
 * in is a long article.
 */

export type WallKind = 'login' | 'captcha' | 'consent';

export interface Wall {
  kind: WallKind;
  reason: string;
}

export interface WallInput {
  title: string;
  markdown: string;
  links: Link[];
}

/**
 * Above this, a page has said enough that it isn't merely a gate. Well above
 * select.ts's 150-character threshold: a login wall with a marketing blurb
 * still runs to a few hundred characters.
 */
const THIN = 2_000;

/** What a bot-check page says while it decides about you. */
const CAPTCHA_PHRASES =
  /just a moment|attention required|checking your browser|verify (?:you are|you're) (?:a )?human|are you a robot|enable cookies (?:and|&) javascript|ddos protection/i;

const CONSENT_PHRASES =
  /accept (?:all )?cookies|we value your privacy|manage (?:your )?(?:cookie )?preferences|consent to the use of cookies|before you continue to/i;

/** Login and signup routes, as they appear in an href. */
const AUTH_PATH = /\/(?:login|signin|sign[-_]in|signup|sign[-_]up|register|auth|account\/login)\b/i;

const AUTH_TEXT = /^(?:log ?in|sign ?in|sign ?up|register|create (?:an )?account|continue)$/i;

export function detectWall({ title, markdown, links }: WallInput): Wall | null {
  const haystack = `${title}\n${markdown}`;

  // Checked first and without the thinness rule: a Cloudflare interstitial is
  // unambiguous, and its whole job is to look like a page.
  if (markdown.length < 5_000 && CAPTCHA_PHRASES.test(haystack)) {
    return { kind: 'captcha', reason: 'looks like a bot check, not the page you asked for' };
  }

  if (markdown.length >= THIN) return null;

  const authLinks = links.filter(
    (link) => AUTH_PATH.test(link.href) || AUTH_TEXT.test(link.text.trim()),
  );

  // Two signals, either sufficient: the page is *made of* auth links, or it
  // names itself a login page in the title.
  if (authLinks.length >= 2 && authLinks.length / Math.max(links.length, 1) >= 0.4) {
    return {
      kind: 'login',
      reason: `${authLinks.length} of ${links.length} links go to log in or sign up`,
    };
  }

  if (/^(?:log ?in|sign ?in)\b/i.test(title.trim())) {
    return { kind: 'login', reason: `the page calls itself ${JSON.stringify(title)}` };
  }

  if (CONSENT_PHRASES.test(haystack)) {
    return { kind: 'consent', reason: 'a consent screen stands where the content should be' };
  }

  return null;
}
