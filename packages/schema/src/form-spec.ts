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
 * It began with a survey of real captured forms rather than an imagined clean
 * form. That original survey found 69 controls, of which 25 carry `autocomplete`, 19
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
 * a control. The corpus contains both native selects and modern widgets, so
 * the schema has to describe both without pretending one is the other.
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

/**
 * What the filler must do with a field.
 *
 * HTML tag names are not enough here: a contenteditable textbox and an ARIA
 * combobox can both be non-native `custom` controls while requiring completely
 * different browser actions.
 */
export const FieldInteractionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('type') }),
  z.object({
    kind: z.literal('choose'),
    mode: z.enum(['single', 'multiple']),
    optionsStatus: z.enum(['complete', 'partial', 'dynamic']),
  }),
  z.object({ kind: z.literal('toggle') }),
  z.object({ kind: z.literal('upload') }),
  z.object({ kind: z.literal('none') }),
]);

/** One independently replayable way to address an element. */
export const LocatorCandidateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('css'),
    selector: z.string().min(1),
    source: z.enum(['name', 'test-id', 'aria-label', 'id', 'src', 'path']),
  }),
  z.object({
    kind: z.literal('role-name'),
    role: z.string().min(1),
    name: z.string().min(1),
  }),
]);

/** How many controls a field locator is supposed to address. */
export const LocatorCardinalitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('single') }),
  z.object({ kind: z.literal('group'), count: z.number().int().min(2) }),
]);

/**
 * A boundary crossed on the way from the page document to a control.
 *
 * A CSS selector alone cannot enter an iframe, and browser DOM APIs require an
 * explicit shadow-root hop. Keeping those hops structured means the eventual
 * filler can replay the same route instead of trying to parse a magic string.
 */
export const FieldScopeSchema = z.object({
  kind: z.enum(['frame', 'shadow']),
  /** Deprecated compatibility selector. New consumers replay `candidates`. */
  selector: z.string().min(1),
  candidates: z.array(LocatorCandidateSchema).optional(),
  fingerprint: z
    .object({
      tag: z.string().min(1),
      name: z.string().nullable(),
      ariaLabel: z.string().nullable(),
      src: z.string().nullable(),
    })
    .optional(),
});

export const FieldLocatorSchema = z.object({
  scopes: z.array(FieldScopeSchema),
  /** A field is normally one element; native radio/checkbox groups are exact sets. */
  cardinality: LocatorCardinalitySchema,
  /** Deprecated compatibility selector. New consumers replay `preferred`. */
  selector: z.string().min(1),
  candidates: z.array(LocatorCandidateSchema).optional(),
  preferred: LocatorCandidateSchema.nullable().optional(),
  verification: z.enum(['fresh-load', 'snapshot-only']).optional(),
  fingerprint: z
    .object({
      type: FieldTypeSchema,
      interactionKind: z.enum(['type', 'choose', 'toggle', 'upload', 'none']),
      name: z.string().nullable(),
      label: z.string().nullable(),
    })
    .optional(),
});

export const FieldSchema = z.object({
  /**
   * Compatibility CSS address for this control's inspection snapshot.
   *
   * Live consumers should replay `locator.preferred` and its ordered fallbacks;
   * only those carry fresh-load verification. Static HTML has no second page
   * load with which to make a durability claim.
   */
  selector: z.string().min(1),

  /**
   * The complete browser route to the control when it was read from a live
   * page. Static HTML extraction leaves this absent because it cannot know
   * which live document or shadow root produced serialized markup.
   */
  locator: FieldLocatorSchema.optional(),

  /** Zero-based wizard step where live inspection first saw the field. */
  stepIndex: z.number().int().nonnegative().optional(),

  name: z.string().nullable(),
  id: z.string().nullable(),
  type: FieldTypeSchema,
  interaction: FieldInteractionSchema,

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
   * A password, a card number, a national id, a date of birth.
   *
   * **A label, not a blocker** (decided 2026-08-14). The filler fills every
   * field it has a value for, including these; what the flag buys is that the
   * Phase 8 review UI can highlight them, a report can call them out, and a
   * future policy could gate them without re-deriving the judgement.
   *
   * Note what limits the blast radius already: the filler can only type what
   * the profile store holds. If a card number was never stored, "fill
   * everything" fills nothing sensitive.
   *
   * Derived here rather than at fill time because this is where the evidence
   * is — type, name, label and autocomplete all at hand. Phase 5 carries the
   * same flag on stored values, so both halves use the same word.
   */
  sensitive: z.boolean(),

  placeholder: z.string().nullable(),
  /** Current values are evidence, never a substitute for the field's label. */
  currentValues: z.array(z.string()),
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
  /** Zero-based wizard step where live inspection saw this form state. */
  stepIndex: z.number().int().nonnegative().optional(),
  fields: z.array(FieldSchema),
});

export const FormInspectionWarningSchema = z.object({
  code: z.enum([
    'step-limit',
    'step-stalled',
    'closed-shadow-root',
    'branch-not-exhaustive',
    'inspection-budget-exhausted',
    'locator-not-replayable',
  ]),
  message: z.string().min(1),
});

/**
 * Every form on one page.
 *
 * A list, not a single form, because real pages often contain search, feedback
 * and primary forms together. A schema that assumed "the form" would have
 * been wrong on the first such page it met.
 */
export const FormSpecSchema = z.object({
  url: z.string().url(),
  fetchedAt: z.coerce.date(),
  fetchedWith: z.enum(['http', 'browser']),
  forms: z.array(FormSchema),
  /** Honest limits encountered while inspecting a live page. */
  warnings: z.array(FormInspectionWarningSchema).optional(),
});

export type FieldType = z.infer<typeof FieldTypeSchema>;
export type LabelSource = z.infer<typeof LabelSourceSchema>;
export type FieldOption = z.infer<typeof FieldOptionSchema>;
export type FieldInteraction = z.infer<typeof FieldInteractionSchema>;
export type LocatorCandidate = z.infer<typeof LocatorCandidateSchema>;
export type LocatorCardinality = z.infer<typeof LocatorCardinalitySchema>;
export type FieldScope = z.infer<typeof FieldScopeSchema>;
export type FieldLocator = z.infer<typeof FieldLocatorSchema>;
export type Field = z.infer<typeof FieldSchema>;
export type Form = z.infer<typeof FormSchema>;
export type FormInspectionWarning = z.infer<typeof FormInspectionWarningSchema>;
export type FormSpec = z.infer<typeof FormSpecSchema>;
