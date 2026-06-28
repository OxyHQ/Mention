/**
 * Strips the scheme (`http(s)://`), a leading `www.`, and a trailing slash from
 * a URL for compact display. Extracted from the inline regex previously used in
 * `ProfileMeta` so the profile link summary row and sheet share one source.
 */
export const prettifyUrl = (url: string): string =>
  url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
