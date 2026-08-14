import { z } from 'zod';

/**
 * THE CONTRACT — Phase 4.
 *
 * Everything before this produces prose. This produces *structure*: what boxes
 * a page has, what each one is for, and how to find it again in a browser.
 * Phases 6 and 7 are built entirely against this shape, weeks after it is
 * written, which is why the plan insists it is settled before any code is
 * written against it.
 *
 * It is designed against the six real forms in fixtures/, not from memory. The
 * survey that produced it: 69 controls, of which 25 carry `autocomplete`, 19
 * carry `aria-describedby`, 18 have no label at all, 8 are hidden, and one
 * page holds five separate <form> elements. Every decision below is downstream
 * of one of those numbers.
 */

/**
 * What kind of control it is, normalised.
 *
 * `<input type=...>` collapses into the same union as `<select>` and
 * `<textarea>`, because the filler cares what it must *do* — type, choose,
 * check, upload — not which tag the page used.
 *
 * `custom` is the honest bucket for a React combobox: a div that behaves like
 * a control. None of the six fixtures uses a native <select>, which is itself
 * the finding — modern forms reach for widgets, and pretending otherwise would
 * make this schema describe a web that no longer exists.
 */
export const FieldTypeSchema = z.enum([
  'text',
  'email',
  'tel',
  'url',
  'number',
  'password',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
  'search',
  'color',
  'range',
  'checkbox',
  'radio',
  'select',
  'textarea',
  'file',
  'hidden',
  'custom',
]);

/**
 * Where the label came from.
 *
 * Recorded, not just used. The same reasoning as `reason` on a FillPlan entry:
 * when a field is filled with the wrong value, the first question is what we
 * thought it was called and why — and "nearby text" deserves far less trust
 * than "its <label for> said so".
 */
export const LabelSourceSchema = z.enum([
  'label-for',
  'label-wrapping',
  'aria-label',
  'aria-labelledby',
  'placeholder',
  'nearby-text',
  'title',
]);

/** One choice within a select, or one member of a radio/checkbox group. */
export const FieldOptionSchema = z.object({
  /** What gets submitted. */
  value: z.string(),
  /** What a person reads. Falls back to the value when there is no text. */
  label: z.string(),
  selected: z.boolean(),
});

export const FieldSchema = z.object({
  /**
   * How to find this control again in a browser.
   *
   * Stability is the whole job: `#id`, then `[name=]`, then a scoped path.
   * Never an auto-generated class — those change on every deploy, and a
   * selector that worked in the FormSpec but not at fill time is the failure
   * mode that makes the whole system look unreliable.
   */
  selector: z.string().min(1),

  name: z.string().nullable(),
  id: z.string().nullable(),
  type: FieldTypeSchema,

  /**
   * The visible label, and how we got it. Null when the page offers nothing —
   * 18 of 69 controls in the fixture set, so this is a normal case rather than
   * a broken page, and inventing a label would be a lie the matcher then acts on.
   */
  label: z.string().nullable(),
  labelSource: LabelSourceSchema.nullable(),

  /**
   * Help text, usually via aria-describedby — the most common attribute in the
   * whole survey. "We'll never share this" and "must be 8 characters" are
   * context a matcher can use and a person needs to see.
   */
  description: z.string().nullable(),

  /**
   * The browser's own field vocabulary: `given-name`, `family-name`,
   * `address-line1`, `cc-number`.
   *
   * Present on 25 of 69 controls, and unlike a label it is *standardised* — a
   * fixed set of tokens the whole web agreed on. Phase 6 should try this before
   * any string distance or embedding: when a page tells you exactly what a box
   * is for, guessing is strictly worse.
   */
  autocomplete: z.string().nullable(),

  required: z.boolean(),
  disabled: z.boolean(),
  readonly: z.boolean(),

  /**
   * Do not fill without explicit confirmation.
   *
   * Derived here rather than left to the filler, because this is where the
   * evidence is: a password field, a field named for a national id or a card
   * number. Phase 5 carries the same flag on profile values, and Phase 7 must
   * refuse to touch either without being asked twice.
   */
  sensitive: z.boolean(),

  placeholder: z.string().nullable(),
  /** For select, radio groups, and checkbox groups. Empty for everything else. */
  options: z.array(FieldOptionSchema),

  /** Constraints worth respecting when formatting a value. */
  pattern: z.string().nullable(),
  maxLength: z.number().int().positive().nullable(),
  minLength: z.number().int().nonnegative().nullable(),
  min: z.string().nullable(),
  max: z.string().nullable(),
  step: z.string().nullable(),
  /** `accept` on a file input: ".pdf,.doc" — what the page will take. */
  accept: z.string().nullable(),
  multiple: z.boolean(),
});

export const FormSchema = z.object({
  /**
   * Null for controls that belong to no <form> at all — a search box in a
   * header, or a React form that never used the element. They are still
   * fields, and dropping them would lose real boxes on the page.
   */
  selector: z.string().nullable(),
  name: z.string().nullable(),
  /** Absolute, resolved against the page. Null when the form posts to itself. */
  action: z.string().nullable(),
  method: z.enum(['get', 'post']),
  /** The button that submits it. Null when there isn't one to find. */
  submitSelector: z.string().nullable(),
  fields: z.array(FieldSchema),
});

/**
 * Every form on one page.
 *
 * A list, not a single form, because five of the six fixtures have more than
 * one — Wikipedia's signup page has three, the checkout demo has five. A
 * schema that assumed "the form" would have been wrong on the first real page
 * it met.
 */
export const FormSpecSchema = z.object({
  url: z.string().url(),
  fetchedAt: z.coerce.date(),
  fetchedWith: z.enum(['http', 'browser']),
  forms: z.array(FormSchema),
});

export type FieldType = z.infer<typeof FieldTypeSchema>;
export type LabelSource = z.infer<typeof LabelSourceSchema>;
export type FieldOption = z.infer<typeof FieldOptionSchema>;
export type Field = z.infer<typeof FieldSchema>;
export type Form = z.infer<typeof FormSchema>;
export type FormSpec = z.infer<typeof FormSpecSchema>;
