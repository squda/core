import type { Field, LabelSource } from '@untitled/schema';

/**
 * How much we believe a field's label.
 *
 * The schema already records *where* a label came from, on the grounds that
 * "its <label for> said so" and "there was some text nearby" are not the same
 * claim. This turns that recorded provenance into the thing the page is built
 * around: a reader can see, per box, whether we know what it is or are
 * guessing — which is the honest version of "what can you fill?".
 */

export type Trust = 'named' | 'inferred' | 'guessed' | 'unknown';

const TRUST_BY_SOURCE: Record<LabelSource, Trust> = {
  // The page said so outright, in the same way it tells a screen reader.
  'label-for': 'named',
  'label-wrapping': 'named',
  'aria-labelledby': 'named',
  'aria-label': 'named',
  // Real text, but written for a different purpose than naming the field.
  placeholder: 'inferred',
  title: 'inferred',
  // Proximity is not meaning. This is the layer that gets it wrong.
  'nearby-text': 'guessed',
};

export function trustOf(field: Field): Trust {
  if (!field.label || !field.labelSource) return 'unknown';
  return TRUST_BY_SOURCE[field.labelSource];
}

export const TRUST_COPY: Record<Trust, { badge: string; explain: string }> = {
  named: { badge: 'named', explain: 'the page names this field' },
  inferred: { badge: 'inferred', explain: 'read from text meant for something else' },
  guessed: { badge: 'guessed', explain: 'taken from nearby text — often wrong' },
  unknown: { badge: 'no name', explain: 'the page never says what this is' },
};

export const SOURCE_COPY: Record<LabelSource, string> = {
  'label-for': '<label for>',
  'label-wrapping': 'wrapping <label>',
  'aria-label': 'aria-label',
  'aria-labelledby': 'aria-labelledby',
  placeholder: 'placeholder',
  title: 'title attribute',
  'nearby-text': 'nearby text',
};

export interface Tally {
  fields: number;
  named: number;
  inferred: number;
  guessed: number;
  unknown: number;
  required: number;
  sensitive: number;
  files: number;
}

export function tally(fields: Field[]): Tally {
  const counts: Tally = {
    fields: fields.length,
    named: 0,
    inferred: 0,
    guessed: 0,
    unknown: 0,
    required: 0,
    sensitive: 0,
    files: 0,
  };
  for (const field of fields) {
    counts[trustOf(field)] += 1;
    if (field.required) counts.required += 1;
    if (field.sensitive) counts.sensitive += 1;
    if (field.type === 'file') counts.files += 1;
  }
  return counts;
}

/**
 * Hidden fields are real and are deliberately kept by the walker — but a CSRF
 * token is not something a person fills, so the demo counts them separately
 * rather than diluting the headline number.
 */
export function isFillable(field: Field): boolean {
  return field.type !== 'hidden' && !field.disabled && !field.readonly;
}
