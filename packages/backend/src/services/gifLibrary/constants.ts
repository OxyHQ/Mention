import { config } from '../../config';

/**
 * Tunables for the native GIF library (full import, local-first search).
 *
 * The library is NOT a TTL cache: every GIF we surface is imported into Oxy once,
 * as public files the Mention APPLICATION owns (ADR 0043), and kept for as long
 * as its `gifs` row references them. These constants bound the import work
 * (size, concurrency, search-term storage) and carry the kill-switch.
 */

const BYTES_PER_MIB = 1024 * 1024;
const MS_PER_SECOND = 1000;

/**
 * MASTER kill-switch for the GIF library WRITE side (imports + `Gif` rows).
 *
 * Defaults ON — only the literal string `'false'` disables it. When disabled the
 * routes are a pure Klipy passthrough: no imports, no Oxy files, no `Gif`
 * writes, and `POST /use` returns the Klipy mp4 url with an empty `fileId` (the
 * documented safety-valve; the client must keep its old upload path in that case,
 * which is out of scope since the default is on).
 */
export const GIF_LIBRARY_WRITE_ENABLED = config.gif.libraryWriteEnabled;

/**
 * Content-type declared when a GIF mp4 has to be uploaded rather than imported
 * by URL. Klipy occasionally serves mp4 bytes under a generic
 * `application/octet-stream`, which Oxy's import fetcher refuses (415); we only
 * ever fetch `.mp4` variant URLs, so the fallback downloads them and declares
 * the true type.
 */
export const GIF_UPLOAD_CONTENT_TYPE = 'video/mp4';

/**
 * Maximum size of a single GIF mp4 (full or preview) the upload fallback will
 * download (Oxy's importer applies its own 40 MiB cap). GIFs-as-mp4 are tiny; a
 * generous cap still bounds an abusive/oversized source.
 */
export const GIF_IMPORT_MAX_BYTES = 16 * BYTES_PER_MIB;

/** Idle socket timeout while streaming a GIF source to a temp file. */
export const GIF_DOWNLOAD_SOCKET_TIMEOUT_MS = 20 * MS_PER_SECOND;

/**
 * Max concurrent NEW background imports (download + upload) kicked off by the
 * search/trending top-up. The foreground `POST /use` import is NOT bounded by
 * this — a user selecting a GIF must never queue behind background fan-out.
 */
export const GIF_IMPORT_CONCURRENCY = 3;

/** How many local `$text`/trending hits are prepended ahead of the Klipy page. */
export const GIF_LOCAL_HITS_LIMIT = 12;

/** Cap on stored `searchTerms` per GIF (bounds unbounded growth from resurfacing). */
export const GIF_SEARCH_TERM_MAX = 40;

/** Max length of a single search-term token (drops absurd/garbage tokens). */
export const GIF_TERM_MAX_LEN = 32;

/** Temp directory prefix for GIF import downloads (under the OS tmpdir). */
export const GIF_TEMP_DIR_PREFIX = 'mention-gif-import-';

/** Random bytes for temp filenames (collision resistance). */
export const GIF_TEMP_NAME_RANDOM_BYTES = 16;

/** Fallback width/height when the provider omits dimensions. */
export const GIF_DEFAULT_DIMENSION = 200;

/**
 * Minimal stop-word set stripped from search terms. The text index is declared
 * with `default_language: 'none'` (no stemming / stop-word handling), so the few
 * highest-noise tokens are removed here at normalization time instead.
 */
export const GIF_STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'is',
  'it',
  'this',
  'that',
  'at',
  'by',
  'from',
  'as',
  'be',
  'are',
]);
