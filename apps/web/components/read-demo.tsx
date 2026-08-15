'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Field, FormSpec } from '@untitled/schema';
import { fetchDemo, ServiceError, type PageText } from '@/lib/api';
import {
  isFillable,
  SOURCE_LABEL,
  tally,
  TRUST_LABEL,
  TRUST_ORDER,
  TRUST_STYLE,
  trustOf,
} from '@/lib/trust';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

/**
 * Real urls, chosen so the four states are all one click away — including the
 * refusal, which is a normal outcome rather than a bug and is worth showing.
 */
/**
 * Chosen by measurement, not by taste — each was read through the same path
 * `/demo` uses, and each earns its place by showing something the others do not.
 *
 *   a job application    22 fields, 18 named · the product's actual use case
 *   a login form          2 fields · the simplest thing that works
 *   a messy practice form 14 fields across all four trust levels
 *   four forms at once    4 forms, 18 fields · a page is not one form
 *   a government scheme   2 fields, 10k of markdown · needs a browser to see
 *   a wikipedia article   no forms at all, which is an answer and not a failure
 *
 * Ordered strongest first: whichever a visitor clicks, the one above it is a
 * better argument, and the first is the one that looks most like their problem.
 */
const EXAMPLES = [
  { chip: 'a job application', url: 'https://job-boards.greenhouse.io/gitlab/jobs/8503792002' },
  { chip: 'a login form', url: 'https://the-internet.herokuapp.com/login' },
  { chip: 'a messy practice form', url: 'https://demoqa.com/automation-practice-form' },
  { chip: 'four forms at once', url: 'https://www.w3schools.com/html/html_forms.asp' },
  { chip: 'a government scheme', url: 'https://www.myscheme.gov.in/schemes/sui' },
  { chip: 'a wikipedia article', url: 'https://en.wikipedia.org/wiki/Web_scraping' },
];

type Status =
  | { state: 'idle' }
  | { state: 'reading' }
  | { state: 'read'; spec: FormSpec; text: PageText; ms: number }
  | { state: 'failed'; code: string; message: string; url: string };

export function ReadDemo() {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<Status>({ state: 'idle' });
  const results = useRef<HTMLDivElement>(null);

  async function read(target: string) {
    setStatus({ state: 'reading' });
    const started = Date.now();

    try {
      const { spec, text } = await fetchDemo(target);
      setStatus({ state: 'read', spec, text, ms: Date.now() - started });
    } catch (error) {
      const { code, message } =
        error instanceof ServiceError
          ? error
          : {
              code: 'unreachable',
              message: 'We could not reach the reader. Try again in a moment.',
            };
      setStatus({ state: 'failed', code, message, url: target });
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (url.trim()) void read(url.trim());
  }

  return (
    <section className="mt-16">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Read a page</h2>
        <span className="text-muted-foreground font-mono text-xs">text · fields</span>
      </div>

      <form onSubmit={submit} className="mt-4 flex flex-wrap gap-2">
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://"
          spellCheck={false}
          aria-label="Page url"
          className="min-w-0 flex-1 basis-80 font-mono"
        />
        <Button type="submit" disabled={status.state === 'reading'} className="shrink-0">
          {status.state === 'reading' ? 'Reading…' : 'Read the page'}
        </Button>
      </form>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground font-mono text-xs">or try</span>
        {EXAMPLES.map((example) => (
          <Button
            key={example.url}
            type="button"
            variant="outline"
            size="sm"
            className="font-mono text-xs"
            onClick={() => {
              setUrl(example.url);
              void read(example.url);
            }}
          >
            {example.chip}
          </Button>
        ))}
      </div>

      <div ref={results} className="mt-6">
        {status.state === 'idle' && <Idle />}
        {status.state === 'reading' && <Reading />}
        {status.state === 'failed' && <Failed status={status} />}
        {status.state === 'read' && <Result status={status} />}
      </div>
    </section>
  );
}

function Idle() {
  return (
    <div className="grid gap-px sm:grid-cols-2">
      {[
        {
          eyebrow: 'panel one · text',
          body: 'The article, without the navigation, the cookie banner, the newsletter box or the footer. If the page builds itself with JavaScript, we open a real browser and wait.',
        },
        {
          eyebrow: 'panel two · fields',
          body: 'Every box on the page, and where its name came from. A name read from a <label> is worth more than one guessed from the text sitting next to it, so we show you which is which.',
        },
      ].map((panel) => (
        <div key={panel.eyebrow} className="border-border bg-card border p-6">
          <p className="text-muted-foreground font-mono text-[11px] tracking-widest uppercase">
            {panel.eyebrow}
          </p>
          <p className="text-muted-foreground mt-3 max-w-prose text-sm leading-relaxed">
            {panel.body}
          </p>
        </div>
      ))}
    </div>
  );
}

function Reading() {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const tick = setInterval(() => setElapsed(Date.now() - started), 200);
    return () => clearInterval(tick);
  }, []);

  return (
    <div className="border-border bg-card border p-6" aria-live="polite">
      <div className="bg-muted h-0.5 overflow-hidden">
        <div className="bg-primary h-full w-1/3 animate-[sweep_1.5s_ease-in-out_infinite]" />
      </div>
      <p className="text-muted-foreground mt-5 font-mono text-sm">
        reading the page… {(elapsed / 1000).toFixed(1)}s
      </p>
      {/* Only claimed once it is actually true — a slow read is the browser path. */}
      {elapsed > 2500 && (
        <p className="text-muted-foreground mt-3 max-w-prose text-sm">
          This one is taking a while, which usually means the page builds itself with JavaScript and
          we have opened a real browser for it.
        </p>
      )}
    </div>
  );
}

