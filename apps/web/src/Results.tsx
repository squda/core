import type { Field, Form, FormSpec } from '@untitled/schema';
import { isFillable, SOURCE_COPY, tally, TRUST_COPY, trustOf } from './trust';

/**
 * The answer to "what could you fill on this page?" — per box, with its
 * provenance showing. The row is the signature element of the whole page: a
 * label, and underneath it, in small type, how we came to believe that label.
 */
export function Results({ spec }: { spec: FormSpec }) {
  const everyField = spec.forms.flatMap((form) => form.fields);
  const fillable = everyField.filter(isFillable);
  const counts = tally(fillable);
  const hidden = everyField.length - fillable.length;

  return (
    <section className="results">
      <div className="results__head">
        <p className="eyebrow">what we found</p>
        <h2 className="results__url">{spec.url}</h2>
        <p className="results__meta">
          fetched with {spec.fetchedWith === 'browser' ? 'a real browser' : 'plain http'} ·{' '}
          {spec.forms.length} {spec.forms.length === 1 ? 'form' : 'forms'} · {counts.fields}{' '}
          {counts.fields === 1 ? 'box' : 'boxes'} a person fills
          {hidden > 0 && ` · ${hidden} hidden or locked, not counted`}
        </p>
      </div>

      {counts.fields > 0 && (
        <ul className="tally">
          <Count n={counts.named} of={counts.fields} label="we can name" tone="named" />
          <Count n={counts.inferred} of={counts.fields} label="inferred" tone="inferred" />
          <Count n={counts.guessed} of={counts.fields} label="guessed" tone="guessed" />
          <Count n={counts.unknown} of={counts.fields} label="unnamed" tone="unknown" />
          <Count n={counts.required} of={counts.fields} label="required" tone="plain" />
          <Count n={counts.sensitive} of={counts.fields} label="sensitive" tone="sensitive" />
        </ul>
      )}

      {spec.forms.length === 0 && (
        <p className="empty">
          No form on this page. Try a signup, a checkout, or a job application.
        </p>
      )}

      {spec.forms.map((form, index) => (
        <FormBlock key={form.selector ?? `loose-${index}`} form={form} index={index} />
      ))}
    </section>
  );
}

function Count({ n, of, label, tone }: { n: number; of: number; label: string; tone: string }) {
  return (
    <li className={`tally__cell tally__cell--${tone}`} data-empty={n === 0 ? 'yes' : 'no'}>
      <span className="tally__n">{n}</span>
      <span className="tally__label">{label}</span>
      <span className="tally__bar" aria-hidden="true">
        <span className="tally__fill" style={{ width: `${of === 0 ? 0 : (n / of) * 100}%` }} />
      </span>
    </li>
  );
}

function FormBlock({ form, index }: { form: Form; index: number }) {
  const fields = form.fields.filter(isFillable);
  const skipped = form.fields.length - fields.length;

  return (
    <article className="form">
      <header className="form__head">
        <h3 className="form__name">
          <span className="form__ordinal">form {index + 1}</span>
          <code>{form.selector ?? 'no <form> element'}</code>
        </h3>
        <p className="form__route">
          {form.method} → {form.action ?? 'itself'}
          {form.submitSelector ? ` · submits with ${form.submitSelector}` : ' · no submit button'}
          {skipped > 0 && ` · ${skipped} hidden or locked`}
        </p>
      </header>

      {fields.length === 0 ? (
        <p className="empty">Nothing here a person would type into.</p>
      ) : (
        <ol className="fields">
          {fields.map((field) => (
            <FieldRow key={field.selector} field={field} />
          ))}
        </ol>
      )}
    </article>
  );
}

function FieldRow({ field }: { field: Field }) {
  const trust = trustOf(field);
  const copy = TRUST_COPY[trust];

  return (
    <li className="field" data-trust={trust}>
      <div className="field__main">
        <p className="field__label">
          {field.label ?? <span className="field__nolabel">unnamed box</span>}
          {field.required && (
            <span className="field__required" title="required">
              required
            </span>
          )}
          {field.sensitive && <span className="field__sensitive">sensitive</span>}
        </p>
        <p className="field__from">
          <span className="field__dot" aria-hidden="true" />
          {field.labelSource ? (
            <>
              <strong>{copy.badge}</strong> — from {SOURCE_COPY[field.labelSource]}
            </>
          ) : (
            <>
              <strong>{copy.badge}</strong> — {copy.explain}
            </>
          )}
          {field.autocomplete && (
            <>
              {' · '}
              <span className="field__auto">autocomplete={field.autocomplete}</span>
            </>
          )}
        </p>
        {field.description && <p className="field__help">{field.description}</p>}
        {field.options.length > 0 && (
          <p className="field__options">
            {field.options.length} choices:{' '}
            {field.options
              .slice(0, 6)
              .map((option) => option.label)
              .join(' · ')}
            {field.options.length > 6 && ' …'}
          </p>
        )}
      </div>

      <div className="field__side">
        <span className="chip">{field.type}</span>
        <code className="field__selector">{field.selector}</code>
      </div>
    </li>
  );
}
