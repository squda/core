import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A tiny local site for the browser tests.
 *
 * Local because the plan is right that a test hitting the live internet isn't
 * a test — but a browser has to fetch something over HTTP, so a fixture file
 * won't do. This is the middle ground: real HTTP, no internet.
 */

const ARTICLE = `<!doctype html>
<html><head><title>Static Article</title>
<meta name="description" content="Served as HTML, no JavaScript needed.">
</head><body>
  <nav>Home About</nav>
  <article><h1>Static Article</h1>
  ${'<p>This paragraph was in the HTML that came off the wire. It needs no JavaScript at all.</p>'.repeat(4)}
  </article>
  <footer>Copyright</footer>
</body></html>`;

/**
 * The page the whole phase exists for: an empty root that only fills in after
 * JavaScript runs. Fetch it with HTTP and you get the shell; fetch it with a
 * browser and you get the article.
 */
const SPA = `<!doctype html>
<html><head><title>Client Rendered</title></head><body>
  <div id="root"></div>
  <script>
    setTimeout(() => {
      document.getElementById('root').innerHTML =
        '<article><h1>Rendered By JavaScript</h1>' +
        '<p>This sentence did not exist in the HTML response. It was written by a script after the page loaded, which is exactly what a plain HTTP fetch cannot see.</p>'.repeat(3) +
        '</article>';
    }, 50);
  </script>
</body></html>`;

/** A consent overlay standing where the article should be, as many sites do. */
const CONSENT = `<!doctype html>
<html><head><title>Consent Wall</title></head><body>
  <div id="cookie-banner" style="position:fixed;inset:0;background:#fff">
    <p>We value your privacy.</p>
    <button id="onetrust-accept-btn-handler" onclick="
      document.getElementById('cookie-banner').remove();
      document.getElementById('article').style.display = 'block';
    ">Accept all</button>
  </div>
  <article id="article" style="display:none">
    <h1>Behind The Banner</h1>
    ${'<p>This paragraph is only readable once the consent banner has been dismissed, which is the whole point of the test.</p>'.repeat(4)}
  </article>
</body></html>`;

/** Appends a batch of items each time you reach the bottom, forever. */
const INFINITE = `<!doctype html>
<html><head><title>Infinite Scroll</title></head><body>
  <div id="feed">
    <p style="height:900px">Item 0 of an endless feed that appends as you scroll.</p>
  </div>
  <script>
    let batch = 0;
    addEventListener('scroll', () => {
      if (window.scrollY + window.innerHeight < document.body.scrollHeight - 10) return;
      batch += 1;
      const p = document.createElement('p');
      p.textContent = 'Item ' + batch + ' of an endless feed that appends as you scroll.';
      p.style.height = '900px';
      document.getElementById('feed').append(p);
    });
  </script>
</body></html>`;

/**
 * Content behind clicks, in the three shapes the web actually uses.
 *
 * The tab panels are *unmounted* rather than hidden, which is the hard case:
 * reading the DOM at the end sees only whichever tab was opened last, so the
 * expander has to collect each panel while it is on screen.
 *
 * The sign-out button is the control that must still be there, unclicked, when
 * the page is read. It is a plain button with plain text, which is exactly what
 * a "click anything that says Show more" rule would eventually reach.
 */
const DISCLOSURES = `<!doctype html>
<html><head><title>Behind A Click</title></head><body>
  <article>
    <h1>Behind A Click</h1>

    <div role="tablist">
      <button role="tab" aria-selected="true" aria-controls="panel-a" onclick="show('a')">Overview</button>
      <button role="tab" aria-selected="false" aria-controls="panel-b" onclick="show('b')">Eligibility</button>
      <button role="tab" aria-selected="false" aria-controls="panel-c" onclick="show('c')">Documents</button>
    </div>
    <div id="panels"><div id="panel-a"><p>OverviewOnly for the first tab.</p></div></div>

    <button aria-expanded="false" aria-controls="acc" onclick="
      this.setAttribute('aria-expanded', 'true');
      document.getElementById('acc').hidden = false;
    ">How do I apply?</button>
    <div id="acc" hidden><p>AccordionOnly that was hidden until asked for.</p></div>

    <details><summary>Fine print</summary><p>DetailsOnly nobody reads.</p></details>

    <button onclick="document.body.innerHTML = '<p>SignedOutNow</p>'">Sign out</button>
  </article>
  <script>
    const bodies = {
      a: '<p>OverviewOnly for the first tab.</p>',
      b: '<p>EligibilityOnly that only tab two has.</p>',
      c: '<p>DocumentsOnly that only tab three has.</p>',
    };
    function show(which) {
      // Replaces the panel rather than hiding it — the previous tab's content
      // is gone from the DOM entirely once another is opened.
      document.getElementById('panels').innerHTML =
        '<div id="panel-' + which + '">' + bodies[which] + '</div>';
      for (const tab of document.querySelectorAll('[role="tab"]')) {
        tab.setAttribute('aria-selected', String(tab.getAttribute('aria-controls') === 'panel-' + which));
      }
    }
  </script>
</body></html>`;

