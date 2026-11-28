/**
 * The ONE token for a list that pages by OFFSET (Oxy's ranking and follow-graph
 * pages), sibling of `chronoCursor.ts` for the keyset lists. Opaque to clients:
 * `v1.<base64url json>`.
 *
 * `phase`/`after` exist for a list whose paging moves from offset pages to
 * something else (the remote connections list continues in a keyset over ids once
 * Oxy's pages end); a plain offset list leaves them out.
 *
 * Decoding is fail-soft: anything this server did not mint is `undefined`, and the
 * caller starts at page one. That cannot loop, because every cursor a page then
 * emits is freshly encoded and decodes.
 */

export interface OffsetCursor {
  offset: number;
  phase?: string;
  after?: string;
}

const PREFIX = 'v1.';
const MAX_CURSOR_LENGTH = 512;

export function encodeOffsetCursor(cursor: OffsetCursor): string {
  return `${PREFIX}${Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')}`;
}

export function decodeOffsetCursor(cursor: string | undefined): OffsetCursor | undefined {
  if (!cursor || cursor.length > MAX_CURSOR_LENGTH || !cursor.startsWith(PREFIX)) return undefined;
  const encoded = cursor.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const { offset, phase, after } = parsed;
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return undefined;
    if (phase !== undefined && typeof phase !== 'string') return undefined;
    if (after !== undefined && typeof after !== 'string') return undefined;
    return { offset, phase, after };
  } catch {
    return undefined;
  }
}
