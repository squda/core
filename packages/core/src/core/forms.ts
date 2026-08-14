import * as cheerio from 'cheerio';
// cheerio parses into domhandler nodes but does not re-export their types.
import type { AnyNode, Element } from 'domhandler';
import {
  FormSpecSchema,
  type Field,
  type FieldOption,
  type FieldType,
  type Form,
  type FormSpec,
  type LabelSource,
} from '@untitled/schema';
import { isSensitive } from './sensitive.js';
import { collapseWhitespace } from '../support/text.js';
import { toAbsoluteUrl } from './url.js';
import type { HtmlDocument } from './types.js';

/**
 * Phase 4 — the walker. Raw HTML in, FormSpec out.
 *
 * It reads the *unprocessed* page, deliberately. The extraction pipeline that
 * produces Markdown strips every `<input>` — Readability keeps a `<form>` and
 * its labels and throws the controls away, which a test in extract.test.ts
 * records. So prose extraction and form extraction are two different readings
 * of the same document, and this one starts from scratch.
 */

/** Types we take at face value from `<input type=...>`. */
const INPUT_TYPES = new Set<FieldType>([
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
  'file',
  'hidden',
]);

/** Buttons. Not fields — they become a form's submitSelector. */
const BUTTON_TYPES = new Set(['submit', 'button', 'reset', 'image']);

const CONTROL_SELECTOR =
  'input, select, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"]';

export function extractForms(doc: HtmlDocument): FormSpec {
  const $ = cheerio.load(doc.html);
  const forms: Form[] = [];

  $('form').each((_index, element) => {
    const form = readForm($, element, doc.finalUrl);
    if (form.fields.length > 0) forms.push(form);
  });

  // Controls that belong to no <form> at all — a header search box, or a React
  // form that never used the element. Real boxes on the page; dropping them
  // would mean a spec that cannot describe the page it just read.
  const orphans = $(CONTROL_SELECTOR)
    .toArray()
    .filter((element) => $(element).parents('form').length === 0);

  if (orphans.length > 0) {
    forms.push({
      selector: null,
      name: null,
      action: null,
      method: 'get',
      submitSelector: null,
      fields: readFields($, orphans, null),
    });
  }

  // Parse, don't validate: the same boundary discipline as ScrapedDocument.
  return FormSpecSchema.parse({
    url: doc.url,
    fetchedAt: doc.fetchedAt,
    fetchedWith: doc.fetchedWith,
    forms,
  } satisfies FormSpec);
}

function readForm($: cheerio.CheerioAPI, element: Element, baseUrl: string): Form {
  const $form = $(element);
  const selector = selectorFor($, element, null);

  const controls = $form.find(CONTROL_SELECTOR).toArray();
  const action = toAbsoluteUrl($form.attr('action') ?? '', baseUrl);
  const method = ($form.attr('method') ?? 'get').toLowerCase() === 'post' ? 'post' : 'get';

  return {
    selector,
    name: $form.attr('name') ?? null,
    action,
    method,
    submitSelector: findSubmit($, $form, selector),
    fields: readFields($, controls, selector),
  };
}

/**
 * The button that submits the form.
 *
 * Preferred in the order a person would look: an explicit `type=submit`, then
 * a bare `<button>` (submit is its default type), then anything shaped like a
 * submit input. Null rather than a guess when there is nothing to find — a
 * wrong submit selector is worse than none, because Phase 7 clicks it.
 */
function findSubmit(
  $: cheerio.CheerioAPI,
  $form: cheerio.Cheerio<Element>,
  formSelector: string | null,
): string | null {
  for (const candidate of ['[type="submit"]', 'button:not([type])', 'button[type="submit"]']) {
    const found = $form.find(candidate).first();
    const element = found.get(0);
    if (element) return selectorFor($, element as Element, formSelector);
  }
  return null;
}

/**
 * Turn controls into fields, grouping the ones that answer a single question.
 *
 * Radios sharing a name are one question with several answers, and so are
 * checkbox groups. Emitting one field per input would make the matcher answer
 * "what goes in this box?" three times for one question, and give the filler
 * three chances to disagree with itself.
 */