/**
 * The two kinds of hidden, which must not be treated the same way.
 *
 * Overlays the page ships but is not showing are junk: taken out of the flow
 * with `position: fixed`, or saying outright that they are a dialog. Hidden the
 * way real sites hide them — a CSS class, not the `hidden` attribute — so
 * extraction, which sees no stylesheet, would otherwise print them as headings.
 *
 * Collapsed content is not junk. The FAQ here is built the way myscheme.gov.in
 * builds its own: a plain div with no role and no `aria-expanded`, which the
 * expander cannot open and must therefore not delete.
 *
 * The hidden input is the third rule — it must survive into `html`, because
 * Phase 4's form walker is supposed to find it.
 */
const HIDDEN_DIALOGS = `<!doctype html>
<html><head><title>Hidden Dialogs</title>
<style>
  .overlay { display: none; position: fixed; inset: 0 }
  .invisible-overlay { visibility: hidden; position: fixed; inset: 0 }
  .collapsed { display: none }
</style>
</head><body>
  <div class="overlay"><h3>SomethingWentWrong please try again later.</h3><button>Ok</button></div>
  <div class="invisible-overlay"><p>AreYouSure you want to sign out?</p></div>
  <div role="dialog" class="collapsed"><p>PleaseSignIn before applying.</p></div>

  <article><h1>Real Article</h1>
  ${'<p>This is the content a reader actually sees on the page, and the only part that should reach the markdown.</p>'.repeat(4)}
  <div><p>Is there a deadline?</p><div class="collapsed"><p>CollapsedAnswer that no attribute marks as expandable.</p></div></div>
  </article>

  <form><input type="hidden" name="csrf" value="tok"><input name="email"></form>
</body></html>`;

/** Polls forever, so networkidle never arrives. */
const NEVER_IDLE = `<!doctype html>
<html><head><title>Never Idle</title></head><body>
  <article><h1>Still Readable</h1>
  ${'<p>This page is perfectly readable, it simply never stops talking to the server.</p>'.repeat(4)}
  </article>
  <script>setInterval(() => fetch('/ping').catch(() => {}), 150);</script>
</body></html>`;

/**
 * A form whose second field only exists in a live open shadow root.
 * `page.content()` cannot serialize that root, so this distinguishes live DOM
 * inspection from running the static HTML walker after a browser fetch.
 */
const LIVE_FORMS = `<!doctype html>
<html><head><title>Live forms</title></head><body>
  <form id="profile">
    <label for="full-name">Full name</label>
    <input id="full-name" autocomplete="name">
  </form>
  <section id="account-shell"></section>
  <section id="private-shell"></section>
  <section id="generated-host-a83cf87f"></section>
  <section class="anonymous-shell"></section>
  <iframe id="embedded" src="/embedded-form"></iframe>
  <iframe id="generated-frame-a83cf87f" name="address-frame" src="/generated-frame-form"></iframe>
  <script>
    const root = document.getElementById('account-shell').attachShadow({ mode: 'open' });
    root.innerHTML = '<form id="account"><label for="shadow-email">Work email</label><input id="shadow-email" type="email" autocomplete="email"></form><section><span>Anonymous shadow field</span><input></section><iframe id="shadow-frame" src="/shadow-frame-form"></iframe>';
    const closed = document.getElementById('private-shell').attachShadow({ mode: 'closed' });
    closed.innerHTML = '<label for="private-code">Private code</label><input id="private-code">';
    const generated = document.getElementById('generated-host-a83cf87f').attachShadow({ mode: 'open' });
    generated.innerHTML = '<label for="generated-field">Generated host field</label><input id="generated-field">';
    const anonymous = document.querySelector('.anonymous-shell').attachShadow({ mode: 'open' });
    anonymous.innerHTML = '<label for="anonymous-host-field">Anonymous host field</label><input id="anonymous-host-field">';
  </script>
</body></html>`;

let generatedFormId = 112_599;

function generatedIdForm(): string {
  generatedFormId += 1;
  const id = `select-input-${generatedFormId}`;
  return `<!doctype html><html><body>
    <main><section><label for="${id}">Account type</label><input id="${id}"></section></main>
  </body></html>`;
}

