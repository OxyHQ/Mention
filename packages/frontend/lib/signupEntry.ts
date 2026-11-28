import { WEB_BASE_URL } from '@/config';

/**
 * Query keys Oxy's entry link reads for campaign attribution and guest locale
 * (`readEntryLink`). A signup landing must keep these on the document URL: the
 * SDK records them from `window.location` / the initial link, and the account
 * dialog itself does not put them in the address bar.
 */
const ENTRY_QUERY_KEYS = new Set(['fbclid', 'lang']);

export type EntryParamValue = string | string[] | undefined;
export type EntryParams = Record<string, EntryParamValue>;

export function isPreservedEntryParam(key: string): boolean {
  return key.startsWith('utm_') || ENTRY_QUERY_KEYS.has(key);
}

/** `?utm_source=…` (and the other entry params), or `''` when there are none. */
export function preservedEntryQuery(params: EntryParams): string {
  const search = new URLSearchParams();
  for (const key of Object.keys(params).sort()) {
    if (!isPreservedEntryParam(key)) continue;
    const raw = params[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string' || value.length === 0) continue;
    search.append(key, value);
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

/** Home, still carrying the campaign query a signed-in visit to `/signup` arrived with. */
export function homeHrefPreservingEntry(params: EntryParams): string {
  return `/${preservedEntryQuery(params)}`;
}

/** Public signup URL from the configured web origin. No host is hardcoded here. */
export function signupPublicUrl(): string {
  return `${WEB_BASE_URL.replace(/\/+$/, '')}/signup`;
}
