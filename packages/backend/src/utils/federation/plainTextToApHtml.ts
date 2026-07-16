/**
 * HTML-escape the three characters that are significant inside HTML element text
 * content. `&` is escaped FIRST so that the `&` this function introduces into
 * `&lt;` / `&gt;` is never re-escaped — the canonical, double-escape-safe order.
 *
 * Only `&`, `<` and `>` matter here: the output is placed between `<p>…</p>` (as
 * text content), never inside an attribute value, so `"`/`'` need no escaping.
 * For an ATTRIBUTE value (an anchor `href`), use {@link escapeApHtmlAttr}.
 */
export function escapeApHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * HTML-escape a value placed inside a DOUBLE-QUOTED attribute (an anchor `href`).
 * Everything {@link escapeApHtml} escapes, PLUS the `"` that would otherwise close
 * the attribute — so a user-typed URL carrying `"`/`&`/`<`/`>` can never break out
 * of the `href="…"`. `&` first (via `escapeApHtml`) keeps the order double-escape
 * safe; the introduced entities contain no `"`, so the trailing `"` pass is clean.
 */
export function escapeApHtmlAttr(value: string): string {
  return escapeApHtml(value).replace(/"/g, '&quot;');
}

/**
 * Normalize a post body for AP HTML rendering: `\r\n` and lone `\r` → `\n`, and
 * trim surrounding whitespace so the body never opens or closes with an empty
 * paragraph or a stray `<br>`. Shared by the plain-text transform and the
 * linkifier so both do line-break detection on the same single-newline basis.
 */
export function normalizeApBody(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

/**
 * Wrap an ALREADY-SAFE body — escaped plain text, with any anchors already
 * injected — into AP `content` paragraphs. Blank-line runs become paragraph
 * boundaries (`<p>…</p>`); a single newline inside a paragraph becomes `<br>`.
 *
 * This is the paragraph structuring shared by {@link plainTextToApHtml} and the
 * linkifier. It NEVER escapes (its input is already safe), so injected `<a>`
 * anchors pass through intact — and because an anchor contains no newline, the
 * newline-based paragraph/line-break split only ever cuts at plain-text
 * boundaries. Input must already be normalized (see {@link normalizeApBody}).
 */
export function wrapApParagraphs(safeBody: string): string {
  if (safeBody.length === 0) return '';

  // A paragraph boundary is a run of two or more newlines. Horizontal whitespace
  // on the "blank" line(s) is tolerated, and a run of 3+ newlines collapses to a
  // single boundary, because HTML has no empty paragraph to render.
  const paragraphs = safeBody.split(/\n[ \t]*(?:\n[ \t]*)+/);

  return paragraphs
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    // A single newline that survives inside a paragraph is an author line break.
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
    .join('');
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
 * URLs, hashtags and mentions are deliberately NOT linkified here — that is the
 * job of the linkifier (`linkifyApHtml`), which the Note builder uses for the
 * post body. This helper is strictly the plain-text → line-break-preserving HTML
 * transform, kept for any caller that has no linkification context.
 *
 * An empty or whitespace-only body returns `''`: an empty-bodied post (e.g. a
 * boost, whose body is intentionally empty) must never grow stray `<p>` tags, and
 * every caller already handles an empty `content`.
 */
export function plainTextToApHtml(text: string): string {
  const normalized = normalizeApBody(text);
  if (normalized.length === 0) return '';
  return wrapApParagraphs(escapeApHtml(normalized));
}
