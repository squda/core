import type { Field, LabelSource } from '@untitled/schema';

/**
 * How much we believe a field's name.
 *
 * The schema records *where* a label came from, on the grounds that "its
 * <label for> said so" and "there was some text nearby" are not the same
 * claim. This turns that into the thing the page is built around: a reader can
 * see, per box, whether we know what it is or are guessing.
 */

export type Trust = 'named' | 'inferred' | 'guessed' | 'unknown';

const TRUST_BY_SOURCE: Record<LabelSource, Trust> = {
  // The page said so outright, the same way it tells a screen reader.
  'label-for': 'named',
  'label-wrapping': 'named',
  'aria-labelledby': 'named',
  'aria-label': 'named',
  // Real text, but written for a purpose other than naming the field.
  placeholder: 'inferred',
  title: 'inferred',
  // Proximity is not meaning. This is the layer that gets it wrong.
  'nearby-text': 'guessed',
};

export function trustOf(field: Field): Trust {
  if (!field.label || !field.labelSource) return 'unknown';
  return TRUST_BY_SOURCE[field.labelSource];
}

export const TRUST_LABEL: Record<Trust, string> = {
  named: 'named by the page',
  inferred: 'read from a placeholder or tooltip',
  guessed: 'guessed from nearby text',
  unknown: 'no name at all',
};

export const SOURCE_LABEL: Record<LabelSource, string> = {
  'label-for': '<label for>',
  'label-wrapping': 'wrapping <label>',
  'aria-label': 'aria-label',
  'aria-labelledby': 'aria-labelledby',
  placeholder: 'placeholder',
  title: 'title attribute',
  'nearby-text': 'nearby text',
};

/** Tailwind classes per trust level, so the legend and the rows cannot disagree. */
export const TRUST_STYLE: Record<Trust, { tick: string; text: string; label: string }> = {
  named: {
    tick: 'bg-trust-named border-trust-named',
    text: 'text-trust-named',
    label: 'text-foreground',
  },
  inferred: {
    tick: 'bg-trust-inferred/40 border-trust-inferred',
    text: 'text-trust-inferred',
    label: 'text-foreground',
  },
  guessed: {
    tick: 'bg-trust-guessed/25 border-trust-guessed border-dashed',
    text: 'text-trust-guessed',
    label: 'text-foreground italic',
  },
  unknown: {
    tick: 'bg-transparent border-trust-unknown border-dashed',
    text: 'text-trust-unknown',
    label: 'text-muted-foreground italic',
  },
};

export const TRUST_ORDER: Trust[] = ['named', 'inferred', 'guessed', 'unknown'];

/**
 * Hidden, disabled and readonly controls are real and the walker keeps them —
 * but a CSRF token is not something a person fills, so they are counted
 * separately rather than diluting the headline number.
 */
export function isFillable(field: Field): boolean {
  return field.type !== 'hidden' && !field.disabled && !field.readonly;
}

export function tally(fields: Field[]): Record<Trust, number> {
  const counts: Record<Trust, number> = { named: 0, inferred: 0, guessed: 0, unknown: 0 };
  for (const field of fields) counts[trustOf(field)] += 1;
  return counts;
}
