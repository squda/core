import type { FieldType } from './form-spec.js';

/**
 * Which boxes hold something private.
 *
 * **This marks; it does not block** (decided 2026-08-14). The filler fills
 * everything it has a value for. The flag exists so a review screen can
 * highlight those rows and a report can name them — and so a policy that does
 * want to gate them has a boolean to read rather than a judgement to re-make.
 *
 * Decided here, while the page is in front of us, because this is where the
 * evidence is: the input type, the name the page gave it, the label a person
 * reads, and the browser's own autocomplete token. A filler holding only a
 * Field object would be re-deriving the same answer later with less to go on,
 * and every other consumer — the Phase 8 review UI, the API — would have to
 * derive it again and could disagree.
 *
 * Erring toward sensitive stays the cheap direction even as a label: a false
 * positive highlights one row too many, a false negative lets a card number
 * scroll past unremarked in a review nobody looked at twice.
 */

export interface SensitiveInput {
  type: FieldType;
  name: string | null;
  id: string | null;
  label: string | null;
  autocomplete: string | null;
}

/**
 * autocomplete tokens that are sensitive by definition.
 *
 * These are the strongest signal available: standardised, unambiguous, and
 * written by the page itself. `cc-*` is the whole payment family.
 */
const SENSITIVE_AUTOCOMPLETE = /^(?:cc-|current-password|new-password|one-time-code)/i;

/**
 * Wording that means a secret or a government identifier.
 *
 * Matched against name, id and label together. Word boundaries throughout:
 * `card` must not fire on "discard", and `cvv` is only ever `cvv`.
 */
const SENSITIVE_WORDS = [
  /\bpassw(or)?d\b/i,
  /\bpasscode\b/i,
  /\bsecret\b/i,
  /\botp\b/i,
  /\bone[-_ ]?time[-_ ]?(code|password)\b/i,
  /\bmfa\b|\b2fa\b|\btwo[-_ ]factor\b/i,
  /\b(cvv|cvc|csc)\b/i,
  /\bsecurity[-_ ]code\b/i,
  /\bcard[-_ ]?(number|no)\b/i,
  /\bcredit[-_ ]?card\b/i,
  /\bdebit[-_ ]?card\b/i,
  /\biban\b/i,
  /\bsort[-_ ]?code\b/i,
  /\brouting[-_ ]?(number|no)\b/i,
  /\bbank[-_ ]?account\b/i,
  /\bssn\b/i,
  /\bsocial[-_ ]security\b/i,
  /\bnational[-_ ]?(id|insurance)\b/i,
  /\bnino\b/i,
  /\baadhaa?r\b/i,
  /\bpassport\b/i,
  /\bdriver'?s?[-_ ]licen[cs]e\b/i,
  /\btax[-_ ]?(id|file|number)\b/i,
  /\bdate[-_ ]of[-_ ]birth\b/i,
  /\bbirth[-_ ]?(date|day)\b/i,
  /\bdob\b/i,
];

/**
 * "PIN" is the trap.
 *
 * In India a *PIN code* is a postal code — and PLAN.md's own Phase 6 example
 * is "PIN code" matching `address.postalCode`. Treating that as a secret would
 * make the matcher refuse to fill an address, which is both wrong and
 * confusing. So a bare `pin` counts and `pin code` explicitly does not.
 */
const BARE_PIN = /\bpin\b/i;
const POSTAL_PIN = /\bpin[-_ ]?code\b|\bpincode\b/i;

/**
 * `dateOfBirthInput` has to read as "date of birth".
 *
 * Ids and names are written in camelCase far more often than in prose, and
 * every pattern here uses word boundaries — so without this step
 * `dateOfBirthInput` matches nothing, which is exactly what the fixture set
 * caught: the practice form's DOB field came back clean.
 */
function toWords(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isSensitive({ type, name, id, label, autocomplete }: SensitiveInput): boolean {
  // A password box is a password box, whatever it is called.
  if (type === 'password') return true;

  if (autocomplete && SENSITIVE_AUTOCOMPLETE.test(autocomplete.trim())) return true;

  const haystack = [name, id, label]
    .filter((part): part is string => Boolean(part))
    .map(toWords)
    .join(' ');
  if (haystack === '') return false;

  if (SENSITIVE_WORDS.some((pattern) => pattern.test(haystack))) return true;
  if (BARE_PIN.test(haystack) && !POSTAL_PIN.test(haystack)) return true;

  return false;
}
