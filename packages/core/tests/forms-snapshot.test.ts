import { describe, expect, it } from 'vitest';
import { extractForms } from '../src/core/forms.js';
import { loadFixture } from './fixtures.js';
import type { Field, FormSpec } from '@untitled/schema';

/**
 * Phase 4, step 6 — snapshots of every captured form.
 *
 * These answer a different question from forms.test.ts. Those tests assert
 * things I thought to check; these notice things I did not — a label that
 * quietly changes source, a selector that gets longer, a field that stops
 * being grouped, on any of the six pages at once.
 *
 * The plan's warning applies and is worth repeating where it can be read: **a
 * snapshot only tells you something changed, never that it is correct.** When
 * one of these fails, the question is "is the new output better?" — and
 * `pnpm test -u` is the answer only after looking, never before.
 *
 * Rendered as a table rather than raw JSON on purpose. A diff of 1,200 lines
 * of object literals is technically the same information and practically
 * unreadable, and an unreadable diff gets accepted without being read, which
 * defeats the point of having it.
 *
 * One row is deliberately enormous: form-native-select's country list runs to
 * 264 options on a single line. Left as it is — truncating it would hide the
 * day the list comes back with three.
 */

function render(spec: FormSpec): string {
  const lines: string[] = [];

  for (const form of spec.forms) {
    lines.push(
      `FORM ${form.selector ?? '(controls outside any <form>)'}`,
      `  ${form.method.toUpperCase()} → ${form.action ?? '(posts to itself)'}`,
      `  submit: ${form.submitSelector ?? '(none found)'}`,
    );

    for (const field of form.fields) lines.push(...renderField(field));
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function renderField(field: Field): string[] {
  const flags = [
    field.required ? 'required' : '',
    field.disabled ? 'disabled' : '',
    field.readonly ? 'readonly' : '',
    field.sensitive ? 'sensitive' : '',
    field.multiple ? 'multiple' : '',
  ].filter(Boolean);

  const lines = [
    `  · ${field.label ?? '(no label)'}  [${field.type}]${flags.length ? '  ' + flags.join(' ') : ''}`,
    `      selector: ${field.selector}`,
    `      from: ${field.labelSource ?? 'nothing'}  name=${field.name ?? '-'}  id=${field.id ?? '-'}`,
  ];

  if (field.autocomplete) lines.push(`      autocomplete: ${field.autocomplete}`);
  if (field.description) lines.push(`      help: ${field.description}`);
  if (field.placeholder) lines.push(`      placeholder: ${field.placeholder}`);
  if (field.options.length > 0) {
    lines.push(
      `      options: ${field.options
        .map((option) => `${option.label}=${option.value}${option.selected ? '*' : ''}`)
        .join(', ')}`,
    );
  }

  const constraints = [
    field.pattern ? `pattern=${field.pattern}` : '',
    field.maxLength ? `maxLength=${field.maxLength}` : '',
    field.minLength ? `minLength=${field.minLength}` : '',
    field.accept ? `accept=${field.accept}` : '',
  ].filter(Boolean);
  if (constraints.length > 0) lines.push(`      ${constraints.join('  ')}`);

  return lines;
}

const FIXTURES = [
  'form-job-application',
  'form-page',
  'form-native-select',
  'form-all-controls',
  'form-select-minimal',
  'form-login-minimal',
  'form-login-nolabels',
  'form-shadow-dom',
] as const;

describe('the FormSpec of every captured form', () => {
  it.each(FIXTURES)('%s', (name) => {
    expect(render(extractForms(loadFixture(name)))).toMatchSnapshot();
  });

  /**
   * One fixture kept as raw JSON as well, because the table above deliberately
   * omits fields that are usually null — and "usually null" is exactly where a
   * regression hides quietly.
   */
  it('form-job-application, in full', () => {
    const spec = extractForms(loadFixture('form-job-application'));

    expect(spec.forms).toMatchSnapshot();
  });
});

describe('what the shape of the output is', () => {
  // Not a snapshot: a snapshot would happily record a day where every field
  // lost its selector. These are the invariants that must hold whatever the
  // pages do.
  it.each(FIXTURES)('%s keeps every field addressable and typed', (name) => {
    const fields = extractForms(loadFixture(name)).forms.flatMap((form) => form.fields);

    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(field.selector.length).toBeGreaterThan(0);
      expect(field.type).toBeTruthy();
      // A label may be null, but a source without a label is a contradiction.
      if (field.labelSource !== null) expect(field.label).not.toBeNull();
      if (field.label !== null) expect(field.labelSource).not.toBeNull();
    }
  });
});