function readFields(
  $: cheerio.CheerioAPI,
  controls: AnyNode[],
  formSelector: string | null,
): Field[] {
  const fields: Field[] = [];
  const claimed = new Set<AnyNode>();

  for (const element of controls) {
    if (claimed.has(element)) continue;

    const $control = $(element as Element);
    const type = typeOf($, element as Element);
    if (type === null) continue; // a button

    if (type === 'radio' || type === 'checkbox') {
      const name = $control.attr('name');
      const siblings = name
        ? controls.filter(
            (other) =>
              $(other as Element).attr('name') === name && typeOf($, other as Element) === type,
          )
        : [element];

      // A lone checkbox is its own question ("I agree"), so it keeps no
      // options — its value is whether it is ticked. Two or more sharing a
      // name is a group, and the options are the answers.
      const grouped = type === 'radio' || siblings.length > 1;
      for (const sibling of siblings) claimed.add(sibling);

      fields.push(
        readField($, element as Element, formSelector, type, {
          groupWith: grouped ? (siblings as Element[]) : [],
        }),
      );
      continue;
    }

    claimed.add(element);
    fields.push(readField($, element as Element, formSelector, type, { groupWith: [] }));
  }

  return fields;
}

function readField(
  $: cheerio.CheerioAPI,
  element: Element,
  formSelector: string | null,
  type: FieldType,
  { groupWith }: { groupWith: Element[] },
): Field {
  const $control = $(element);
  const name = $control.attr('name') ?? null;
  const id = $control.attr('id') ?? null;

  const { label, labelSource } =
    groupWith.length > 1
      ? resolveGroupLabel($, groupWith)
      : type === 'hidden'
        ? resolveHiddenLabel($, element)
        : resolveLabel($, element);
  const autocomplete = $control.attr('autocomplete') ?? null;

  // A group is addressed by its shared name: the filler picks among the
  // options rather than typing into one particular radio.
  const selector =
    groupWith.length > 1 && name
      ? scoped(formSelector, `[name="${escapeAttribute(name)}"]`)
      : selectorFor($, element, formSelector);

  return {
    selector,
    name,
    id,
    type,
    label,
    labelSource,
    description: resolveDescription($, element),
    autocomplete,
    required: has($control, 'required') || $control.attr('aria-required') === 'true',
    disabled: has($control, 'disabled'),
    readonly: has($control, 'readonly'),
    sensitive: isSensitive({ type, name, id, label, autocomplete }),
    placeholder: collapseOrNull($control.attr('placeholder')),
    options: readOptions($, element, type, groupWith),
    pattern: $control.attr('pattern') ?? null,
    maxLength: numberAttribute($control.attr('maxlength')),
    minLength: numberAttribute($control.attr('minlength')),
    min: $control.attr('min') ?? null,
    max: $control.attr('max') ?? null,
    step: $control.attr('step') ?? null,
    accept: $control.attr('accept') ?? null,
    multiple: has($control, 'multiple'),
  };
}

function typeOf($: cheerio.CheerioAPI, element: Element): FieldType | null {
  const tag = element.tagName.toLowerCase();
  if (tag === 'select') return 'select';
  if (tag === 'textarea') return 'textarea';

  if (tag === 'input') {
    const raw = ($(element).attr('type') ?? 'text').toLowerCase();
    if (BUTTON_TYPES.has(raw)) return null;
    // An unknown type behaves as text, which is what the HTML spec says a
    // browser must do — so a page inventing `type="fancy"` is a text box.
    return INPUT_TYPES.has(raw as FieldType) ? (raw as FieldType) : 'text';
  }

  // contenteditable, role=textbox, role=combobox: it behaves like a control
  // without being one. The honest label is `custom`.
  return 'custom';
}

/**
 * Label resolution, in the order the plan sets — which is also the order of
 * how much each source deserves to be trusted.
 *
 * `<label for>` and a wrapping `<label>` are the page *saying* what a field
 * is. aria-* is the same information written for a screen reader. A
 * placeholder is a hint that disappears when you type. Nearby text is a guess.
 * The source travels with the answer so a wrong fill can be traced to a weak
 * one.
 */
