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