const CHOICE_WIDGETS = `<!doctype html><html><body>
  <label id="colour-label">Favourite colour</label>
  <div class="choice-control">
    <span>Ocean</span>
    <input id="colour-picker" role="combobox" aria-labelledby="colour-label"
           aria-expanded="false" aria-controls="colour-options" value="">
  </div>
  <label id="size-label">Size</label>
  <div id="size-picker" role="listbox" aria-labelledby="size-label">
    <div role="option" data-value="small" aria-selected="true">Small</div>
    <div role="option" data-value="large">Large</div>
  </div>
  <script>
    const picker = document.getElementById('colour-picker');
    const close = () => {
      picker.setAttribute('aria-expanded', 'false');
      document.getElementById('colour-options')?.remove();
    };
    picker.addEventListener('click', () => {
      picker.setAttribute('aria-expanded', 'true');
      const listbox = document.createElement('div');
      listbox.id = 'colour-options';
      listbox.setAttribute('role', 'listbox');
      listbox.setAttribute('aria-setsize', '3');
      listbox.innerHTML = '<div role="option" data-value="ocean" aria-selected="true">Ocean</div><div role="option" data-value="red">Red</div><div role="option" data-value="blue">Blue</div>';
      document.body.append(listbox);
    });
    picker.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });
    const sizePicker = document.getElementById('size-picker');
    const mutateSize = () => {
      sizePicker.querySelector('[data-value="small"]').setAttribute('aria-selected', 'false');
      sizePicker.querySelector('[data-value="large"]').setAttribute('aria-selected', 'true');
    };
    sizePicker.addEventListener('click', mutateSize);
    sizePicker.addEventListener('keydown', mutateSize);
  </script>
</body></html>`;

const SLOW_CHOICE_WIDGETS = `<!doctype html><html><body>
  ${Array.from(
    { length: 8 },
    (_value, index) =>
      `<input role="combobox" aria-label="Choice ${index}" aria-expanded="false" aria-controls="missing-${index}">`,
  ).join('')}
</body></html>`;

const FORM_WIZARD = `<!doctype html>
<html><head><title>Application wizard</title></head><body>
  <form id="application" action="/wizard-step-2" method="get">
    <h2>Contact</h2>
    <label for="wizard-email">Email</label>
    <input id="wizard-email" name="email" type="email" required>
    <fieldset><legend>Are you currently working?</legend>
      <label><input type="radio" name="working" value="yes"> Yes</label>
      <label><input type="radio" name="working" value="no"> No</label>
    </fieldset>
    <input type="submit" value="Next step">
  </form>
</body></html>`;

const FORM_WIZARD_STEP_2 = `<!doctype html>
<html><head><title>Application wizard</title></head><body>
  <form id="application" action="/wizard-submitted" method="post">
    <h2>Experience</h2>
    <label for="years">Years of experience</label>
    <input id="years" name="years" type="number" required>
    <button type="submit">Submit application</button>
  </form>
</body></html>`;

const STALLED_WIZARD = `<!doctype html>
<html><head><title>Stalled wizard</title></head><body>
  <form id="stalled">
    <label for="unchanged">Unchanged answer</label>
    <input id="unchanged" name="answer">
    <button type="button">Continue</button>
  </form>
</body></html>`;

export interface TestServer {
  /** e.g. http://127.0.0.1:53124 — no trailing slash. */
  origin: string;
  close(): Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://test.local').pathname;

    if (path === '/spa') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(SPA);
      return;
    }
    if (path === '/consent') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(CONSENT);
      return;
    }
    if (path === '/infinite') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(INFINITE);
      return;
    }
    if (path === '/hidden-dialogs') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(HIDDEN_DIALOGS);
      return;
    }
    if (path === '/disclosures') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(DISCLOSURES);
      return;
    }
    if (path === '/never-idle') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(NEVER_IDLE);
      return;
    }
    if (path === '/live-forms') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(LIVE_FORMS);
      return;
    }
    if (path === '/generated-id-form') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(generatedIdForm());
      return;
    }
    if (path === '/choice-widgets') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(CHOICE_WIDGETS);
      return;
    }
    if (path === '/slow-choice-widgets') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(SLOW_CHOICE_WIDGETS);
      return;
    }
    if (path === '/embedded-form') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html><body><form><label for="city">City</label><input id="city" autocomplete="address-level2"></form></body></html>',
      );
      return;
    }
    if (path === '/shadow-frame-form') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html><body><label for="nested-code">Nested code</label><input id="nested-code"></body></html>',
      );
      return;
    }
    if (path === '/generated-frame-form') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html><body><label for="postal-code">Postal code</label><input id="postal-code"></body></html>',
      );
      return;
    }
    if (path === '/wizard') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(FORM_WIZARD);
      return;
    }
    if (path === '/wizard-step-2') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(FORM_WIZARD_STEP_2);
      return;
    }
    if (path === '/wizard-stalled') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(STALLED_WIZARD);
      return;
    }
    if (path === '/wizard-submitted') {
      response.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<html><body>THE INSPECTOR SUBMITTED THE FORM</body></html>');
      return;
    }
    if (path === '/ping') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    if (path === '/missing') {
      response.writeHead(404, { 'content-type': 'text/html' });
      response.end('<html><body>not found</body></html>');
      return;
    }
    if (path === '/paper.pdf') {
      response.writeHead(200, { 'content-type': 'application/pdf' });
      response.end('%PDF-1.7');
      return;
    }
    if (path === '/moved') {
      response.writeHead(302, { location: '/' });
      response.end();
      return;
    }
    if (path === '/hang') {
      // Never responds. The socket stays open until the test closes the server.
      return;
    }

    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(ARTICLE);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
