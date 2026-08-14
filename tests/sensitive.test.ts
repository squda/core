import { describe, expect, it } from 'vitest';
import { isSensitive } from '../src/core/sensitive.js';
import type { FieldType } from '../src/core/form-spec.js';

function field(overrides: Partial<Parameters<typeof isSensitive>[0]> = {}) {
  return {
    type: 'text' as FieldType,
    name: null,
    id: null,
    label: null,
    autocomplete: null,
    ...overrides,
  };
}

describe('always sensitive', () => {
  it('flags a password box whatever it is called', () => {
    expect(isSensitive(field({ type: 'password', name: 'x' }))).toBe(true);
  });

  it.each([
    'cc-number',
    'cc-csc',
    'cc-exp',
    'cc-name',
    'current-password',
    'new-password',
    'one-time-code',
  ])('flags autocomplete="%s"', (autocomplete) => {
    expect(isSensitive(field({ autocomplete }))).toBe(true);
  });
});

describe('by wording', () => {
  it.each([
    ['name', 'ssn'],
    ['name', 'card_number'],
    ['name', 'cvv'],
    ['id', 'aadhaar'],
    ['label', 'Social Security Number'],
    ['label', 'Date of birth'],
    ['label', 'Passport number'],
    ['label', 'IBAN'],
    ['name', 'bank_account'],
    ['label', 'One-time code'],
  ])('flags %s = %s', (key, value) => {
    expect(isSensitive(field({ [key]: value }))).toBe(true);
  });

  it.each([
    ['label', 'First name'],
    ['label', 'Email address'],
    ['name', 'company'],
    ['label', 'Discard draft'],
    ['label', 'Card design'],
    ['name', 'linkedin_url'],
  ])('leaves %s = %s alone', (key, value) => {
    expect(isSensitive(field({ [key]: value }))).toBe(false);
  });
});

/**
 * The trap worth a test of its own. In India a *PIN code* is a postal code,
 * and PLAN.md's own Phase 6 example is "PIN code" matching address.postalCode.
 * Calling that a secret would make the filler refuse to fill an address.
 */
describe('the PIN ambiguity', () => {
  it.each(['PIN code', 'Pincode', 'pin_code'])('treats %s as an address, not a secret', (label) => {
    expect(isSensitive(field({ label }))).toBe(false);
  });

  it.each(['PIN', 'ATM pin', 'card pin'])('treats %s as a secret', (label) => {
    expect(isSensitive(field({ label }))).toBe(true);
  });
});

/**
 * Found by running the detector over the fixture set: demoqa's practice form
 * has a date-of-birth field called `dateOfBirthInput`, and every pattern here
 * uses word boundaries — so it matched nothing at all.
 */
describe('camelCase names', () => {
  it.each(['dateOfBirthInput', 'cardNumber', 'socialSecurityNumber', 'cvvCode'])(
    'reads %s as words',
    (id) => {
      expect(isSensitive(field({ id }))).toBe(true);
    },
  );

  it.each(['firstName', 'emailAddress', 'currentCompany', 'pinCode'])('leaves %s alone', (id) => {
    expect(isSensitive(field({ id }))).toBe(false);
  });
});

describe('what it reads', () => {
  it('checks name, id and label together', () => {
    expect(isSensitive(field({ name: 'q1', id: 'q1', label: 'Enter your CVV' }))).toBe(true);
  });

  it('is not sensitive when the page says nothing at all', () => {
    expect(isSensitive(field())).toBe(false);
  });
});
