import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FormSpecSchema, type FormSpec } from '@untitled/schema';
import { BrowserPool } from '../src/fetching/pool.js';
import { createApp } from '../src/service/app.js';
import { startTestServer, type TestServer } from './test-server.js';

let server: TestServer;
let pool: BrowserPool;

beforeAll(async () => {
  server = await startTestServer();
  pool = new BrowserPool({ idleMs: 60_000 });
});

afterAll(async () => {
  await pool.close();
  await server.close();
});

async function inspect(path: string): Promise<FormSpec> {
  const response = await createApp({ pool }).request(
    `/form-spec?url=${encodeURIComponent(`${server.origin}${path}`)}&browser=always`,
  );
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return FormSpecSchema.parse(body);
}

describe('GET /form-spec against a live browser document', () => {
  it('finds ordinary fields and fields inside an open shadow root', async () => {
    const spec = await inspect('/live-forms');
    const fields = spec.forms.flatMap((form) => form.fields);

    expect(fields.find((field) => field.id === 'full-name')).toMatchObject({
      label: 'Full name',
      locator: { scopes: [], selector: '#full-name' },
    });
    expect(fields.find((field) => field.id === 'shadow-email')).toMatchObject({
      label: 'Work email',
      locator: {
        scopes: [{ kind: 'shadow', selector: '#account-shell' }],
        selector: '#shadow-email',
      },
    });
  });

  it('publishes positional selectors relative to a shadow root, not its synthetic wrapper', async () => {
    const spec = await inspect('/live-forms');
    const field = spec.forms
      .flatMap((form) => form.fields)
      .find((candidate) => candidate.label === 'Anonymous shadow field');

    expect(field?.locator?.selector).toBe('section:nth-of-type(1) > input:nth-of-type(1)');
    expect(field?.locator?.selector).not.toContain('body');
    expect(field?.locator?.verification).toBe('snapshot-only');
  });

  it('does not certify a field through an anonymous positional scope hop', async () => {
    const spec = await inspect('/live-forms');
    const field = spec.forms
      .flatMap((form) => form.fields)
      .find((candidate) => candidate.label === 'Anonymous host field');

    expect(field?.locator?.scopes[0]?.candidates).toEqual([
      expect.objectContaining({ kind: 'css', source: 'path' }),
    ]);
    expect(field?.locator?.verification).toBe('snapshot-only');
  });

  it('reads a custom choice widget without confusing its selected value for its name', async () => {
    const spec = await inspect('/choice-widgets');
    const field = spec.forms.flatMap((form) => form.fields)[0];

    expect(field).toMatchObject({
      label: 'Favourite colour',
      labelSource: 'aria-labelledby',
      interaction: { kind: 'choose', mode: 'single', optionsStatus: 'complete' },
      currentValues: ['Ocean'],
    });
    expect(field?.options).toEqual([
      { value: 'ocean', label: 'Ocean', selected: true },
      { value: 'red', label: 'Red', selected: false },
      { value: 'blue', label: 'Blue', selected: false },
    ]);
  });

  it('reads an always-open listbox without clicking or pressing keys on it', async () => {
    const spec = await inspect('/choice-widgets');
    const field = spec.forms
      .flatMap((form) => form.fields)
      .find((candidate) => candidate.label === 'Size');

    expect(field).toMatchObject({
      currentValues: ['Small'],
      interaction: { kind: 'choose', mode: 'single', optionsStatus: 'dynamic' },
      options: [
        { value: 'small', label: 'Small', selected: true },
        { value: 'large', label: 'Large', selected: false },
      ],
    });
  });

  it('rejects an id that changes on a fresh load and verifies a durable fallback', async () => {
    const spec = await inspect('/generated-id-form');
    const field = spec.forms.flatMap((form) => form.fields)[0];

    expect(field?.id).toMatch(/^select-input-\d+$/);
    expect(field?.locator).toMatchObject({
      verification: 'fresh-load',
      preferred: { kind: 'role-name', role: 'textbox', name: 'Account type' },
    });
    expect(field?.locator?.selector).not.toContain(field?.id ?? 'missing');
  });

  it('returns usable partial inspection results when optional discovery exhausts the deadline', async () => {
    const startedAt = Date.now();
    const result = await pool.inspectForms(`${server.origin}/slow-choice-widgets`, {
      timeoutMs: 2_000,
    });

    expect(result.spec.forms.flatMap((form) => form.fields).length).toBeGreaterThan(0);
    expect(result.spec.warnings).toContainEqual(
      expect.objectContaining({ code: 'inspection-budget-exhausted' }),
    );
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it('reports a closed shadow root while preserving its fields for inspection', async () => {
    const spec = await inspect('/live-forms');
    const field = spec.forms
      .flatMap((form) => form.fields)
      .find((candidate) => candidate.id === 'private-code');

    expect(field?.locator?.scopes.map(({ kind, selector }) => ({ kind, selector }))).toEqual([
      { kind: 'shadow', selector: '#private-shell' },
    ]);
    expect(spec.warnings).toContainEqual(expect.objectContaining({ code: 'closed-shadow-root' }));
  });

  it('finds a field inside an iframe and records how to enter the frame', async () => {
    const spec = await inspect('/live-forms');
    const city = spec.forms.flatMap((form) => form.fields).find((field) => field.id === 'city');

    expect(city).toMatchObject({
      locator: {
        scopes: [{ kind: 'frame', selector: '#embedded' }],
        selector: '#city',
      },
    });
  });

  it('records alternating shadow-root and iframe hops in order', async () => {
    const spec = await inspect('/live-forms');
    const nested = spec.forms
      .flatMap((form) => form.fields)
      .find((field) => field.id === 'nested-code');

    expect(nested?.locator?.scopes.map(({ kind, selector }) => ({ kind, selector }))).toEqual([
      { kind: 'shadow', selector: '#account-shell' },
      { kind: 'frame', selector: '#shadow-frame' },
    ]);
  });

  it('does not put generated host or frame ids into locator scopes', async () => {
    const spec = await inspect('/live-forms');
    const fields = spec.forms.flatMap((form) => form.fields);
    const shadowField = fields.find((field) => field.id === 'generated-field');
    const frameField = fields.find((field) => field.id === 'postal-code');

    expect(shadowField?.locator?.scopes[0]?.selector).not.toContain('a83cf87f');
    expect(shadowField?.locator?.scopes[0]?.selector).toContain('nth-of-type');
    expect(frameField?.locator?.scopes.map(({ kind, selector }) => ({ kind, selector }))).toEqual([
      { kind: 'frame', selector: 'iframe[name="address-frame"]' },
    ]);
  });

  it('collects fields across wizard steps without submitting the form', async () => {
    const spec = await inspect('/wizard');
    const fields = spec.forms.flatMap((form) => form.fields);

    expect(fields.find((field) => field.id === 'wizard-email')).toMatchObject({ stepIndex: 0 });
    expect(fields.find((field) => field.id === 'years')).toMatchObject({
      stepIndex: 1,
      locator: { verification: 'fresh-load' },
    });
    expect(spec.forms.find((form) => form.stepIndex === 1)?.action).toBe(
      `${server.origin}/wizard-submitted`,
    );
    expect(fields.map((field) => field.id)).not.toContain('THE INSPECTOR SUBMITTED THE FORM');
    expect(spec.warnings).toContainEqual(
      expect.objectContaining({ code: 'branch-not-exhaustive' }),
    );
  });

  it('stops when Continue leaves a wizard on the same fields', async () => {
    const spec = await inspect('/wizard-stalled');

    expect(spec.forms.flatMap((form) => form.fields)).toHaveLength(1);
    expect(spec.warnings).toContainEqual(expect.objectContaining({ code: 'step-stalled' }));
    expect(spec.warnings).toContainEqual(
      expect.objectContaining({ code: 'branch-not-exhaustive' }),
    );
  });
});
