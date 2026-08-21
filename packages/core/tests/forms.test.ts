import { describe, expect, it } from 'vitest';
import { extractForms } from '../src/core/forms.js';
import { htmlDocument } from './helpers.js';
import { formFixtureNames, loadFixture } from './fixtures.js';

/** One form's fields, from a fragment of HTML. */
function fieldsOf(html: string) {
  return extractForms(htmlDocument(`<html><body>${html}</body></html>`)).forms.flatMap(
    (form) => form.fields,
  );
}

function firstField(html: string) {
  const field = fieldsOf(html)[0];
  if (!field) throw new Error('no field found');
  return field;
}

describe('what counts as a field', () => {
  it.each([
    ['<input>', 'text'],
    ['<input type="email">', 'email'],
    ['<input type="TEL">', 'tel'],
    ['<input type="password">', 'password'],
    ['<input type="file">', 'file'],
    ['<input type="hidden">', 'hidden'],
    ['<textarea></textarea>', 'textarea'],
    ['<select><option>a</option></select>', 'select'],
    ['<div contenteditable="true"></div>', 'custom'],
    ['<div role="combobox"></div>', 'custom'],
  ])('reads %s as %s', (html, type) => {
    expect(firstField(html).type).toBe(type);
  });

  // The HTML spec says a browser treats an unknown type as text, so we do too.
  it('treats an unknown input type as text', () => {
    expect(firstField('<input type="fancy">').type).toBe('text');
  });

  it.each(['submit', 'button', 'reset', 'image'])('does not treat type=%s as a field', (type) => {
    expect(fieldsOf(`<input type="${type}"><input name="real">`)).toHaveLength(1);
  });

  it('keeps a custom choice widget current value separate from its name', () => {
    const field = firstField('<div role="combobox" aria-expanded="false"><span>Ocean</span></div>');

    expect(field).toMatchObject({
      label: null,
      currentValues: ['Ocean'],
      interaction: { kind: 'choose', mode: 'single', optionsStatus: 'dynamic' },
    });
  });

  it('does not use a combobox input’s displayed selection as its label', () => {
    const field = firstField(
      '<div><span>Ocean</span><input role="combobox" aria-expanded="false"></div>',
    );

    expect(field.label).toBeNull();
    expect(field.interaction.kind).toBe('choose');
  });

  it('counts a standalone ARIA listbox but not a combobox-owned popup', () => {
    expect(
      fieldsOf('<div role="listbox" tabindex="0"><div role="option">A</div></div>'),
    ).toHaveLength(1);
    expect(
      fieldsOf(
        '<input role="combobox" aria-controls="choices"><div id="choices" role="listbox"><div role="option">A</div></div>',
      ),
    ).toHaveLength(1);
  });
});

describe('grouping', () => {
  const gender = `
    <fieldset>
      <legend>Gender</legend>
      <input type="radio" name="gender" value="m" id="m"><label for="m">Male</label>
      <input type="radio" name="gender" value="f" id="f" checked><label for="f">Female</label>
    </fieldset>`;

  // One question, two answers. Two fields would make the matcher answer the
  // same question twice and let the filler disagree with itself.
  it('makes one field out of radios sharing a name', () => {
    const fields = fieldsOf(gender);

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ type: 'radio', name: 'gender' });
  });

  it('keeps the answers as options, with the checked one marked', () => {
    expect(firstField(gender).options).toEqual([
      { value: 'm', label: 'Male', selected: false },
      { value: 'f', label: 'Female', selected: true },
    ]);
  });

  // Calling the field "Male" would send the matcher hunting for a profile
  // value called Male.
  it('labels the group with the question, not the first answer', () => {
    expect(firstField(gender)).toMatchObject({ label: 'Gender', labelSource: 'label-wrapping' });
  });

  it('addresses a group by its shared name', () => {
    expect(firstField(gender).selector).toContain('[name="gender"]');
  });

  it('treats a lone checkbox as its own question', () => {
    const field = firstField('<input type="checkbox" id="tos"><label for="tos">I agree</label>');

    expect(field).toMatchObject({ type: 'checkbox', label: 'I agree' });
    expect(field.options).toEqual([]);
  });

  it('groups checkboxes that share a name', () => {
    const fields = fieldsOf(`
      <input type="checkbox" name="food" value="a" id="a"><label for="a">Apple</label>
      <input type="checkbox" name="food" value="b" id="b"><label for="b">Pear</label>`);

    expect(fields).toHaveLength(1);
    expect(fields[0]?.options.map((option) => option.label)).toEqual(['Apple', 'Pear']);
  });
});

