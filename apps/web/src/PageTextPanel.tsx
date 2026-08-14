import type { PageText } from './api';

/**
 * The other half of what the scraper does: the prose.
 *
 * Loaded on demand rather than with the form spec, because `/scrape` is behind
 * auth whenever Supabase is configured and `/form-spec` is not — so an
 * unauthenticated demo still does its main job, and this panel explains itself
 * instead of failing the whole page.
 */
export function PageTextPanel({
  text,
  error,
  onLoad,
}: {
  text: PageText | null;
  error: string | null;
  onLoad: () => void;
}) {
  return (
    <section className="text">
      <div className="text__head">
        <p className="eyebrow">the same page, as words</p>
        <h2 className="text__title">{text?.title ?? 'Readable text'}</h2>
      </div>

      {!text && !error && (
        <>
          <p className="text__pitch">
            Forms are one surface. The same fetch also produces clean Markdown — the article without
            the navigation, the cookie banner, or the footer.
          </p>
          <button type="button" className="text__load" onClick={onLoad}>
            Show the text
          </button>
        </>
      )}

      {error && (
        <p className="text__error">
          {error}. This endpoint needs a token when Supabase is configured — run{' '}
          <code>REQUIRE_AUTH=0 pnpm serve</code> to try it locally.
        </p>
      )}

      {text && (
        <>
          {text.description && <p className="text__desc">{text.description}</p>}
          <pre className="text__body">{text.markdown.slice(0, 4000)}</pre>
          {text.markdown.length > 4000 && (
            <p className="text__more">
              showing the first 4,000 of {text.markdown.length.toLocaleString()} characters
            </p>
          )}
        </>
      )}
    </section>
  );
}
