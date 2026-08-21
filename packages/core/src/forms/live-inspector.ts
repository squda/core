import type { Frame, Page } from 'playwright';
import {
  FormSpecSchema,
  type FieldScope,
  type Form,
  type FormInspectionWarning,
  type FormSpec,
} from '@untitled/schema';
import { extractForms, isStableId } from '../core/forms.js';
import type { HtmlDocument } from '../core/types.js';

interface CapturedScope {
  html: string;
  scopes: FieldScope[];
}

// Strings on purpose: tsx/esbuild names nested functions with a Node-side
// helper. Passing the transformed function to Playwright made that helper leak
// into the page and fail only in production. Source strings execute exactly as
// written in Chromium under every Node transform.
const SELECTOR_FOR_SCRIPT = String.raw`(element, root) => {
    const idIsStable = element.id &&
      !/[:«»\s]/.test(element.id) &&
      !/^[0-9a-f]{16,}$/i.test(element.id) &&
      !/[-_][0-9a-f]{8,}$/i.test(element.id) &&
      !/^(radix|headlessui|mui|mantine)-/i.test(element.id);
    if (idIsStable) return '#' + CSS.escape(element.id);

    const name = element.getAttribute('name');
    if (name) {
      const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const candidate = '[name="' + escaped + '"]';
      if (root.querySelectorAll(candidate).length === 1) return candidate;
    }

    const parts = [];
    let current = element;
    while (current) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(
          (sibling) => sibling.tagName === current.tagName,
        );
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(' > ');
  }`;

const CAPTURE_DOCUMENT_SCOPES_SCRIPT = String.raw`(() => {
  const selectorFor = ${SELECTOR_FOR_SCRIPT};

  const result = [{ html: document.documentElement.outerHTML, scopes: [] }];
  const visit = (root, scopes) => {
    for (const element of root.querySelectorAll('*')) {
      if (!element.shadowRoot) continue;
      const nextScopes = scopes.concat([
        { kind: 'shadow', selector: selectorFor(element, root) },
      ]);
      result.push({
        html: '<html><body>' + element.shadowRoot.innerHTML + '</body></html>',
        scopes: nextScopes,
      });
      visit(element.shadowRoot, nextScopes);
    }
  };

  visit(document, []);
  return result;
})()`;

export interface BrowserFormInspection {
  document: HtmlDocument;
  spec: FormSpec;
}

/**
 * Read forms from the live DOM while Chromium still owns it.
 *
 * Each document and open shadow root is serialized separately, then handed to
 * the existing form walker. The browser-specific part only discovers scopes;
 * label resolution, grouping, sensitivity and selector rules remain in one
 * implementation.
 */
export async function inspectFormsOnPage(page: Page, document: HtmlDocument): Promise<FormSpec> {
  const forms: Form[] = [];
  const warnings: FormInspectionWarning[] = [];
  const seenFields = new Set<string>();
  const maxSteps = 20;
  let followedWizardBranch = false;

  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
    const added = await collectStep(page, document, stepIndex, seenFields);
    forms.push(...added);

    const next = await findNextControl(page);
    if (!next) break;

    // A real wizard can leave a Continue-shaped control behind after a
    // validation error, or a site-wide feedback form can use the same word.
    // If the previous click revealed no new field at all, another click would
    // only repeat the same state until the hard step limit.
    if (stepIndex > 0 && added.length === 0) {
      warnings.push({
        code: 'step-stalled',
        message:
          'Stopped because a Next/Continue control remained but the preceding click revealed no new fields.',
      });
      break;
    }

    await fillDiscoveryValues(next);
    await next.click();
    await page.waitForTimeout(100);
    followedWizardBranch = true;

    if (stepIndex === maxSteps - 1) {
      warnings.push({
        code: 'step-limit',
        message: `Stopped after ${maxSteps} wizard steps; another Next or Continue control remained.`,
      });
    }
  }

  if (followedWizardBranch) {
    warnings.push({
      code: 'branch-not-exhaustive',
      message:
        'Wizard inspection used synthetic values and followed one safe Next/Continue path; other answers may reveal different fields.',
    });
  }

  const closedRoots = await page.locator('[data-scrape-original-closed-shadow]').count();
  if (closedRoots > 0) {
    warnings.push({
      code: 'closed-shadow-root',
      message: `Found ${closedRoots} closed shadow root${closedRoots === 1 ? '' : 's'}; fields were inspected by opening the roots before site scripts ran, and filling them requires the same browser hook.`,
    });
  }

  return FormSpecSchema.parse({
    url: document.url,
    fetchedAt: document.fetchedAt,
    fetchedWith: 'browser',
    forms,
    warnings,
  });
}

async function collectStep(
  page: Page,
  document: HtmlDocument,
  stepIndex: number,
  seenFields: Set<string>,
): Promise<Form[]> {
  const forms: Form[] = [];

  for (const frame of page.frames()) {
    const frameScopes = await scopesForFrame(frame);
    const captured = await captureDocumentScopes(frame);

    for (const scope of captured) {
      // Resolve relative form actions against the document that owns the
      // control, not the top page or the wizard's first URL.
      const spec = extractForms({ ...document, finalUrl: frame.url(), html: scope.html });
      const scopes = [...frameScopes, ...scope.scopes];

      for (const form of spec.forms) {
        const fields = form.fields
          .map((field) => ({
            ...field,
            locator: { scopes, selector: field.selector },
            stepIndex,
          }))
          .filter((field) => {
            // Wizards commonly reuse `name=answer` and the same CSS selector on
            // every page. Same address plus different meaning is a new field;
            // same address and same meaning is persistent chrome to dedupe.
            const key = JSON.stringify([field.locator, field.type, field.name, field.label]);
            if (seenFields.has(key)) return false;
            seenFields.add(key);
            return true;
          });

        if (fields.length > 0) forms.push({ ...form, stepIndex, fields });
      }
    }
  }

  return forms;
}

