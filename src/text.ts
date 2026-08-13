/** Collapse runs of whitespace and trim. Used wherever HTML text becomes a value. */
export function collapseWhitespace(value: string | undefined | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** As above, but an empty result reads as "the page didn't say". */
export function collapseOrNull(value: string | undefined | null): string | null {
  return collapseWhitespace(value) || null;
}
