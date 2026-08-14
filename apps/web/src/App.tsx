import { useState, type FormEvent } from 'react';
import type { FormSpec } from '@untitled/schema';
import { fetchFormSpec, fetchPageText, ServiceError, type BrowserMode, type PageText } from './api';
import { Results } from './Results';
import { PageTextPanel } from './PageTextPanel';

const EXAMPLES = [
  { label: 'a job application', url: 'https://boards.greenhouse.io/gitlab' },
  { label: 'a practice form', url: 'https://demoqa.com/automation-practice-form' },
  { label: 'a signup', url: 'https://en.wikipedia.org/w/index.php?title=Special:CreateAccount' },
];

type Status =
  | { state: 'idle' }
  | { state: 'reading' }
  | { state: 'read'; spec: FormSpec }
  | { state: 'failed'; code: string; message: string };

export function App() {
  const [url, setUrl] = useState('');
  const [browser, setBrowser] = useState<BrowserMode>('auto');
  const [status, setStatus] = useState<Status>({ state: 'idle' });
  const [text, setText] = useState<PageText | null>(null);
  const [textError, setTextError] = useState<string | null>(null);

  async function read(target: string) {
    setStatus({ state: 'reading' });
    setText(null);
    setTextError(null);
    try {
      setStatus({ state: 'read', spec: await fetchFormSpec(target, browser) });
    } catch (error) {
      const { code, message } =
        error instanceof ServiceError
          ? error
          : {
              code: 'unreachable',
              message: 'the service is not answering — is `pnpm serve` running?',
            };
      setStatus({ state: 'failed', code, message });
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (url.trim()) void read(url.trim());
  }

  async function loadText() {
    if (status.state !== 'read') return;
    setTextError(null);
    try {
      setText(await fetchPageText(status.spec.url, browser));
    } catch (error) {
      setTextError(
        error instanceof ServiceError
          ? `${error.message} (${error.code})`
          : 'the service is not answering',
      );
    }
  }

  return (
    <>
      <header className="bar">
        <span className="bar__mark">untitled</span>
        <span className="bar__note">phase 4 · reads forms, fills nothing yet</span>
      </header>

      <main>
        <section className="hero">
          <p className="eyebrow">what it does</p>
          <h1 className="hero__line">
            Every form asks for the same things.
            <span className="hero__turn"> Nothing agrees what to call them.</span>
          </h1>
          <p className="hero__sub">
            Give it a url and it opens the page — with a real browser if the page needs one — then
            reports every box on it: what the box is called, <em>where that name came from</em>, and
            whether we&rsquo;d trust it enough to fill.
          </p>

          {/* The hero is a form field, because a form field is the subject. */}
          <form className="ask" onSubmit={submit}>
            <label className="ask__label" htmlFor="url">
              Page url
            </label>
            <div className="ask__row">
              <input
                id="url"
                className="ask__input"
                type="url"
                inputMode="url"
                placeholder="https://…"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
              />
              <button className="ask__go" type="submit" disabled={status.state === 'reading'}>
                {status.state === 'reading' ? 'Reading…' : 'Read the page'}
              </button>
            </div>
            <div className="ask__foot">
              <fieldset className="modes">
                <legend className="modes__legend">Fetch with</legend>
                {(['auto', 'never', 'always'] as const).map((mode) => (
                  <label key={mode} className="modes__option">
                    <input
                      type="radio"
                      name="browser"
                      value={mode}
                      checked={browser === mode}
                      onChange={() => setBrowser(mode)}
                    />
                    <span>{mode === 'never' ? 'http only' : `browser ${mode}`}</span>
                  </label>
                ))}
              </fieldset>
            </div>
          </form>

          <p className="tries">
            Or try{' '}
            {EXAMPLES.map((example, index) => (
              <span key={example.url}>
                {index > 0 && <span aria-hidden="true"> · </span>}
                <button
                  type="button"
                  className="tries__one"
                  onClick={() => {
                    setUrl(example.url);
                    void read(example.url);
                  }}
                >
                  {example.label}
                </button>
              </span>
            ))}
          </p>
        </section>

        {status.state === 'reading' && (
          <section className="waiting" aria-live="polite">
            <span className="waiting__pulse" aria-hidden="true" />
            Opening the page. A page that builds itself with JavaScript takes a few seconds longer.
          </section>
        )}

        {status.state === 'failed' && (
          <section className="failed" aria-live="polite">
            <p className="failed__what">{status.message}</p>
            <p className="failed__code">{status.code}</p>
          </section>
        )}

        {status.state === 'read' && (
          <>
            <Results spec={status.spec} />
            <PageTextPanel text={text} error={textError} onLoad={() => void loadText()} />
          </>
        )}

        {status.state === 'idle' && <Explainer />}
      </main>

      <footer className="foot">
        <p>
          Reading a page is half of it. The other half — remembering your answers and typing them
          back into the next form — is being built.
        </p>
      </footer>
    </>
  );
}

function Explainer() {
  const steps = [
    {
      key: 'read',
      title: 'Read the page',
      body: 'Plain http first. If the page comes back an empty shell, it opens again in a real browser and waits for the page to build itself.',
    },
    {
      key: 'name',
      title: 'Work out what each box is',
      body: 'A label, a wrapping label, an aria attribute, a placeholder, or the text sitting next to it. In that order, because they are not equally believable.',
    },
    {
      key: 'fill',
      title: 'Fill it, and stop before submitting',
      body: 'Not built yet. It will type what it knows, show you the filled page, and wait for you to press the button.',
    },
  ];

  return (
    <section className="explain">
      {steps.map((step) => (
        <article key={step.key} className="explain__step">
          <h2 className="explain__title">{step.title}</h2>
          <p className="explain__body">{step.body}</p>
        </article>
      ))}
    </section>
  );
}