function resolveLabel(
  $: cheerio.CheerioAPI,
  element: Element,
): { label: string | null; labelSource: LabelSource | null } {
  const $control = $(element);
  const id = $control.attr('id');

  if (id) {
    const forLabel = collapseOrNull(
      $(`label[for="${escapeAttribute(id)}"]`)
        .first()
        .text(),
    );
    if (forLabel) return { label: forLabel, labelSource: 'label-for' };
  }

  const $wrapping = $control.parents('label').first();
  if ($wrapping.length > 0) {
    // The label's own text, minus any text belonging to controls inside it.
    const wrapped = collapseOrNull($wrapping.clone().find(CONTROL_SELECTOR).remove().end().text());
    if (wrapped) return { label: wrapped, labelSource: 'label-wrapping' };
  }

  const ariaLabel = collapseOrNull($control.attr('aria-label'));
  if (ariaLabel) return { label: ariaLabel, labelSource: 'aria-label' };

  const ariaLabelledBy = textOfIds($, $control.attr('aria-labelledby'));
  if (ariaLabelledBy) return { label: ariaLabelledBy, labelSource: 'aria-labelledby' };

  const placeholder = collapseOrNull($control.attr('placeholder'));
  if (placeholder) return { label: placeholder, labelSource: 'placeholder' };

  const title = collapseOrNull($control.attr('title'));
  if (title) return { label: title, labelSource: 'title' };

  const nearby = nearbyText($, element);
  if (nearby) return { label: nearby, labelSource: 'nearby-text' };

  // 18 of 69 controls in the fixture set land here. Null, not a guess: an
  // invented label is a lie the matcher would then act on.
  return { label: null, labelSource: null };
}

/**
 * A group's label is the *question*, not the first answer.
 *
 * Three radios labelled Male / Female / Other answer one question called
 * Gender, and the group's label has to be that question — the first radio's
 * own label is an option, and calling the field "Male" makes the matcher hunt
 * for a profile value called Male.
 *
 * So it looks outward instead: a fieldset's legend, an explicit ARIA group
 * label, then the text nearest the container holding the whole group. The
 * practice form keeps "Gender" in a plain div, not a legend, which is why the
 * container fallback is not optional.
 */
function resolveGroupLabel(
  $: cheerio.CheerioAPI,
  members: Element[],
): { label: string | null; labelSource: LabelSource | null } {
  const first = members[0];
  if (!first) return { label: null, labelSource: null };

  const $first = $(first);

  const legend = collapseOrNull($first.parents('fieldset').first().find('legend').first().text());
  if (legend) return { label: legend, labelSource: 'label-wrapping' };

  const $group = $first.parents('[role="radiogroup"], [role="group"]').first();
  if ($group.length > 0) {
    const ariaLabel = collapseOrNull($group.attr('aria-label'));
    if (ariaLabel) return { label: ariaLabel, labelSource: 'aria-label' };

    const labelledBy = textOfIds($, $group.attr('aria-labelledby'));
    if (labelledBy) return { label: labelledBy, labelSource: 'aria-labelledby' };
  }

  const container = commonAncestor($, members);
  if (container) {
    const nearby = nearbyText($, container);
    if (nearby) return { label: nearby, labelSource: 'nearby-text' };
  }

  return { label: null, labelSource: null };
}

/** The nearest element that holds every member of the group. */
function commonAncestor($: cheerio.CheerioAPI, members: Element[]): Element | null {
  const first = members[0];
  if (!first) return null;

  for (const ancestor of $(first).parents().toArray()) {
    const holdsAll = members.every((member) => $(member).parents().toArray().includes(ancestor));
    if (holdsAll) return ancestor as Element;
  }
  return null;
}

/**
 * A hidden input has no position on the page, so "the text near it" describes
 * nothing — Wikipedia's `wpEditToken` was picking up the heading "Create your
 * account", which is not what that field is. Only what the page states
 * directly counts.
 */
function resolveHiddenLabel(
  $: cheerio.CheerioAPI,
  element: Element,
): { label: string | null; labelSource: LabelSource | null } {
  const $control = $(element);

  const ariaLabel = collapseOrNull($control.attr('aria-label'));
  if (ariaLabel) return { label: ariaLabel, labelSource: 'aria-label' };

  const title = collapseOrNull($control.attr('title'));
  if (title) return { label: title, labelSource: 'title' };

  return { label: null, labelSource: null };
}

/**
 * The last resort: text immediately before the control.
 *
 * Walks previous siblings, then the parent's, looking for the nearest text
 * that isn't another control's. Capped in length, because a paragraph is
 * context rather than a name.
 */
function nearbyText($: cheerio.CheerioAPI, element: Element): string | null {
  for (const start of [element, element.parent as Element | null]) {
    if (!start) continue;

    let cursor = $(start).prev();
    for (let hops = 0; hops < 3 && cursor.length > 0; hops += 1) {
      if (cursor.find(CONTROL_SELECTOR).length === 0) {
        const text = collapseOrNull(cursor.text());
        if (text && text.length <= 80) return text;
      }
      cursor = cursor.prev();
    }
  }
  return null;
}

/** Help text, usually aria-describedby — the commonest attribute in the survey. */
function resolveDescription($: cheerio.CheerioAPI, element: Element): string | null {
  return textOfIds($, $(element).attr('aria-describedby'));
}