/**
 * Not the Alert component: its destructive variant paints every child in
 * translucent red at text-xs, which is a legibility problem rather than a
 * styling one. A failure is information the reader has to be able to read, so
 * the colour signals and the text stays at full contrast.
 */
function Failed({ status }: { status: Extract<Status, { state: 'failed' }> }) {
  return (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/5 animate-[rise_0.25s_ease-out] border p-6"
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <Badge variant="destructive" className="font-mono">
          {status.code}
        </Badge>
        <p className="font-medium">We could not read that page</p>
      </div>
      <p className="mt-3 max-w-prose">{status.message}</p>
      {/* Several service messages already quote the url. Repeating it reads as a bug. */}
      {!status.message.includes(status.url) && (
        <p className="text-muted-foreground mt-2 font-mono text-xs break-all">{status.url}</p>
      )}
      <p className="text-muted-foreground mt-4 max-w-prose text-sm">
        A refusal tells you about the site, not about your url. Stack Overflow, Quora and Medium all
        turn us away.
      </p>
    </div>
  );
}

function Result({ status }: { status: Extract<Status, { state: 'read' }> }) {
  const { spec, text, ms } = status;
  const everyField = spec.forms.flatMap((form) => form.fields);
  const fields = everyField.filter(isFillable);
  const counts = tally(fields);
  const nameable = fields.length - counts.unknown;

  return (
    <div className="animate-[rise_0.3s_ease-out]">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono">
          {ms.toLocaleString()}ms
        </Badge>
        <Badge variant="outline" className="font-mono">
          {spec.fetchedWith === 'browser' ? 'real browser' : 'http'}
        </Badge>
        <span className="text-muted-foreground ml-auto max-w-full truncate text-xs">
          {spec.url}
        </span>
      </div>

      <Tabs defaultValue="fields">
        <TabsList>
          <TabsTrigger value="fields">Fields</TabsTrigger>
          <TabsTrigger value="text">Text</TabsTrigger>
        </TabsList>

        <TabsContent value="fields">
          {fields.length === 0 ? (
            <div className="border-border bg-card border p-10">
              <p className="font-medium text-sm">No forms on this page</p>
              <p className="text-muted-foreground mt-2 max-w-prose text-sm">
                We read it and found nothing to fill: no inputs, no selects, no textareas. That is
                an answer, not a failure — try a sign-up, an application or a checkout.
              </p>
            </div>
          ) : (
            <FieldsPanel fields={fields} spec={spec} nameable={nameable} counts={counts} />
          )}
        </TabsContent>

        <TabsContent value="text">
          <TextPanel text={text} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function FieldsPanel({
  fields,
  spec,
  nameable,
  counts,
}: {
  fields: Field[];
  spec: FormSpec;
  nameable: number;
  counts: Record<string, number>;
}) {
  const [highlight, setHighlight] = useState(-1);

  return (
    <div className="border-border bg-card border">
      <div className="border-border border-b p-6">
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="text-3xl font-semibold tracking-tight tabular-nums">
            {nameable} of {fields.length}
          </span>
          <span className="text-muted-foreground max-w-prose text-sm">
            boxes a person fills that we can name.{' '}
            {fields.length - nameable === 0
              ? 'None are unnamed.'
              : `${fields.length - nameable} we cannot.`}
          </span>
        </div>

        {/* One mark per field, in page order — the shape of the whole form at a glance. */}
        <div className="mt-4 flex flex-wrap gap-[3px]">
          {fields.map((field, index) => {
            const trust = trustOf(field);
            return (
              <button
                key={field.selector + index}
                type="button"
                title={`${field.label ?? 'unnamed'} — ${TRUST_LABEL[trust]}`}
                onClick={() => setHighlight(index)}
                className={cn('h-6 w-3 border', TRUST_STYLE[trust].tick)}
              />
            );
          })}
        </div>

        <div className="text-muted-foreground mt-3 flex flex-wrap gap-4 font-mono text-[11px]">
          {TRUST_ORDER.map((trust) => (
            <span key={trust} className="flex items-center gap-1.5">
              <span className={cn('inline-block h-4 w-2 border', TRUST_STYLE[trust].tick)} />
              {TRUST_LABEL[trust]}
              {counts[trust] ? ` (${counts[trust]})` : ''}
            </span>
          ))}
        </div>
      </div>

      <ul className="max-h-[32rem] overflow-y-auto">
        {fields.map((field, index) => (
          <FieldRow key={field.selector + index} field={field} highlighted={index === highlight} />
        ))}
      </ul>

      <p className="border-border text-muted-foreground border-t p-4 text-sm">
        {spec.forms.length === 1 ? '1 form' : `${spec.forms.length} forms`} on this page. Across the
        six pages we test on, 18 of 69 boxes had no label at all, and not one used a native select.
      </p>
    </div>
  );
}

function FieldRow({ field, highlighted }: { field: Field; highlighted: boolean }) {
  const trust = trustOf(field);
  const style = TRUST_STYLE[trust];

  return (
    <li
      className={cn(
        'border-border grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 border-b p-4 last:border-b-0',
        highlighted && 'bg-muted',
      )}
    >
      <div className="min-w-0">
        <p className={cn('leading-snug', style.label)}>{field.label ?? 'no name on the page'}</p>
        {/* Selectors run to 145 characters on real pages, so this scrolls rather than wraps. */}
        <div className="mt-1 overflow-x-auto">
          <span className="text-muted-foreground font-mono text-xs whitespace-nowrap">
            {field.selector}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {field.sensitive && <Badge className="font-mono">sensitive</Badge>}
        {field.required && (
          <Badge variant="outline" className="font-mono">
            required
          </Badge>
        )}
        <Badge variant="secondary" className="font-mono">
          {field.type}
        </Badge>
      </div>

      <p className="col-span-2 flex flex-wrap items-center gap-2 font-mono text-[11px]">
        <span className={cn('inline-block h-4 w-2 border', style.tick)} />
        <span className={style.text}>
          {field.labelSource ? SOURCE_LABEL[field.labelSource] : 'no name at all'}
        </span>
        {field.options.length > 0 && (
          <span className="text-muted-foreground">{field.options.length} options</span>
        )}
        {field.accept && <span className="text-muted-foreground">accept {field.accept}</span>}
      </p>
    </li>
  );
}

function TextPanel({ text }: { text: PageText }) {
  if (!text.markdown) {
    return (
      <div className="border-border bg-card border p-10">
        <p className="font-medium text-sm">No readable text on this page</p>
        <p className="text-muted-foreground mt-2 max-w-prose text-sm">
          There was a page, but nothing on it that reads as an article — which is normal for a form,
          a dashboard or an app shell.
        </p>
      </div>
    );
  }

  return (
    <div className="border-border bg-card border">
      <div className="border-border border-b p-5">
        <p className="font-medium text-sm">{text.title || 'Untitled page'}</p>
        {text.description && (
          <p className="text-muted-foreground mt-1 text-sm">{text.description}</p>
        )}
      </div>
      <pre className="max-h-[28rem] overflow-auto p-5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
        {text.markdown}
      </pre>
      <p className="border-border text-muted-foreground border-t p-4 font-mono text-xs">
        {text.characters.toLocaleString()} characters · fetched with {text.fetchedWith}
        {/* Said outright: a preview that quietly stops is worse than one that admits it. */}
        {text.truncated &&
          ` · showing the first ${text.markdown.length.toLocaleString()} on the demo`}
      </p>
    </div>
  );
}
