import type { Frame, FrameLocator, Locator, Page } from 'playwright';
import {
  FormSpecSchema,
  type Field,
  type FieldScope,
  type Form,
  type FormInspectionWarning,
  type FormSpec,
  type LabelSource,
  type LocatorCandidate,
} from '@untitled/schema';
import { extractForms, IMPLAUSIBLE_ID_PATTERN, isPlausiblyStableId } from '../core/forms.js';
import type { HtmlDocument } from '../core/types.js';
import { waitForDomQuiet } from './dom-readiness.js';

interface CapturedScope {
  html: string;
  scopes: FieldScope[];
  selectorRoot: 'document' | 'fragment';
}

// Strings on purpose: tsx/esbuild names nested functions with a Node-side
// helper. Passing the transformed function to Playwright made that helper leak
// into the page and fail only in production. Source strings execute exactly as
// written in Chromium under every Node transform.
const PATH_FOR_SCRIPT = String.raw`(element) => {
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

const CANDIDATES_FOR_SCRIPT = String.raw`(element, root) => {
    const candidates = [];
    const attribute = (name, source) => {
      const value = element.getAttribute(name);
      if (!value) return;
      const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const selector = '[' + name + '="' + escaped + '"]';
      if (root.querySelectorAll(selector).length === 1) {
        candidates.push({ kind: 'css', selector, source });
      }
    };
    attribute('name', 'name');
    attribute('data-testid', 'test-id');
    attribute('aria-label', 'aria-label');
    const idIsStable = element.id &&
      !new RegExp(${JSON.stringify(IMPLAUSIBLE_ID_PATTERN.source)}, 'i').test(element.id);
    if (idIsStable) {
      candidates.push({ kind: 'css', selector: '#' + CSS.escape(element.id), source: 'id' });
    }
    candidates.push({ kind: 'css', selector: (${PATH_FOR_SCRIPT})(element), source: 'path' });
    return candidates;
  }`;

const SELECTOR_FOR_SCRIPT = String.raw`(element, root) => {
    const idIsStable = element.id &&
      !new RegExp(${JSON.stringify(IMPLAUSIBLE_ID_PATTERN.source)}, 'i').test(element.id);
    if (idIsStable) return '#' + CSS.escape(element.id);

    const name = element.getAttribute('name');
    if (name) {
      const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const candidate = '[name="' + escaped + '"]';
      if (root.querySelectorAll(candidate).length === 1) return candidate;
    }

    return (${PATH_FOR_SCRIPT})(element);
  }`;

const CAPTURE_DOCUMENT_SCOPES_SCRIPT = String.raw`(() => {
  const selectorFor = ${SELECTOR_FOR_SCRIPT};
  const candidatesFor = ${CANDIDATES_FOR_SCRIPT};

  const result = [{ html: document.documentElement.outerHTML, scopes: [], selectorRoot: 'document' }];
  const visit = (root, scopes) => {
    for (const element of root.querySelectorAll('*')) {
      if (!element.shadowRoot) continue;
      const nextScopes = scopes.concat([{
        kind: 'shadow',
        selector: selectorFor(element, root),
        candidates: candidatesFor(element, root),
        fingerprint: {
          tag: element.tagName.toLowerCase(),
          name: element.getAttribute('name'),
          ariaLabel: element.getAttribute('aria-label'),
          src: element.getAttribute('src'),
        },
      }]);
      result.push({
        html: element.shadowRoot.innerHTML,
        scopes: nextScopes,
        selectorRoot: 'fragment',
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

interface InspectionOptions {
  deadline?: number;
}

/**
 * Read forms from the live DOM while Chromium still owns it.
 *
 * Each document and open shadow root is serialized separately, then handed to
 * the existing form walker. The browser-specific part only discovers scopes;
 * label resolution, grouping, sensitivity and selector rules remain in one
 * implementation.
 */
export async function inspectFormsOnPage(
  page: Page,
  document: HtmlDocument,
  options: InspectionOptions = {},
): Promise<FormSpec> {
  const forms: Form[] = [];
  const warnings: FormInspectionWarning[] = [];
  const seenFields = new Set<string>();
  const maxSteps = 20;
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
  let followedWizardBranch = false;

  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
    if (Date.now() >= deadline) {
      warnings.push({
        code: 'inspection-budget-exhausted',
        message: 'Stopped form exploration because the request deadline was reached.',
      });
      break;
    }
    const added = await collectStep(page, document, stepIndex, seenFields, deadline);
    forms.push(...added);
    if (Date.now() >= deadline) {
      warnings.push({
        code: 'inspection-budget-exhausted',
        message: 'Stopped form exploration because the request deadline was reached.',
      });
      break;
    }

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

  await verifyLocatorsOnFreshLoad(page, document.finalUrl, forms, warnings, deadline);

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
  deadline: number,
): Promise<Form[]> {
  const forms: Form[] = [];

  for (const frame of page.frames()) {
    const frameScopes = await scopesForFrame(frame);
    const captured = await captureDocumentScopes(frame);

    for (const scope of captured) {
      // Resolve relative form actions against the document that owns the
      // control, not the top page or the wizard's first URL.
      const spec = extractForms(
        { ...document, finalUrl: frame.url(), html: scope.html },
        { selectorRoot: scope.selectorRoot },
      );
      const scopes = [...frameScopes, ...scope.scopes];

      for (const form of spec.forms) {
        const locatedFields: Field[] = [];
        // Choice widgets are intentionally inspected one at a time. Opening a
        // React Select normally closes whichever one was already open, so a
        // Promise.all here makes every widget race for the page's one listbox.
        for (const field of form.fields) {
          const enriched = await enrichLiveField(frame, scope.scopes, field, deadline);
          const candidates = await candidatesForField(frame, scope.scopes, enriched);
          locatedFields.push({
            ...enriched,
            locator: {
              scopes,
              selector: enriched.selector,
              candidates,
              preferred: candidates[0] ?? null,
              verification: 'snapshot-only' as const,
              fingerprint: {
                type: enriched.type,
                interactionKind: enriched.interaction.kind,
                name: enriched.name,
                label: enriched.label,
              },
            },
            stepIndex,
          });
        }
        const fields = locatedFields.filter((field) => {
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

type LocatorRoot = Page | Frame | FrameLocator | Locator;

async function rootForScopes(
  root: LocatorRoot,
  scopes: FieldScope[],
  recordSelection = false,
): Promise<LocatorRoot | null> {
  let current = root;
  for (const scope of scopes) {
    const candidate = await firstMatchingScopeCandidate(
      current,
      scope.candidates ?? [{ kind: 'css', selector: scope.selector, source: 'path' }],
      scope.fingerprint,
      recordSelection,
    );
    if (!candidate || candidate.kind !== 'css') return null;
    if (recordSelection) {
      scope.selector = candidate.selector;
      scope.candidates = [
        candidate,
        ...(scope.candidates ?? []).filter(
          (existing) => JSON.stringify(existing) !== JSON.stringify(candidate),
        ),
      ];
    }
    current =
      scope.kind === 'frame'
        ? current.frameLocator(candidate.selector)
        : current.locator(candidate.selector);
  }
  return current;
}

async function firstMatchingScopeCandidate(
  root: LocatorRoot,
  candidates: LocatorCandidate[],
  fingerprint: FieldScope['fingerprint'],
  requireDurableIdentity: boolean,
): Promise<LocatorCandidate | null> {
  for (const candidate of candidates) {
    if (candidate.kind !== 'css') continue;
    if (
      requireDurableIdentity &&
      candidate.source === 'path' &&
      !fingerprint?.name &&
      !fingerprint?.ariaLabel &&
      !fingerprint?.src
    ) {
      continue;
    }
    const locator = root.locator(candidate.selector);
    if ((await locator.count()) !== 1) continue;
    if (fingerprint) {
      const observed = await locator.evaluate((element) => ({
        tag: element.tagName.toLowerCase(),
        name: element.getAttribute('name'),
        ariaLabel: element.getAttribute('aria-label'),
        src: element.getAttribute('src'),
      }));
      if (
        observed.tag !== fingerprint.tag ||
        observed.name !== fingerprint.name ||
        observed.ariaLabel !== fingerprint.ariaLabel ||
        observed.src !== fingerprint.src
      ) {
        continue;
      }
    }
    return candidate;
  }
  return null;
}

async function enrichLiveField(
  frame: Frame,
  scopes: FieldScope[],
  field: Field,
  deadline: number,
): Promise<Field> {
  if (field.interaction.kind !== 'choose' || field.interaction.optionsStatus !== 'dynamic') {
    return field;
  }
  if (Date.now() >= deadline) return field;

  const root = await rootForScopes(frame, scopes);
  if (!root) return field;
  const control = root.locator(field.selector);
  if ((await control.count()) !== 1) return field;

  const currentValues = await currentValuesOf(control);
  const role = (await control.getAttribute('role'))?.toLowerCase();
  const isAlwaysOpenListbox = role === 'listbox';
  let opened = false;
  try {
    if (!isAlwaysOpenListbox && (await control.getAttribute('aria-expanded')) !== 'true') {
      await control.click({ timeout: Math.max(1, Math.min(500, deadline - Date.now())) });
      opened = true;
    }
    await frame.page().waitForTimeout(Math.max(1, Math.min(50, deadline - Date.now())));

    const controlled =
      (await control.getAttribute('aria-controls')) ?? (await control.getAttribute('aria-owns'));
    const localOptionRoot = controlled
      ? root.locator(`#${escapeCssIdentifier(controlled)}`)
      : control;
    const optionRoot =
      controlled && (await localOptionRoot.count()) !== 1
        ? frame.locator(`#${escapeCssIdentifier(controlled)}`)
        : localOptionRoot;
    const options = optionRoot.locator('[role="option"]:visible');
    await options
      .first()
      .waitFor({ state: 'visible', timeout: Math.max(1, Math.min(500, deadline - Date.now())) })
      .catch(() => {});
    const count = await options.count();
    if (count === 0) return { ...field, currentValues };

    const values = await Promise.all(
      Array.from({ length: count }, async (_value, index) => {
        const option = options.nth(index);
        const label =
          ((await option.innerText()).trim() || (await option.textContent())?.trim()) ?? '';
        return {
          value:
            (await option.getAttribute('data-value')) ??
            (await option.getAttribute('value')) ??
            label,
          label,
          selected: (await option.getAttribute('aria-selected')) === 'true',
        };
      }),
    );
    const declaredTotal = await optionRoot
      .evaluate((element) => {
        const declarations = [
          element.getAttribute('aria-setsize'),
          ...[...element.querySelectorAll('[role="option"]')].map((option) =>
            option.getAttribute('aria-setsize'),
          ),
        ]
          .map(Number)
          .filter((value) => Number.isFinite(value) && value >= 0);
        return declarations.length > 0 ? Math.max(...declarations) : null;
      })
      .catch(() => null);
    const optionsStatus =
      declaredTotal === count
        ? 'complete'
        : declaredTotal && declaredTotal > count
          ? 'partial'
          : 'dynamic';

    return {
      ...field,
      currentValues,
      options: values,
      interaction: {
        ...field.interaction,
        optionsStatus,
      },
    };
  } catch {
    return { ...field, currentValues };
  } finally {
    if (opened) await control.press('Escape').catch(() => {});
  }
}

async function currentValuesOf(control: Locator): Promise<string[]> {
  const explicit =
    (await control.getAttribute('aria-valuetext')) ?? (await control.getAttribute('value'));
  if (explicit) return [explicit];
  const selected = control.locator('[aria-selected="true"]');
  const selectedValues: string[] = [];
  for (let index = 0; index < (await selected.count()); index += 1) {
    const value = (await selected.nth(index).innerText()).trim();
    if (value) selectedValues.push(value);
  }
  if (selectedValues.length > 0) return selectedValues;
  const text = ((await control.innerText().catch(() => '')) || '').trim();
  if (text) return [text];

  // React Select puts role=combobox on an empty input while rendering the
  // selected value as its sibling. Read a small enclosing control without
  // letting labels, live announcements, or option popups become values.
  return control.evaluate((element) => {
    let container = element.parentElement;
    for (let depth = 0; depth < 3 && container; depth += 1) {
      const clone = container.cloneNode(true) as Element;
      for (const excluded of clone.querySelectorAll(
        'input, textarea, select, label, [role="listbox"], [role="option"], [role="log"], [role="status"], [aria-live]',
      )) {
        excluded.remove();
      }
      const candidate = (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (candidate && candidate.length <= 80) return [candidate];
      container = container.parentElement;
    }
    return [];
  });
}

const DIRECT_LABEL_SOURCES = new Set<LabelSource>([
  'label-for',
  'label-wrapping',
  'aria-label',
  'aria-labelledby',
]);

async function candidatesForField(
  frame: Frame,
  scopes: FieldScope[],
  field: Field,
): Promise<LocatorCandidate[]> {
  const root = await rootForScopes(frame, scopes);
  if (!root) return [];
  const control = root.locator(field.selector);
  if ((await control.count()) !== 1) return [];

  const candidates: LocatorCandidate[] = [];
  const name = await control.getAttribute('name');
  const testId = await control.getAttribute('data-testid');
  const ariaLabel = await control.getAttribute('aria-label');
  const id = await control.getAttribute('id');
  const positional = await control.evaluate((element) => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current) {
      const tag = current.tagName.toLowerCase();
      const parent: Element | null = current.parentElement;
      let position = 1;
      if (parent) {
        position =
          [...parent.children]
            .filter((sibling) => sibling.tagName === current?.tagName)
            .indexOf(current) + 1;
      }
      parts.unshift(`${tag}:nth-of-type(${position})`);
      if (tag === 'body') break;
      current = parent;
    }
    return parts.join(' > ');
  });
  if (name)
    candidates.push({
      kind: 'css',
      selector: `[name="${escapeCssAttribute(name)}"]`,
      source: 'name',
    });
  if (testId)
    candidates.push({
      kind: 'css',
      selector: `[data-testid="${escapeCssAttribute(testId)}"]`,
      source: 'test-id',
    });
  if (ariaLabel)
    candidates.push({
      kind: 'css',
      selector: `[aria-label="${escapeCssAttribute(ariaLabel)}"]`,
      source: 'aria-label',
    });

  const role = await roleOf(control, field);
  if (role && field.label && field.labelSource && DIRECT_LABEL_SOURCES.has(field.labelSource)) {
    candidates.push({ kind: 'role-name', role, name: field.label });
  }
  if (id && isPlausiblyStableId(id)) {
    candidates.push({ kind: 'css', selector: `#${escapeCssIdentifier(id)}`, source: 'id' });
  }
  candidates.push({ kind: 'css', selector: positional, source: 'path' });

  const unique: LocatorCandidate[] = [];
  for (const candidate of candidates) {
    if (unique.some((existing) => JSON.stringify(existing) === JSON.stringify(candidate))) continue;
    const locator = locatorForCandidate(root, candidate);
    if ((await locator.count()) === 1) unique.push(candidate);
  }
  return unique;
}

async function roleOf(control: Locator, field: Field): Promise<string | null> {
  const explicit = await control.getAttribute('role');
  if (explicit) return explicit;
  return field.type === 'select'
    ? 'combobox'
    : field.type === 'checkbox'
      ? 'checkbox'
      : field.type === 'radio'
        ? 'radio'
        : field.type === 'range'
          ? 'slider'
          : field.interaction.kind === 'type'
            ? 'textbox'
            : null;
}

function locatorForCandidate(root: LocatorRoot, candidate: LocatorCandidate): Locator {
  return candidate.kind === 'css'
    ? root.locator(candidate.selector)
    : root.getByRole(candidate.role as Parameters<Page['getByRole']>[0], {
        name: candidate.name,
        exact: true,
      });
}

async function verifyLocatorsOnFreshLoad(
  page: Page,
  url: string,
  forms: Form[],
  warnings: FormInspectionWarning[],
  deadline: number,
): Promise<void> {
  if (deadline - Date.now() < 250) return;
  const fresh = await page.context().newPage();
  try {
    await fresh.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: Math.max(1, Math.min(5_000, deadline - Date.now())),
    });
    await waitForDomQuiet(fresh, Math.max(1, Math.min(2_000, deadline - Date.now())));

    const fields = forms.flatMap((form) => form.fields);
    const stepIndexes = [...new Set(fields.map((field) => field.stepIndex ?? 0))].sort(
      (left, right) => left - right,
    );
    let currentStep = 0;

    for (const stepIndex of stepIndexes) {
      while (currentStep < stepIndex && Date.now() < deadline) {
        const next = await findNextControl(fresh);
        if (!next) break;
        await fillDiscoveryValues(next);
        await next.click({ timeout: Math.max(1, Math.min(1_000, deadline - Date.now())) });
        currentStep += 1;
        await waitForDomQuiet(fresh, Math.max(1, Math.min(2_000, deadline - Date.now())));
      }
      if (currentStep !== stepIndex) continue;

      for (const field of fields.filter((candidate) => (candidate.stepIndex ?? 0) === stepIndex)) {
        if (Date.now() >= deadline) break;
        await verifyFieldLocator(fresh, field, warnings);
      }
    }
  } catch (error) {
    // A verification load is evidence gathering, not permission to discard a
    // successfully inspected page. Snapshot-only locators remain explicit.
    warnings.push({
      code: 'locator-not-replayable',
      message: `Fresh-load locator verification stopped: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    await fresh.close().catch(() => {});
  }
}

async function verifyFieldLocator(
  page: Page,
  field: Field,
  warnings: FormInspectionWarning[],
): Promise<void> {
  if (!field.locator) return;
  const root = await rootForScopes(page, field.locator.scopes, true);
  if (!root) return;
  const replayed: LocatorCandidate[] = [];
  for (const candidate of field.locator.candidates ?? []) {
    if (await candidateMatchesField(root, candidate, field)) replayed.push(candidate);
  }
  const preferred = replayed[0] ?? null;
  if (!preferred) {
    warnings.push({
      code: 'locator-not-replayable',
      message: `No locator candidate replayed uniquely for ${field.label ?? field.name ?? field.id ?? 'an unnamed field'}.`,
    });
    return;
  }

  field.locator.preferred = preferred;
  field.locator.verification = 'fresh-load';
  field.locator.candidates = [
    ...replayed,
    ...(field.locator.candidates ?? []).filter(
      (candidate) =>
        !replayed.some((verified) => JSON.stringify(candidate) === JSON.stringify(verified)),
    ),
  ];
  if (preferred.kind === 'css') {
    field.locator.selector = preferred.selector;
    field.selector = preferred.selector;
  } else {
    const durableCss = replayed.find((candidate) => candidate.kind === 'css');
    if (durableCss?.kind === 'css') {
      field.locator.selector = durableCss.selector;
      field.selector = durableCss.selector;
    }
  }
}

async function candidateMatchesField(
  root: LocatorRoot,
  candidate: LocatorCandidate,
  field: Field,
): Promise<boolean> {
  const locator = locatorForCandidate(root, candidate);
  if ((await locator.count()) !== 1) return false;

  const observed = await locator.evaluate((element) => {
    const tag = element.tagName.toLowerCase();
    const role = (element.getAttribute('role') ?? '').toLowerCase();
    const rawType = (element.getAttribute('type') ?? 'text').toLowerCase();
    const inputTypes = new Set([
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
    const type =
      tag === 'select'
        ? 'select'
        : tag === 'textarea'
          ? 'textarea'
          : tag === 'input'
            ? inputTypes.has(rawType)
              ? rawType
              : 'text'
            : 'custom';

    let interactionKind: 'type' | 'choose' | 'toggle' | 'upload' | 'none';
    if (role === 'combobox' || role === 'listbox' || type === 'select' || type === 'radio') {
      interactionKind = 'choose';
    } else if (type === 'checkbox') {
      const name = element.getAttribute('name');
      const rootNode = element.getRootNode() as Document | ShadowRoot;
      const peers = name
        ? rootNode.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(name)}"]`).length
        : 1;
      interactionKind = peers > 1 ? 'choose' : 'toggle';
    } else if (type === 'file') {
      interactionKind = 'upload';
    } else if (type === 'hidden') {
      interactionKind = 'none';
    } else {
      interactionKind = 'type';
    }
    return { type, interactionKind };
  });
  if (observed.type !== field.type || observed.interactionKind !== field.interaction.kind) {
    return false;
  }

  // Type alone is not an identity. A positional selector for an anonymous
  // text box can still point at a different text box after the DOM shifts.
  // Only certify it when either the candidate itself is durable or the field
  // has a semantic discriminator that we verify below.
  const hasDirectLabel = Boolean(
    field.label && field.labelSource && DIRECT_LABEL_SOURCES.has(field.labelSource),
  );
  const hasDurableCandidate =
    candidate.kind === 'role-name' || (candidate.kind === 'css' && candidate.source !== 'path');
  if (!hasDurableCandidate && !field.name && !hasDirectLabel) return false;

  const actualName = await locator.getAttribute('name');
  if (field.name && actualName !== field.name) return false;

  if (field.label && field.labelSource && DIRECT_LABEL_SOURCES.has(field.labelSource)) {
    const accessibleName = await locator.evaluate((element) => {
      const ariaLabel = element.getAttribute('aria-label')?.trim();
      if (ariaLabel) return ariaLabel;

      const rootNode = element.getRootNode() as Document | ShadowRoot;
      const labelledBy = element
        .getAttribute('aria-labelledby')
        ?.split(/\s+/)
        .filter(Boolean)
        .map((id) => rootNode.querySelector(`#${CSS.escape(id)}`)?.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ');
      if (labelledBy) return labelledBy;

      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement
      ) {
        const labels = [...(element.labels ?? [])]
          .map((label) => label.textContent?.trim() ?? '')
          .filter(Boolean)
          .join(' ');
        if (labels) return labels;
      }
      return element.closest('label')?.textContent?.trim() ?? '';
    });
    if (accessibleName.replace(/\s+/g, ' ').trim() !== field.label.replace(/\s+/g, ' ').trim()) {
      return false;
    }
  }

  return true;
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
    const shadowScopes = await element.evaluate<FieldScope[], string>((frameElement, pattern) => {
      const found: FieldScope[] = [];
      const implausibleId = new RegExp(pattern, 'i');
      let current: Element | null = frameElement as Element;

      while (current) {
        const root: Node = current.getRootNode();
        if (!(root instanceof ShadowRoot)) break;
        const host: Element = root.host;
        let selector: string;
        const candidates: LocatorCandidate[] = [];

        if (host.id && !implausibleId.test(host.id)) {
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

        const hostName = host.getAttribute('name');
        if (hostName) {
          const candidate = `[name="${CSS.escape(hostName)}"]`;
          if (root.querySelectorAll(candidate).length === 1) {
            candidates.push({ kind: 'css', selector: candidate, source: 'name' });
          }
        }
        const hostTestId = host.getAttribute('data-testid');
        if (hostTestId) {
          const candidate = `[data-testid="${CSS.escape(hostTestId)}"]`;
          if (root.querySelectorAll(candidate).length === 1) {
            candidates.push({ kind: 'css', selector: candidate, source: 'test-id' });
          }
        }
        const hostAriaLabel = host.getAttribute('aria-label');
        if (hostAriaLabel) {
          const candidate = `[aria-label="${CSS.escape(hostAriaLabel)}"]`;
          if (root.querySelectorAll(candidate).length === 1) {
            candidates.push({ kind: 'css', selector: candidate, source: 'aria-label' });
          }
        }
        if (host.id && !implausibleId.test(host.id)) {
          candidates.push({ kind: 'css', selector: `#${CSS.escape(host.id)}`, source: 'id' });
        }
        candidates.push({ kind: 'css', selector, source: 'path' });

        found.unshift({
          kind: 'shadow',
          selector,
          candidates,
          fingerprint: {
            tag: host.tagName.toLowerCase(),
            name: host.getAttribute('name'),
            ariaLabel: host.getAttribute('aria-label'),
            src: host.getAttribute('src'),
          },
        });
        current = host;
      }

      return found;
    }, IMPLAUSIBLE_ID_PATTERN.source);
    const id = await element.getAttribute('id');
    const name = await element.getAttribute('name');
    const src = await element.getAttribute('src');
    const testId = await element.getAttribute('data-testid');
    const ariaLabel = await element.getAttribute('aria-label');
    const positional = await element.evaluate((frameElement) => {
      const parts: string[] = [];
      let cursor: Element | null = frameElement as Element;
      while (cursor) {
        const tag = cursor.tagName.toLowerCase();
        const parentElement: Element | null = cursor.parentElement;
        let position = 1;
        if (parentElement) {
          position =
            [...parentElement.children]
              .filter((sibling) => sibling.tagName === cursor?.tagName)
              .indexOf(cursor) + 1;
        }
        parts.unshift(`${tag}:nth-of-type(${position})`);
        if (tag === 'body') break;
        cursor = parentElement;
      }
      return parts.join(' > ');
    });
    const selector =
      id && isPlausiblyStableId(id)
        ? `#${escapeCssIdentifier(id)}`
        : name
          ? `iframe[name="${escapeCssAttribute(name)}"]`
          : src
            ? `iframe[src="${escapeCssAttribute(src)}"]`
            : 'iframe';
    const candidates: LocatorCandidate[] = [];
    if (name)
      candidates.push({
        kind: 'css',
        selector: `iframe[name="${escapeCssAttribute(name)}"]`,
        source: 'name',
      });
    if (testId)
      candidates.push({
        kind: 'css',
        selector: `[data-testid="${escapeCssAttribute(testId)}"]`,
        source: 'test-id',
      });
    if (ariaLabel)
      candidates.push({
        kind: 'css',
        selector: `[aria-label="${escapeCssAttribute(ariaLabel)}"]`,
        source: 'aria-label',
      });
    if (id && isPlausiblyStableId(id))
      candidates.push({ kind: 'css', selector: `#${escapeCssIdentifier(id)}`, source: 'id' });
    if (src)
      candidates.push({
        kind: 'css',
        selector: `iframe[src="${escapeCssAttribute(src)}"]`,
        source: 'src',
      });
    candidates.push({ kind: 'css', selector: positional, source: 'path' });
    scopes.unshift(...shadowScopes, {
      kind: 'frame',
      selector,
      candidates,
      fingerprint: { tag: 'iframe', name, ariaLabel, src },
    });
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