async function findNextControl(page: Page) {
  const safeText = /^(?:next(?:\s+step)?|continue|proceed|save\s*(?:&|and)\s*continue)$/i;

  for (const frame of page.frames()) {
    const candidates = frame.locator(
      'button, input[type="button"], input[type="submit"], [role="button"]',
    );
    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (!(await candidate.isVisible()) || !(await candidate.isEnabled())) continue;
      const textContent = (await candidate.textContent())?.trim() ?? '';
      const text = textContent || ((await candidate.getAttribute('value')) ?? '').trim();
      if (safeText.test(text)) return candidate;
    }
  }

  return null;
}

async function fillDiscoveryValues(
  next: Awaited<ReturnType<typeof findNextControl>>,
): Promise<void> {
  if (!next) return;
  const form = next.locator('xpath=ancestor::form[1]');
  if ((await form.count()) === 0) return;

  // Server-rendered wizards often enforce a choice without writing HTML's
  // `required` attribute (GOV.UK is one). Populate every empty answer control
  // in this one form so the discovery click can cross that boundary.
  const controls = form.locator(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), select, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"]',
  );
  const handledRadioGroups = new Set<string>();

  for (let index = 0; index < (await controls.count()); index += 1) {
    const control = controls.nth(index);
    const type = (await control.getAttribute('type'))?.toLowerCase() ?? '';

    if (type === 'radio') {
      const name = (await control.getAttribute('name')) ?? '';
      const groupKey = name || (await control.getAttribute('id')) || `unnamed-${index}`;
      if (handledRadioGroups.has(groupKey)) continue;
      handledRadioGroups.add(groupKey);
      const first = name
        ? form.locator(`input[type="radio"][name=${JSON.stringify(name)}]`).first()
        : control;
      await first.check();
      continue;
    }

    if (type === 'checkbox') {
      await control.check();
      continue;
    }

    if ((await control.locator('xpath=self::select').count()) > 0) {
      const options = control.locator('option:not([disabled])');
      for (let optionIndex = 0; optionIndex < (await options.count()); optionIndex += 1) {
        const option = options.nth(optionIndex);
        const value = (await option.getAttribute('value')) ?? (await option.textContent()) ?? '';
        if (!value.trim()) continue;
        await control.selectOption(value);
        break;
      }
      continue;
    }

    if (type === 'file') continue;

    const current = await control.inputValue().catch(() => '');
    if (current) continue;
    const value =
      type === 'email'
        ? 'inspection@example.invalid'
        : type === 'url'
          ? 'https://example.invalid/'
          : type === 'tel'
            ? '5555555555'
            : type === 'date'
              ? '2000-01-01'
              : type === 'datetime-local'
                ? '2000-01-01T12:00'
                : type === 'time'
                  ? '12:00'
                  : type === 'month'
                    ? '2000-01'
                    : type === 'week'
                      ? '2000-W01'
                      : type === 'number'
                        ? '0'
                        : 'Inspection';
    await control.fill(value);
  }
}

async function scopesForFrame(frame: Frame): Promise<FieldScope[]> {
  const scopes: FieldScope[] = [];
  let current: Frame | null = frame;

  while (current) {
    const parent = current.parentFrame();
    if (!parent) break;
    const element = await current.frameElement();
    const shadowScopes = await element.evaluate<FieldScope[]>((frameElement) => {
      const found: FieldScope[] = [];
      let current: Element | null = frameElement as Element;

      while (current) {
        const root: Node = current.getRootNode();
        if (!(root instanceof ShadowRoot)) break;
        const host: Element = root.host;
        let selector: string;

        if (
          host.id &&
          !/[:«»\s]/.test(host.id) &&
          !/^[0-9a-f]{16,}$/i.test(host.id) &&
          !/[-_][0-9a-f]{8,}$/i.test(host.id) &&
          !/^(radix|headlessui|mui|mantine)-/i.test(host.id)
        ) {
          selector = `#${CSS.escape(host.id)}`;
        } else {
          const parts: string[] = [];
          let partElement: Element | null = host;
          while (partElement) {
            let part = partElement.tagName.toLowerCase();
            const parentElement: Element | null = partElement.parentElement;
            if (parentElement) {
              let sameTagCount = 0;
              let position = 0;
              for (const sibling of parentElement.children) {
                if (sibling.tagName !== partElement.tagName) continue;
                sameTagCount += 1;
                if (sibling === partElement) position = sameTagCount;
              }
              if (sameTagCount > 1) part += `:nth-of-type(${position})`;
            }
            parts.unshift(part);
            partElement = parentElement;
          }
          selector = parts.join(' > ');
        }

        found.unshift({ kind: 'shadow', selector });
        current = host;
      }

      return found;
    });
    const id = await element.getAttribute('id');
    const name = await element.getAttribute('name');
    const src = await element.getAttribute('src');
    const selector =
      id && isStableId(id)
        ? `#${escapeCssIdentifier(id)}`
        : name
          ? `iframe[name="${escapeCssAttribute(name)}"]`
          : src
            ? `iframe[src="${escapeCssAttribute(src)}"]`
            : 'iframe';
    scopes.unshift(...shadowScopes, { kind: 'frame', selector });
    current = parent;
  }

  return scopes;
}

async function captureDocumentScopes(frame: Frame): Promise<CapturedScope[]> {
  return frame.evaluate<CapturedScope[]>(CAPTURE_DOCUMENT_SCOPES_SCRIPT);
}

function escapeCssIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

function escapeCssAttribute(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
