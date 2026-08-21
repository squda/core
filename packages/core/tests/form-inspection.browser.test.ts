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

  it('reports a closed shadow root while preserving its fields for inspection', async () => {
    const spec = await inspect('/live-forms');
    const field = spec.forms
      .flatMap((form) => form.fields)
      .find((candidate) => candidate.id === 'private-code');

    expect(field?.locator?.scopes).toEqual([{ kind: 'shadow', selector: '#private-shell' }]);
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

    expect(nested?.locator?.scopes).toEqual([
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
    expect(frameField?.locator?.scopes).toEqual([
      { kind: 'frame', selector: 'iframe[name="address-frame"]' },
    ]);
  });

  it('collects fields across wizard steps without submitting the form', async () => {
    const spec = await inspect('/wizard');
    const fields = spec.forms.flatMap((form) => form.fields);

    expect(fields.find((field) => field.id === 'wizard-email')).toMatchObject({ stepIndex: 0 });
    expect(fields.find((field) => field.id === 'years')).toMatchObject({ stepIndex: 1 });
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
