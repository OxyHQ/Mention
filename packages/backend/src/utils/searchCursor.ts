const SEARCH_CURSOR_VERSION = 1;
const SEARCH_CURSOR_PREFIX = `v${SEARCH_CURSOR_VERSION}.`;
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;
const MAX_CURSOR_LENGTH = 512;

interface EncodedSearchCursor {
  v: typeof SEARCH_CURSOR_VERSION;
  t: number;
  i: string;
}

export interface SearchCursorData {
  createdAt: Date;
  id: string;
}

/**
 * Encode the stable chronological search axis as an opaque, versioned token.
 * The version prefix allows a future cursor migration to fail explicitly
 * instead of silently applying an incompatible filter.
 */
export function encodeSearchCursor(
  createdAt: Date | string,
  id: string,
): string {
  const timestamp = new Date(createdAt).getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error('Cannot encode search cursor with invalid createdAt');
  }
  if (!OBJECT_ID_PATTERN.test(id)) {
    throw new Error('Cannot encode search cursor with invalid id');
  }

  const payload: EncodedSearchCursor = {
    v: SEARCH_CURSOR_VERSION,
    t: timestamp,
    i: id.toLowerCase(),
  };
  return `${SEARCH_CURSOR_PREFIX}${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

/**
 * Decode a cursor without throwing. Invalid, oversized, legacy, or unknown
 * versions return undefined so the route can reject them as a bad request.
 */
export function decodeSearchCursor(cursor: string): SearchCursorData | undefined {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH
      || !cursor.startsWith(SEARCH_CURSOR_PREFIX)) {
    return undefined;
  }

  const encoded = cursor.slice(SEARCH_CURSOR_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<EncodedSearchCursor>;
    if (parsed.v !== SEARCH_CURSOR_VERSION
        || !Number.isSafeInteger(parsed.t)
        || (parsed.t as number) < 0
        || typeof parsed.i !== 'string'
        || !OBJECT_ID_PATTERN.test(parsed.i)) {
      return undefined;
    }

    return {
      createdAt: new Date(parsed.t as number),
      id: parsed.i.toLowerCase(),
    };
  } catch {
    return undefined;
  }
}
