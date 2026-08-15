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

/** Polls forever, so networkidle never arrives. */
const NEVER_IDLE = `<!doctype html>
<html><head><title>Never Idle</title></head><body>
  <article><h1>Still Readable</h1>
  ${'<p>This page is perfectly readable, it simply never stops talking to the server.</p>'.repeat(4)}
  </article>
  <script>setInterval(() => fetch('/ping').catch(() => {}), 150);</script>
</body></html>`;

export interface TestServer {
  /** e.g. http://127.0.0.1:53124 — no trailing slash. */
  origin: string;
  close(): Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const server: Server = createServer((request, response) => {
    const path = request.url ?? '/';

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
