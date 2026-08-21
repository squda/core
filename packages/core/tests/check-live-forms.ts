import assert from 'node:assert/strict';
import type { FormSpec } from '@untitled/schema';
import { BrowserStrategy } from '../src/fetching/browser.js';

/**
 * Optional network smoke check for the production form-inspection path.
 *
 * This is deliberately not part of Vitest: third-party availability must not
 * make the deterministic suite flaky. Run it when changing live DOM or wizard
 * behavior; the normal browser tests provide the repeatable local coverage.
 */
interface LiveCase {
  name: string;
  url: string;
  verify(spec: FormSpec): void;
}

const cases: LiveCase[] = [
  {
    name: 'signup',
    url: 'https://www.qapractice.com/register',
    verify(spec) {
      const fields = spec.forms.flatMap((form) => form.fields);
      const labels = fields.flatMap((field) => (field.label ? [field.label] : []));
      assert(labels.includes('Email Address'));
      assert(fields.filter((field) => field.type === 'password').length >= 2);
    },
  },
  {
    name: 'checkout',
    url: 'https://demo.guru99.com/payment-gateway/process_purchasetoy.php',
    verify(spec) {
      const fields = spec.forms.flatMap((form) => form.fields);
      const labels = fields.flatMap((field) => (field.label ? [field.label] : []));
      assert(labels.includes('Enter Your Card Number'));
      assert(labels.includes('CVV Code'));
      assert(fields.filter((field) => field.type === 'select').length >= 2);
    },
  },
  {
    name: 'government wizard',
    url: 'https://www.gov.uk/check-student-finance-eligibility-nationality-residency/y',
    verify(spec) {
      const fields = spec.forms.flatMap((form) => form.fields);
      const questions = new Set(
        fields.flatMap((field) => (field.type === 'radio' && field.label ? [field.label] : [])),
      );

      assert([...questions].some((label) => label.includes('When does your course start?')));
      assert(questions.size >= 3, 'expected at least three distinct GOV.UK wizard questions');
      assert(!spec.warnings?.some((warning) => warning.code === 'step-stalled'));
    },
  },
];

const browser = new BrowserStrategy({ timeoutMs: 30_000 });

try {
  for (const testCase of cases) {
    const { spec } = await browser.inspectForms(testCase.url);
    const fields = spec.forms.flatMap((form) => form.fields);
    const steps = [...new Set(fields.flatMap((field) => field.stepIndex ?? []))];

    testCase.verify(spec);
    console.log(
      `${testCase.name}: ${spec.forms.length} forms, ${fields.length} fields, steps ${steps.join(', ')}`,
    );
  }
} finally {
  await browser.close();
}