describe('labels, in order of how much they can be trusted', () => {
  it('prefers a <label for>', () => {
    const field = firstField(
      '<label for="x">By for</label><input id="x" aria-label="By aria" placeholder="By placeholder">',
    );

    expect(field).toMatchObject({ label: 'By for', labelSource: 'label-for' });
  });

  it('then a wrapping label, without swallowing the control’s own text', () => {
    const field = firstField('<label>Wrapped <input value="typed"></label>');

    expect(field).toMatchObject({ label: 'Wrapped', labelSource: 'label-wrapping' });
  });

  it.each([
    ['<input aria-label="By aria" placeholder="p">', 'By aria', 'aria-label'],
    [
      '<span id="l">By id</span><input aria-labelledby="l" placeholder="p">',
      'By id',
      'aria-labelledby',
    ],
    ['<input placeholder="By placeholder" title="t">', 'By placeholder', 'placeholder'],
    ['<input title="By title">', 'By title', 'title'],
    ['<div>Nearby words</div><input>', 'Nearby words', 'nearby-text'],
  ])('falls back through %s', (html, label, source) => {
    expect(firstField(html)).toMatchObject({ label, labelSource: source });
  });

  // 18 of 69 controls in the fixture set have nothing. Inventing a label would
  // be a lie the matcher then acts on.
  it('is null when the page says nothing', () => {
    expect(firstField('<input>')).toMatchObject({ label: null, labelSource: null });
  });

  // A hidden input has no position, so "the text near it" describes nothing.
  it('never gives a hidden input a label from nearby text', () => {
    const field = firstField('<h1>Create your account</h1><input type="hidden" name="token">');

    expect(field).toMatchObject({ type: 'hidden', label: null });
  });

  it('reads help text from aria-describedby', () => {
    const field = firstField('<input aria-describedby="h"><small id="h">We never share it</small>');

    expect(field.description).toBe('We never share it');
  });
});

describe('selectors', () => {
  it('prefers an id', () => {
    expect(firstField('<input id="email" name="email">').selector).toBe('#email');
  });

  it('falls back to a name, scoped to its form', () => {
    const field = extractForms(htmlDocument('<form id="f"><input name="email"></form>')).forms[0]
      ?.fields[0];

    expect(field?.selector).toBe('#f [name="email"]');
  });

  it('falls back to a path when there is neither', () => {
    const field = firstField('<div id="wrap"><span></span><input></div>');

    expect(field.selector).toBe('#wrap > input:nth-of-type(1)');
  });

  it('builds fragment selectors relative to the fragment root', () => {
    const doc = htmlDocument('<section><span>Anonymous</span><input></section>');
    const field = extractForms(doc, { selectorRoot: 'fragment' }).forms[0]?.fields[0];

    expect(field?.selector).toBe('section:nth-of-type(1) > input:nth-of-type(1)');
  });

  // Generated ids are unique today and different tomorrow, which is the one
  // thing a selector must not be.
  it.each([':r1:', '«r7»', 'a1b2c3d4e5f60718', 'radix-42'])('refuses the generated id %s', (id) => {
    expect(firstField(`<input id="${id}" name="real">`).selector).not.toContain(id);
  });

  it('refuses a name that matches more than one control', () => {
    const fields = fieldsOf('<input name="dup" type="text"><input name="dup" type="email">');

    for (const field of fields) expect(field.selector).not.toBe('[name="dup"]');
  });
});

describe('the form around the fields', () => {
  const doc = htmlDocument(
    `<form id="f" name="signup" method="POST" action="/submit">
       <input name="email">
       <button type="submit">Go</button>
     </form>`,
    { finalUrl: 'https://example.com/page' },
  );

  it('records where it posts, resolved absolute', () => {
    expect(extractForms(doc).forms[0]).toMatchObject({
      selector: '#f',
      name: 'signup',
      method: 'post',
      action: 'https://example.com/submit',
    });
  });

  it('finds the submit button', () => {
    expect(extractForms(doc).forms[0]?.submitSelector).toContain('button');
  });

  it('says null rather than guessing when there is no submit button', () => {
    const spec = extractForms(htmlDocument('<form id="f"><input name="a"></form>'));

    expect(spec.forms[0]?.submitSelector).toBeNull();
  });

  it('defaults the method to get', () => {
    expect(extractForms(htmlDocument('<form><input name="a"></form>')).forms[0]?.method).toBe(
      'get',
    );
  });

  // Five separate <form> elements on one page is a real fixture, not a
  // hypothetical.
  it('keeps forms separate', () => {
    const spec = extractForms(
      htmlDocument('<form id="a"><input name="x"></form><form id="b"><input name="y"></form>'),
    );

    expect(spec.forms).toHaveLength(2);
  });

  // A React form that never used the element still has boxes on the page.
  it('collects controls that belong to no form', () => {
    const spec = extractForms(
      htmlDocument('<input name="search"><form id="f"><input name="a"></form>'),
    );
    const orphans = spec.forms.find((form) => form.selector === null);

    expect(orphans?.fields).toHaveLength(1);
    expect(orphans?.fields[0]?.name).toBe('search');
  });
});