/** aria-labelledby and aria-describedby both hold a space-separated id list. */
function textOfIds($: cheerio.CheerioAPI, value: string | undefined): string | null {
  if (!value) return null;

  const parts = value
    .split(/\s+/)
    .filter(Boolean)
    .map((id) =>
      collapseWhitespace(
        $(`#${escapeAttribute(id)}`)
          .first()
          .text(),
      ),
    )
    .filter(Boolean);

  return parts.length > 0 ? parts.join(' ') : null;
}

function readOptions(
  $: cheerio.CheerioAPI,
  element: Element,
  type: FieldType,
  groupWith: Element[],
): FieldOption[] {
  if (type === 'select') {
    return $(element)
      .find('option')
      .toArray()
      .map((option) => {
        const $option = $(option);
        const text = collapseWhitespace($option.text());
        return {
          // An option with no value submits its text — the HTML default.
          value: $option.attr('value') ?? text,
          label: text || ($option.attr('value') ?? ''),
          selected: has($option, 'selected'),
        };
      });
  }

  if (groupWith.length > 1) {
    return groupWith.map((member) => {
      const $member = $(member);
      const { label } = resolveLabel($, member);
      const value = $member.attr('value') ?? 'on';
      return { value, label: label ?? value, selected: has($member, 'checked') };
    });
  }

  return [];
}

/**
 * A selector that will still find this control after the next deploy.
 *
 * `#id` first, then `[name=]` scoped to the form, then a positional path.
 * Never a class: framework classes are generated and change without warning,
 * and a selector that worked when the spec was built but not when the filler
 * runs is the failure that makes the whole system look unreliable.
 *
 * Each candidate is checked for uniqueness against the document before it is
 * accepted — a selector that matches two things is not an address.
 */
function selectorFor($: cheerio.CheerioAPI, element: Element, formSelector: string | null): string {
  const $element = $(element);

  const id = $element.attr('id');
  if (id && isStableId(id)) {
    const candidate = `#${escapeAttribute(id)}`;
    if ($(candidate).length === 1) return candidate;
  }

  const name = $element.attr('name');
  if (name) {
    const candidate = scoped(formSelector, `[name="${escapeAttribute(name)}"]`);
    if ($(candidate).length === 1) return candidate;
  }

  return positionalPath($, element);
}

/**
 * Ids that a framework generated rather than a person chose.
 *
 * React's `useId` emits `«r1»` / `:r1:`, and bundlers emit hex hashes. They are
 * unique today and different tomorrow, which is the one thing a selector must
 * not be.
 */
function isStableId(id: string): boolean {
  if (/[:«»\s]/.test(id)) return false;
  if (/^[0-9a-f]{16,}$/i.test(id)) return false;
  if (/^(radix|headlessui|mui|mantine)-/i.test(id)) return false;
  return true;
}

/**
 * A path of `:nth-child()` steps, stopping at the nearest stable id.
 *
 * Positional and therefore fragile — it is the last resort, used when a
 * control has neither a usable id nor a unique name. Anchoring at an id keeps
 * it as short as possible, so a change elsewhere in the page has less chance
 * of invalidating it.
 */
function positionalPath($: cheerio.CheerioAPI, element: Element): string {
  const steps: string[] = [];
  let cursor: Element | null = element;

  while (cursor && cursor.tagName && cursor.tagName.toLowerCase() !== 'html') {
    const id = $(cursor).attr('id');
    if (id && isStableId(id) && $(`#${escapeAttribute(id)}`).length === 1) {
      steps.unshift(`#${escapeAttribute(id)}`);
      break;
    }

    const tag = cursor.tagName.toLowerCase();
    const index = $(cursor).parent().children(tag).index(cursor) + 1;
    steps.unshift(`${tag}:nth-of-type(${index})`);

    if (tag === 'body') break;
    cursor = cursor.parent as Element | null;
  }

  return steps.join(' > ');
}

function scoped(formSelector: string | null, selector: string): string {
  return formSelector ? `${formSelector} ${selector}` : selector;
}

/** Quotes are the only character that can break out of an attribute selector. */
function escapeAttribute(value: string): string {
  return value.replace(/(["\\])/g, '\\$1');
}

function has($element: cheerio.Cheerio<AnyNode>, attribute: string): boolean {
  return $element.attr(attribute) !== undefined;
}

function numberAttribute(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function collapseOrNull(value: string | undefined): string | null {
  return collapseWhitespace(value) || null;
}
