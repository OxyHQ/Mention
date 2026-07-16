/**
 * HTML-escape the three characters that are significant inside HTML element text
 * content. `&` is escaped FIRST so that the `&` this function introduces into
 * `&lt;` / `&gt;` is never re-escaped — the canonical, double-escape-safe order.
 *
 * Only `&`, `<` and `>` matter here: the output is placed between `<p>…</p>` (as
 * text content), never inside an attribute value, so `"`/`'` need no escaping.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Convert an author-written PLAIN-TEXT post body into the safe ActivityPub
 * `content` HTML fragment — the OUTBOUND inverse of {@link htmlToPlainText}.
 *
 * ActivityPub `content` (and every `contentMap` value) is an HTML string: every
 * fediverse server — Mastodon included — renders it as HTML, where a run of
 * whitespace collapses and a bare newline is insignificant. Emitting a stored
 * plain-text body raw therefore DROPS the author's blank lines and line breaks the
 * moment it is rendered, and leaves any literal `<`/`&` to be mis-parsed as markup.
 *
 * The transform mirrors how Mastodon itself serializes a status body:
 *   1. Normalize line endings (`\r\n` and lone `\r` → `\n`).
 *   2. HTML-escape the text (`&` first, then `<`/`>`).
 *   3. Split on blank-line boundaries into paragraphs, each wrapped in `<p>…</p>`.
 *   4. Convert every remaining single newline inside a paragraph to `<br>`.
 *
 * URLs, hashtags and mentions are deliberately NOT linkified here — that is a
 * separate concern (the machine-readable references travel in the AP `tag` array).
 * This helper is strictly the plain-text → line-break-preserving HTML transform.
 *
 * An empty or whitespace-only body returns `''`: an empty-bodied post (e.g. a
 * boost, whose body is intentionally empty) must never grow stray `<p>` tags, and
 * every caller already handles an empty `content`.
 */
export function plainTextToApHtml(text: string): string {
  // Normalize line endings so paragraph/line-break detection is single-newline
  // based, and drop leading/trailing whitespace so the body never opens or closes
  // with an empty paragraph or a stray `<br>`.
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (normalized.length === 0) return '';

  const escaped = escapeHtml(normalized);

  // A paragraph boundary is a run of two or more newlines. Horizontal whitespace
  // on the "blank" line(s) is tolerated — a line that holds only spaces still
  // separates paragraphs — and a run of 3+ newlines collapses to a single
  // boundary, because HTML has no empty paragraph to render.
  const paragraphs = escaped.split(/\n[ \t]*(?:\n[ \t]*)+/);

  return paragraphs
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    // A single newline that survives inside a paragraph is an author line break.
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
    .join('');
}