describe('constraints', () => {
  it('reads what the page requires and forbids', () => {
    const field = firstField(
      '<input name="a" required disabled readonly pattern="\\d+" maxlength="10" minlength="2" accept=".pdf" multiple>',
    );

    expect(field).toMatchObject({
      required: true,
      disabled: true,
      readonly: true,
      pattern: '\\d+',
      maxLength: 10,
      minLength: 2,
      accept: '.pdf',
      multiple: true,
    });
  });

  it('accepts aria-required as required', () => {
    expect(firstField('<input aria-required="true">').required).toBe(true);
  });

  it('reads select options, and the one that submits its own text', () => {
    const field = firstField(
      '<select><option value="a">A</option><option selected>B</option></select>',
    );

    expect(field.options).toEqual([
      { value: 'a', label: 'A', selected: false },
      { value: 'B', label: 'B', selected: true },
    ]);
  });
});

describe('against the real form corpus', () => {
  it.each(formFixtureNames)('%s parses into a FormSpec', (name) => {
    const spec = extractForms(loadFixture(name));

    expect(spec.forms.length).toBeGreaterThan(0);
    expect(spec.forms.flatMap((form) => form.fields).length).toBeGreaterThan(0);
  });

  it('reads the GitLab application the way a person would', () => {
    const application = extractForms(loadFixture('form-job-application')).forms[0];
    const fields = application?.fields ?? [];
    const byId = new Map(fields.map((field) => [field.id, field]));

    expect(application?.selector).toBe('#application-form');
    expect(fields).toHaveLength(23);
    expect(byId.get('first_name')).toMatchObject({
      label: 'First Name*',
      autocomplete: 'given-name',
      required: true,
      selector: '#first_name',
    });
    expect(byId.get('resume')?.type).toBe('file');
    // Nothing on a job application is a secret.
    expect(fields.filter((field) => field.sensitive)).toHaveLength(0);
  });

  /**
   * Not one control on the GitLab application has a `name`. React holds the
   * state and submits over fetch, so the attribute buys the page nothing — and
   * the matcher cannot lean on it. `id`, `label` and `autocomplete` are what is
   * actually there, which is why all three are on the schema.
   *
   * Scoped to the application form on purpose: the page also carries a stray
   * reCAPTCHA textarea outside any <form>, and *that* one does have a name. The
   * finding is about how the application is built, not about every node Google
   * injected next to it.
   */
  it('copes with a form that has no name attributes at all', () => {
    const fields = extractForms(loadFixture('form-job-application')).forms[0]?.fields ?? [];

    expect(fields.every((field) => field.name === null)).toBe(true);
    expect(fields.every((field) => field.selector.length > 0)).toBe(true);
    expect(fields.filter((field) => field.autocomplete !== null).length).toBeGreaterThan(10);
  });

  it('groups the pizza form’s radios and checkboxes under their questions', () => {
    const fields = extractForms(loadFixture('form-page')).forms.flatMap((form) => form.fields);
    const size = fields.find((field) => field.name === 'size');
    const topping = fields.find((field) => field.name === 'topping');

    expect(size).toMatchObject({ type: 'radio', label: 'Pizza Size' });
    expect(size?.options.map((option) => option.label)).toEqual(['Small', 'Medium', 'Large']);

    expect(topping).toMatchObject({ type: 'checkbox', label: 'Pizza Toppings' });
    expect(topping?.options).toHaveLength(4);
  });

  /**
   * The gap this fixture exists to document.
   *
   * Grouping keys on a shared `name`, and formy-project gives its radios and
   * checkboxes ids only. So nine controls that a person reads as three
   * questions come back as nine separate fields, each labelled "Radio button"
   * or "checkbox" off its aria-label. That is wrong the way a person means it
   * and right the way the markup reads — there is nothing in the DOM tying them
   * together. Asserted rather than fixed so the day someone groups by position
   * or by fieldset, this test tells them what they changed.
   */
  it('cannot group controls that share no name, and says so', () => {
    const fields = extractForms(loadFixture('form-all-controls')).forms.flatMap((f) => f.fields);
    const radios = fields.filter((field) => field.type === 'radio');

    expect(radios).toHaveLength(3);
    expect(radios.every((field) => field.name === null)).toBe(true);
    expect(radios.every((field) => field.options.length === 0)).toBe(true);
  });

  // 264 countries. The options array is not a formality on a real page.
  it('reads a long native select whole', () => {
    const country = extractForms(loadFixture('form-native-select'))
      .forms.flatMap((form) => form.fields)
      .find((field) => field.name === 'country');

    expect(country?.type).toBe('select');
    expect(country?.options).toHaveLength(264);
    expect(country?.options[0]).toEqual({ value: 'ALBANIA', label: 'ALBANIA', selected: false });
  });

  it('keeps hidden fields without inventing labels for them', () => {
    const hidden = extractForms(loadFixture('form-native-select'))
      .forms.flatMap((form) => form.fields)
      .filter((field) => field.type === 'hidden');

    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.every((field) => field.label === null)).toBe(true);
  });

  it('finds every password field, across every form', () => {
    for (const name of ['form-native-select', 'form-login-minimal', 'form-login-nolabels']) {
      const sensitive = extractForms(loadFixture(name))
        .forms.flatMap((form) => form.fields)
        .filter((field) => field.sensitive);

      expect(sensitive.length).toBeGreaterThan(0);
    }
  });

  /**
   * guru99 has its two account fields the wrong way round: the control named
   * `userName` sits under the text "Email:", and the one named `email` sits
   * under "User Name:". We report what the page says, because a walker that
   * "corrects" a page is a walker you cannot trust to describe one. It is also
   * the argument for Phase 6 needing more than a label to match on — here the
   * label and the name flatly contradict each other.
   */
  it('reports a mislabelled field faithfully rather than correcting it', () => {
    const fields = extractForms(loadFixture('form-native-select')).forms.flatMap((f) => f.fields);

    expect(fields.find((field) => field.name === 'userName')?.label).toBe('Email:');
    expect(fields.find((field) => field.name === 'email')?.label).toBe('User Name:');
  });

  /**
   * A page laid out in nested tables gives a field no id, no usable name
   * ancestor, and nothing but its position. The selector that comes back is 423
   * characters of `nth-of-type`, which is ugly and correct — and far better
   * than a short selector that matches the wrong box.
   */
  it('falls back to a positional path on a table-built page', () => {
    const password = extractForms(loadFixture('form-native-select'))
      .forms.flatMap((form) => form.fields)
      .find((field) => field.name === 'password');

    expect(password?.selector).toContain('nth-of-type');
    expect(password?.selector).toContain('[name="password"]');
  });

  // Every label on guru99 comes from a table cell sitting next to the input.
  it('reads labels from nearby text when the page never wrote a <label for>', () => {
    const fields = extractForms(loadFixture('form-native-select')).forms.flatMap((f) => f.fields);
    const labelled = fields.filter((field) => field.label !== null);

    expect(labelled.length).toBeGreaterThan(5);
    expect(labelled.every((field) => field.labelSource === 'nearby-text')).toBe(true);
  });

  it('finds no labels to find on the no-labels login', () => {
    const fields = extractForms(loadFixture('form-login-nolabels')).forms.flatMap((f) => f.fields);

    expect(fields.every((field) => field.labelSource !== 'label-for')).toBe(true);
    expect(fields.every((field) => field.labelSource === 'placeholder')).toBe(true);
  });

  it('reads the real signup fields and their human labels', () => {
    const fields = extractForms(loadFixture('form-signup')).forms.flatMap((form) => form.fields);

    expect(fields.map((field) => [field.label, field.type])).toEqual([
      ['Email Address', 'email'],
      ['Password', 'password'],
      ['Confirm Password', 'password'],
    ]);
  });

  it('reads card, expiry and security-code controls from the test checkout', () => {
    const fields = extractForms(loadFixture('form-checkout')).forms.flatMap((form) => form.fields);

    expect(fields.find((field) => field.id === 'card_nmuber')).toMatchObject({
      label: 'Enter Your Card Number',
      maxLength: 16,
      sensitive: true,
    });
    expect(fields.find((field) => field.id === 'month')?.type).toBe('select');
    expect(fields.find((field) => field.id === 'year')?.type).toBe('select');
    expect(fields.find((field) => field.id === 'cvv_code')).toMatchObject({
      label: 'CVV Code',
      sensitive: true,
    });
  });

  it('reads the first question of the real government wizard', () => {
    const fields = extractForms(loadFixture('form-government-wizard')).forms.flatMap(
      (form) => form.fields,
    );
    const courseStart = fields.find((field) => field.type === 'radio');

    expect(courseStart?.label).toContain('When does your course start?');
    expect(courseStart?.options.length).toBeGreaterThan(1);
  });

  it('rejects deployment-generated id suffixes in selectors', () => {
    const search = extractForms(loadFixture('form-government-wizard'))
      .forms.flatMap((form) => form.fields)
      .find((field) => field.label === 'Search GOV.UK');

    expect(search?.id).toMatch(/^search-main-[0-9a-f]{8}$/i);
    expect(search?.selector).not.toBe(`#${search?.id}`);
    expect(search?.selector).toContain('[name="keywords"]');
  });
});
