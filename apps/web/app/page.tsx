'use client';

import { useState, type FormEvent } from 'react';
import type { FormSpec } from '@untitled/schema';
import { fetchFormSpec, ServiceError, type BrowserMode } from '@/lib/api';

/**
 * The one page — a template, not a design.
 *
 * Everything below the state machine is placeholder markup that exists to prove
 * the pipe works end to end: url in, FormSpec out. Replace the render, keep the
 * state machine. The four states it distinguishes are the four the real UI has
 * to distinguish too, and getting that wrong is the usual reason a redesign
 * turns into a rewrite.
 *
 * What is deliberately already here:
 *  - a client component, because this page is a text field and a button
 *  - `browser` mode as state, because a page that builds itself with JavaScript
 *    needs `always` and the user has to be able to say so
 *  - errors carried as `{ code, message }` from the service rather than a bare
 *    string, because the code is what makes a failure actionable
 */

type Status =
  | { state: 'idle' }
  | { state: 'reading' }
  | { state: 'read'; spec: FormSpec }
  | { state: 'failed'; code: string; message: string };

export default function Home() {
  const [url, setUrl] = useState('');
  const [browser] = useState<BrowserMode>('auto');
  const [status, setStatus] = useState<Status>({ state: 'idle' });

  async function read(target: string) {
    setStatus({ state: 'reading' });
    try {
      setStatus({ state: 'read', spec: await fetchFormSpec(target, browser) });
    } catch (error) {
      const { code, message } =
        error instanceof ServiceError
          ? error
          : { code: 'unreachable', message: 'could not reach the service' };
      setStatus({ state: 'failed', code, message });
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (url.trim()) void read(url.trim());
  }

  /* ─────────────────────────────────────────────────────────────────
   * Everything from here down is scaffolding. Replace it with the
   * design; the state above is what it plugs into.
   * ───────────────────────────────────────────────────────────────── */

  return (
    <main style={{ maxWidth: '48rem', margin: '0 auto', padding: '3rem 1.5rem' }}>
      <h1>untitled</h1>
      <p>Paste a url and see every form field on the page.</p>

      <form onSubmit={submit}>
        <label htmlFor="url">Page url</label>
        <br />
        <input
          id="url"
          type="url"
          placeholder="https://…"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          required
          style={{ width: '24rem', maxWidth: '100%' }}
        />
        <button type="submit" disabled={status.state === 'reading'}>
          {status.state === 'reading' ? 'Reading…' : 'Read the page'}
        </button>
      </form>

      {status.state === 'failed' && (
        <p role="alert">
          {status.message} ({status.code})
        </p>
      )}

      {status.state === 'read' && (
        <section>
          <p>
            {status.spec.forms.length} form(s) ·{' '}
            {status.spec.forms.reduce((total, form) => total + form.fields.length, 0)} field(s) ·
            fetched with {status.spec.fetchedWith}
          </p>
          <pre style={{ overflow: 'auto', fontSize: '0.75rem' }}>
            {JSON.stringify(status.spec, null, 2)}
          </pre>
        </section>
      )}
    </main>
  );
}
